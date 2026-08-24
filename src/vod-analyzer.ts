// 다시보기(VOD) 영상 하나를 분석해서, 실시간 감시(collector.ts)와 똑같은 형태의 리포트/
// 타임라인/편집점을 만들어내는 "한 번 실행하면 끝나는" 배치 작업.
//
// collector.ts의 ChannelWatcher는 "채널을 계속 지켜보는" 상주형이라 즐겨찾기 토글과 잘
// 어울리지만, VOD 분석은 영상 하나 주면 끝까지 처리하고 끝나는 일회성 작업이라 토글이라는
// 개념 자체가 안 맞는다. 그래서 별도 클래스로 뒀다 — 다만 결과물(SessionReport, TimelineData,
// 편집점 CSV)은 완전히 같은 형태라 report.ts/timeline.ts/edit-points.ts를 그대로 재사용한다.
//
// 게임중/대화중 구분은 카테고리(스트리머 자진 신고) + 채팅량 추정을 쓴다. 화면 변화 감지 기반
// "자리비움"(motion-detector.ts)은 연속적인 프레임 비교가 필요해서 이 배치 방식과 궁합이 안
// 맞아 VOD에서는 지원하지 않는다 — 대신 timeline.ts가 이미 갖고 있는 "채팅량이 잠잠해지면
// 휴식으로 추정" 폴백이 그 자리를 대신한다.
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { ChzzkClient } from "chzzk";
import { buildReport, saveReport, renderMarkdown } from "./report";
import { buildTimeline, buildUserTimeline } from "./timeline";
import { saveEditPointsCsv } from "./edit-points";
import { fetchAllVodChats } from "./vod-chat";
import { resolveVodPlayback } from "./vod-playback";
import {
  isFfmpegAvailable,
  captureVodFrameSequence,
  classifyImageBuffer,
  activityTypeForScreenState,
} from "./frame-classifier";
import { getAnthropicApiKey, DEFAULT_ANALYSIS_SETTINGS } from "./config";
import type {
  ActivityType,
  BroadcastSession,
  CategoryEvent,
  ChatMessage,
  SessionReport,
  TimelineData,
  UserTimeline,
  VisionEvent,
} from "./types";

export type VodLogTag = "INFO" | "WARN" | "ERROR";

export interface VodLogEntry {
  time: string;
  tag: VodLogTag;
  text: string;
}

export interface VodProgress {
  phase: "video" | "chat" | "report" | "vision";
  fetchedCount: number;
  percent: number; // 0~100 대략치
}

export interface VodAnalysisResult {
  session: BroadcastSession;
  videoTitle: string;
  filePath: string;
  markdown: string;
  report: SessionReport;
  timeline: TimelineData;
  editPointsPath: string | null;
}

export interface VodAnalyzeOptions {
  videoNo: string | number;
  reportDir?: string;
  // chzzk.naver.com 로그인 쿠키. VOD 메타데이터 조회(/service/v1/videos/{videoNo})는 로그인
  // 없이는 content가 빈 값으로 오는 경우가 있어서(실제로 확인됨 — exposure:true인 공개
  // 영상인데도 로그인 없이는 조회가 막힘), 이 값이 없으면 "영상 정보를 찾을 수 없습니다"
  // 에러가 날 수 있다.
  nidAuth?: string;
  nidSession?: string;
  timelineBucketMs?: number;
  timelineMinSegmentMs?: number;
  timelineQuietMinBuckets?: number;
  /** "정밀분석"(화면 분석)에 쓰는 성긴 분류 간격(ms). 촘촘한 캡처 간격은 이 값을 기준으로
   * 자동 계산된다 (runVisionOnly 참고). */
  frameIntervalMs?: number;
  visionConfidenceThreshold?: number;
  visionConfirmCount?: number;
}

function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** chzzk API가 "YYYY-MM-DD HH:mm:ss" 형태 문자열로 주는 날짜(예: liveOpenDate)를 epoch ms로
 * 바꾼다. new Date("YYYY-MM-DD HH:mm:ss")로 바로 파싱하지 않는 이유는, 이 형식이 정식
 * ISO 8601이 아니라서 엔진에 따라 해석이 갈릴 수 있기 때문 — 직접 숫자를 뽑아
 * new Date(y, m, d, h, mi, s)로 만들면(로컬 시간 기준, 이 값들은 한국 시각 그대로 온다는
 * 전제) 어떤 환경에서도 같은 결과가 나온다. */
