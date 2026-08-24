import type {
  ChatMessage,
  TopChatter,
  WordFrequency,
  ChatSpeedBucket,
  MoodSummary,
} from "./types";
import { tokenizeNouns } from "./kiwi-tokenizer";

// 기본은 정규식 기반 토큰화(형태소 분석기 없이 대충 자르는 수준). Kiwi 모델이 설치돼
// 있으면(`npm run setup:kiwi`) wordFrequency()가 자동으로 이쪽 대신 명사 추출 결과를 쓴다.
const STOPWORDS = new Set([
  "이거", "저거", "그거", "나는", "저는", "너는", "우리", "진짜", "그냥",
  "근데", "그리고", "이제", "지금", "오늘", "그래서", "그래", "아니",
  "네", "예", "응", "음", "아", "어", "요", "다", "은", "는", "이", "가",
  "을", "를", "에", "의", "도", "만", "고", "게", "좀", "왜", "뭐", "다시",
  "합니다", "해요", "했어요", "그런데", "이번", "정말", "완전",
]);

const LAUGH_REGEX = /[ㅋㅎ]{2,}/g;
const SHOCK_REGEX = /[ㄷ]{2,}/g;
const EXCLAIM_REGEX = /[!?]{1,}/g;
const URL_REGEX = /https?:\/\/\S+/g;
const EMOJI_TAG_REGEX = /\{:[^}]+:\}/g; // 치지직 커스텀 이모티콘 표기

// 형태소 분석 없이 키워드 매칭만으로 대충 분류하는 감정 사전. 정확한 감정분석이 아니라
// "대충 훈훈했는지 싸했는지" 정도의 느낌만 잡는 용도. 오탐이 꽤 있을 수 있음(MVP 한계).
const POSITIVE_WORDS = [
  "좋다", "좋아", "최고", "대박", "굿", "감사", "고마워", "사랑", "재밌",
  "재미있", "웃기", "축하", "화이팅", "파이팅", "응원", "잘한다", "잘하네",
  "미쳤다", "떡상", "인정", "귀엽", "예쁘", "짱", "완벽", "훈훈",
];
const NEGATIVE_WORDS = [
  "싫다", "싫어", "별로", "짜증", "화남", "최악", "지루", "노잼", "실망",
  "아쉽", "구려", "구리", "답답", "화나", "짜증나", "욕", "꺼져", "저격",
  "선넘", "역겹", "재미없",
];

function containsAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

