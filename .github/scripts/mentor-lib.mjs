// mentor-lib.mjs
// 4개의 진입 스크립트(pr-open-review, pr-reply, full-review-start, issue-reply)가
// 공유하는 공통 로직: Claude 호출, 라운드 마커 파싱, 프롬프트 빌더.
import { readFileSync } from "node:fs";

// ---- 설정값 (필요하면 이 파일 안에서만 바꾸면 됨) ----
export const MAX_ROUNDS = Number(process.env.MENTOR_MAX_ROUNDS || 3); // 꼬리질문 최대 횟수
export const MODEL = process.env.MENTOR_MODEL || "claude-haiku-4-5-20251001";
export const MARKER_PREFIX = "mentor-bot:v1";

// 리뷰 대상에서 제외할 경로 패턴 (락파일/빌드산출물/이미지 등)
export const EXCLUDE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^node_modules\//,
  /\.(png|jpg|jpeg|gif|svg|webp|ico|lock|min\.js|map)$/,
];

export function isExcludedPath(path) {
  return EXCLUDE_PATTERNS.some((re) => re.test(path));
}

// ---- 마커: 각 봇 댓글 끝에 숨겨서 붙이는 HTML 주석 ----
// round: 이 댓글이 몇 번째 질문인지, done: 마무리 댓글인지 여부
export function buildMarker({ round, done }) {
  return `<!-- ${MARKER_PREFIX}:round=${round}:done=${done ? "1" : "0"} -->`;
}

const MARKER_RE = new RegExp(
  `<!--\\s*${MARKER_PREFIX}:round=(\\d+):done=([01])\\s*-->`
);

export function parseMarker(body = "") {
  const m = body.match(MARKER_RE);
  if (!m) return null;
  return { round: Number(m[1]), done: m[2] === "1" };
}

export function stripMarker(body = "") {
  return body.replace(MARKER_RE, "").trim();
}

// ---- Claude API 호출 ----
export async function callClaude({ system, messages, maxTokens = 500 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 시크릿이 설정되어 있지 않습니다.");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API 오류 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const block = data.content?.find((b) => b.type === "text");
  return block?.text?.trim() || "";
}

// 오프닝 질문(멘토가 처음 코드를 보고 던지는 질문) 생성용 시스템 프롬프트
export const OPENING_SYSTEM_PROMPT = `너는 신입/주니어 개발자를 지도하는 시니어 개발자(사수)야.
후배가 작성한 코드를 보고, 정답이나 수정 방법을 바로 알려주지 말고, 코드의 "의도"를 스스로 설명하게 만드는 질문을 1~2개 던져.
예시 톤: "이 부분 왜 이렇게 짰어? 의도가 뭐야?", "이 조건문은 어떤 케이스를 막으려고 넣은거야?"
규칙:
- 정답이나 개선 코드를 절대 먼저 제시하지 마.
- 친근하지만 진지한 사수 말투(반말, 너무 딱딱하지 않게)로 짧게 써.
- 정말 짚을 부분이 없으면 "여긴 딱히 물어볼 거 없이 깔끔하네" 같은 짧은 코멘트만 남겨.
- 코드 스니펫을 인용할 땐 마크다운 코드블록을 써도 좋아.
- 전체 3~6문장 이내로, 실제 PR 댓글처럼 자연스럽게 작성해.`;

// 꼬리질문/마무리 판단용 시스템 프롬프트 (JSON 출력 강제)
export const FOLLOWUP_SYSTEM_PROMPT = `너는 신입/주니어 개발자를 지도하는 시니어 개발자(사수)야.
아래에는 너(사수)와 후배 사이의 코드 리뷰 대화 기록이 주어져.
후배의 마지막 답변을 보고 판단해:
- 후배가 의도를 충분히 설명했고 이해가 확인되면: 짧게 인정/격려하는 코멘트로 마무리해.
- 아직 설명이 부족하거나 더 깊게 생각해볼 지점이 있으면: 이전 질문과 겹치지 않는 자연스러운 꼬리질문을 1개 던져.
규칙:
- 정답이나 개선 코드를 절대 먼저 제시하지 마.
- 친근하지만 진지한 사수 말투(반말)로 짧게 써 (2~4문장).
- 반드시 아래 JSON 형식으로만 응답해. 다른 텍스트를 앞뒤에 붙이지 마:
{"done": true|false, "message": "실제로 댓글에 올릴 텍스트"}`;

export function buildOpeningUserMessage({ context, diffOrCode }) {
  return `${context}\n\n다음 코드를 보고 사수처럼 질문해줘:\n\n${diffOrCode}`;
}

export function buildFollowupUserMessage({ context, history }) {
  const historyText = history
    .map((h) => `${h.role === "mentor" ? "사수" : "후배"}: ${h.text}`)
    .join("\n\n");
  return `${context}\n\n지금까지의 대화:\n\n${historyText}\n\n위 판단 규칙에 따라 JSON으로 응답해.`;
}

// 텍스트를 대략적인 토큰/글자수로 잘라서 API 비용과 컨텍스트 길이를 통제
export function truncate(text, maxChars = 8000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(생략됨)...";
}

// ---- GitHub REST API 헬퍼 (raw fetch, 별도 패키지 설치 불필요) ----
const GH_API = "https://api.github.com";

export function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN 환경변수가 없습니다.");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "content-type": "application/json",
  };
}

