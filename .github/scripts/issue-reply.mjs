// issue-reply.mjs
// 트리거: issue_comment (created) — mentor-review 라벨이 붙은 "이슈" 댓글만 처리
// (PR 댓글은 pr-reply.mjs가 처리하므로 여기서는 진짜 이슈만 다룬다)
import {
  ghGetAll,
  ghPost,
  readEventPayload,
  repoOwnerAndName,
  decideFollowup,
} from "./mentor-lib.mjs";

const LABEL = "mentor-review";

async function main() {
  const payload = readEventPayload();
  const { owner, repo } = repoOwnerAndName();
  const issue = payload.issue;
  const comment = payload.comment;

  if (!issue || issue.pull_request) {
    console.log("PR 댓글이라 종료합니다 (pr-reply.mjs 담당).");
    return;
  }
  const hasLabel = (issue.labels || []).some((l) => (l.name || l) === LABEL);
  if (!hasLabel) {
    console.log(`${LABEL} 라벨이 없는 이슈라 종료합니다.`);
    return;
  }
  if (comment.user.type === "Bot") {
    console.log("봇 자신의 댓글이라 종료합니다 (무한루프 방지).");
    return;
  }

  const comments = await ghGetAll(`/repos/${owner}/${repo}/issues/${issue.number}/comments`);
  comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const result = await decideFollowup({
    comments,
    contextText: `이건 GitHub 이슈 #${issue.number} ("${issue.title}") 코드 리뷰 스레드야.`,
    // 이 이슈는 봇이 만들었으므로 issue.user는 멘티가 아니라 봇 자신이다.
    // 대신 지금 답글을 단 사람을 이후 대화 상대로 고정한다.
    menteeLogin: comment.user.login,
  });

  if (result.skip) {
    console.log(`처리하지 않음: ${result.reason}`);
    return;
  }

  await ghPost(`/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: result.body });
  console.log(`이슈 #${issue.number}에 후속 댓글을 남겼습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
