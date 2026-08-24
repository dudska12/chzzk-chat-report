// 다시보기(VOD) 영상의 채팅 로그를 통째로 긁어온다.
// 실시간 감시(collector.ts)는 웹소켓으로 채팅이 오는 족족 받지만, VOD는 이미 끝난 방송이라
// 그런 실시간 채널이 없다. 대신 치지직 웹 플레이어가 다시보기 재생 중 채팅을 동기화해서
// 보여줄 때 내부적으로 호출하는 REST API를 그대로 쓴다:
//   GET /service/v1/videos/{videoNo}/chats?playerMessageTime={ms}&previousVideoChatSize={n}
// 이 요청 하나에 최대 50개 정도의 채팅이 오고, 응답에 담긴 nextPlayerMessageTime을 다음 요청의
// playerMessageTime으로 넣어서 반복하면 영상 처음부터 끝까지 순회할 수 있다.
//
// 주의: 이 엔드포인트는 치지직이 공식 문서로 공개한 API가 아니다. 페이지네이션이 정확히
// 어떤 규칙으로 끝나는지(중복/누락 없이 끝까지 도는지)는 실제 영상으로 끝까지 검증하지
// 못했다. 그래서 아래 종료 조건들은 하나가 아니라 여러 겹으로 방어적으로 짜여 있다.
import type { ChzzkClient } from "chzzk";
import type { ChatMessage } from "./types";

const PAGE_SIZE = 50;
// 안전장치: 페이지네이션이 어떤 이유로든 끝나지 않을 경우를 대비한 상한선. 페이지당 최대
// PAGE_SIZE개이므로, 이 값이면 최대 100만 개 채팅(웬만한 몇 시간짜리 방송의 전체 채팅보다도
// 훨씬 많은 양)까지 커버하고도 남는다.
const MAX_PAGES = 20_000;
// 요청 하나의 응답 제한 시간. 서버가 응답 없이 매달아두면(네트워크 이상 등) 예전엔 이 함수가
// 영원히 안 끝나서 VOD 작업이 "수집 중" 상태로 영영 멈춰 있었다 - 페이지 하나에 30초면
// 정상 상황에선 절대 안 걸리는 넉넉한 값이라, 걸렸다는 건 뭔가 잘못됐다는 뜻으로 봐도 된다.
const PAGE_FETCH_TIMEOUT_MS = 30_000;

/** promise가 제한 시간 안에 안 끝나면 에러로 던진다. 성공/실패 어느 쪽이든 타이머는 정리해서
 * (CLI에서) 이벤트 루프가 타이머 때문에 붙잡혀 있지 않게 한다. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 응답 시간 초과 (${ms / 1000}초)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RawVodChatProfile {
  userIdHash?: string;
  nickname?: string;
}

interface RawVodChatExtras {
  payAmount?: number;
  donationType?: string;
}

interface RawVodChat {
  content?: string;
  extras?: string; // JSON 문자열
  messageTime?: number; // 원 방송 당시 epoch ms
  messageTypeCode?: number;
  playerMessageTime?: number; // VOD 재생 위치 기준 경과 ms
  profile?: string; // JSON 문자열
  userIdHash?: string;
}

interface VodChatsResponse {
  code: number;
  message: string | null;
  content?: {
    nextPlayerMessageTime?: number | null;
    previousVideoChats?: RawVodChat[];
    videoChats?: RawVodChat[];
  };
}

function safeJsonParse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 원본 응답 한 줄을 기존 파이프라인이 그대로 쓸 수 있는 ChatMessage로 바꾼다.
 * content/profile이 없는 항목(시스템 메시지 등으로 추정)은 조용히 건너뛴다. */
