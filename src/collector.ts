import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { ChzzkClient } from "chzzk";
import type { ChzzkChat } from "chzzk/dist/chat/chat";
import { Store } from "./store";
import { buildReport, saveReport, renderMarkdown } from "./report";
import { buildTimeline, buildUserTimeline } from "./timeline";
import { saveEditPointsCsv } from "./edit-points";
import {
  isFfmpegAvailable,
  captureTinyGrayFrameForChannel,
  frameDiffScore,
  classifyBroadcastFrame,
  confirmRestByVision,
} from "./frame-classifier";
import { MotionTracker } from "./motion-detector";
import { DEFAULT_ANALYSIS_SETTINGS, getAnthropicApiKey } from "./config";
import type {
  ActivityType,
  BroadcastSession,
  ChatMessage,
  SessionReport,
  TimelineData,
  UserTimeline,
} from "./types";

/** AI 화면 분석 상태/비용 배지(GUI 상단)용. */
export interface VisionStats {
  enabled: boolean;
  callCount: number;
  estimatedCostUsd: number;
  reason?: string; // enabled가 false일 때만 (예: "API 키 없음", "ffmpeg 없음")
}

// Haiku 모델 기준 대략 계산한 호출 1건당 비용(달러). 실제 청구 금액과는 캡처 해상도/토큰 수에
// 따라 오차가 있을 수 있는 "추정치"라는 걸 GUI 배지 문구에도 명시한다.
const VISION_COST_PER_CALL_USD = 0.002;

export interface WatchOptions {
  channelId: string;
  /** 방송 시작/종료를 감지하기 위한 폴링 주기 (ms). 기본 30초 */
  statusPollMs?: number;
  /** 화면 변화 감지(휴식 판단) 주기 (ms). 로컬에서만 동작. 기본 10초 */
  restCheckIntervalMs?: number;
  reportDir?: string;
  /** 로그인 없이도 공개 채팅 읽기는 가능하지만, 필요하면 쿠키를 넣을 수 있음 */
  nidAuth?: string;
  nidSession?: string;
  // 아래는 전부 "고급 설정"에서 사용자가 조절할 수 있는 세부 로직 값들. 안 넘기면
  // config.ts의 DEFAULT_ANALYSIS_SETTINGS를 그대로 쓴다 (types.ts의 AnalysisSettings 참고).
  /** AI 화면 분석(Claude 비전) 호출 주기 (ms). API 키가 없으면 이 기능 자체가 꺼진다. */
  frameIntervalMs?: number;
  /** AI 판단 신뢰도 임계값 (0~1) */
  visionConfidenceThreshold?: number;
  /** 화면 상태 변경 확정까지 필요한 연속 동일 판정 횟수 */
  visionConfirmCount?: number;
  /** AI 분위기 요약(자연어 총평)에 보낼 채팅 최대 샘플 개수 */
  moodMaxSampleMessages?: number;
  restSuspectTicks?: number;
  restBurstSamples?: number;
  restBurstGapMs?: number;
  restBurstMinStatic?: number;
  motionAbsFloor?: number;
  motionRelativeFactor?: number;
  motionRollingWindow?: number;
  timelineBucketMs?: number;
  timelineMinSegmentMs?: number;
  timelineQuietMinBuckets?: number;
}

export interface ChatPreview {
  nickname: string;
  message: string;
  isDonation: boolean;
}

export interface ReportReadyPayload {
  filePath: string;
  markdown: string;
  report: SessionReport;
  /** 편집점(휴식/하이라이트) CSV 저장 경로. 편집점이 하나도 안 잡힌 방송이면 null. */
  editPointsPath: string | null;
}

export type LogTag = "INFO" | "CONN" | "DONA" | "WARN" | "ERROR";

export interface LogEntry {
  time: string; // "21:02:11" 형태
  tag: LogTag;
  text: string;
}

function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 채널 하나를 감시하면서:
 *  - 방송 시작 감지 -> 세션 시작 + 채팅 수집 시작
 *  - 방송 종료 감지(또는 사용자가 직접 stop() 호출) -> 세션 종료 + 리포트 생성
 * 를 반복하는 워커.
 *
 * CLI(index.ts)에서도, Electron GUI(gui/main.js)에서도 이 클래스 하나를 그대로 재사용한다.
 * console.log는 CLI용, EventEmitter 이벤트(log/chat/sessionStart/reportReady)는 GUI용.
 */
