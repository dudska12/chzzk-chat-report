// 타임라인(방송 히스토리) 계산 모듈.
//
// 채팅 텍스트만으로는 "지금 게임 중인지 잡담 중인지"를 알 방법이 없다. 대신 치지직
// live.status() API가 스트리머 본인이 직접 설정한 카테고리(categoryType: "GAME"/"TALK" 등,
// liveCategoryValue: 게임명/저스트채팅 등)를 그대로 내려주기 때문에, collector.ts가 폴링
// 주기마다 이 값이 바뀌는 걸 CategoryEvent로 기록해두고, 여기서 그 이벤트를 구간 경계로
// 써서 "게임중/대화중" 구간을 나눈다 (=스트리머가 직접 설정한 값이라 정확함).
//
// 게임중/대화중을 더 정확히 알고 싶으면(카테고리는 스트리머 "자진 신고"라 실제 화면과 다를 수
// 있음) VisionEvent(Claude 비전 API로 화면을 직접 판단한 결과, frame-classifier.ts 참고)가
// 하나라도 있을 때 카테고리 대신 이쪽을 우선 사용한다 — 게임 이름 라벨만은 모델에게 추측을
// 금지시켰기 때문에 그 시점 카테고리 구간에서 빌려온다(gameLabelAt).
//
// "휴식중"은 카테고리로는 알 수 없는 정보다 (카테고리를 안 바꾼 채로 자리를 비울 수 있으니).
// 판단 근거는 세 가지가 있고, 우선순위는 motion > vision > chat이다.
//  1) RestEvent (motion-detector.ts 기반, collector.ts가 실시간으로 화면 변화량을 로컬에서
//     추적해서 만듦): 화면이 오래 정적이면 휴식으로 본다. 외부 API 없이도 동작하고, 채팅량과
//     달리 "스트리머가 없을 때 채팅이 오히려 늘 수도 있다"는 함정이 없어서 가장 직접적인
//     신호다. 이 이벤트가 하나라도 있으면 이쪽을 최우선으로 사용한다.
//  2) VisionEvent 중 activityType이 "휴식중"인 것(주로 먹방 — 화면이 정적이지 않고 스트리머가
//     움직이며 먹기 때문에 motion 감지로는 못 잡는 케이스를 보완한다).
//  3) 둘 다 없으면(구버전 세션, 화면 변화 감지/영상 분석 자체가 실패한 경우) 채팅량이 일정
//     시간 이상 눈에 띄게 잠잠해지는 구간을 찾는 기존 방식으로 폴백한다.
// 어느 쪽이든 카테고리/영상 구간 위에 "휴식중" 서브구간으로 덮어씌우는 방식이고, 100% 정확하진
// 않은 추정치라는 걸 ActivitySegment.estimated 플래그로 표시해둔다.

import type {
  ActivitySegment,
  ActivityType,
  BroadcastSession,
  CategoryEvent,
  ChatMessage,
  RestEvent,
  TimelineData,
  TimelineHighlight,
  UserTimeline,
  VisionEvent,
  VolumeBucket,
} from "./types";
import { topChatters } from "./analyzer";

const DEFAULT_BUCKET_MS = 60_000; // 기본 1분 단위
const TARGET_BUCKET_COUNT = 240; // 방송이 아주 길어지면(예: 마라톤 방송) 버킷 크기를 늘려서 이 개수 근처로 유지
const QUIET_MIN_BUCKETS = 4; // 최소 이만큼 연속으로 잠잠해야 "휴식중" 후보로 인정 (버킷 크기에 비례해서 실제 시간이 달라짐)
const MIN_SEGMENT_MS = 60_000; // 이보다 짧은 조각은 잡음으로 보고 버림/병합

function activityTypeFromCategory(categoryType: string | undefined): ActivityType {
  return categoryType === "GAME" ? "게임중" : "대화중";
}