function tokenize(message: string): string[] {
  const cleaned = message
    .replace(URL_REGEX, "")
    .replace(EMOJI_TAG_REGEX, "")
    .replace(LAUGH_REGEX, " ")
    .replace(SHOCK_REGEX, " ")
    .trim();

  return cleaned
    .split(/[\s,.!?~^_\-()\[\]"'“”·|/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export function topChatters(messages: ChatMessage[], limit = 10): TopChatter[] {
  const counts = new Map<string, TopChatter>();
  for (const m of messages) {
    const existing = counts.get(m.userIdHash);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(m.userIdHash, {
        userIdHash: m.userIdHash,
        nickname: m.nickname,
        count: 1,
      });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export function topDonators(messages: ChatMessage[], limit = 5): TopChatter[] {
  const counts = new Map<string, TopChatter>();
  for (const m of messages) {
    if (!m.isDonation) continue;
    const existing = counts.get(m.userIdHash);
    if (existing) {
      existing.count += m.donationAmount ?? 0;
    } else {
      counts.set(m.userIdHash, {
        userIdHash: m.userIdHash,
        nickname: m.nickname,
        count: m.donationAmount ?? 0,
      });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export async function wordFrequency(
  messages: ChatMessage[],
  limit = 20
): Promise<WordFrequency[]> {
  // Kiwi 모델이 설치돼 있는지 한 번만 확인(내부적으로 초기화 결과를 캐시하므로 메시지마다
  // 반복 확인하는 비용은 없다). 있으면 명사만 추출, 없으면 기존 정규식 방식을 그대로 씀.
  const kiwiAvailable = (await tokenizeNouns("")) !== null;

  const counts = new Map<string, number>();
  for (const m of messages) {
    const tokens = kiwiAvailable ? (await tokenizeNouns(m.message)) ?? [] : tokenize(m.message);
    for (const token of tokens) {
      if (STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function chatSpeedTimeline(
  messages: ChatMessage[],
  bucketSeconds = 60
): ChatSpeedBucket[] {
  if (messages.length === 0) return [];
  const bucketMs = bucketSeconds * 1000;
  const start = messages[0].timestamp;
  const buckets = new Map<number, number>();

  for (const m of messages) {
    const bucketStart = start + Math.floor((m.timestamp - start) / bucketMs) * bucketMs;
    buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .map(([bucketStart, count]) => ({ bucketStart, count }))
    .sort((a, b) => a.bucketStart - b.bucketStart);
}

export function analyzeMood(messages: ChatMessage[]): MoodSummary {
  if (messages.length === 0) {
    return {
      label: "데이터 없음",
      emoji: "💭",
      subtitle: "채팅 기록이 없습니다.",
      laughRatio: 0,
      exclaimRatio: 0,
      positivePct: 0,
      neutralPct: 100,
      negativePct: 0,
      peakMoments: [],
      note: "채팅 기록이 없습니다.",
    };
  }

  let laughCount = 0;
  let exclaimCount = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const m of messages) {
    const isLaugh = LAUGH_REGEX.test(m.message);
    if (isLaugh) laughCount += 1;
    if (EXCLAIM_REGEX.test(m.message)) exclaimCount += 1;
    // regex에 /g 플래그가 있으면 lastIndex가 남아서 다음 test가 틀어질 수 있으므로 매번 리셋
    LAUGH_REGEX.lastIndex = 0;
    EXCLAIM_REGEX.lastIndex = 0;

    // 감정 분류: 웃음 표현도 긍정으로 취급, 그 다음 키워드 사전으로 판별
    if (isLaugh || containsAny(m.message, POSITIVE_WORDS)) {
      positiveCount += 1;
    } else if (containsAny(m.message, NEGATIVE_WORDS)) {
      negativeCount += 1;
    }
  }

  const laughRatio = laughCount / messages.length;
  const exclaimRatio = exclaimCount / messages.length;

  // 반올림하다보면 합이 100이 안 될 수 있어서, neutral을 나머지로 채워서 항상 100이 되게 함
  const positivePct = Math.round((positiveCount / messages.length) * 100);
  const negativePct = Math.round((negativeCount / messages.length) * 100);
  const neutralPct = Math.max(0, 100 - positivePct - negativePct);

  const timeline = chatSpeedTimeline(messages, 60);
  const avg = timeline.reduce((sum, b) => sum + b.count, 0) / (timeline.length || 1);
  const peakMoments = timeline
    .filter((b) => b.count > avg * 2 && b.count >= 5)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  let label: string;
  let emoji: string;
  let subtitle: string;

  if (negativePct > 30) {
    label = "다소 시끄러움";
    emoji = "😕";
    subtitle = "부정적인 반응이 꽤 있었어요";
  } else if (laughRatio > 0.3) {
    label = "웃음 폭발";
    emoji = "🤣";
    subtitle = "웃음 표현이 아주 많았어요";
  } else if (laughRatio > 0.15 || positivePct > 40) {
    label = "화기애애";
    emoji = "😄";
    subtitle = "긍정적인 반응이 많았어요";
  } else if (exclaimRatio > 0.25) {
    label = "텐션 높음";
    emoji = "🔥";
    subtitle = "채팅 텐션이 계속 높았어요";
  } else if (avg < 1) {
    label = "잔잔함";
    emoji = "😌";
    subtitle = "차분하게 흘러간 방송이었어요";
  } else {
    label = "무난한 분위기";
    emoji = "🙂";
    subtitle = "특별한 굴곡 없이 무난했어요";
  }

  const note = `채팅 ${messages.length}개 중 웃음 표현 비율 ${(laughRatio * 100).toFixed(
    1
  )}%, 긍정 ${positivePct}% · 중립 ${neutralPct}% · 부정 ${negativePct}%, 하이라이트 구간 ${peakMoments.length}곳 감지됨.`;

  return {
    label,
    emoji,
    subtitle,
    laughRatio,
    exclaimRatio,
    positivePct,
    neutralPct,
    negativePct,
    peakMoments,
    note,
  };
}
