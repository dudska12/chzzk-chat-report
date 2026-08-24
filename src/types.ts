// 플랫폼에 상관없이 공통으로 쓰는 채팅 메시지 형태.
// 나중에 숲(SOOP)/유튜브 어댑터를 추가해도 analyzer/report 모듈은 손댈 필요가 없도록
// 이 인터페이스로 통일한다.
export interface ChatMessage {
  sessionId: string;
  userIdHash: string; // 유저 식별자 (닉네임은 바뀔 수 있어서 해시/고유ID 기준으로 집계)
  nickname: string;
  message: string;
  timestamp: number; // epoch ms
  isDonation?: boolean;
  donationAmount?: number;
}

export interface BroadcastSession {
  sessionId: string;
  platform: "chzzk" | "soop" | "twitch" | "youtube";
  channelId: string;
  channelName: string;
  startedAt: number;
  endedAt: number | null;
}

export interface TopChatter {
  userIdHash: string;
  nickname: string;
  count: number;
}

export interface WordFrequency {
  word: string;
  count: number;
}

export interface ChatSpeedBucket {
  bucketStart: number; // epoch ms
  count: number;
}

export interface MoodSummary {
  label: string; // 예: "화기애애", "웃음 폭발", "잔잔함"
  emoji: string; // GUI 리포트 카드에 쓸 이모지 한 개
  subtitle: string; // "긍정적인 반응이 많았어요" 같은 짧은 한 줄
  laughRatio: number; // 'ㅋㅋ' 류 웃음 표현 비율
  exclaimRatio: number; // 느낌표/놀람 표현 비율
  positivePct: number; // 0~100, 세 값 합이 100이 되도록 반올림 보정됨
  neutralPct: number;
  negativePct: number;
  peakMoments: ChatSpeedBucket[]; // 채팅 속도가 튄 구간 (하이라이트 후보)
  note: string; // 사람이 읽을 수 있는 한 줄 코멘트 (markdown 리포트용, subtitle보다 좀 더 상세함)
  aiComment?: string; // (선택) Claude API로 생성한 자연어 총평 4~6문장. 키가 없으면 undefined.
}

// ---- 리포트 심화 분석 관련 타입 (활동 구간/참여 구조/후원 교차/하이라이트 발췌) ----
// 전부 이미 수집된 데이터(타임라인 구간, 채팅 로그)를 다시 가공해서 만드는 "해석"이라,
// 원본 raw 카운트(topChatters 등)와 달리 집계 로직이 report.ts에 들어있다.

export interface ActivityBreakdown {
  type: ActivityType;
  minutes: number;
}

export interface GameBreakdown {
  label: string; // 게임명 (카테고리/영상 분석으로 판단한 라벨)
  minutes: number;
}

export interface EngagementSummary {
  topSharePct: number; // 채팅왕 TOP 10이 전체 채팅에서 차지하는 비율 (0~100)
  oneTimeChatterCount: number; // 방송 중 딱 1번만 채팅한 사람 수
  oneTimeChatterPct: number; // 위 인원이 전체 참여자 중 차지하는 비율 (0~100)
}

export interface DonationActivityAmount {
  type: ActivityType;
  amount: number;
}

export interface DonationInsight {
  byActivity: DonationActivityAmount[]; // 후원이 어떤 활동 구간에 몰렸는지
  topDonatorsAlsoChatty: number; // 후원 TOP 5 중 채팅 TOP 10에도 있는 사람 수
}

export interface HighlightQuote {
  contextLabel: string; // "최고 채팅 폭발 구간" 등
  time: number; // epoch ms
  quotes: { time: number; nickname: string; message: string; isDonation?: boolean }[];
}

export interface SessionReport {
  session: BroadcastSession;
  totalMessages: number;
  uniqueChatters: number;
  durationMinutes: number;
  topChatters: TopChatter[];
  topWords: WordFrequency[];
  mood: MoodSummary;
  topDonators: TopChatter[];
  totalDonationAmount: number;