function labelFromCategory(categoryType: string | undefined, categoryValue: string | undefined): string {
  if (categoryValue) return categoryValue;
  return categoryType === "GAME" ? "게임" : "대화";
}

/** 방송 길이에 맞춰 분당 버킷이 너무 많아지지 않도록 버킷 크기를 정한다.
 * baseBucketMs를 넘기면(고급 설정에서 사용자가 바꾼 값) 그 크기를 기준으로 자동 확대만
 * 적용하고, 안 넘기면 기본 1분 단위를 기준으로 삼는다. */
export function pickBucketMs(durationMs: number, baseBucketMs: number = DEFAULT_BUCKET_MS): number {
  if (durationMs <= 0) return baseBucketMs;
  const naiveCount = durationMs / baseBucketMs;
  if (naiveCount <= TARGET_BUCKET_COUNT) return baseBucketMs;
  const scale = Math.ceil(naiveCount / TARGET_BUCKET_COUNT);
  return baseBucketMs * scale;
}

export function buildVolumeBuckets(
  messages: ChatMessage[],
  start: number,
  end: number,
  bucketMs: number = DEFAULT_BUCKET_MS
): VolumeBucket[] {
  if (end <= start) return [];
  const bucketCount = Math.max(1, Math.ceil((end - start) / bucketMs));
  const buckets: VolumeBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    bucketStart: start + i * bucketMs,
    count: 0,
    donationAmount: 0,
  }));
  for (const m of messages) {
    if (m.timestamp < start || m.timestamp >= end) continue;
    const idx = Math.min(bucketCount - 1, Math.floor((m.timestamp - start) / bucketMs));
    buckets[idx].count += 1;
    if (m.isDonation && m.donationAmount) buckets[idx].donationAmount += m.donationAmount;
  }
  return buckets;
}

/** 카테고리 이벤트만으로 만든 1차 구간 (게임중/대화중). 휴식중 서브구간은 아직 반영 전. */
function buildCategorySegments(events: CategoryEvent[], start: number, end: number): ActivitySegment[] {
  if (end <= start) return [];
  if (events.length === 0) {
    // 카테고리 정보가 아예 없으면(라이브러리/채널 사정으로 필드가 안 내려오는 경우) 전체를
    // "대화중"으로 깔아두고, 휴식중 추정만 그 위에 얹는다. 완전히 틀린 값보다는 중립적인
    // 기본값을 쓰는 게 낫다고 판단했다.
    return [{ type: "대화중", label: "정보 없음", start, end, estimated: true }];
  }

  const sorted = [...events].sort((a, b) => a.time - b.time);
  const segments: ActivitySegment[] = [];

  // 첫 이벤트 이전 구간은 첫 이벤트와 같은 카테고리였다고 가정한다 (방송 시작과 거의 동시에
  // 카테고리를 기록하긴 하지만, 폴링 주기 때문에 몇십 초 정도 어긋날 수 있어서).
  if (sorted[0].time > start) {
    segments.push({
      type: activityTypeFromCategory(sorted[0].categoryType),
      label: labelFromCategory(sorted[0].categoryType, sorted[0].categoryValue),
      start,
      end: sorted[0].time,
    });
  }

  for (let i = 0; i < sorted.length; i++) {
    const segStart = sorted[i].time;
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].time : end;
    if (segEnd <= segStart) continue;
    segments.push({
      type: activityTypeFromCategory(sorted[i].categoryType),
      label: labelFromCategory(sorted[i].categoryType, sorted[i].categoryValue),
      start: segStart,
      end: segEnd,
    });
  }

  return segments;
}

/** 그 시점 카테고리 구간의 게임명을 빌려온다. VisionEvent는 "게임중이다"까지만 판단하고
 * 게임 "이름"까지 확정하는 건 모델에게도 추측을 금지시켰기 때문에, 라벨은 항상 카테고리에서
 * 가져온다. 카테고리 정보가 없거나 그 시점이 게임중이 아니면 "게임"으로 대체한다. */