export class ChannelWatcher extends EventEmitter {
  private client: ChzzkClient;
  private store: Store;
  // 나머지 "고급 설정" 값들(motionAbsFloor 등)은 각자 전용 인스턴스 필드로 따로 들고 있어서
  // (아래), 여기 options에는 원래부터 있던 핵심 필드만 남긴다.
  private options: Required<Pick<WatchOptions, "channelId" | "statusPollMs" | "restCheckIntervalMs" | "reportDir">>;
  private chat: ChzzkChat | null = null;
  private currentSession: BroadcastSession | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private channelName = "";
  // 타임라인 구간 나누기용 카테고리 추적 상태. finalizeSession에서 리셋하고,
  // lastSessionId는 리포트가 나온 뒤에도 "타임라인 탭"에서 계속 조회할 수 있도록 남겨둔다.
  private lastCategoryType: string | undefined;
  private lastCategoryValue: string | undefined;
  private lastSessionId: string | null = null;
  // 화면 변화 감지(휴식 판단) 관련 상태. 외부 API 호출 없이 항상 동작하는 무료 경로다.
  private restTimer: NodeJS.Timeout | null = null;
  private motionTracker: MotionTracker;
  private prevTinyFrame: Buffer | null = null;
  private restState: "active" | "resting" = "active";
  // 버스트 재확인(아래 restBurst*)이 진행 중일 때 다음 정기 체크가 겹쳐 돌지 않게 막는 플래그.
  private restCheckInFlight = false;
  // 실제 BJ들의 자리비움은 보통 1분 안팎이라, 의심까지 도달하는 데 너무 오래 걸리면(예:
  // 기존 60초) 의심이 뜬 시점엔 이미 돌아올 때가 다 돼서 놓치기 쉽다. restCheckIntervalMs
  // 기본값(10초) 기준 2틱 = 약 20초 정적 지속이면 의심으로 넘어간다.
  private restSuspectTicks: number;
  // 의심이 뜨면 바로 확정하지 않고, 짧은 간격으로 몇 장 더 몰아서 재확인한다 - 20초짜리
  // 판단 하나로 확정하면 우연히 낀 잡음(디코딩 노이즈 등)에 흔들릴 수 있어서다. 같은 HLS
  // 세그먼트를 중복으로 받아오는 걸 피할 정도의 최소 간격(약 2초)으로 5번 캡처해서 다수결로
  // 판단한다 (예: 5번 중 4번 이상 정적이어야 통과).
  private restBurstSamples: number;
  private restBurstGapMs: number;
  private restBurstMinStatic: number;
  private motionAbsFloor: number;
  private motionRelativeFactor: number;
  private motionRollingWindow: number;
  private timelineBucketMs: number;
  private timelineMinSegmentMs: number;
  private timelineQuietMinBuckets: number;
  // AI 화면 분석(선택 기능, Claude API 키 필요) 관련 상태.
  private frameIntervalMs: number;
  private visionConfidenceThreshold: number;
  private visionConfirmCount: number;
  private moodMaxSampleMessages: number;
  private visionTimer: NodeJS.Timeout | null = null;
  private visionEnabled = false;
  private visionDisabledReason: string | undefined;
  private visionCallCount = 0;
  private visionEstimatedCostUsd = 0;
  // 화면 상태 변경을 바로 반영하지 않고, 같은 판정이 visionConfirmCount번 연속 나와야만
  // 확정한다 (애매한 프레임 한 장 때문에 타임라인이 계속 흔들리는 걸 막기 위함).
  private visionPendingType: ActivityType | null = null;
  private visionPendingCount = 0;
  private visionLastConfirmedType: ActivityType | null = null;

  /** 지금 진행 중인 방송 세션이 있는지 (GUI가 stop() 호출 전에 reportReady가 뒤따를지 미리 알기 위함) */
  get isSessionActive(): boolean {
    return this.currentSession !== null;
  }