export async function ghGet(path) {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Link 헤더를 따라가며 전체 페이지를 모으는 GET (댓글/파일 목록 등)
export async function ghGetAll(path) {
  let url = `${GH_API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const items = [];
  while (url) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      throw new Error(`GitHub GET ${url} 실패 (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    items.push(...data);
    const link = res.headers.get("link") || "";
    const next = link.split(",").find((p) => p.includes('rel="next"'));
    url = next ? next.split(";")[0].trim().replace(/^<|>$/g, "") : null;
  }
  return items;
}

export async function ghPost(path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub POST ${path} 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

export function repoOwnerAndName() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  return { owner, repo };
}

// ---- 라운드/마무리 판단이 필요한 "답장" 흐름 공통 로직 ----
// comments: 시간순 정렬된 댓글 배열 (body, user.login, user.type 포함)
// contextText: 오프닝 프롬프트에 썼던 것과 같은 맥락 설명 한 줄
// menteeLogin: 대화 상대로 취급할 사람의 로그인. 봇 댓글은 항상 포함하고,
// 그 외에는 menteeLogin과 일치하는 댓글만 히스토리에 넣어 제3자의 잡담을 걸러낸다.
export async function decideFollowup({ comments, contextText, menteeLogin }) {
  const botComments = comments
    .map((c) => ({ c, marker: parseMarker(c.body) }))
    .filter((x) => x.marker);

  if (botComments.length === 0) return { skip: true, reason: "no-thread" };

  const lastBot = botComments[botComments.length - 1];
  if (lastBot.marker.done) return { skip: true, reason: "already-done" };

  // 대화 히스토리 구성: 첫 봇 댓글 이후, 봇 댓글과 menteeLogin의 댓글만 시간순으로
  const firstBotIndex = comments.indexOf(botComments[0].c);
  const history = comments
    .slice(firstBotIndex)
    .filter((c) => parseMarker(c.body) || !menteeLogin || c.user.login === menteeLogin)
    .map((c) => {
      const marker = parseMarker(c.body);
      return marker
        ? { role: "mentor", text: stripMarker(c.body) }
        : { role: "mentee", text: c.body };
    });

  const roundOfLastQuestion = lastBot.marker.round;
  const atCap = roundOfLastQuestion >= MAX_ROUNDS;

  const raw = await callClaude({
    system: FOLLOWUP_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildFollowupUserMessage({ context: contextText, history }) },
    ],
  });

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    parsed = { done: true, message: raw || "오케이, 여기까지 짚어볼게. 고생했어!" };
  }

  const newRound = roundOfLastQuestion + 1;
  const finalDone = Boolean(parsed.done) || atCap;
  const body = `${parsed.message}\n\n${buildMarker({ round: newRound, done: finalDone })}`;
  return { skip: false, body };
}
