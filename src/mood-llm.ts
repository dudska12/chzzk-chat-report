// (선택 기능) 채팅 로그 샘플과 방송 흐름 요약을 Claude API에 보내서, 정규식/키워드 기반
// analyzeMood()보다 훨씬 자연스러운 자연어 총평(4~6문장)을 만든다. API 키가 없으면 이 파일의
// 함수는 아예 호출되지 않거나(config.getAnthropicApiKey()가 undefined) 호출부가 undefined를
// 받고 조용히 넘어가서, 이 기능이 꺼져 있어도 리포트 생성 자체는 항상 정상적으로 끝난다.
import type {
  ActivityBreakdown,
  ChatMessage,
  DonationInsight,
  EngagementSummary,
} from "./types";
import { getAnthropicApiKey, getAnthropicModel } from "./config";

export interface MoodCommentContext {
  channelName: string;
  durationMinutes: number;
  totalMessages: number;
  uniqueChatters: number;
  totalDonationAmount: number;
  activityBreakdown: ActivityBreakdown[];
  engagement: EngagementSummary;
  donationInsight: DonationInsight;
  /** 이미 maxSampleMessages개로 잘라서 넘겨야 한다 (샘플링은 호출부인 report.ts 책임). */
  sampleMessages: ChatMessage[];
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 500;

function buildPrompt(ctx: MoodCommentContext): string {
  const activityLine =
    ctx.activityBreakdown.length > 0
      ? ctx.activityBreakdown.map((b) => `${b.type} ${b.minutes}분`).join(", ")
      : "정보 없음";
  const donationLine =
    ctx.donationInsight.byActivity.length > 0
      ? ctx.donationInsight.byActivity.map((b) => `${b.type} ${b.amount.toLocaleString()}원`).join(", ")
      : "없음";
  const chatSample = ctx.sampleMessages
    .map((m) => `[${m.isDonation ? "후원" : "채팅"}] ${m.nickname}: ${m.message}`)
    .join("\n");

  return `아래는 치지직(CHZZK) 스트리머 "${ctx.channelName}"의 방송 데이터입니다. 이 데이터를
바탕으로 "이 방송이 어떻게 흘러갔는지"를 4~6문장 정도의 자연스러운 한국어 문단으로 써주세요.
숫자를 단순 나열하지 말고, 실제로 방송을 본 사람이 요약해주듯 자연스럽게 서술해주세요.
과장하거나 없는 사실을 지어내지 마세요. 마크다운 문법(굵게, 목록 등)은 쓰지 말고 순수
텍스트 문단으로만 답하세요.

- 방송 시간: ${ctx.durationMinutes}분
- 총 채팅 수: ${ctx.totalMessages}개, 참여 시청자 ${ctx.uniqueChatters}명
- 채팅왕 TOP10 집중도: ${ctx.engagement.topSharePct}%, 1회만 채팅한 시청자 비율: ${ctx.engagement.oneTimeChatterPct}%
- 활동 구간: ${activityLine}
- 총 후원: ${ctx.totalDonationAmount.toLocaleString()}원 (활동별: ${donationLine})

실제 채팅 샘플(시간순 아님, 발췌):
${chatSample || "(채팅 샘플 없음)"}

위 내용을 참고해서 방송 분위기/흐름에 대한 자연어 총평만 답하세요. 다른 설명이나 인사말은
붙이지 마세요.`;
}

/** Claude API로 자연어 방송 총평을 생성한다. API 키가 없거나 요청이 실패하면 undefined를
 * 돌려주고, 호출부(report.ts)는 이 경우 mood.aiComment를 그냥 비워둔다 — 리포트의 다른
 * 부분에는 영향이 없다. */
export async function generateAiMoodComment(ctx: MoodCommentContext): Promise<string | undefined> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return undefined;
  const model = getAnthropicModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: buildPrompt(ctx) }],
      }),
    });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