function gameLabelAt(categorySegments: ActivitySegment[], time: number): string {
  const seg = categorySegments.find((s) => time >= s.start && time < s.end);
  if (seg && seg.type === "게임중") return seg.label;
  return "게임";
}

function visionSegmentFor(ev: VisionEvent, categorySegments: ActivitySegment[], start: number, end: number): ActivitySegment {
  if (ev.activityType === "게임중") {
    return { type: "게임중", label: gameLabelAt(categorySegments, start), start, end };
  }
  if (ev.activityType === "휴식중") {
    const isEating = ev.screenState === "EATING";
    return { type: "휴식중", label: isEating ? "먹방" : "휴식", start, end, estimated: true };
  }
  return { type: "대화중", label: "대화", start, end };
}

/** VisionEvent들로 1차 활동 구간을 만든다 (buildCategorySegments의 영상 분석 버전).
 * 카테고리 이벤트와 똑같이 "다음 이벤트 전까지 이 상태가 이어졌다"고 가정해서 구간을 나눈다.
 * collector.ts/vod-analyzer.ts가 이미 연속 확정(같은 상태가 N회 연속 나와야 확정)을 거쳐서
 * 저장한 이벤트라, 여기서는 그대로 구간 경계로 믿고 쓴다. */
function buildVisionSegments(
  visionEvents: VisionEvent[],
  categorySegments: ActivitySegment[],
  start: number,
  end: number
): ActivitySegment[] {
  if (visionEvents.length === 0) return [];
  const sorted = [...visionEvents].sort((a, b) => a.time - b.time);
  const segments: ActivitySegment[] = [];

  if (sorted[0].time > start) {
    segments.push(visionSegmentFor(sorted[0], categorySegments, start, sorted[0].time));
  }
  for (let i = 0; i < sorted.length; i++) {
    const segStart = sorted[i].time;
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].time : end;
    if (segEnd <= segStart) continue;
    segments.push(visionSegmentFor(sorted[i], categorySegments, segStart, segEnd));
  }
  return segments;
}

interface QuietRange {
  start: number;
  end: number;
}

/** RestEvent(rest_start/rest_end 쌍)를 시간 범위 목록으로 정리한다. 아직 rest_end가 안
 * 온(=현재 진행 중인) rest_start는 end까지(지금까지) 이어지는 걸로 취급한다. */
function quietRangesFromRestEvents(restEvents: RestEvent[], end: number): QuietRange[] {
  const sorted = [...restEvents].sort((a, b) => a.time - b.time);
  const ranges: QuietRange[] = [];
  let openStart: number | null = null;
  for (const e of sorted) {
    if (e.state === "rest_start" && openStart === null) {
      openStart = e.time;
    } else if (e.state === "rest_end" && openStart !== null) {
      if (e.time > openStart) ranges.push({ start: openStart, end: e.time });
      openStart = null;
    }
  }
  if (openStart !== null && end > openStart) ranges.push({ start: openStart, end });
  return ranges;
}

/** 채팅량이 일정 시간 이상 눈에 띄게 잠잠해지는 구간을 찾는다 (RestEvent가 없을 때의 폴백). */
function quietRangesFromChatVolume(
  buckets: VolumeBucket[],
  bucketMs: number,
  quietMinBuckets: number = QUIET_MIN_BUCKETS
): QuietRange[] {
  if (buckets.length === 0) return [];

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const avg = total / buckets.length;
  const quietThreshold = Math.max(1, Math.round(avg * 0.2));

  // 잠잠한 버킷들을 이어 붙여서 "잠잠 구간" 후보를 만들고, 충분히 길게(quietMinBuckets
  // 이상) 이어진 것만 실제 휴식중 후보로 채택한다.
  const quietRanges: QuietRange[] = [];
  let runStart: number | null = null;
  let runLen = 0;
  for (const b of buckets) {
    if (b.count <= quietThreshold) {
      if (runStart === null) runStart = b.bucketStart;
      runLen++;
    } else {
      if (runStart !== null && runLen >= quietMinBuckets) {
        quietRanges.push({ start: runStart, end: b.bucketStart });
      }
      runStart = null;
      runLen = 0;
    }
  }
  if (runStart !== null && runLen >= quietMinBuckets) {
    const lastBucket = buckets[buckets.length - 1];
    quietRanges.push({ start: runStart, end: lastBucket.bucketStart + bucketMs });
  }
  return quietRanges;
}

