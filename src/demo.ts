// 실제 방송 없이 analyzer/report 파이프라인이 잘 도는지 확인하기 위한 합성 데이터 데모.
// `npm run demo` 로 실행.
import { buildReport, renderMarkdown, saveReport } from "./report";
import { buildTimeline, buildUserTimeline } from "./timeline";
import { buildEditPoints, buildEditPointsCsv, CSV_BOM } from "./edit-points";
import { MotionTracker } from "./motion-detector";
import { fetchAllVodChats } from "./vod-chat";
import {
  extractVideoNo,
  parseChzzkDateTime,
  resolveVodStartedAt,
  buildVideoNotFoundMessage,
} from "./vod-analyzer";
import { decideVodPlayback, extractHlsPathFromRewindJson } from "./vod-playback";
import { pickLiveMediaPath } from "./live-playback";
import { pickBucketMs } from "./timeline";
import { DEFAULT_ANALYSIS_SETTINGS } from "./config";
import { ChzzkClient } from "chzzk";
import type { ChatMessage, BroadcastSession, CategoryEvent, RestEvent, VisionEvent } from "./types";

const NICKS = ["감자칩", "야옹이", "오늘도평화", "치킨헌터", "구운밤", "우주먼지", "라면킹"];
const SAMPLE_LINES = [
  "ㅋㅋㅋㅋㅋㅋ",
  "이거 실화냐 ㄷㄷ",
  "와 미쳤다",
  "오늘 방송 재밌다",
  "스킬 미쳤네 ㅋㅋ",
  "저거 왜 저럼",
  "화이팅!!",
  "다음 판 가자",
  "ㅋㅋㅋㅋ진짜웃기다",
  "떡상 가즈아",
  "오늘 컨디션 좋아보임",
  "저건 좀 아니지 않나",
  "치지직 화질 좋다",
  "다들 안녕하세요",
  "겜잘알 인정",
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMessages(sessionId: string, start: number, count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    // 중간 지점에 채팅이 몰리는 '하이라이트' 구간을 하나 만들어서 mood 분석이 잘 잡는지 확인
    const isPeak = i > count * 0.4 && i < count * 0.5;
    const gapMs = isPeak ? 500 : 4000;
    const nick = randomFrom(NICKS);
    messages.push({
      sessionId,
      userIdHash: `hash_${nick}`,
      nickname: nick,
      message: randomFrom(SAMPLE_LINES),
      timestamp: start + i * gapMs,
    });
  }
  // 후원 메시지도 몇 개 섞기
  messages.push({
    sessionId,
    userIdHash: "hash_구운밤",
    nickname: "구운밤",
    message: "방송 잘보고 있어요!",
    timestamp: start + 10_000,
    isDonation: true,
    donationAmount: 5000,
  });
  return messages;
}