  constructor(opts: WatchOptions) {
    super();
    this.client = new ChzzkClient({
      nidAuth: opts.nidAuth,
      nidSession: opts.nidSession,
    });
    this.store = new Store();
    this.options = {
      channelId: opts.channelId,
      statusPollMs: opts.statusPollMs ?? DEFAULT_ANALYSIS_SETTINGS.statusPollMs,
      restCheckIntervalMs: opts.restCheckIntervalMs ?? DEFAULT_ANALYSIS_SETTINGS.restCheckIntervalMs,
      reportDir: opts.reportDir ?? "reports",
    };
    this.restSuspectTicks = opts.restSuspectTicks ?? DEFAULT_ANALYSIS_SETTINGS.restSuspectTicks;
    this.restBurstSamples = opts.restBurstSamples ?? DEFAULT_ANALYSIS_SETTINGS.restBurstSamples;
    this.restBurstGapMs = opts.restBurstGapMs ?? DEFAULT_ANALYSIS_SETTINGS.restBurstGapMs;
    this.restBurstMinStatic = opts.restBurstMinStatic ?? DEFAULT_ANALYSIS_SETTINGS.restBurstMinStatic;
    this.motionAbsFloor = opts.motionAbsFloor ?? DEFAULT_ANALYSIS_SETTINGS.motionAbsFloor;
    this.motionRelativeFactor = opts.motionRelativeFactor ?? DEFAULT_ANALYSIS_SETTINGS.motionRelativeFactor;
    this.motionRollingWindow = opts.motionRollingWindow ?? DEFAULT_ANALYSIS_SETTINGS.motionRollingWindow;
    this.timelineBucketMs = opts.timelineBucketMs ?? DEFAULT_ANALYSIS_SETTINGS.timelineBucketMs;
    this.timelineMinSegmentMs = opts.timelineMinSegmentMs ?? DEFAULT_ANALYSIS_SETTINGS.timelineMinSegmentMs;
    this.timelineQuietMinBuckets =
      opts.timelineQuietMinBuckets ?? DEFAULT_ANALYSIS_SETTINGS.timelineQuietMinBuckets;
    this.frameIntervalMs = opts.frameIntervalMs ?? DEFAULT_ANALYSIS_SETTINGS.frameIntervalMs;
    this.visionConfidenceThreshold =
      opts.visionConfidenceThreshold ?? DEFAULT_ANALYSIS_SETTINGS.visionConfidenceThreshold;
    this.visionConfirmCount = opts.visionConfirmCount ?? DEFAULT_ANALYSIS_SETTINGS.visionConfirmCount;
    this.moodMaxSampleMessages = opts.moodMaxSampleMessages ?? DEFAULT_ANALYSIS_SETTINGS.moodMaxSampleMessages;
    this.motionTracker = new MotionTracker({
      absFloor: this.motionAbsFloor,
      relativeFactor: this.motionRelativeFactor,
      rollingWindow: this.motionRollingWindow,
    });
  }

  /** 이 인스턴스가 지금 어떤 분석 세부값으로 동작 중인지 (고급 설정 화면 등에서 참고용). */
  private buildTimelineOpts() {
    return {
      bucketMs: this.timelineBucketMs,
      minSegmentMs: this.timelineMinSegmentMs,
      quietMinBuckets: this.timelineQuietMinBuckets,
    };
  }

  private log(tag: LogTag, text: string) {
    console.log(`[${tag}] ${text}`);
    const entry: LogEntry = { time: formatTime(), tag, text };
    this.emit("log", entry);
  }

  async start() {
    const channel = await this.client.channel(this.options.channelId);
    this.channelName = channel.channelName ?? this.options.channelId;
    this.log("INFO", `"${this.channelName}" 채널 감시를 시작합니다.`);

    await this.checkStatus(); // 즉시 한 번 확인 (이미 방송 중일 수 있음)
    this.statusTimer = setInterval(() => this.checkStatus(), this.options.statusPollMs);
  }