  // 심화 분석 (전부 타임라인/채팅 로그를 재가공한 "해석"이라 원본 집계보다 근사치임을
  // 전제로 한다 — hasTimelineData가 false면 activityBreakdown/gameBreakdown은 카테고리도
  // 영상 분석도 없어 전체를 "정보 없음"으로 깐 추정치라는 뜻).
  activityBreakdown: ActivityBreakdown[];
  gameBreakdown: GameBreakdown[];
  activitySource: "vision" | "category" | "none";
  restSource: "vision" | "motion" | "chat" | "none";
  hasTimelineData: boolean;
  engagement: EngagementSummary;
  donationInsight: DonationInsight;
  highlightQuotes: HighlightQuote[];
}

// ---- 타임라인(방송 히스토리) 관련 타입 ----
// 채팅 텍스트만으로는 "지금 게임 중인지 잡담 중인지"를 알 방법이 없다. 대신 치지직
// live.status()가 스트리머가 직접 설정한 카테고리(categoryType: GAME/TALK 등, liveCategoryValue:
// 게임명/저스트채팅 등)를 그대로 내려주기 때문에, 이걸 폴링 주기마다 기록해서 구간을 나눈다.
// "휴식중"만은 카테고리로 알 수 없어서(카테고리를 안 바꾸고 자리를 비울 수 있으니) 채팅량이
// 오래 잠잠한 구간을 찾는 별도 추정 로직을 카테고리 구간 위에 얹는다.

export type ActivityType = "게임중" | "대화중" | "휴식중";

export interface CategoryEvent {
  time: number; // epoch ms
  categoryType?: string; // chzzk API 원본: "GAME" | "SPORTS" | "ETC"
  categoryValue?: string; // 사람이 읽는 라벨 (게임명, "저스트채팅" 등)
}

// 화면 변화가 거의 없는 상태가 이어지는지를 로컬(순수 픽셀 비교, 외부 API 호출 없음)로
// 감지해서 만드는 휴식중 판단 이벤트. 채팅량 기반 추정(채팅이 조용하다고 꼭 자리비움인 건
// 아니고, 오히려 스트리머가 없을 때 채팅이 더 늘 수도 있다)보다 직접적인 신호라고 보고, 이
// 이벤트가 하나라도 있으면 timeline.ts가 채팅량 추정 대신 이쪽을 우선 사용한다
// (motion-detector.ts 참고). Claude API 키가 설정돼 있으면 확정 직전에 한 번 더
// confirmRestByVision()으로 화면을 봐서 로딩/메뉴 화면처럼 원래 정적인 화면을 자리비움으로
// 오판하는 걸 추가로 걸러준다(선택 사항 — 키가 없거나 실패해도 로컬 판단을 그대로 믿는다).
export interface RestEvent {
  time: number; // epoch ms
  state: "rest_start" | "rest_end";
}

// 방송 화면을 실제로 캡처해서 Claude 비전 API로 게임중/대화중/휴식중(먹방 포함)을 직접
// 판단한 결과. 카테고리(스트리머 자진 신고)보다 우선 적용된다 — 이 이벤트가 하나라도 쌓이면
// timeline.ts가 카테고리 대신 이쪽을 우선 사용한다(게임 이름 라벨만 카테고리에서 빌려옴).
export interface VisionEvent {
  time: number; // epoch ms
  activityType: ActivityType; // 게임중 | 대화중 | 휴식중(먹방 포함)
  confidence: number; // 0~1, 모델이 낸 확신도. 낮은 값은 호출부에서 이미 걸러내고 저장한다.
  screenState?: string; // 원본 화면 상태 9종(GAMEPLAY/CHAT/MENU/LOADING/CUTSCENE/VIDEO/WEB/
  // DESKTOP/EATING) 중 하나. "먹방" 라벨을 붙일지(EATING인지) 판단하는 데 쓴다.
}

export interface ActivitySegment {
  type: ActivityType;
  label: string; // 게임명 / "대화" / "휴식"
  start: number; // epoch ms
  end: number; // epoch ms
  estimated?: boolean; // true면 카테고리 정보가 없어 추정치라는 표시 (휴식중은 항상 true)
}

export interface VolumeBucket {
  bucketStart: number; // epoch ms
  count: number; // 해당 구간 채팅 수 (후원 메시지 포함)
  donationAmount: number; // 해당 구간 후원 합계
}

export interface TimelineHighlight {
  type: "burst" | "donation" | "quiet";
  time: number; // epoch ms (해당 버킷 시작)
  label: string;
  detail: string;
}