export function parseChzzkDateTime(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 영상 메타데이터 조회(client.video())가 null을 반환했을 때 보여줄 에러 메시지를 결정한다.
 * 로그인 쿠키를 이미 넘긴 상태에서도 실패했다면, 영상이 진짜로 없다기보다 저장해둔
 * NID_AUT/NID_SES가 만료됐을 확률이 훨씬 높다(실제로 확인된 케이스 — v1 videos 엔드포인트는
 * 공개 영상이어도 로그인 없이는 content가 빈 값으로 오는 경우가 있다). 반대로 쿠키 자체가
 * 없었다면 원래부터 로그인이 필요했을 가능성을 안내한다. */
export function buildVideoNotFoundMessage(hasAuth: boolean): string {
  return hasAuth
    ? "영상 정보를 찾을 수 없습니다. chzzk 로그인이 만료됐을 수 있습니다 — 설정에서 로그아웃 후 다시 로그인해주세요."
    : "영상 정보를 찾을 수 없습니다. 다시보기 URL/영상 번호를 확인하거나, 설정에서 chzzk 로그인을 해주세요.";
}

/** 방송 시작 시각 결정 우선순위: liveOpenDate(실제 방송을 시작한 시각) > publishDateAt
 * (다시보기가 "게시"된 시각 — 방송이 끝나고 처리가 완료된 뒤에 찍히는 값이라 시작 시각
 * 대용으로 쓰면 안 된다. 실제로 이걸 몰라서 방송이 실제보다 길이만큼 뒤로 밀려 보이는 버그를
 * 겪었다) > 그마저 없으면 "지금 - 영상 길이"로 대략 추정. */
export function resolveVodStartedAt(
  video: { liveOpenDate?: string; publishDateAt?: number },
  durationMs: number
): number {
  return parseChzzkDateTime(video.liveOpenDate) ?? video.publishDateAt ?? Date.now() - durationMs;
}

export class VodAnalyzer extends EventEmitter {
  private client: ChzzkClient;
  private videoNo: string | number;
  private reportDir: string;
  // 로그인 쿠키를 넘겨받았는지 여부. 영상 조회가 실패했을 때 에러 메시지를 다르게 하기 위함
  // (로그인은 돼 있는데 실패했다면 "영상이 없다"보다 "로그인이 만료됐을 가능성"이 훨씬 크다 —
  // 실제로 이 경우가 대부분 만료된 NID_AUT/NID_SES 쿠키 때문이었다).
  private hasAuth: boolean;
  // GUI의 타임라인 탭(구간/유저 지정/특정 시간대 채팅 조회)이 실시간 감시와 똑같이 동작하려면
  // ChannelWatcher.getTimeline()/getUserTimeline()/getMessagesInRange()와 같은 조회 메서드가
  // 필요하다. ChannelWatcher는 Store(파일)에서 다시 읽어오지만, VOD는 한 번 다 모은 뒤로는
  // 바뀔 일이 없는 데이터라 굳이 파일에 왕복하지 않고 메모리에 들고 있다가 그대로 응답한다.
  private session: BroadcastSession | null = null;
  private messages: ChatMessage[] = [];
  private categoryEvents: CategoryEvent[] = [];
  private videoTitle = "";
  private timelineBucketMs?: number;
  private timelineMinSegmentMs?: number;
  private timelineQuietMinBuckets?: number;
  private nidAuth?: string;
  private nidSession?: string;
  private frameIntervalMs: number;
  private visionConfidenceThreshold: number;
  private visionConfirmCount: number;
  // "정밀분석"(화면 분석, 선택 기능) 상태. run()은 이제 이 이벤트를 자동으로 채우지 않고,
  // runVisionOnly()가 별도로 호출됐을 때만 채워진다.
  private visionEvents: VisionEvent[] = [];
  private visionRunning = false;
  private visionDone = false;
  private visionCancelRequested = false;
  private visionChildProcess: ChildProcess | null = null;
  private visionCallCount = 0;
  private visionEstimatedCostUsd = 0;

  constructor(opts: VodAnalyzeOptions) {
    super();
    this.client = new ChzzkClient({
      nidAuth: opts.nidAuth,
      nidSession: opts.nidSession,
    });
    this.videoNo = opts.videoNo;
    this.reportDir = opts.reportDir ?? "reports";
    this.hasAuth = !!(opts.nidAuth && opts.nidSession);
    this.timelineBucketMs = opts.timelineBucketMs;
    this.timelineMinSegmentMs = opts.timelineMinSegmentMs;
    this.timelineQuietMinBuckets = opts.timelineQuietMinBuckets;
    this.nidAuth = opts.nidAuth;
    this.nidSession = opts.nidSession;
    this.frameIntervalMs = opts.frameIntervalMs ?? DEFAULT_ANALYSIS_SETTINGS.frameIntervalMs;
    this.visionConfidenceThreshold =
      opts.visionConfidenceThreshold ?? DEFAULT_ANALYSIS_SETTINGS.visionConfidenceThreshold;
    this.visionConfirmCount = opts.visionConfirmCount ?? DEFAULT_ANALYSIS_SETTINGS.visionConfirmCount;
  }

  get isVisionRunning(): boolean {
    return this.visionRunning;
  }

  get isVisionDone(): boolean {
    return this.visionDone;
  }

  /** AI 화면 분석 상태/비용 배지(GUI 상단)용. VOD도 라이브와 같은 형태로 값을 돌려준다. */
  getVisionStats() {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) return { enabled: false, callCount: 0, estimatedCostUsd: 0, reason: "API 키 없음" };
    if (!isFfmpegAvailable()) return { enabled: false, callCount: 0, estimatedCostUsd: 0, reason: "ffmpeg 없음" };
    return { enabled: true, callCount: this.visionCallCount, estimatedCostUsd: this.visionEstimatedCostUsd };
  }

  private buildTimelineOpts() {
    return {
      bucketMs: this.timelineBucketMs,
      minSegmentMs: this.timelineMinSegmentMs,
      quietMinBuckets: this.timelineQuietMinBuckets,
    };
  }

  /** 타임라인 탭용. 실시간 감시(ChannelWatcher.getTimeline)와 동일한 시그니처. */
  getTimeline(): TimelineData | null {
    if (!this.session) return null;
    return buildTimeline(
      this.session,
      this.messages,
      this.categoryEvents,
      this.visionEvents,
      [],
      this.buildTimelineOpts()
    );
  }

  /** "유저 지정" 칩/채팅왕 행 클릭 시 호출됨. */
  getUserTimeline(nickname: string): UserTimeline | null {
    if (!this.session) return null;
    const timeline = buildTimeline(
      this.session,
      this.messages,
      this.categoryEvents,
      this.visionEvents,
      [],
      this.buildTimelineOpts()
    );
    return buildUserTimeline(this.messages, timeline.segments, nickname);
  }

  /** 타임라인에서 특정 구간/막대를 선택했을 때, 그 시간대 채팅 로그 조회. */
  getMessagesInRange(startMs: number, endMs: number): ChatMessage[] {
    return this.messages.filter((m) => m.timestamp >= startMs && m.timestamp < endMs);
  }

  private log(tag: VodLogTag, text: string) {
    const entry: VodLogEntry = { time: formatTime(), tag, text };
    this.emit("log", entry);
  }

  async run(): Promise<VodAnalysisResult> {
    this.log("INFO", `영상 정보를 조회합니다 (videoNo=${this.videoNo})...`);
    this.emit("progress", { phase: "video", fetchedCount: 0, percent: 0 } as VodProgress);

    const video = await this.client.video(this.videoNo);
    if (!video) {
      throw new Error(buildVideoNotFoundMessage(this.hasAuth));
    }

    const channelName = video.channel?.channelName ?? String(this.videoNo);
    // chzzk API의 duration은 초 단위로 알려져 있어서 ms로 환산한다. 방송 시작 시각은
    // resolveVodStartedAt()이 liveOpenDate를 우선 쓴다(그 이유는 함수 주석 참고 — 예전엔
    // publishDateAt을 잘못 써서 방송이 실제보다 길이만큼 뒤로 밀려 보이는 버그가 있었다).
    const durationMs = Math.max(0, Math.round((video.duration ?? 0) * 1000));
    const startedAt = resolveVodStartedAt(video, durationMs);
    const endedAt = startedAt + durationMs;

    const sessionId = `vod-${this.videoNo}`;
    const session: BroadcastSession = {
      sessionId,
      platform: "chzzk",
      channelId: video.channel?.channelId ?? String(this.videoNo),
      channelName,
      startedAt,
      endedAt,
    };
    this.session = session;

    this.log("INFO", `"${video.videoTitle}" (${channelName}) 채팅을 수집합니다...`);
    const messages = await fetchAllVodChats(this.client, {
      videoNo: this.videoNo,
      sessionId,
      videoStartMs: startedAt,
      videoDurationMs: durationMs,
      onProgress: (count, cursorMs, totalMs) => {
        const percent = totalMs > 0 ? Math.min(100, Math.round((cursorMs / totalMs) * 100)) : 0;
        this.emit("progress", { phase: "chat", fetchedCount: count, percent } as VodProgress);
      },
    });
    this.log("INFO", `채팅 ${messages.length.toLocaleString()}개 수집 완료.`);
    this.messages = messages;

    // 영상 카테고리는 방송 중간에 바뀔 수 있지만(실시간 감시는 30초마다 폴링해서 변화를
    // 잡아내는데, VOD 메타데이터엔 시점별 이력이 없이 대표 카테고리 하나만 있음) 어쩔 수 없이
    // 영상 전체에 카테고리 하나만 적용한다. 여러 게임을 넘나든 방송이면 정확도가 떨어질 수
    // 있다는 뜻 — 이 경우 채팅량 기반 활동 추정이 어차피 병행되니 크게 어긋나진 않는다.
    const categoryEvents: CategoryEvent[] =
      video.categoryType && video.videoCategoryValue
        ? [{ time: startedAt, categoryType: video.categoryType, categoryValue: video.videoCategoryValue }]
        : [];
    this.categoryEvents = categoryEvents;
    this.videoTitle = video.videoTitle;

    this.emit("progress", { phase: "report", fetchedCount: messages.length, percent: 100 } as VodProgress);
    const result = await this.buildAndSaveResult();
    this.emit("done", result);
    return result;
  }

  private async buildAndSaveResult(): Promise<VodAnalysisResult> {
    const session = this.session!;
    const report = await buildReport(session, this.messages, this.categoryEvents, this.visionEvents, [], {
      timelineBucketMs: this.timelineBucketMs,
      timelineMinSegmentMs: this.timelineMinSegmentMs,
      timelineQuietMinBuckets: this.timelineQuietMinBuckets,
    });
    const filePath = saveReport(report, this.reportDir);
    const markdown = renderMarkdown(report);

    const timeline = buildTimeline(
      session,
      this.messages,
      this.categoryEvents,
      this.visionEvents,
      [],
      this.buildTimelineOpts()
    );
    const editPointsPath = saveEditPointsCsv(session, timeline, this.reportDir);

    this.log("INFO", `리포트 생성 완료: ${filePath}`);
    if (editPointsPath) this.log("INFO", `편집점 목록 저장 완료: ${editPointsPath}`);

    return {
      session,
      videoTitle: this.videoTitle,
      filePath,
      markdown,
      report,
      timeline,
      editPointsPath,
    };
  }

  // ================================================================================
  // ---- "정밀분석"(화면 분석, 선택 기능) — run()과 완전히 분리된 옵트인 작업 ----
  // ================================================================================
  //
  // 기본 run()은 채팅+카테고리만으로 빠르게 끝난다. 이 메서드는 VOD 카드의 "정밀분석" 버튼을
  // 눌렀을 때만 별도로 실행되고, 실제 화면을 캡처해서 Claude 비전 API로 게임중/대화중/
  // 휴식중(먹방 포함)을 다시 판단한 뒤 같은 리포트/타임라인/편집점 CSV 파일을 덮어쓴다.
  //
  // 동작 방식(라이브와 다름 — VOD는 "지금 이 순간"이 없고 영상 전체가 이미 존재한다):
  //  - 캡처는 촘촘한 간격(fine, 기본 15초 이상)으로 영상을 처음부터 끝까지 "한 번만" 순차로
  //    읽으면서 다 뽑아둔다(captureVodFrameSequence, frame-classifier.ts). 프레임마다 개별
  //    시킹하면 이 CDN 기준 오프셋에 비례해서 느려지는 문제가 있어서(총 처리 시간이 영상
  //    길이의 제곱에 가깝게 느려짐), 한 번의 순차 읽기로 바꿨다.
  //  - Claude 분류는 훨씬 성긴 간격(sparse, 고급 설정의 frameIntervalMs, 기본 90초)으로 먼저
  //    훑고, 인접한 두 성긴 샘플의 판정이 서로 다를 때만 그 사이 이미 캡처해둔 촘촘한 프레임
  //    들을 추가로 Claude에게 물어봐서 정확한 전환 지점을 찾는다(재시킹 없이 — 이미 캡처돼
  //    있으니까). 정확도는 촘촘한 간격 수준으로 유지하면서 API 호출 수는 크게 줄어든다.
  //  - 지나치게 긴 영상에서 프레임 수가 무한정 늘어나지 않도록, 성긴 샘플 수 상한과 촘촘한
  //    캡처 프레임 수 상한을 각각 두고 넘으면 간격을 자동으로 넓힌다.

  private static readonly MIN_FINE_INTERVAL_MS = 15_000;
  private static readonly SPARSE_SUBDIVISION = 6;
  private static readonly MAX_FINE_FRAMES = 2000; // 디스크 보호용 상한
  private static readonly MAX_SPARSE_SAMPLES = 300;

  /** "정밀분석" 버튼용 진입점. 기본 분석(run())이 이미 끝난 뒤(채팅/세션 정보가 있는 상태)에만
   * 호출 가능하다. 완료되면 같은 리포트/타임라인/편집점 CSV를 화면 분석 결과로 덮어쓴다. */
  async runVisionOnly(): Promise<VodAnalysisResult> {
    if (!this.session) {
      throw new Error("기본 분석이 먼저 끝나야 정밀분석을 실행할 수 있습니다.");
    }
    if (this.visionRunning) {
      throw new Error("이미 정밀분석이 진행 중입니다.");
    }
    // "정밀분석 다시 하기"를 대비해, 재실행 전에 이전 실행의 이벤트를 비워둔다 — 안 비우면
    // 같은 상태 전환이 타임라인에 중복으로 기록된다. 도중에 취소되면 아래 catch에서
    // 이전(완결된) 결과로 복원한다.
    const previousVisionEvents = this.visionEvents;
    this.visionEvents = [];
    this.visionRunning = true;
    this.visionCancelRequested = false;
    this.visionCallCount = 0;
    this.visionEstimatedCostUsd = 0;

    try {
      const events = await this.runVisionAnalysis();
      if (this.visionCancelRequested) {
        // 취소된 실행 결과는 버리고 이전 결과를 그대로 유지한다.
        this.visionEvents = previousVisionEvents;
        this.visionRunning = false;
        throw new Error("정밀분석이 취소되었습니다.");
      }
      this.visionEvents = events;
      this.visionRunning = false;
      this.visionDone = true;
      const result = await this.buildAndSaveResult();
      this.emit("done", result);
      return result;
    } catch (err) {
      this.visionRunning = false;
      if (!this.visionCancelRequested) this.visionEvents = previousVisionEvents;
      throw err;
    } finally {
      this.visionChildProcess = null;
    }
  }

  /** 정밀분석 진행 중(ffmpeg 캡처/Claude 호출 루프)에 실제로 중단시킨다. Windows는 부모가
   * 죽어도 자식 ffmpeg 프로세스가 안 죽어서, 캡처 중이던 자식 프로세스를 직접 SIGKILL한다.
   * 분석이 돌고 있지 않을 때 불러도 안전하다(아무 일도 안 함). */
  cancelVision(): void {
    this.visionCancelRequested = true;
    this.visionChildProcess?.kill("SIGKILL");
  }

  private async runVisionAnalysis(): Promise<VisionEvent[]> {
    const session = this.session!;
    if (!getAnthropicApiKey()) {
      this.log("WARN", "Claude API 키가 설정돼 있지 않아 정밀분석을 건너뜁니다.");
      return [];
    }
    if (!isFfmpegAvailable()) {
      this.log("WARN", "ffmpeg 바이너리가 없어 정밀분석을 건너뜁니다.");
      return [];
    }

    const durationMs = Math.max(0, (session.endedAt ?? Date.now()) - session.startedAt);
    const durationSec = durationMs / 1000;
    if (durationSec <= 0) return [];

    const playback = await resolveVodPlayback(this.videoNo, {
      nidAuth: this.nidAuth,
      nidSession: this.nidSession,
    });
    if (!playback) {
      this.log("WARN", "재생 URL을 구하지 못해 정밀분석을 건너뜁니다 (비공식 API 응답 구조가 바뀌었을 수 있음).");
      return [];
    }

    // 성긴(sparse) 간격은 사용자가 고급 설정에서 조절한 frameIntervalMs가 기본이고, 촘촘한
    // (fine) 간격은 그 값을 SPARSE_SUBDIVISION으로 나눈 값(최소 MIN_FINE_INTERVAL_MS)이다.
    // 영상이 아주 길어서 상한을 넘으면 두 간격 다 자동으로 넓힌다.
    let sparseIntervalMs = this.frameIntervalMs;
    if (durationSec / (sparseIntervalMs / 1000) > VodAnalyzer.MAX_SPARSE_SAMPLES) {
      sparseIntervalMs = Math.ceil((durationSec / VodAnalyzer.MAX_SPARSE_SAMPLES) * 1000);
    }
    let fineIntervalMs = Math.max(
      VodAnalyzer.MIN_FINE_INTERVAL_MS,
      Math.round(sparseIntervalMs / VodAnalyzer.SPARSE_SUBDIVISION)
    );
    if (durationSec / (fineIntervalMs / 1000) > VodAnalyzer.MAX_FINE_FRAMES) {
      fineIntervalMs = Math.ceil((durationSec / VodAnalyzer.MAX_FINE_FRAMES) * 1000);
    }
    const subdivision = Math.max(1, Math.round(sparseIntervalMs / fineIntervalMs));

    const timeoutMs = Math.min(90 * 60_000, Math.max(10 * 60_000, durationMs * 2));

    this.log(
      "INFO",
      `화면을 촘촘한 간격(${Math.round(fineIntervalMs / 1000)}초)으로 영상 처음부터 끝까지 캡처합니다...`
    );
    const fineFrames = await captureVodFrameSequence(playback.url, durationSec, {
      intervalMs: fineIntervalMs,
      maxFrames: VodAnalyzer.MAX_FINE_FRAMES,
      timeoutMs,
      onChildProcess: (child) => {
        this.visionChildProcess = child;
        if (this.visionCancelRequested) child.kill("SIGKILL");
      },
      onProgress: (count, percent) => {
        this.emit("progress", { phase: "vision", fetchedCount: count, percent: percent ?? 0 } as VodProgress);
      },
    });
    this.visionChildProcess = null;
    if (this.visionCancelRequested) return [];
    if (fineFrames.length === 0) {
      this.log("WARN", "화면 캡처에 실패해 정밀분석을 건너뜁니다 (ffmpeg 오류였을 수 있습니다 — 위 로그를 확인해주세요).");
      return [];
    }
    this.log(
      "INFO",
      `총 ${fineFrames.length}개 프레임 캡처 완료. 성긴 간격(${Math.round(
        sparseIntervalMs / 1000
      )}초)으로 먼저 훑고, 판정이 바뀌는 구간만 정밀 재확인합니다.`
    );

    type Classified = { activityType: ActivityType; confidence: number; screenState?: string } | null;
    const cache = new Map<number, Classified>();
    const classifyAt = async (idx: number): Promise<Classified> => {
      if (idx < 0 || idx >= fineFrames.length) return null;
      if (cache.has(idx)) return cache.get(idx)!;
      const result = await classifyImageBuffer(fineFrames[idx]);
      this.visionCallCount += 1;
      this.visionEstimatedCostUsd += 0.002; // Haiku 기준 대략치, collector.ts와 동일 가정
      let mapped: Classified = null;
      if (result) {
        const activityType = activityTypeForScreenState(result.state);
        if (activityType && result.confidence >= this.visionConfidenceThreshold) {
          mapped = { activityType, confidence: result.confidence, screenState: result.state };
        }
      }
      cache.set(idx, mapped);
      return mapped;
    };

    // 같은 상태가 visionConfirmCount번 연속으로 나와야만 확정한다 (collector.ts의 라이브
    // 디바운스와 같은 원칙 — 애매한 프레임 한 장으로 타임라인이 계속 흔들리는 걸 막는다).
    // 성긴 샘플이든 정밀 재확인용 촘촘한 샘플이든, 시간순으로 흘러 들어오기만 하면 그대로
    // 동작한다.
    const events: VisionEvent[] = [];
    let pendingType: ActivityType | null = null;
    let pendingCount = 0;
    let lastConfirmedType: ActivityType | null = null;
    const considerSample = (idx: number, result: Classified) => {
      if (!result) return;
      const timeMs = idx * fineIntervalMs;
      if (result.activityType === pendingType) {
        pendingCount += 1;
      } else {
        pendingType = result.activityType;
        pendingCount = 1;
      }
      if (pendingCount >= this.visionConfirmCount && result.activityType !== lastConfirmedType) {
        lastConfirmedType = result.activityType;
        events.push({ time: timeMs, activityType: result.activityType, confidence: result.confidence, screenState: result.screenState });
      }
    };

    const sparseIndices: number[] = [];
    for (let i = 0; i < fineFrames.length; i += subdivision) sparseIndices.push(i);
    if (sparseIndices[sparseIndices.length - 1] !== fineFrames.length - 1) {
      sparseIndices.push(fineFrames.length - 1);
    }

    let prevSparseIdx: number | null = null;
    let prevSparseResult: Classified = null;
    for (const idx of sparseIndices) {
      if (this.visionCancelRequested) return events;
      const result = await classifyAt(idx);
      considerSample(idx, result);

      // 인접한 두 성긴 샘플의 판정이 서로 다르면(둘 다 유효한 신호일 때만), 그 사이 구간을
      // 촘촘한 간격으로 재확인해서 정확한 전환 지점을 찾는다.
      if (
        prevSparseIdx !== null &&
        result &&
        prevSparseResult &&
        result.activityType !== prevSparseResult.activityType
      ) {
        for (let i = prevSparseIdx + 1; i < idx; i++) {
          if (this.visionCancelRequested) return events;
          const fineResult = await classifyAt(i);
          considerSample(i, fineResult);
        }
      }
      prevSparseIdx = idx;
      prevSparseResult = result;

      const percent = Math.round(((sparseIndices.indexOf(idx) + 1) / sparseIndices.length) * 100);
      this.emit("progress", {
        phase: "vision",
        fetchedCount: this.visionCallCount,
        percent,
      } as VodProgress);
    }

    this.log("INFO", `정밀분석 완료: 총 ${this.visionCallCount}회 호출, 상태 전환 ${events.length}건 확정.`);
    return events;
  }
}

/** 다시보기 URL(예: chzzk.naver.com/video/12345678)이나 순수 숫자 videoNo를 그대로 받아
 * videoNo만 뽑아낸다. 즐겨찾기 채널ID 추출(gui/renderer.js의 extractChannelId)과 같은 역할을
 * VOD 쪽에서 하는 함수. */
export function extractVideoNo(value: string): string {
  const trimmed = (value || "").trim();
  const match = trimmed.match(/\/video\/(\d+)/);
  return match ? match[1] : trimmed;
}
