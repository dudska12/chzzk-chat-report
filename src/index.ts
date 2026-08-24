#!/usr/bin/env node
import { Command } from "commander";
import { ChannelWatcher } from "./collector";

const program = new Command();

program
  .name("chzzk-chat-report")
  .description("치지직 라이브 방송 채팅을 감시하고, 방송 종료 시 리포트를 생성합니다.");

program
  .command("watch")
  .argument("<channelId>", "치지직 채널 ID (채널 URL의 마지막 부분)")
  .option("-p, --poll <ms>", "라이브 상태 폴링 주기(ms)", "30000")
  .option("-o, --out <dir>", "리포트 저장 폴더", "reports")
  .action(async (channelId: string, cmdOpts: { poll: string; out: string }) => {
    const watcher = new ChannelWatcher({
      channelId,
      statusPollMs: Number(cmdOpts.poll),
      reportDir: cmdOpts.out,
    });

    // Ctrl+C(또는 프로그램의 "종료" 버튼이 나중에 이걸 호출)를 누르면,
    // 방송 상태 API가 아직 CLOSE로 안 바뀌었더라도 지금 시점 기준으로 리포트를 만든다.
    let shuttingDown = false;
    process.on("SIGINT", async () => {
      if (shuttingDown) return; // 두 번 눌러도 중복 실행 방지
      shuttingDown = true;
      console.log("\n[watcher] 종료 요청 감지, 리포트 생성 중...");
      await watcher.stop();
      process.exit(0);
    });

    await watcher.start();
  });

program.parse();
