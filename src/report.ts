import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import type {
  ActivityBreakdown,
  ActivitySegment,
  ActivityType,
  BroadcastSession,
  CategoryEvent,
  ChatMessage,
  DonationInsight,
  EngagementSummary,
  GameBreakdown,
  HighlightQuote,
  RestEvent,
  SessionReport,
  TimelineHighlight,
  TopChatter,
  VisionEvent,
} from "./types";
import {
  topChatters,
  topDonators,
  wordFrequency,
  analyzeMood,
} from "./analyzer";
import { buildTimeline, findSegmentForTime } from "./timeline";
import { generateAiMoodComment } from "./mood-llm";

const ACTIVITY_ORDER: ActivityType[] = ["게임중", "대화중", "휴식중"];

/** 활동 구간(게임중/대화중/휴식중)별 총 시간(분)을 구한다. */
function summarizeActivity(segments: ActivitySegment[]): ActivityBreakdown[] {
  const totals = new Map<ActivityType, number>(ACTIVITY_ORDER.map((t) => [t, 0]));
  for (const seg of segments) {
    totals.set(seg.type, (totals.get(seg.type) ?? 0) + (seg.end - seg.start));
  }
  return ACTIVITY_ORDER.map((type) => ({ type, minutes: Math.round((totals.get(type) ?? 0) / 60000) })).filter(
    (b) => b.minutes > 0
  );
}

