// full-review-start.mjs
// 트리거: workflow_dispatch (수동 실행)
// 이미 끝난 프로젝트도 전체 코드베이스에서 파일을 골라 이슈로 멘토 질문을 연다.
import {
  ghGet,
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

const LABEL = "mentor-review";
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|java|kt|rb|c|cpp|cs)$/;

async function ensureLabel(owner, repo) {
  try {
    await ghPost(`/repos/${owner}/${repo}/labels`, {
      name: LABEL,
      color: "5319e7",
      description: "사수봇이 코드 리뷰 질문을 남긴 이슈",
    });
  } catch (e) {
    // 이미 존재하면 422가 나는데, 정상 흐름이므로 무시
    if (!String(e.message).includes("422")) throw e;
  }
}

async function main() {
  const payload = readEventPayload();
  const { owner, repo } = repoOwnerAndName();
  const inputs = payload.inputs || {};
  const maxFiles = Number(inputs.max_files || 6);
  const pathPrefix = (inputs.path_prefix || "").trim();

  const repoInfo = await ghGet(`/repos/${owner}/${repo}`);
  const branch = repoInfo.default_branch;
  const branchInfo = await ghGet(`/repos/${owner}/${repo}/branches/${branch}`);
  const treeSha = branchInfo.commit.commit.tree.sha;

  const tree = await ghGet(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  let candidates = (tree.tree || []).filter(
    (t) =>
      t.type === "blob" &&
      CODE_EXT_RE.test(t.path) &&
      !isExcludedPath(t.path) &&
      (!pathPrefix || t.path.startsWith(pathPrefix))
  );

  if (candidates.length === 0) {
    console.log("조건에 맞는 파일이 없어 종료합니다.");
    return;
  }

  // 파일 크기가 큰(=로직이 많을 가능성이 높은) 파일 위주로 선정
  candidates.sort((a, b) => (b.size || 0) - (a.size || 0));
  const selected = candidates.slice(0, maxFiles);

  await ensureLabel(owner, repo);

  // 이미 리뷰 이슈가 열려 있는 파일은 건너뛰어 재실행 시 중복 생성을 막는다
  const existingIssues = await ghGetAll(
    `/repos/${owner}/${repo}/issues?labels=${LABEL}&state=all`
  );
  const existingTitles = new Set(existingIssues.map((i) => i.title));

  for (const file of selected) {
    const title = `🧑‍💻 코드 리뷰: ${file.path}`;
    if (existingTitles.has(title)) {
      console.log(`이미 리뷰 이슈가 있어 건너뜀: ${file.path}`);
      continue;
    }
    const contentRes = await ghGet(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}?ref=${branch}`
    );
    if (!contentRes.content) continue;
    const code = Buffer.from(contentRes.content, "base64").toString("utf8");
    const truncated = truncate(code, 8000);

    const context = `이건 이미 끝난 프로젝트의 기존 코드 파일이야 (PR diff 아님). 파일 경로: ${file.path}`;
    const question = await callClaude({
      system: OPENING_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildOpeningUserMessage({ context, diffOrCode: truncated }) },
      ],
      maxTokens: 400,
    });

    const body = `${question}\n\n${buildMarker({ round: 1, done: false })}`;
    const issue = await ghPost(`/repos/${owner}/${repo}/issues`, {
      title,
      body,
      labels: [LABEL],
    });
    console.log(`이슈 생성: #${issue.number} (${file.path})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
