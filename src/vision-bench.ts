// AI 화면 분석(Claude 비전 API) 벤치마크 스크립트. 실제로 라이브 감시/VOD 정밀분석을 오래
// 돌리기 전에, 지금 설정된 API 키/모델로 호출 1건이 얼마나 걸리고(레이턴시) 얼마나 정확하게
// 분류하는지(화면을 눈으로 보고 결과와 비교) 몇 번만 미리 찍어보고 싶을 때 쓴다.
//
// `npm run bench:vision -- <channelId> [횟수] [간격초]` 형태로 실행한다. 지금 그 채널이
// 방송 중이어야 하고(라이브 HLS 프레임을 캡처하므로), API 키가 설정돼 있어야 한다. 실제
// 과금이 발생하니(호출 1회당 약 $0.002) 필요한 만큼만 돌리는 걸 권장한다.
import { ChzzkClient } from "chzzk";
import { classifyBroadcastFrame, isFfmpegAvailable } from "./frame-classifier";
import { getAnthropicApiKey, getAnthropicModel } from "./config";

// collector.ts의 VISION_COST_PER_CALL_USD와 같은 값(Haiku 기준 대략치). 이 스크립트는
// collector.ts 인스턴스 없이 독립적으로 돌아가서 별도로 들고 있는다.
const VISION_COST_PER_CALL_USD = 0.002;

function parseArgs(argv: string[]): { channelId: string; count: number; intervalSec: number } {
  const [channelId, countRaw, intervalRaw] = argv;
  if (!channelId) {
    console.error("사용법: npm run bench:vision -- <channelId> [호출횟수(기본 3)] [간격초(기본 10)]");
    process.exit(1);
  }
  const count = Math.max(1, Number(countRaw) || 3);
  const intervalSec = Math.max(1, Number(intervalRaw) || 10);
  return { channelId, count, intervalSec };
}

async function main() {
  const { channelId, count, intervalSec } = parseArgs(process.argv.slice(2));

  if (!getAnthropicApiKey()) {
    console.error(
      "Claude API 키가 설정돼 있지 않습니다. config.json의 anthropicApiKey 또는 환경변수 " +
        "ANTHROPIC_API_KEY를 설정한 뒤 다시 실행하세요 (GUI 설정 화면에서 입력해도 config.json에 저장됩니다)."
    );
    process.exit(1);
  }
  if (!isFfmpegAvailable()) {
    console.error("ffmpeg를 찾을 수 없습니다. ffmpeg-static이 정상 설치됐는지 확인하세요.");
    process.exit(1);
  }

  console.log(`[vision-bench] 모델: ${getAnthropicModel()}`);
  console.log(`[vision-bench] 채널: ${channelId} · ${count}회 호출 · ${intervalSec}초 간격\n`);

  const client = new ChzzkClient();
  let totalCostUsd = 0;
  let successCount = 0;

  for (let i = 0; i < count; i++) {
    const startedAt = Date.now();
    const event = await classifyBroadcastFrame(client, channelId);
    const elapsedMs = Date.now() - startedAt;

    if (!event) {
      console.log(`  [${i + 1}/${count}] 실패 또는 UNKNOWN (${elapsedMs}ms) — 방송 중인지, HLS URL을 얻었는지 확인하세요.`);
    } else {
      totalCostUsd += VISION_COST_PER_CALL_USD;
      successCount++;
      console.log(
        `  [${i + 1}/${count}] ${event.screenState} -> ${event.activityType} ` +
          `(신뢰도 ${event.confidence.toFixed(2)}, ${elapsedMs}ms)`
      );
    }

    if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }

  console.log(
    `\n[vision-bench] 완료: ${successCount}/${count}회 성공, 추정 비용 약 $${totalCostUsd.toFixed(4)} ` +
      `(호출당 약 $${VISION_COST_PER_CALL_USD})`
  );
}

main().catch((err) => {
  console.error("[vision-bench] 오류:", err);
  process.exit(1);
});