/** 게임중 구간을 게임명(라벨)별로 묶어서 시간(분)이 많은 순으로 정렬한다. */
function summarizeGames(segments: ActivitySegment[]): GameBreakdown[] {
  const totals = new Map<string, number>();
  for (const seg of segments) {
    if (seg.type !== "게임중") continue;
    totals.set(seg.label, (totals.get(seg.label) ?? 0) + (seg.end - seg.start));
  }
  return [...totals.entries()]
    .map(([label, ms]) => ({ label, minutes: Math.round(ms / 60000) }))
    .filter((g) => g.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

/** 채팅 집중도(상위 10명 비중)와 "눈팅형"(1회만 채팅) 시청자 비율을 계산한다. */
function summarizeEngagement(messages: ChatMessage[], top10: TopChatter[]): EngagementSummary {
  if (messages.length === 0) {
    return { topSharePct: 0, oneTimeChatterCount: 0, oneTimeChatterPct: 0 };
  }
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.userIdHash, (counts.get(m.userIdHash) ?? 0) + 1);

  const top10Total = top10.reduce((sum, c) => sum + c.count, 0);
  const topSharePct = Math.round((top10Total / messages.length) * 100);

  const uniqueCount = counts.size;
  const oneTimeChatterCount = [...counts.values()].filter((c) => c === 1).length;
  const oneTimeChatterPct = uniqueCount > 0 ? Math.round((oneTimeChatterCount / uniqueCount) * 100) : 0;

  return { topSharePct, oneTimeChatterCount, oneTimeChatterPct };
}

/** 후원이 어떤 활동 구간에 몰렸는지, 후원자와 채팅왕이 겹치는 사람인지를 본다. */
function summarizeDonations(
  messages: ChatMessage[],
  segments: ActivitySegment[],
  top10: TopChatter[],
  top5Donators: TopChatter[]
): DonationInsight {
  const byActivity = new Map<ActivityType, number>(ACTIVITY_ORDER.map((t) => [t, 0]));
  for (const m of messages) {
    if (!m.isDonation || !m.donationAmount) continue;
    const seg = segments.length > 0 ? findSegmentForTime(segments, m.timestamp) : undefined;
    const type: ActivityType = seg?.type ?? "대화중";
    byActivity.set(type, (byActivity.get(type) ?? 0) + m.donationAmount);
  }

  const chattyIds = new Set(top10.map((c) => c.userIdHash));
  const topDonatorsAlsoChatty = top5Donators.filter((d) => chattyIds.has(d.userIdHash)).length;

  return {
    byActivity: ACTIVITY_ORDER.map((type) => ({ type, amount: byActivity.get(type) ?? 0 })).filter(
      (b) => b.amount > 0
    ),
    topDonatorsAlsoChatty,
  };
}

/**
 * 하이라이트 구간(채팅 폭발/최다 후원)에서 실제로 오간 채팅 몇 줄을 발췌한다. "조용한 구간"은
 * 발췌할 만한 채팅이 마땅치 않아 제외한다. 어디까지나 근사치 추출이라, 정말 그 순간의 맥락을
 * 대표하는 채팅인지는 사람이 리포트를 보고 판단해야 한다.
 */
function pickHighlightQuotes(messages: ChatMessage[], highlights: TimelineHighlight[]): HighlightQuote[] {
  const quotes: HighlightQuote[] = [];
  for (const h of highlights) {
    if (h.type === "quiet") continue;
    const windowEnd = h.time + 60_000; // 하이라이트는 1분 버킷 단위라 그 1분 구간을 그대로 본다
    const inWindow = messages
      .filter((m) => m.timestamp >= h.time && m.timestamp < windowEnd)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (inWindow.length === 0) continue;

    let picked: ChatMessage[];
    if (h.type === "donation") {
      // 후원 구간은 실제 후원 메시지를 우선으로 넣고, 자리가 남으면 주변 반응으로 채운다.
      const donations = inWindow.filter((m) => m.isDonation);
      const reactions = inWindow.filter((m) => !m.isDonation);
      picked = [...donations, ...reactions].slice(0, 3).sort((a, b) => a.timestamp - b.timestamp);
    } else {
      // 채팅 폭발 구간은 짧은 웃음 표현만 나열되면 밋밋해서, 조금 더 내용 있는(긴) 메시지를
      // 우선 고르되 다시 시간순으로 정렬해서 보여준다.
      picked = [...inWindow]
        .sort((a, b) => b.message.length - a.message.length)
        .slice(0, 3)
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    quotes.push({
      contextLabel: h.label,
      time: h.time,
      quotes: picked.map((m) => ({
        time: m.timestamp,
        nickname: m.nickname,
        message: m.message,
        isDonation: m.isDonation,
      })),
    });
  }
  return quotes;
}

// wordFrequency가 Kiwi 형태소 분석기를 쓸 수도 있어서(선택 사항, 비동기) async로 뒀다.
// 호출부(collector.ts, demo.ts)는 이미 await 가능한 위치에서 부르고 있어서 문제 없음.
//
// categoryEvents/visionEvents/restEvents는 타임라인 탭과 동일한 데이터를 재사용해서 "방송
// 흐름 요약"(게임중/대화중/휴식중 시간 분배)을 만드는 데 쓴다. 전부 선택 인자라, 이 정보가
// 없는 예전 세션이나 데모 데이터를 넘겨도 그냥 "정보 없음"/채팅량 추정 취급되고 나머지는
// 정상 동작한다.
export interface ReportBuildOptions {
  timelineBucketMs?: number;
  timelineMinSegmentMs?: number;
  timelineQuietMinBuckets?: number;
  /** AI 분위기 요약(자연어 총평)에 보낼 채팅 최대 샘플 개수. API 키가 없으면 어차피 안 쓰임. */
  moodMaxSampleMessages?: number;
}

export async function buildReport(
  session: BroadcastSession,
  messages: ChatMessage[],
  categoryEvents: CategoryEvent[] = [],
  visionEvents: VisionEvent[] = [],
  restEvents: RestEvent[] = [],
  opts: ReportBuildOptions = {}
): Promise<SessionReport> {
  const uniqueChatters = new Set(messages.map((m) => m.userIdHash)).size;
  const durationMinutes = session.endedAt
    ? Math.round((session.endedAt - session.startedAt) / 60000)
    : 0;

  const totalDonationAmount = messages.reduce(
    (sum, m) => sum + (m.isDonation ? m.donationAmount ?? 0 : 0),
    0
  );

  const top10 = topChatters(messages, 10);
  const top5Donators = topDonators(messages, 5);

  const timeline = buildTimeline(session, messages, categoryEvents, visionEvents, restEvents, {
    bucketMs: opts.timelineBucketMs,
    minSegmentMs: opts.timelineMinSegmentMs,
    quietMinBuckets: opts.timelineQuietMinBuckets,
  });
  const activityBreakdown = summarizeActivity(timeline.segments);
  const gameBreakdown = summarizeGames(timeline.segments);
  const engagement = summarizeEngagement(messages, top10);
  const donationInsight = summarizeDonations(messages, timeline.segments, top10, top5Donators);
  const highlightQuotes = pickHighlightQuotes(messages, timeline.highlights);

  const mood = analyzeMood(messages);
  const maxSample = opts.moodMaxSampleMessages ?? 200;
  const sampleMessages = messages.slice(-maxSample);
  mood.aiComment = await generateAiMoodComment({
    channelName: session.channelName,
    durationMinutes,
    totalMessages: messages.length,
    uniqueChatters,
    totalDonationAmount,
    activityBreakdown: summarizeActivity(timeline.segments),
    engagement,
    donationInsight,
    sampleMessages,
  });

  return {
    session,
    totalMessages: messages.length,
    uniqueChatters,
    durationMinutes,
    topChatters: top10,
    topWords: await wordFrequency(messages, 20),
    mood,
    topDonators: top5Donators,
    totalDonationAmount,
    activityBreakdown,
    gameBreakdown,
    activitySource: timeline.activitySource,
    restSource: timeline.restSource,
    hasTimelineData: timeline.hasCategoryInfo,
    engagement,
    donationInsight,
    highlightQuotes,
  };
}

export function renderMarkdown(report: SessionReport): string {
  const { session, mood } = report;
  const lines: string[] = [];

  lines.push(`# 📊 방송 리포트 — ${session.channelName}`);
  lines.push("");
  lines.push(
    `- 방송 시작: ${dayjs(session.startedAt).format("YYYY-MM-DD HH:mm")}`
  );
  lines.push(
    `- 방송 종료: ${
      session.endedAt ? dayjs(session.endedAt).format("YYYY-MM-DD HH:mm") : "진행중"
    }`
  );
  lines.push(`- 방송 시간: ${report.durationMinutes}분`);
  lines.push(`- 총 채팅 수: ${report.totalMessages}개`);
  lines.push(`- 참여 시청자 수: ${report.uniqueChatters}명`);
  lines.push("");

  if (report.activityBreakdown.length > 0) {
    lines.push("## 🎮 방송 흐름 요약");
    lines.push("");
    const sourceLabel =
      report.activitySource === "vision"
        ? "🎥 영상 분석 기반"
        : report.activitySource === "category"
        ? "📋 카테고리(스트리머 자진 신고) 기반"
        : "정보 없음 (추정치)";
    const restSourceLabel =
      report.restSource === "motion"
        ? "🖼 화면 변화 감지 기반"
        : report.restSource === "vision"
        ? "🎥 영상 분석 기반 (먹방 등)"
        : report.restSource === "chat"
        ? "💬 채팅량 추정"
        : "정보 없음";
    lines.push(`_게임중/대화중 구분 판단 근거: ${sourceLabel} · 휴식중 판단 근거: ${restSourceLabel}_`);
    lines.push("");
    lines.push(report.activityBreakdown.map((b) => `${b.type} ${b.minutes}분`).join(" · "));
    if (report.gameBreakdown.length > 0) {
      lines.push("");
      lines.push(
        "게임별로는 " + report.gameBreakdown.map((g) => `${g.label} ${g.minutes}분`).join(", ") + "."
      );
    }
    lines.push("");
  }

  lines.push(`## ${mood.emoji} 방송 분위기: ${mood.label}`);
  lines.push("");
  lines.push(mood.subtitle);
  lines.push("");
  lines.push(
    `긍정 ${mood.positivePct}% · 중립 ${mood.neutralPct}% · 부정 ${mood.negativePct}%`
  );
  lines.push("");
  lines.push(mood.note);
  if (mood.aiComment) {
    lines.push("");
    lines.push(`_${mood.aiComment}_`);
  }
  if (mood.peakMoments.length > 0) {
    lines.push("");
    lines.push("**하이라이트 구간 (채팅이 몰린 시간대)**");
    for (const peak of mood.peakMoments) {
      lines.push(
        `- ${dayjs(peak.bucketStart).format("HH:mm")} 경 — ${peak.count}개 채팅`
      );
    }
  }
  lines.push("");

  lines.push("## 🏆 채팅왕 TOP 10");
  lines.push("");
  if (report.topChatters.length === 0) {
    lines.push("_데이터 없음_");
  } else {
    lines.push("| 순위 | 닉네임 | 채팅 수 |");
    lines.push("|---|---|---|");
    report.topChatters.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.nickname} | ${c.count} |`);
    });
  }
  lines.push("");

  lines.push("## 👥 시청자 참여 구조");
  lines.push("");
  lines.push(`채팅왕 TOP 10이 전체 채팅의 ${report.engagement.topSharePct}%를 차지했어요.`);
  if (report.engagement.oneTimeChatterCount > 0) {
    lines.push(
      `전체 참여자 중 ${report.engagement.oneTimeChatterCount}명(${report.engagement.oneTimeChatterPct}%)은 ` +
        `방송 중 딱 한 번만 채팅했어요.`
    );
  }
  lines.push("");

  if (report.topDonators.length > 0) {
    lines.push(`## 💰 후원 TOP 5 (총 ${report.totalDonationAmount.toLocaleString()}원)`);
    lines.push("");
    lines.push("| 순위 | 닉네임 | 후원 금액 |");
    lines.push("|---|---|---|");
    report.topDonators.forEach((d, i) => {
      lines.push(`| ${i + 1} | ${d.nickname} | ${d.count.toLocaleString()}원 |`);
    });
    lines.push("");

    if (report.donationInsight.byActivity.length > 0 || report.donationInsight.topDonatorsAlsoChatty > 0) {
      lines.push("**후원과 방송 흐름**");
      lines.push("");
      if (report.donationInsight.byActivity.length > 0) {
        lines.push(
          report.donationInsight.byActivity.map((b) => `${b.type} ${b.amount.toLocaleString()}원`).join(" · ")
        );
        lines.push("");
      }
      if (report.donationInsight.topDonatorsAlsoChatty > 0) {
        lines.push(
          `후원 TOP 5 중 ${report.donationInsight.topDonatorsAlsoChatty}명은 채팅왕 TOP 10에도 이름을 올렸어요.`
        );
        lines.push("");
      }
    }
  }

  if (report.highlightQuotes.length > 0) {
    lines.push("## 🎬 그 순간 채팅");
    lines.push("");
    for (const hq of report.highlightQuotes) {
      lines.push(`**${hq.contextLabel} (${dayjs(hq.time).format("HH:mm")} 경)**`);
      lines.push("");
      for (const q of hq.quotes) {
        const prefix = q.isDonation ? "💰 " : "";
        lines.push(`> ${prefix}${q.nickname}: ${q.message}`);
      }
      lines.push("");
    }
  }

  lines.push("## 💬 자주 나온 단어 TOP 20");
  lines.push("");
  if (report.topWords.length === 0) {
    lines.push("_데이터 없음_");
  } else {
    lines.push(
      report.topWords.map((w) => `\`${w.word}\`(${w.count})`).join(", ")
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** 채널명을 파일명에 넣기 전에 OS가 허용하지 않는 문자를 정리한다. 채널명은 치지직에서
 * 스트리머가 정한 값이라 어떤 문자가 올지 우리가 통제할 수 없는데, Windows 금지 문자
 * (\/:*?"<>|)나 제어 문자가 섞여 있으면 저장 자체가 실패하거나(EINVAL), 경로 구분자(/,\)가
 * 들어있으면 reports/ 바깥의 엉뚱한 위치에 쓰일 수 있다. */
export function sanitizeFilenamePart(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return cleaned || "채널";
}

export function saveReport(report: SessionReport, outDir: string): string {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = `${sanitizeFilenamePart(report.session.channelName)}_${dayjs(
    report.session.startedAt
  ).format("YYYYMMDD_HHmm")}.md`;
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, renderMarkdown(report), "utf-8");
  return filePath;
}