/**
 * 게임중/대화중 구간 위에 "휴식중" 서브구간을 얹는다. RestEvent(로컬 화면 변화 감지 기반,
 * motion-detector.ts)가 하나라도 있으면 그쪽이 채팅량 추정보다 더 직접적인 신호라고 보고
 * 우선 사용하고, 없으면(구버전 세션 등) 기존 채팅량 기반 추정으로 조용히 폴백한다.
 */
function applyQuietSegments(
  baseSegments: ActivitySegment[],
  buckets: VolumeBucket[],
  bucketMs: number,
  restEvents: RestEvent[],
  quietMinBuckets: number = QUIET_MIN_BUCKETS
): ActivitySegment[] {
  if (baseSegments.length === 0) return baseSegments;

  const overallEnd = baseSegments[baseSegments.length - 1].end;
  const quietRanges =
    restEvents.length > 0
      ? quietRangesFromRestEvents(restEvents, overallEnd)
      : quietRangesFromChatVolume(buckets, bucketMs, quietMinBuckets);

  if (quietRanges.length === 0) return baseSegments;

  const result: ActivitySegment[] = [];
  for (const seg of baseSegments) {
    let cursor = seg.start;
    const overlaps = quietRanges
      .map((q) => ({ start: Math.max(q.start, seg.start), end: Math.min(q.end, seg.end) }))
      .filter((q) => q.end > q.start)
      .sort((a, b) => a.start - b.start);

    for (const q of overlaps) {
      if (q.start > cursor) result.push({ ...seg, start: cursor, end: q.start });
      result.push({ type: "휴식중", label: "휴식", start: q.start, end: q.end, estimated: true });
      cursor = q.end;
    }
    if (cursor < seg.end) result.push({ ...seg, start: cursor, end: seg.end });
  }

  return result;
}

/**
 * 너무 짧은 조각은 걸러내고, 인접한 동일 타입/라벨 구간은 하나로 합친다.
 *
 * 길이 필터에는 두 가지 예외가 있다.
 *  1) 맨 마지막 구간(=지금 진행 중인 상태): 방송 도중 실시간 조회 시 구간의 끝은 "지금"이라,
 *     상태가 막 바뀐 직후엔 이 구간이 아직 60초를 못 채운 상태다. 예외 없이 걸러내면 방금
 *     확정된 상태가 화면에서 사라지고 그 이전 상태로 되돌아가 보여서, 실제 로그(영상 분석
 *     결과 확정 시점)와 타임라인 화면 사이에 최대 60초 지연이 생긴다. 영상 분석 쪽은 이미
 *     collector.ts에서 같은 상태가 연속 2회 나와야만 로그를 남기는 디바운스를 거치므로,
 *     로그에 뜬 시점엔 이미 "확정된" 전환이라 마지막 구간까지 다시 걸러낼 필요가 없다.
 *  2) 휴식중 타입 구간(위치 무관): RestEvent 기반 휴식은 실제 자리비움 길이(보통 1분 안팎)를
 *     그대로 반영하는데, 이미 collector.ts에서 연속 확정 + 짧은 간격 재확인(버스트 체크)까지
 *     거쳐서 나온 신뢰할 수 있는 결과라 여기서 또 60초 미만이라고 걸러내면 "확정된 휴식이
 *     타임라인에 아예 안 찍히고 앞뒤 게임중/대화중 구간에 흡수돼서 사라지는" 문제가 생긴다.
 *     채팅량 기반 폴백 쪽은 원래도 QUIET_MIN_BUCKETS로 최소 길이가 보장되니 이 예외를 둬도
 *     잡음이 새로 생기지 않는다.
 * (그 외 진짜 짧은 조각들은 그대로 걸러진다.)
 */
