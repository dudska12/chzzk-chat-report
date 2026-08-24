// 라이브 방송을 GUI 안에서 직접 재생하기 위해, 실제로 재생 가능한 스트림 주소를 알아내는
// 모듈. vod-playback.ts와 목적은 같지만 훨씬 간단하다 — VOD는 비공식 API(inKey 조합)를
// 역공학해야 했는데, 라이브는 이미 쓰고 있는 `chzzk` npm 패키지의 공식 지원 메서드
// (client.live.detail())가 livePlayback.media[].path로 바로 재생 가능한 HLS(.m3u8) 주소를
// 내려준다(내부적으로 /service/v2/channels/{channelId}/live-detail 응답의 livePlaybackJson을
// 파싱해서 붙여준다 — node_modules/chzzk/dist/api/live.js 참고).
import { ChzzkClient } from "chzzk";

export interface LivePlaybackInfo {
  url: string;
}

export interface ResolveLivePlaybackOptions {
  nidAuth?: string;
  nidSession?: string;
  client?: ChzzkClient; // 테스트용 주입 지점
}

interface LivePlaybackMedia {
  mediaId?: string;
  path?: string;
}

/** livePlayback.media 배열에서 재생에 쓸 항목 하나를 고른다. LLHLS(초저지연)는 hls.js
 * 기본 설정으로는 최적화가 안 돼 있을 수 있어서, 일반 HLS가 있으면 그걸 우선하고 없으면
 * 아무거나(LLHLS 포함) 쓴다. */
export function pickLiveMediaPath(media: LivePlaybackMedia[] | undefined | null): string | null {
  if (!Array.isArray(media) || media.length === 0) return null;
  const normal = media.find((m) => m.mediaId !== "LLHLS" && m.path);
  if (normal) return normal.path as string;
  const any = media.find((m) => m.path);
  return any ? (any.path as string) : null;
}

/** 방송 중이 아니거나(status !== "OPEN") 재생 가능한 media가 없으면 null. 연령 제한
 * 방송이면 로그인 쿠키(nidAuth/nidSession)가 있어야 열람 가능한 경우가 있어서 같이 실어
 * 보낸다(VOD 쪽과 동일한 이유). */
export async function resolveLivePlayback(
  channelId: string,
  opts: ResolveLivePlaybackOptions = {}
): Promise<LivePlaybackInfo | null> {
  const client = opts.client || new ChzzkClient({ nidAuth: opts.nidAuth, nidSession: opts.nidSession });
  const detail = await client.live.detail(channelId);
  if (!detail || detail.status !== "OPEN") return null;
  const url = pickLiveMediaPath(detail.livePlayback?.media);
  if (!url) return null;
  return { url };
}
