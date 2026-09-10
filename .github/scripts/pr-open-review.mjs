// pr-open-review.mjs
// 트리거: pull_request (opened, synchronize, reopened)
// PR의 diff를 보고 사수 톤으로 첫 질문 댓글을 남긴다.
import {
  ghGetAll,
  ghPost,
  readEventPayload,
  repoOwnerAndName,
  isExcludedPath,
  callClaude,
  OPENING_SYSTEM_PROMPT,
  buildOpeningUserMessage,
  buildMarker,
  truncate,
} from "./mentor-lib.mjs";

const MAX_FILES = 8;
const MAX_TOTAL_DIFF_CHARS = 9000;

async function main() {
  const payload = readEventPayload();
  const { owner, repo } = repoOwnerAndName();
  const pr = payload.pull_request;
  if (!pr) {
    console.log("pull_request 정보가 없어 종료합니다.");
    return;
  }

  const files = await ghGetAll(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
  const candidates = files.filter((f) => f.patch && !isExcludedPath(f.filename));

  if (candidates.length === 0) {
    console.log("리뷰할 만한 변경 파일이 없어 종료합니다.");
    return;
  }

  let used = 0;
  const chunks = [];
  for (const f of candidates.slice(0, MAX_FILES)) {
    const section = `### 파일: ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\`\n`;
    if (used + section.length > MAX_TOTAL_DIFF_CHARS) break;
    chunks.push(section);
    used += section.length;
  }

  const diffText = truncate(chunks.join("\n"), MAX_TOTAL_DIFF_CHARS);
  const context = `이건 GitHub PR #${pr.number} ("${pr.title}")의 diff야.`;

  const question = await callClaude({
    system: OPENING_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildOpeningUserMessage({ context, diffOrCode: diffText }) },
    ],
    maxTokens: 400,
  });

  const body = `${question}\n\n${buildMarker({ round: 1, done: false })}`;
  await ghPost(`/repos/${owner}/${repo}/issues/${pr.number}/comments`, { body });
  console.log(`PR #${pr.number}에 멘토 질문 댓글을 남겼습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