async function main() {
  const start = Date.now() - 60 * 60 * 1000; // 1시간 전 방송 시작 가정
  const end = Date.now();
  const session: BroadcastSession = {
    sessionId: "demo-session",
    platform: "chzzk",
    channelId: "demo-channel",
    channelName: "데모BJ",
    startedAt: start,
    endedAt: end,
  };

  const messages = generateMessages(session.sessionId, start, 300);

  // 카테고리 이벤트를 리포트 생성 시점에도 같이 넘겨서, 새로 추가한 "방송 흐름 요약"
  // (게임중/대화중/휴식중 시간 분배)이 리포트 markdown에 실제로 채워지는지 확인한다.
  const events: CategoryEvent[] = [
    { time: start, categoryType: "GAME", categoryValue: "리그오브레전드" },
    { time: start + 25 * 60_000, categoryType: "TALK", categoryValue: "저스트채팅" },
  ];

  const report = await buildReport(session, messages, events);
  const md = renderMarkdown(report);

  console.log(md);

  const filePath = saveReport(report, "reports");
  console.log(`\n[demo] 리포트 파일 저장됨: ${filePath}`);

  // 타임라인 모듈도 같은 합성 데이터로 검증. 카테고리를 중간에 한 번 바꿔서
  // 게임중 -> 대화중 구간 분리가 되는지, 메시지가 끊기는 뒷부분이 휴식중으로
  // 잡히는지 확인한다.
  const timeline = buildTimeline(session, messages, events);
  const toMin = (ms: number) => Math.round((ms - start) / 60000);
  console.log("\n[demo] 타임라인 구간:");
  timeline.segments.forEach((s) => {
    console.log(
      `  ${s.type} (${s.label})${s.estimated ? " [추정]" : ""}: ${toMin(s.start)}분 ~ ${toMin(s.end)}분`
    );
  });
  console.log(
    "[demo] 하이라이트:",
    timeline.highlights.map((h) => `${h.label}=${h.detail}`).join(" / ")
  );
  const userTl = buildUserTimeline(messages, timeline.segments, "감자칩");
  if (userTl) {
    console.log(
      `[demo] '감자칩' 유저 타임라인: 총 ${userTl.totalMessages}회, 주활동 ${userTl.mainActivity}, 후원 ${userTl.donationAmount}원`
    );
  }

  // 방송 흐름 요약(활동 구간별 시간 분배)이 리포트에 잘 채워지는지, 카테고리 기반
  // activitySource가 정확히 표시되는지 확인한다.
  const categoryReport = await buildReport(session, messages, events);
  console.log("\n[demo] 카테고리 기반 리포트 — 활동 구간 요약:");
  console.log(
    `  activitySource=${categoryReport.activitySource}, ` +
      categoryReport.activityBreakdown.map((b) => `${b.type} ${b.minutes}분`).join(" · ")
  );
  console.log(
    "  게임별:",
    categoryReport.gameBreakdown.map((g) => `${g.label} ${g.minutes}분`).join(", ") || "(없음)"
  );
  console.log(
    `[demo] 시청자 참여 구조: TOP10 비중 ${categoryReport.engagement.topSharePct}%, ` +
      `1회 채팅 시청자 ${categoryReport.engagement.oneTimeChatterCount}명(${categoryReport.engagement.oneTimeChatterPct}%)`
  );
  console.log(
    "[demo] 후원-활동 교차:",
    categoryReport.donationInsight.byActivity.map((b) => `${b.type} ${b.amount}원`).join(" · ") || "(후원 없음)",
    `/ 후원왕-채팅왕 겹침 ${categoryReport.donationInsight.topDonatorsAlsoChatty}명`
  );
  console.log(
    "[demo] 하이라이트 발췌 개수:",
    categoryReport.highlightQuotes.length,
    categoryReport.highlightQuotes.map((h) => `${h.contextLabel}(${h.quotes.length}줄)`).join(", ")
  );

  // 화면 변화 감지 기반 휴식(RestEvent) 검증. 채팅은 이 구간에도 평소처럼 계속 오가게
  // 뒀다(=채팅량 기반 추정이었다면 절대 휴식으로 안 잡혔을 상황) - 그런데도 RestEvent가
  // 있으면 그쪽을 우선 써서 30~40분 구간이 휴식중으로 확정되는지 확인한다. 이게 바로
  // "채팅이 조용해야만 휴식으로 잡히는" 기존 방식의 한계를 보완하는 지점이다.
  const restEvents: RestEvent[] = [
    { time: start + 30 * 60_000, state: "rest_start" },
    { time: start + 40 * 60_000, state: "rest_end" },
  ];
  const restTimeline = buildTimeline(session, messages, events, [], restEvents);
  console.log(`\n[demo] 휴식 판단 근거(restSource): ${restTimeline.restSource}`);
  console.log("[demo] 화면 변화 감지 반영 타임라인 구간:");
  restTimeline.segments.forEach((s) => {
    console.log(
      `  ${s.type} (${s.label})${s.estimated ? " [추정]" : ""}: ${toMin(s.start)}분 ~ ${toMin(s.end)}분`
    );
  });

  // 편집점(edit-points.ts) 검증: restTimeline엔 30~40분 구간의 확정 휴식(RestEvent)과
  // 채팅 데이터에서 나온 하이라이트(채팅 폭발/후원 몰림)가 둘 다 있으니, 이 두 종류가 전부
  // 편집점 목록에 시간순으로 섞여 들어가는지, 휴식중은 방송 시작 기준 "30분~40분"이라는
  // 상대 시간(=VOD 타임코드)으로 정확히 변환되는지 확인한다.
  const editPoints = buildEditPoints(restTimeline);
  const restPoint = editPoints.find((p) => p.type === "rest");
  const editPointsOk =
    editPoints.length >= 2 && // 휴식 1개 + 하이라이트 최소 1개 이상
    !!restPoint &&
    restPoint.startMs === 30 * 60_000 &&
    restPoint.endMs === 40 * 60_000 &&
    editPoints.every((p, i) => i === 0 || editPoints[i - 1].startMs <= p.startMs); // 시간순 정렬
  console.log(`\n[demo] 편집점(edit-points.ts) 계산 결과: ${editPointsOk ? "OK" : "FAIL"}`);
  editPoints.forEach((p) => {
    const range = p.endMs !== undefined ? `${toMin(start + p.startMs)}~${toMin(start + p.endMs)}분` : `${toMin(start + p.startMs)}분`;
    console.log(`  [${p.label}] ${range} - ${p.detail}`);
  });

  const csv = buildEditPointsCsv(restTimeline);
  const csvLines = csv.split("\r\n").filter(Boolean);
  const csvOk =
    csv.charCodeAt(0) === 0xfeff && // 엑셀 한글 깨짐 방지 BOM
    csvLines[0] === CSV_BOM + "구분,시작,종료,길이(초),설명" &&
    csvLines.length === editPoints.length + 1; // 헤더 1줄 + 데이터
  console.log(`[demo] 편집점 CSV 형식(BOM/헤더/행 수) 확인: ${csvOk ? "OK" : "FAIL"}`);

  // 짧은(30초) 휴식이 방송 중간에 확정된 경우도 검증. 예전엔 cleanupSegments의 "60초 미만은
  // 잡음으로 버림" 필터가 휴식중에도 그대로 적용돼서, 이런 짧은 확정 휴식이 타임라인에서
  // 통째로 사라지고 앞뒤 게임중 구간에 흡수되는 버그가 있었다. 실제 자리비움은 보통 1분
  // 안팎이라 이 케이스가 오히려 더 흔하기 때문에 반드시 회귀로 남겨둔다.
  const shortRestEvents: RestEvent[] = [
    { time: start + 10 * 60_000, state: "rest_start" },
    { time: start + 10 * 60_000 + 30_000, state: "rest_end" }, // 30초 후 복귀
  ];
  const shortRestTimeline = buildTimeline(session, messages, events, [], shortRestEvents);
  const shortRestKept = shortRestTimeline.segments.some(
    (s) => s.type === "휴식중" && s.end - s.start === 30_000
  );
  console.log(
    `\n[demo] 30초짜리 중간 휴식이 안 사라지고 유지되는지: ${shortRestKept ? "OK" : "FAIL"}`
  );
  shortRestTimeline.segments.forEach((s) => {
    console.log(
      `  ${s.type} (${s.label})${s.estimated ? " [추정]" : ""}: ${toMin(s.start)}분 ~ ${toMin(s.end)}분`
    );
  });

  // motion-detector.ts의 순수 로직도 따로 검증: 평소엔 변화량이 들쭉날쭉하다가, 어느
  // 시점부터 화면이 딱 멈춘 것처럼(값이 거의 0) 몇 틱 이어지면 staticStreak이 쌓이면서
  // "휴식 의심" 문턱(collector.ts 기준 2틱)을 넘는지 확인한다.
  const tracker = new MotionTracker();
  const sampleDiffs = [12, 15, 9, 14, 11, 0.5, 0.4, 0.6, 0.3, 13, 10];
  console.log("\n[demo] MotionTracker 관찰 결과:");
  sampleDiffs.forEach((d) => {
    const obs = tracker.observe(d);
    console.log(
      `  diff=${d} -> isStatic=${obs.isStatic}, rollingAvg=${obs.rollingAvg.toFixed(
        1
      )}, staticStreak=${obs.staticStreak}`
    );
  });

  // AI 영상 분석(VisionEvent) 우선 적용 검증. 카테고리는 "리그오브레전드"로 잡혀 있어도,
  // 영상 분석 이벤트가 있으면 그쪽을 우선 써서 활동 구간을 나누고(activitySource=vision),
  // 게임 이름 라벨만은 모델에게 추측을 금지시켰기 때문에 카테고리에서 그대로 빌려오는지
  // 확인한다.
  const visionEvents: VisionEvent[] = [
    { time: start, activityType: "게임중", confidence: 0.9, screenState: "GAMEPLAY" },
    { time: start + 20 * 60_000, activityType: "대화중", confidence: 0.85, screenState: "CHAT" },
  ];
  // 이 검증은 "활동 종류 분류"만 확인하는 게 목적이라, 채팅이 뜸해지면 자동으로 휴식중
  // 처리되는 채팅량 폴백(quietRangesFromChatVolume)과 뒤섞이지 않도록 방송 내내 채팅이
  // 고르게 유지되는 별도의 메시지 세트를 쓴다 (기존 messages는 ~20분 지점부터 채팅이
  // 끊겨서, 그 폴백이 섞여 들어가면 이 테스트가 검증하려는 것과 다른 이유로 실패/통과할 수 있다).
  const denseMessages: ChatMessage[] = [];
  for (let t = start; t < end; t += 20_000) {
    denseMessages.push({
      sessionId: session.sessionId,
      userIdHash: "hash_감자칩",
      nickname: "감자칩",
      message: "ㅋㅋㅋ",
      timestamp: t,
    });
  }
  const visionTimeline = buildTimeline(session, denseMessages, events, visionEvents);
  const visionPriorityOk =
    visionTimeline.activitySource === "vision" &&
    visionTimeline.segments.some((s) => s.type === "게임중" && s.label === "리그오브레전드") &&
    visionTimeline.segments.some((s) => s.type === "대화중");
  console.log(`\n[demo] 영상 분석 결과가 카테고리보다 우선 적용되는지: ${visionPriorityOk ? "OK" : "FAIL"}`);

  // 먹방(EATING) 판별 검증. 게임 카테고리를 유지한 채로 화면 분석이 EATING을 감지하면
  // "휴식중" + 라벨 "먹방"으로 잡히고(estimated=true), restSource도 vision으로 표시되는지
  // 확인한다 — 게임 카테고리를 안 바꾼 채 식사 방송을 해도 계속 "게임중"으로 잘못 잡히던
  // 문제를 이 매핑으로 고쳤다.
  const eatingEvents: VisionEvent[] = [
    { time: start, activityType: "게임중", confidence: 0.9, screenState: "GAMEPLAY" },
    { time: start + 15 * 60_000, activityType: "휴식중", confidence: 0.88, screenState: "EATING" },
    { time: start + 25 * 60_000, activityType: "게임중", confidence: 0.9, screenState: "GAMEPLAY" },
  ];
  const eatingTimeline = buildTimeline(session, messages, events, eatingEvents);
  const eatingSeg = eatingTimeline.segments.find((s) => s.label === "먹방");
  const eatingOk =
    !!eatingSeg && eatingSeg.type === "휴식중" && eatingSeg.estimated === true && eatingTimeline.restSource === "vision";
  console.log(`[demo] 먹방(EATING) 영상 분석 결과가 휴식중으로 매핑되는지: ${eatingOk ? "OK" : "FAIL"}`);

  // vod-analyzer.ts의 URL/videoNo 추출 검증.
  const videoNoOk =
    extractVideoNo("https://chzzk.naver.com/video/14605416") === "14605416" &&
    extractVideoNo("14605416") === "14605416";
  console.log(`\n[demo] VOD URL에서 videoNo 추출: ${videoNoOk ? "OK" : "FAIL"}`);

  // vod-analyzer.ts의 방송 시작 시각 결정 로직 검증. 실제로 사용자가 겪은 버그를 그대로
  // 재현한다: 사용자가 실제 VOD(videoNo=14617905)로 브라우저에서 확인해준 API 응답 값을
  // 그대로 써서, liveOpenDate가 있으면 그걸 써야지 publishDateAt(다시보기 게시 시각 — 방송이
  // 끝난 뒤 값이라 훨씬 늦음)을 쓰면 안 된다는 걸 확인한다.
  const realBugVideo = { liveOpenDate: "2026-08-09 17:38:14", publishDateAt: 1786290471303 };
  const realBugDurationMs = Math.round(25371.719 * 1000);
  const resolvedStart = resolveVodStartedAt(realBugVideo, realBugDurationMs);
  const expectedStart = new Date(2026, 7, 9, 17, 38, 14).getTime();
  const startedAtOk =
    resolvedStart === expectedStart && // liveOpenDate로 정확히 파싱돼야 한다
    resolvedStart !== realBugVideo.publishDateAt && // 예전 버그처럼 publishDateAt을 쓰면 안 된다
    resolvedStart < realBugVideo.publishDateAt && // 방송 시작은 다시보기 게시 시각보다 항상 이전이어야 한다
    resolveVodStartedAt({ publishDateAt: 555 }, 1000) === 555 && // liveOpenDate 없으면 publishDateAt로 대체
    resolveVodStartedAt({}, 1000) > 0 && // 둘 다 없으면 "지금-길이"로라도 값이 나와야 함
    parseChzzkDateTime(undefined) === null &&
    parseChzzkDateTime("이상한 값") === null;
  console.log(
    `[demo] VOD 방송 시작 시각 결정(liveOpenDate 우선, publishDateAt 오사용 방지): ${startedAtOk ? "OK" : "FAIL"}`
  );

  // vod-chat.ts 페이지네이션 검증. 실제 chzzk API를 부르는 대신, 브라우저 개발자도구에서 관찰한
  // 응답 형태를 그대로 흉내낸 가짜 client.fetch()로 3페이지짜리 대화를 순회시켜본다.
  // 확인하는 것: (1) 여러 페이지에 걸친 채팅이 시간순으로 전부 모이는지, (2) extras의
  // payAmount로 후원이 제대로 감지되는지, (3) nextPlayerMessageTime이 영상 길이를 넘어서면
  // (=마지막 페이지) 루프가 멈추는지 — 셋 다 이 환경에서 실제 API로는 검증 못 했던 부분이라
  // 로직만이라도 회귀로 남겨둔다.
  const vodStart = Date.now() - 24 * 60 * 60 * 1000;
  const vodDurationMs = 600_000; // 10분짜리 가짜 영상
  const fakeProfile = (userIdHash: string, nickname: string) => JSON.stringify({ userIdHash, nickname });
  const vodPages: Record<number, unknown> = {
    0: {
      content: {
        nextPlayerMessageTime: 200_000,
        previousVideoChats: [
          { content: "첫 채팅", profile: fakeProfile("u1", "닉네임1"), userIdHash: "u1", messageTime: vodStart + 50_000, playerMessageTime: 50_000 },
          { content: "두 번째 채팅", profile: fakeProfile("u2", "닉네임2"), userIdHash: "u2", messageTime: vodStart + 150_000, playerMessageTime: 150_000 },
        ],
        videoChats: [],
      },
    },
    200_000: {
      content: {
        nextPlayerMessageTime: 500_000,
        previousVideoChats: [
          {
            content: "후원 감사합니다",
            profile: fakeProfile("u3", "후원자"),
            userIdHash: "u3",
            messageTime: vodStart + 300_000,
            playerMessageTime: 300_000,
            extras: JSON.stringify({ payAmount: 5000 }),
          },
          { content: "세 번째 채팅", profile: fakeProfile("u1", "닉네임1"), userIdHash: "u1", messageTime: vodStart + 450_000, playerMessageTime: 450_000 },
        ],
        videoChats: [],
      },
    },
    500_000: {
      content: {
        // 영상 길이(600_000)를 60초 넘게 넘어서는 값 -> 이번이 마지막 페이지여야 한다.
        nextPlayerMessageTime: 700_000,
        previousVideoChats: [
          { content: "마지막 채팅", profile: fakeProfile("u2", "닉네임2"), userIdHash: "u2", messageTime: vodStart + 550_000, playerMessageTime: 550_000 },
        ],
        videoChats: [],
      },
    },
  };

  let vodFetchCallCount = 0;
  const fakeClient = new ChzzkClient();
  (fakeClient as any).fetch = async (pathOrUrl: string) => {
    vodFetchCallCount++;
    const m = pathOrUrl.match(/playerMessageTime=(\d+)/);
    const cursor = m ? Number(m[1]) : -1;
    if (!(cursor in vodPages)) {
      throw new Error(`예상치 못한 playerMessageTime으로 호출됨: ${cursor} (페이지네이션 종료 조건에 버그가 있을 수 있음)`);
    }
    return { json: async () => vodPages[cursor] } as Response;
  };

  const vodMessages = await fetchAllVodChats(fakeClient, {
    videoNo: 14605416,
    sessionId: "vod-demo",
    videoStartMs: vodStart,
    videoDurationMs: vodDurationMs,
  });
  const vodDonation = vodMessages.find((m) => m.isDonation);
  const vodOk =
    vodFetchCallCount === 3 && // 딱 3페이지에서 멈춰야 함 (더 호출되면 종료 조건 버그)
    vodMessages.length === 5 &&
    vodMessages.every((m, i) => i === 0 || vodMessages[i - 1].timestamp <= m.timestamp) && // 시간순 정렬
    !!vodDonation &&
    vodDonation.donationAmount === 5000;
  console.log(
    `[demo] VOD 채팅 페이지네이션(3페이지, 후원 감지, 종료 조건): ${vodOk ? "OK" : "FAIL"} ` +
      `(호출 ${vodFetchCallCount}회, 메시지 ${vodMessages.length}개)`
  );

  // vod-playback.ts 검증. 실제 chzzk API를 부르지 않고, yt-dlp의 CHZZKVideoIE가 실제로
  // 관찰해서 검증해둔 두 가지 케이스(ABR_HLS/DASH 방식, liveRewindPlaybackJson/HLS 방식) 형태를
  // 그대로 흉내낸 메타데이터로 URL 조합 로직만 검증한다.
  const dashResult = decideVodPlayback({
    videoId: "abcd1234",
    inKey: "sample-in-key",
    vodStatus: "ABR_HLS",
  });
  const dashOk =
    !!dashResult &&
    dashResult.type === "dash" &&
    dashResult.url.startsWith("https://apis.naver.com/neonplayer/vodplay/v1/playback/abcd1234?") &&
    dashResult.url.includes("key=sample-in-key");

  const hlsResult = decideVodPlayback({
    videoId: "abcd1234",
    vodStatus: "NONE",
    liveRewindPlaybackJson: JSON.stringify({
      media: [{ path: "https://example-cdn.chzzk.naver.com/fake/playlist.m3u8" }],
    }),
  });
  const hlsOk =
    !!hlsResult && hlsResult.type === "hls" && hlsResult.url === "https://example-cdn.chzzk.naver.com/fake/playlist.m3u8";

  const emptyOk =
    decideVodPlayback({}) === null && // videoId조차 없으면 null
    decideVodPlayback({ videoId: "x", vodStatus: "NONE" }) === null && // liveRewindPlaybackJson도 없으면 null
    extractHlsPathFromRewindJson(undefined) === null &&
    extractHlsPathFromRewindJson("이상한 JSON 아님") === null; // 파싱 실패해도 죽지 않고 null

  console.log(
    `[demo] VOD 재생 URL 결정(ABR_HLS→DASH / liveRewindPlaybackJson→HLS): ${
      dashOk && hlsOk && emptyOk ? "OK" : "FAIL"
    }`
  );

  // live-playback.ts 검증. media 배열에서 LLHLS(초저지연)보다 일반 HLS를 우선 고르는지,
  // 일반 HLS가 없으면 LLHLS라도 쓰는지, 빈/잘못된 입력엔 안전하게 null을 돌려주는지 확인한다.
  const liveMediaOk =
    pickLiveMediaPath([
      { mediaId: "LLHLS", path: "https://example-cdn.chzzk.naver.com/ll.m3u8" },
      { mediaId: "HLS", path: "https://example-cdn.chzzk.naver.com/normal.m3u8" },
    ]) === "https://example-cdn.chzzk.naver.com/normal.m3u8" && // 일반 HLS 우선
    pickLiveMediaPath([{ mediaId: "LLHLS", path: "https://example-cdn.chzzk.naver.com/ll.m3u8" }]) ===
      "https://example-cdn.chzzk.naver.com/ll.m3u8" && // 일반 HLS가 없으면 LLHLS라도 사용
    pickLiveMediaPath([]) === null &&
    pickLiveMediaPath(undefined) === null &&
    pickLiveMediaPath([{ mediaId: "HLS" }]) === null; // path 없는 항목은 무시
  console.log(`[demo] 라이브 재생 미디어 선택(일반 HLS 우선, LLHLS 대체): ${liveMediaOk ? "OK" : "FAIL"}`);

  // 로그인 쿠키 유무에 따라 "영상 정보를 찾을 수 없습니다" 에러 메시지가 달라지는지 확인.
  // 쿠키가 있는데도 실패했다면 만료를 의심하도록 안내하고, 쿠키가 아예 없었다면 로그인을
  // 권하는 메시지를 보여줘야 한다.
  const errMsgOk =
    buildVideoNotFoundMessage(true).includes("만료") &&
    !buildVideoNotFoundMessage(false).includes("만료") &&
    buildVideoNotFoundMessage(false).includes("로그인");
  console.log(`[demo] 영상 조회 실패 시 로그인 만료/필요 안내 메시지 분기: ${errMsgOk ? "OK" : "FAIL"}`);

  // "고급 설정"으로 노출한 값들이 실제로 로직에 반영되는지 확인. 기본값(민감하지 않음)으로는
  // 정적으로 안 잡히던 diff가, 민감도를 세게 낮추면(relativeFactor를 크게) 정적으로 잡혀야
  // 하고, absFloor를 아주 높게 잡으면 반대로 어지간한 diff는 다 무시(정적 아님)돼야 한다.
  const defaultTracker = new MotionTracker();
  defaultTracker.observe(20); // 기준선(rollingAvg)을 20 근처로 확보
  const defaultObs = defaultTracker.observe(10); // 기본(relativeFactor=0.25) 기준으로는 정적이 아님

  const sensitiveTracker = new MotionTracker({ relativeFactor: 0.9 }); // 훨씬 민감하게(=쉽게 "정적"으로 봄)
  sensitiveTracker.observe(20);
  const sensitiveObs = sensitiveTracker.observe(10); // 평균(20)의 90% = 18 미만이면 정적 -> 10은 정적

  const insensitiveTracker = new MotionTracker({ absFloor: 100 }); // 노이즈 무시 최소값을 극단적으로 높임
  const insensitiveObs = insensitiveTracker.observe(50); // 첫 샘플이라 threshold = max(100, 50*0.25) = 100 -> 50 < 100 이라 정적

  const motionOptionsOk = !defaultObs.isStatic && sensitiveObs.isStatic && insensitiveObs.isStatic;
  console.log(`[demo] 휴식 감지 민감도(고급 설정: motionAbsFloor/motionRelativeFactor) 반영: ${motionOptionsOk ? "OK" : "FAIL"}`);

  // 타임라인 쪽 고급 설정(timelineMinSegmentMs/timelineQuietMinBuckets)도 실제로 결과에
  // 영향을 주는지 확인. 기본 60초 최소 구간 길이로는 걸러질 만큼 짧은 카테고리 변경을
  // minSegmentMs를 0으로 낮추면 안 걸러지고 그대로 남아야 한다.
  const tlSession: BroadcastSession = {
    sessionId: "adv-settings-test",
    platform: "chzzk",
    channelId: "c1",
    channelName: "테스트",
    startedAt: 0,
    endedAt: 5 * 60_000,
  };
  const tlEvents: CategoryEvent[] = [
    { time: 0, categoryType: "GAME", categoryValue: "게임A" },
    { time: 60_000, categoryType: "GAME", categoryValue: "게임B" }, // 10초 뒤 다시 바뀜 -> 아주 짧은 조각
    { time: 70_000, categoryType: "GAME", categoryValue: "게임A" },
  ];
  // 채팅을 골고루 채워서(버킷마다 비슷한 양) "채팅이 전부 0이라 전체가 휴식중으로 덮이는"
  // 경우를 피한다 - 순수하게 카테고리 구간 병합/유지 로직만 확인하기 위함.
  const tlMessages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
    sessionId: "adv-settings-test",
    userIdHash: `u${i}`,
    nickname: `유저${i}`,
    message: "안녕하세요",
    timestamp: i * 15_000,
  }));
  const tlDefault = buildTimeline(tlSession, tlMessages, tlEvents);
  const tlNoMinLength = buildTimeline(tlSession, tlMessages, tlEvents, [], [], { minSegmentMs: 0 });
  const timelineOptionsOk =
    tlDefault.segments.length < tlNoMinLength.segments.length || // 기본값은 짧은 조각을 병합해서 구간 수가 더 적어야 함
    tlNoMinLength.segments.some((s) => s.label === "게임B"); // minSegmentMs=0이면 짧은 "게임B" 조각이 살아남아야 함
  console.log(`[demo] 타임라인 고급 설정(timelineMinSegmentMs) 반영: ${timelineOptionsOk ? "OK" : "FAIL"}`);

  // pickBucketMs가 커스텀 base bucket(고급 설정의 timelineBucketMs)을 기준으로 자동 확대하는지.
  const bucketDefaultOk = pickBucketMs(30 * 60_000) === 60_000; // 30분 방송, 기본 1분 버킷 -> 그대로 1분
  const bucketCustomBaseOk = pickBucketMs(30 * 60_000, 30_000) === 30_000; // base를 30초로 낮추면 그대로 30초 유지
  console.log(`[demo] 타임라인 버킷 크기 커스텀 기준값(timelineBucketMs) 반영: ${bucketDefaultOk && bucketCustomBaseOk ? "OK" : "FAIL"}`);

  // DEFAULT_ANALYSIS_SETTINGS가 예전 하드코딩 값들과 정확히 일치하는지(회귀 방지) 확인.
  const defaultsOk =
    DEFAULT_ANALYSIS_SETTINGS.statusPollMs === 30_000 &&
    DEFAULT_ANALYSIS_SETTINGS.frameIntervalMs === 90_000 &&
    DEFAULT_ANALYSIS_SETTINGS.visionConfidenceThreshold === 0.75 &&
    DEFAULT_ANALYSIS_SETTINGS.visionConfirmCount === 2 &&
    DEFAULT_ANALYSIS_SETTINGS.restCheckIntervalMs === 10_000 &&
    DEFAULT_ANALYSIS_SETTINGS.restBurstSamples === 5 &&
    DEFAULT_ANALYSIS_SETTINGS.motionRelativeFactor === 0.25 &&
    DEFAULT_ANALYSIS_SETTINGS.timelineBucketMs === 60_000 &&
    DEFAULT_ANALYSIS_SETTINGS.moodMaxSampleMessages === 200;
  console.log(`[demo] DEFAULT_ANALYSIS_SETTINGS 값이 예전 하드코딩 기본값과 일치: ${defaultsOk ? "OK" : "FAIL"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