  /**
   * 사용자가 직접 "종료"를 누른 경우 (예: 시청자가 방송이 끝난 걸 보고 프로그램을 끌 때).
   * 방송 상태 API가 아직 CLOSE로 안 바뀌었더라도, 지금 시점 기준으로 세션을 마감하고
   * 즉시 리포트를 만든다. 진행 중이던 세션이 없으면 그냥 연결만 정리한다.
   */
  async stop() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.currentSession) {
      await this.finalizeSession("사용자가 직접 종료했습니다.");
    } else {
      this.chat?.disconnect();
    }
    this.store.close();
  }

  private async checkStatus() {
    try {
      const status = await this.client.live.status(this.options.channelId);
      const isLive = status.status === "OPEN";

      if (isLive && !this.currentSession) {
        await this.onLiveStart();
      } else if (!isLive && this.currentSession) {
        await this.onLiveEnd();
      }

      // onLiveStart() 직후에도 currentSession이 세팅돼 있으니, 같은 폴링 사이클에서
      // 방송 시작 시점의 카테고리도 바로 기록된다.
      if (isLive && this.currentSession) {
        this.trackCategory(status);
      }
    } catch (err) {
      this.log("WARN", `방송 상태 확인 실패: ${err}`);
    }
  }

  /**
   * 카테고리(게임명/저스트채팅 등, 스트리머가 직접 설정) 변화를 감지해서 타임라인 구간
   * 경계로 기록한다. chzzk 라이브러리 버전에 따라 이 필드 자체가 없을 수도 있는데, 그럴
   * 땐 조용히 넘어가고 timeline.ts가 채팅량 기반 추정만으로 대체한다.
   */
  private trackCategory(status: { categoryType?: string; liveCategoryValue?: string }) {
    if (!this.currentSession) return;
    const type = status.categoryType;
    const value = status.liveCategoryValue;
    if (type === undefined && value === undefined) return;
    if (type === this.lastCategoryType && value === this.lastCategoryValue) return;

    this.lastCategoryType = type;
    this.lastCategoryValue = value;
    this.store.addCategoryEvent(this.currentSession.sessionId, {
      time: Date.now(),
      categoryType: type,
      categoryValue: value,
    });
    this.log("INFO", `카테고리 변경 감지: ${value ?? "알 수 없음"}`);
  }

  /**
   * 지금까지 수집된 데이터로 타임라인(활동 구간/채팅량/하이라이트)을 즉석에서 계산해서 돌려준다.
   * 방송 도중(진행 중인 구간까지)과 방송 종료 후(리포트가 나온 뒤) 둘 다 호출 가능.
   */
  getTimeline(): TimelineData | null {
    const sessionId = this.currentSession?.sessionId ?? this.lastSessionId;
    if (!sessionId) return null;
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    const messages = this.store.getMessages(sessionId);
    const events = this.store.getCategoryEvents(sessionId);
    const visionEvents = this.store.getVisionEvents(sessionId);
    const restEvents = this.store.getRestEvents(sessionId);
    return buildTimeline(session, messages, events, visionEvents, restEvents, this.buildTimelineOpts());
  }

  /** 특정 유저(닉네임)의 채팅 타임라인. "유저 지정" 칩/채팅왕 행 클릭 시 호출됨. */
  getUserTimeline(nickname: string): UserTimeline | null {
    const sessionId = this.currentSession?.sessionId ?? this.lastSessionId;
    if (!sessionId) return null;
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    const messages = this.store.getMessages(sessionId);
    const events = this.store.getCategoryEvents(sessionId);
    const visionEvents = this.store.getVisionEvents(sessionId);
    const restEvents = this.store.getRestEvents(sessionId);
    const timeline = buildTimeline(session, messages, events, visionEvents, restEvents, this.buildTimelineOpts());
    return buildUserTimeline(messages, timeline.segments, nickname);
  }

  /** AI 화면 분석 상태/비용 배지(GUI 상단)용. */
  getVisionStats(): VisionStats {
    return {
      enabled: this.visionEnabled,
      callCount: this.visionCallCount,
      estimatedCostUsd: this.visionEstimatedCostUsd,
      reason: this.visionDisabledReason,
    };
  }

  /** 타임라인에서 특정 구간/막대를 선택했을 때, 그 시간대 채팅 로그를 보여주기 위한 조회. */
  getMessagesInRange(startMs: number, endMs: number): ChatMessage[] {
    const sessionId = this.currentSession?.sessionId ?? this.lastSessionId;
    if (!sessionId) return [];
    return this.store
      .getMessages(sessionId)
      .filter((m) => m.timestamp >= startMs && m.timestamp < endMs);
  }

  private async onLiveStart() {
    const sessionId = randomUUID();
    this.currentSession = {
      sessionId,
      platform: "chzzk",
      channelId: this.options.channelId,
      channelName: this.channelName,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.lastSessionId = sessionId;
    this.lastCategoryType = undefined;
    this.lastCategoryValue = undefined;
    this.stopRestDetection(); // 혹시 이전 세션의 타이머가 남아있으면 정리하고 새로 시작
    this.store.startSession(this.currentSession);
    this.log("INFO", `방송 시작을 감지했습니다. (세션 ${sessionId})`);
    this.emit("sessionStart", this.currentSession);

    this.chat = this.client.chat({ channelId: this.options.channelId, pollInterval: 30_000 });

    this.chat.on("connect", () => this.log("CONN", "채팅 서버에 연결되었습니다."));
    this.chat.on("reconnect", () => this.log("CONN", "채팅 서버에 재연결되었습니다."));
    this.chat.on("disconnect", () => this.log("WARN", "채팅 연결이 끊겼습니다."));

    this.chat.on("chat", (c) => {
      if (!this.currentSession) return;
      const message = c.hidden ? "[블라인드 처리됨]" : c.message;
      this.store.insertMessage({
        sessionId: this.currentSession.sessionId,
        userIdHash: c.profile.userIdHash,
        nickname: c.profile.nickname,
        message,
        timestamp: Date.now(),
      });
      const preview: ChatPreview = {
        nickname: c.profile.nickname,
        message,
        isDonation: false,
      };
      this.emit("chat", preview);
    });

    this.chat.on("donation", (d) => {
      if (!this.currentSession) return;
      const nickname = d.profile?.nickname ?? "익명의 후원자";
      const message = d.message ?? "";
      const amount = d.extras.payAmount;
      this.store.insertMessage({
        sessionId: this.currentSession.sessionId,
        userIdHash: d.profile?.userIdHash ?? "anonymous",
        nickname,
        message,
        timestamp: Date.now(),
        isDonation: true,
        donationAmount: amount,
      });
      this.log("DONA", `${nickname} 님의 후원 ${amount.toLocaleString()}원 감지.`);
      const preview: ChatPreview = { nickname, message, isDonation: true };
      this.emit("chat", preview);
    });

    await this.chat.connect();

    this.startRestDetection();
    this.startFrameClassification();
  }

  /**
   * 화면 변화량 기반 휴식(자리비움) 감지 루프. motion-detector.ts가 순수 로컬 계산이라
   * 외부 API 호출이 전혀 없다(채팅량과 달리 "스트리머가 없을 때 채팅이 오히려 늘 수도
   * 있다"는 함정도 없다). ffmpeg 자체가 없으면(설치 실패 등) 캡처가 계속 null만 돌려줄
   * 뿐이라, 휴식 감지만 조용히 비활성 상태로 남고 나머지 기능엔 영향이 없다.
   */
  private startRestDetection() {
    this.motionTracker = new MotionTracker({
      absFloor: this.motionAbsFloor,
      relativeFactor: this.motionRelativeFactor,
      rollingWindow: this.motionRollingWindow,
    });
    this.prevTinyFrame = null;
    this.restState = "active";

    if (!isFfmpegAvailable()) {
      this.log(
        "WARN",
        "ffmpeg 바이너리가 없어 화면 변화 기반 휴식 감지를 건너뜁니다 (채팅량 추정으로 대체됩니다)."
      );
      return;
    }

    this.log(
      "INFO",
      `화면 변화 감지 기반 휴식 판단을 시작합니다 (${Math.round(
        this.options.restCheckIntervalMs / 1000
      )}초 간격, 외부 API 호출 없이 로컬에서만 동작).`
    );
    this.restTimer = setInterval(() => this.runRestCheck(), this.options.restCheckIntervalMs);
    this.runRestCheck();
  }

  private stopRestDetection() {
    if (this.restTimer) {
      clearInterval(this.restTimer);
      this.restTimer = null;
    }
    this.prevTinyFrame = null;
    this.restState = "active";
    this.restCheckInFlight = false;
  }

  /**
   * AI 화면 분석(선택 기능) 시작. Claude API 키가 config.json/환경변수에 없으면 이 기능
   * 자체가 꺼지고, 카테고리 기반 판단만으로 계속 정상 동작한다(에러 아님 — 그냥 보너스
   * 기능이 꺼진 상태).
   */
  private startFrameClassification() {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      this.visionEnabled = false;
      this.visionDisabledReason = "API 키 없음";
      return;
    }
    if (!isFfmpegAvailable()) {
      this.visionEnabled = false;
      this.visionDisabledReason = "ffmpeg 없음";
      return;
    }
    this.visionEnabled = true;
    this.visionDisabledReason = undefined;
    this.visionCallCount = 0;
    this.visionEstimatedCostUsd = 0;
    this.visionPendingType = null;
    this.visionPendingCount = 0;
    this.visionLastConfirmedType = null;
    this.log(
      "INFO",
      `AI 화면 분석을 시작합니다 (${Math.round(this.frameIntervalMs / 1000)}초 간격, Claude API 호출 - 비용이 조금씩 발생합니다).`
    );
    this.visionTimer = setInterval(() => this.runFrameClassification(), this.frameIntervalMs);
    this.runFrameClassification();
  }

  private stopFrameClassification() {
    if (this.visionTimer) {
      clearInterval(this.visionTimer);
      this.visionTimer = null;
    }
    this.visionPendingType = null;
    this.visionPendingCount = 0;
    this.visionLastConfirmedType = null;
  }

  private async runFrameClassification() {
    if (!this.currentSession) return;
    const sessionId = this.currentSession.sessionId;
    const event = await classifyBroadcastFrame(this.client, this.options.channelId);
    if (!this.currentSession || this.currentSession.sessionId !== sessionId) return; // 그 사이 방송 종료
    this.visionCallCount += 1;
    this.visionEstimatedCostUsd += VISION_COST_PER_CALL_USD;
    if (!event) return; // 캡처 실패/UNKNOWN은 frame-classifier.ts가 이미 null로 걸러줌
    if (event.confidence < this.visionConfidenceThreshold) return; // 신뢰도 낮은 응답은 버림

    // 애매한 프레임 한 장 때문에 타임라인이 계속 흔들리지 않도록, 같은 상태가
    // visionConfirmCount번 연속 나와야만 확정한다. 중간에 낀 다른(또는 UNKNOWN으로 버려진)
    // 응답은 이 연속 카운트를 리셋시킨다.
    if (event.activityType === this.visionPendingType) {
      this.visionPendingCount += 1;
    } else {
      this.visionPendingType = event.activityType;
      this.visionPendingCount = 1;
    }

    if (
      this.visionPendingCount >= this.visionConfirmCount &&
      event.activityType !== this.visionLastConfirmedType
    ) {
      this.visionLastConfirmedType = event.activityType;
      this.store.addVisionEvent(sessionId, event);
      this.log(
        "INFO",
        `AI 화면 분석 확정: ${event.activityType}${event.screenState === "EATING" ? "(먹방)" : ""} ` +
          `(신뢰도 ${Math.round(event.confidence * 100)}%)`
      );
    }
  }

  private async runRestCheck() {
    // 버스트 재확인(confirmRestSuspicion)이 진행 중이면(최대 REST_BURST_SAMPLES *
    // REST_BURST_GAP_MS 만큼 걸릴 수 있음) 다음 정기 체크와 겹쳐서 캡처가 꼬이지 않게 건너뛴다.
    if (this.restCheckInFlight) return;
    if (!this.currentSession) return;
    this.restCheckInFlight = true;
    try {
      const sessionId = this.currentSession.sessionId;
      const tiny = await captureTinyGrayFrameForChannel(this.client, this.options.channelId);
      if (!this.currentSession || this.currentSession.sessionId !== sessionId) return; // 그 사이 방송 종료
      if (!tiny) return; // 캡처 실패는 조용히 스킵 (다음 틱에 다시 시도, 로그 도배 방지)

      if (!this.prevTinyFrame) {
        this.prevTinyFrame = tiny; // 비교 대상이 아직 없는 첫 틱
        return;
      }

      const diff = frameDiffScore(this.prevTinyFrame, tiny);
      this.prevTinyFrame = tiny;
      const obs = this.motionTracker.observe(diff);

      if (this.restState === "active") {
        if (obs.staticStreak >= this.restSuspectTicks) {
          await this.confirmRestSuspicion(sessionId);
        }
      } else if (!obs.isStatic) {
        // 화면이 다시 움직이기 시작함 -> 복귀로 판단. 자리비움에서 돌아오면 보통 화면이 확
        // 바뀌기 때문에, 여기는 한 틱만으로 바로 종료를 확정해도 오탐 위험이 낮다고 봤다.
        this.confirmRestEnd(sessionId);
      }
    } finally {
      this.restCheckInFlight = false;
    }
  }

  /**
   * 정기 체크(10초 간격)에서 정적 상태가 REST_SUSPECT_TICKS만큼 이어져 "휴식 의심"이 떴을 때,
   * 바로 확정하지 않고 짧은 간격으로 몇 장 더 몰아서 재확인한다. 20초 안팎의 판단 하나만으로
   * 확정하면 우연히 낀 잡음(디코딩 노이즈, 순간적인 화면 정지 등)에 흔들릴 수 있어서, 압축된
   * 시간 안에 더 많은 샘플을 보고 다수결로 보강한다.
   *
   * 같은 HLS 세그먼트를 중복으로 받아와서 "가짜로 변화 없음"이 나오는 걸 피하려고 정확히
   * 1초가 아니라 REST_BURST_GAP_MS(약 2초) 간격을 둔다. 여기서 나온 diff는 motionTracker의
   * 기준선(history)에는 반영하지 않는다 - 버스트 간격이 평소 10초 주기와 성격이 달라서 기준선을
   * 왜곡시킬 수 있기 때문이다 (MotionTracker.isLikelyStatic이 읽기 전용으로 그 역할을 한다).
   */
  private async confirmRestSuspicion(sessionId: string) {
    this.log("INFO", "화면 변화가 거의 없어 휴식 여부를 재확인합니다...");
    let staticCount = 0;

    for (let i = 0; i < this.restBurstSamples; i++) {
      await new Promise((resolve) => setTimeout(resolve, this.restBurstGapMs));
      if (!this.currentSession || this.currentSession.sessionId !== sessionId) return; // 그 사이 방송 종료

      const frame = await captureTinyGrayFrameForChannel(this.client, this.options.channelId);
      if (!this.currentSession || this.currentSession.sessionId !== sessionId) return;
      if (!frame || !this.prevTinyFrame) continue; // 캡처 실패는 이번 샘플만 건너뜀

      const diff = frameDiffScore(this.prevTinyFrame, frame);
      this.prevTinyFrame = frame;
      if (this.motionTracker.isLikelyStatic(diff)) staticCount += 1;
    }

    if (staticCount < this.restBurstMinStatic) {
      // 재확인에서 기대만큼 정적이지 않았음 -> 순간적인 잡음이었다고 보고 의심을 취소한다.
      this.motionTracker.resetStreak();
      this.log(
        "INFO",
        `재확인 결과 화면이 다시 움직여 휴식 의심을 취소합니다 (정적 ${staticCount}/${this.restBurstSamples}).`
      );
      return;
    }

    await this.tryConfirmRestStart(sessionId);
  }

  /** 버스트 재확인까지 통과한 상태를 실제 휴식 시작으로 확정한다 (정기 체크 + 버스트
   * 재확인을 통과했으니 로컬 판단만으로 충분히 신뢰할 수 있다고 본다). Claude API 키가
   * 설정돼 있으면 여기서 한 번 더 화면을 보여줘서 로딩/메뉴 화면처럼 원래 정적인 화면을
   * 자리비움으로 오판하는 걸 추가로 걸러준다(선택 사항 — 키가 없거나 요청이 실패해도(null)
   * 로컬 판단을 그대로 믿고 진행하므로 휴식 감지 자체가 멈추진 않는다). */
  private async tryConfirmRestStart(sessionId: string) {
    if (this.restState === "resting") return; // 이미 확정됨 (중복 방지)

    // 이 확인이 진행되는 동안엔 restCheckInFlight가 계속 true라(runRestCheck 초입 가드) 다른
    // 경로로 restState가 바뀔 일이 없다 — 방송이 그 사이 끝나는 경우만 아래에서 확인한다.
    const visionConfirmed = await confirmRestByVision(this.client, this.options.channelId);
    if (!this.currentSession || this.currentSession.sessionId !== sessionId) return; // 그 사이 방송 종료
    if (visionConfirmed === false) {
      this.motionTracker.resetStreak();
      this.log("INFO", "AI 확인 결과 원래 정적인 화면(로딩/메뉴 등)으로 판단해 휴식 의심을 취소합니다.");
      return;
    }

    this.restState = "resting";
    this.store.addRestEvent(sessionId, { time: Date.now(), state: "rest_start" });
    this.log("INFO", "휴식 시작 감지 (화면 변화 거의 없음)");
  }

  private confirmRestEnd(sessionId: string) {
    if (this.restState !== "resting") return;
    this.restState = "active";
    this.motionTracker.resetStreak();
    this.store.addRestEvent(sessionId, { time: Date.now(), state: "rest_end" });
    this.log("INFO", "화면 변화 다시 감지됨 — 휴식 종료(복귀)로 판단");
  }

  private async onLiveEnd() {
    if (!this.currentSession) return;
    await this.finalizeSession("방송 종료를 감지했습니다.");
  }

  /** 세션 종료 + 리포트 생성을 실제로 수행하는 공통 로직 (자동 감지든 수동 종료든 여기로 모인다) */
  private async finalizeSession(reason: string) {
    if (!this.currentSession) return;
    const sessionId = this.currentSession.sessionId;
    this.log("INFO", `${reason} (세션 ${sessionId} 종료, 리포트 생성 중...)`);

    const endedAt = Date.now();
    this.store.endSession(sessionId, endedAt);
    this.chat?.disconnect();
    this.chat = null;
    this.stopRestDetection();
    this.stopFrameClassification();

    const session = this.store.getSession(sessionId)!;
    const messages = this.store.getMessages(sessionId);
    const categoryEvents = this.store.getCategoryEvents(sessionId);
    const visionEvents = this.store.getVisionEvents(sessionId);
    const restEvents = this.store.getRestEvents(sessionId);
    const report = await buildReport(session, messages, categoryEvents, visionEvents, restEvents, {
      timelineBucketMs: this.timelineBucketMs,
      timelineMinSegmentMs: this.timelineMinSegmentMs,
      timelineQuietMinBuckets: this.timelineQuietMinBuckets,
      moodMaxSampleMessages: this.moodMaxSampleMessages,
    });
    const filePath = saveReport(report, this.options.reportDir);
    const markdown = renderMarkdown(report);

    // 편집점(휴식/하이라이트) CSV도 리포트와 나란히 자동 저장한다. 이 프로그램의 원래
    // 목적이 "영상 편집할 때 참고할 시점 찾기"였던 만큼, 버튼을 따로 안 눌러도 방송이
    // 끝나면 항상 남도록 리포트 저장과 같은 시점에 처리한다.
    const timeline = buildTimeline(
      session,
      messages,
      categoryEvents,
      visionEvents,
      restEvents,
      this.buildTimelineOpts()
    );
    const editPointsPath = saveEditPointsCsv(session, timeline, this.options.reportDir);

    this.log("INFO", `리포트 생성 완료: ${filePath}`);
    if (editPointsPath) this.log("INFO", `편집점 목록 저장 완료: ${editPointsPath}`);
    this.emit("reportReady", { filePath, markdown, report, editPointsPath } as ReportReadyPayload);

    this.currentSession = null;
  }
}
