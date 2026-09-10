// pr-reply.mjs
// 트리거: issue_comment (created) — PR에 달린 댓글만 처리
// PR 작성자가 답글을 달면, 이해도를 봐서 꼬리질문을 하거나 마무리한다.
import {
  ghGetAll,
  ghPost,
  readEventPayload,
  repoOwnerAndName,
  decideFollowup,
} from "./mentor-lib.mjs";

async function main() {
  const payload = readEventPayload();
  const { owner, repo } = repoOwnerAndName();
  const issue = payload.issue;
  const comment = payload.comment;

  if (!issue || !issue.pull_request) {
    console.log("PR 댓글이 아니라서 종료합니다.");
    return;
  }
  if (comment.user.type === "Bot") {
    console.log("봇 자신의 댓글이라 종료합니다 (무한루프 방지).");
    return;
  }
  if (comment.user.login !== issue.user.login) {
    console.log("PR 작성자의 답글이 아니라서 종료합니다.");
    return;
  }

  const comments = await ghGetAll(`/repos/${owner}/${repo}/issues/${issue.number}/comments`);
  comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const result = await decideFollowup({
    comments,
    contextText: `이건 GitHub PR #${issue.number} ("${issue.title}") 리뷰 스레드야.`,
    menteeLogin: issue.user.login,
  });

  if (result.skip) {
    console.log(`처리하지 않음: ${result.reason}`);
    return;
  }

  await ghPost(`/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: result.body });
  console.log(`PR #${issue.number}에 후속 댓글을 남겼습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