function cleanupSegments(
  segments: ActivitySegment[],
  minSegmentMs: number = MIN_SEGMENT_MS
): ActivitySegment[] {
  if (segments.length === 0) return [];
  const lastIndex = segments.length - 1;
  const filtered = segments.filter((s, i) => {
    if (s.end <= s.start) return false; // 완전히 빈 조각은 항상 제거
    if (i === lastIndex) return true; // 예외 1: 마지막(=진행 중) 구간
    if (s.type === "휴식중") return true; // 예외 2: 휴식중은 이미 확정된 신호
    return s.end - s.start >= minSegmentMs;
  });
  if (filtered.length === 0) return segments.length > 0 ? [segments[0]] : [];

  const merged: ActivitySegment[] = [{ ...filtered[0] }];
  for (let i = 1; i < filtered.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = filtered[i];
    if (prev.type === cur.type && prev.label === cur.label && cur.start - prev.end < 1000) {
      prev.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export interface ActivitySegmentOptions {
  minSegmentMs?: number;
  quietMinBuckets?: number;
}

export function buildActivitySegments(
  events: CategoryEvent[],
  visionEvents: VisionEvent[],
  restEvents: RestEvent[],
  buckets: VolumeBucket[],
  start: number,
  end: number,
  bucketMs: number = DEFAULT_BUCKET_MS,
  opts: ActivitySegmentOptions = {}
): ActivitySegment[] {
  const categorySegments = buildCategorySegments(events, start, end);
  const baseSegments =
    visionEvents.length > 0 ? buildVisionSegments(visionEvents, categorySegments, start, end) : categorySegments;
  const withQuiet = applyQuietSegments(baseSegments, buckets, bucketMs, restEvents, opts.quietMinBuckets);
  return cleanupSegments(withQuiet, opts.minSegmentMs);
}

export function findHighlights(buckets: VolumeBucket[]): TimelineHighlight[] {
  if (buckets.length === 0) return [];
  const highlights: TimelineHighlight[] = [];

  const burst = buckets.reduce((a, b) => (b.count > a.count ? b : a));
  highlights.push({
    type: "burst",
    time: burst.bucketStart,
    label: "최고 채팅 폭발",
    detail: `${burst.count}건/분`,
  });

  const totalDonation = buckets.reduce((sum, b) => sum + b.donationAmount, 0);
  if (totalDonation > 0) {
    const donationBucket = buckets.reduce((a, b) => (b.donationAmount > a.donationAmount ? b : a));
    highlights.push({
      type: "donation",
      time: donationBucket.bucketStart,
      label: "최다 후원 구간",
      detail: `${donationBucket.donationAmount.toLocaleString()}원`,
    });
  } else {
    highlights.push({
      type: "donation",
      time: buckets[0].bucketStart,
      label: "최다 후원 구간",
      detail: "이번 방송엔 후원이 없었어요",
    });
  }

  // 방송 시작 전/끝난 후처럼 아예 채팅이 없던 버킷은 "조용한 구간"에서 제외한다.
  // (그런 버킷이 없다면 전체 중에서 고른다.)
  const activeBuckets = buckets.filter((b) => b.count > 0);
  const quietPool = activeBuckets.length > 0 ? activeBuckets : buckets;
  const quiet = quietPool.reduce((a, b) => (b.count < a.count ? b : a));
  highlights.push({
    type: "quiet",
    time: quiet.bucketStart,
    label: "가장 조용한 구간",
    detail: `${quiet.count}건/분`,
  });

  return highlights;
}

export function findSegmentForTime(segments: ActivitySegment[], time: number): ActivitySegment | undefined {
  return segments.find((s) => time >= s.start && time < s.end) ?? segments[segments.length - 1];
}

export function buildUserTimeline(
  messages: ChatMessage[],
  segments: ActivitySegment[],
  nickname: string
): UserTimeline | null {
  const userMsgs = messages
    .filter((m) => m.nickname === nickname)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (userMsgs.length === 0) return null;

  const activityCounts = new Map<ActivityType, number>();
  const entries = userMsgs.map((m) => {
    const seg = findSegmentForTime(segments, m.timestamp);
    const type: ActivityType = seg?.type ?? "대화중";
    activityCounts.set(type, (activityCounts.get(type) ?? 0) + 1);
    return {
      time: m.timestamp,
      message: m.message,
      activityType: type,
      isDonation: m.isDonation,
      donationAmount: m.donationAmount,
    };
  });

  let mainActivity: ActivityType = "대화중";
  let mainCount = -1;
  for (const [type, count] of activityCounts) {
    if (count > mainCount) {
      mainActivity = type;
      mainCount = count;
    }
  }

  const donationAmount = userMsgs.reduce(
    (sum, m) => sum + (m.isDonation ? m.donationAmount ?? 0 : 0),
    0
  );

  return {
    nickname,
    userIdHash: userMsgs[0].userIdHash,
    totalMessages: userMsgs.length,
    firstMessageAt: userMsgs[0].timestamp,
    lastMessageAt: userMsgs[userMsgs.length - 1].timestamp,
    donationAmount,
    mainActivity,
    messages: entries,
  };
}

export interface TimelineBuildOptions {
  /** 채팅량 집계 기본 단위시간 (ms). 방송이 길면 자동으로 더 커질 수 있음 (pickBucketMs 참고) */
  bucketMs?: number;
  /** 이보다 짧은 활동 구간은 잡음으로 보고 병합/제거 (ms) */
  minSegmentMs?: number;
  /** 채팅량 기반 휴식 추정 시 최소 연속 잠잠 버킷 수 */
  quietMinBuckets?: number;
}

export function buildTimeline(
  session: BroadcastSession,
  messages: ChatMessage[],
  events: CategoryEvent[],
  visionEvents: VisionEvent[] = [],
  restEvents: RestEvent[] = [],
  opts: TimelineBuildOptions = {}
): TimelineData {
  const start = session.startedAt;
  const end = session.endedAt ?? Date.now();
  const bucketMs = pickBucketMs(end - start, opts.bucketMs);

  const volumeBuckets = buildVolumeBuckets(messages, start, end, bucketMs);
  const segments = buildActivitySegments(events, visionEvents, restEvents, volumeBuckets, start, end, bucketMs, {
    minSegmentMs: opts.minSegmentMs,
    quietMinBuckets: opts.quietMinBuckets,
  });
  const highlights = findHighlights(volumeBuckets);

  // 게임중/대화중 판단 근거 우선순위: 영상 분석(vision, 있으면 항상 우선) > 카테고리 > 정보 없음.
  const activitySource: TimelineData["activitySource"] =
    visionEvents.length > 0 ? "vision" : events.length > 0 ? "category" : "none";
  // 휴식중 판단 근거 우선순위: motion-detector.ts 기반 RestEvent(가장 직접적인 신호) >
  // 영상 분석(먹방 등 motion으로 못 잡는 케이스 보완) > 채팅량 추정(폴백) > 정보 없음.
  const restSource: TimelineData["restSource"] = restEvents.length > 0
    ? "motion"
    : visionEvents.some((v) => v.activityType === "휴식중")
    ? "vision"
    : volumeBuckets.length > 0
    ? "chat"
    : "none";

  return {
    sessionStart: start,
    sessionEnd: end,
    bucketMs,
    segments,
    volumeBuckets,
    highlights,
    hasCategoryInfo: events.length > 0,
    topUsers: topChatters(messages, 12),
    activitySource,
    restSource,
  };
}