function toChatMessage(
  raw: RawVodChat,
  sessionId: string,
  videoStartMs: number
): ChatMessage | null {
  if (!raw.content) return null;
  const profile = safeJsonParse<RawVodChatProfile>(raw.profile);
  if (!profile) return null;

  const extras = safeJsonParse<RawVodChatExtras>(raw.extras);
  const donationAmount =
    typeof extras?.payAmount === "number" && extras.payAmount > 0 ? extras.payAmount : undefined;

  // playerMessageTime(재생 위치 기준 경과 ms)을 영상 시작 시각에 더해서 절대 시각으로 맞춘다.
  // messageTime(원 방송 당시 실제 시각)도 같이 오지만, 다시보기 영상은 예고편이 잘리는 등
  // 실제 방송과 길이가 어긋날 수 있어서 재생 위치 기준이 기존 파이프라인(타임라인/편집점 —
  // 전부 "방송 시작 기준 경과 시간"으로 계산함)과 정합성이 더 잘 맞는다.
  const timestamp = videoStartMs + (raw.playerMessageTime ?? 0);

  return {
    sessionId,
    userIdHash: raw.userIdHash || profile.userIdHash || "unknown",
    nickname: profile.nickname || "알 수 없음",
    message: raw.content,
    timestamp,
    isDonation: donationAmount !== undefined,
    donationAmount,
  };
}

export interface FetchVodChatsOptions {
  videoNo: string | number;
  sessionId: string;
  videoStartMs: number; // 방송(영상) 시작 epoch ms
  videoDurationMs: number; // 영상 전체 길이 ms
  onProgress?: (fetchedCount: number, cursorMs: number, durationMs: number) => void;
}

/**
 * VOD 채팅을 처음부터 끝까지 전부 긁어서 시간순 ChatMessage[]로 돌려준다.
 * 실시간 웹소켓과 달리 REST 페이지네이션이라 영상이 길고 채팅이 많을수록 요청 횟수도
 * 비례해서 늘어난다 (한 번에 최대 PAGE_SIZE개).
 */
export async function fetchAllVodChats(
  client: ChzzkClient,
  opts: FetchVodChatsOptions
): Promise<ChatMessage[]> {
  const { videoNo, sessionId, videoStartMs, videoDurationMs, onProgress } = opts;
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];

  let cursor = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    pages++;

    const url = `/service/v1/videos/${videoNo}/chats?playerMessageTime=${cursor}&previousVideoChatSize=${PAGE_SIZE}`;
    let data: VodChatsResponse;
    try {
      const res = await withTimeout(client.fetch(url), PAGE_FETCH_TIMEOUT_MS, "VOD 채팅 조회");
      data = (await withTimeout(res.json(), PAGE_FETCH_TIMEOUT_MS, "VOD 채팅 본문 읽기")) as VodChatsResponse;
    } catch (err) {
      throw new Error(`VOD 채팅 조회 실패 (playerMessageTime=${cursor}): ${err}`);
    }

    const batch = [
      ...(data.content?.previousVideoChats ?? []),
      ...(data.content?.videoChats ?? []),
    ];

    let addedInThisPage = 0;
    for (const raw of batch) {
      // 서버가 같은 채팅을 두 페이지에 걸쳐 중복으로 돌려줄 가능성에 대비해, userIdHash +
      // messageTime + playerMessageTime 조합으로 중복 제거한다.
      const key = `${raw.userIdHash ?? ""}_${raw.messageTime ?? ""}_${raw.playerMessageTime ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const msg = toChatMessage(raw, sessionId, videoStartMs);
      if (msg) {
        messages.push(msg);
        addedInThisPage++;
      }
    }

    onProgress?.(messages.length, cursor, videoDurationMs);

    const next = data.content?.nextPlayerMessageTime;
    const noProgress = next === undefined || next === null || next <= cursor;
    // 영상 길이를 살짝 넘어서면(약간의 여유를 둠) 끝난 것으로 본다.
    const pastEnd = typeof next === "number" && next >= videoDurationMs + 60_000;
    const emptyPage = batch.length === 0;

    if (noProgress || pastEnd || (emptyPage && addedInThisPage === 0)) break;
    cursor = next as number;
  }

  messages.sort((a, b) => a.timestamp - b.timestamp);
  return messages;
}