export interface UserTimelineEntry {
  time: number;
  message: string;
  activityType: ActivityType;
  isDonation?: boolean;
  donationAmount?: number;
}

export interface UserTimeline {
  nickname: string;
  userIdHash: string;
  totalMessages: number;
  firstMessageAt: number;
  lastMessageAt: number;
  donationAmount: number;
  mainActivity: ActivityType;
  messages: UserTimelineEntry[];
}

export interface TimelineData {
  sessionStart: number;
  sessionEnd: number; // 진행 중이면 현재 시각
  bucketMs: number;
  segments: ActivitySegment[];
  volumeBuckets: VolumeBucket[];
  highlights: TimelineHighlight[];
  hasCategoryInfo: boolean; // false면 카테고리 API 응답에 필드가 없어서 전체를 "대화중"으로 깔고 시작했다는 뜻
  topUsers: TopChatter[]; // "유저 지정" 칩 목록용 (채팅 많이 한 순)
  activitySource: "vision" | "category" | "none"; // 게임중/대화중 경계를 뭘로 판단했는지 (GUI 표시용)
  restSource: "vision" | "motion" | "chat" | "none"; // 휴식중 경계를 뭘로 판단했는지 (vision=먹방 등 영상 분석, motion=화면 변화 감지, chat=채팅량 추정)
}

// ---- 로컬 분석 로직 세부 설정 ("고급 설정" 화면에서 사용자가 직접 조절 가능) ----
// 전부 예전엔 collector.ts/timeline.ts/motion-detector.ts에 매직넘버로 박혀있던 값들이다.
// 방송 스타일(채팅 속도, 화면 변화가 원래 큰 게임인지 등)에 따라 기본값이 안 맞을 수 있어서
// 설정으로 뺐다 — 다만 특히 motion* 계수처럼 로우 레벨인 값은 잘못 만지면 오탐/누락이 늘어날
// 수 있어, 설정 화면에 경고 문구를 같이 둔다.
export interface AnalysisSettings {
  /** 방송 시작/종료 감지 폴링 주기 (ms) */
  statusPollMs: number;
  /** AI 화면 분석(Claude 비전) 호출 주기 (ms). 짧을수록 정확하지만 API 비용이 늘어난다. */
  frameIntervalMs: number;
  /** AI 판단 신뢰도 임계값 (0~1). 이 값 미만이거나 UNKNOWN이면 그 회차 신호를 통째로 버린다. */
  visionConfidenceThreshold: number;
  /** 화면 상태 변경을 확정하기까지 필요한 연속 동일 판정 횟수 (노이즈 방지) */
  visionConfirmCount: number;
  /** 휴식(자리비움) 감지 체크 주기 (ms) */
  restCheckIntervalMs: number;
  /** "휴식 의심"으로 넘어가기까지 필요한 연속 정지 횟수 */
  restSuspectTicks: number;
  /** 휴식 의심 발생 시 재확인할 샘플 개수 */
  restBurstSamples: number;
  /** 재확인 샘플 사이 간격 (ms) */
  restBurstGapMs: number;
  /** 재확인 샘플 중 최소 몇 개가 정지여야 휴식으로 확정할지 */
  restBurstMinStatic: number;
  /** 화면 변화 감지 시 인코딩 노이즈로 무시할 최소 픽셀 차이 (0~255) */
  motionAbsFloor: number;
  /** 최근 평균 변화량 대비 이 비율 미만이면 "정지"로 판단 (낮출수록 민감해짐) */
  motionRelativeFactor: number;
  /** 정지 판단 기준선(최근 평균) 계산에 쓰는 샘플 개수 */
  motionRollingWindow: number;
  /** 타임라인 채팅량 집계 기본 단위시간 (ms) */
  timelineBucketMs: number;
  /** 타임라인에서 이보다 짧은 구간은 잡음으로 보고 병합/제거 (ms) */
  timelineMinSegmentMs: number;
  /** 채팅량 기반 휴식 추정 시 최소 연속 잠잠 버킷 수 */
  timelineQuietMinBuckets: number;
  /** AI 분위기 요약(자연어 총평)에 보낼 채팅 최대 샘플 개수 */
  moodMaxSampleMessages: number;
}
