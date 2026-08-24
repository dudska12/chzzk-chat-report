// 사용자마다 다른 로컬 설정(즐겨찾기, chzzk 로그인 쿠키, Claude API 키, 고급 분석 설정값)을
// 프로젝트 루트의 config.json에서 읽고 쓴다. config.json은 .gitignore에 걸려 있어서
// 배포/공유되는 코드에는 절대 포함되지 않는다 — API 키는 사용자가 설정 화면에서 직접 입력한
// 본인 키가 로컬에만 저장되는 구조다.
//
// 예전엔 첫 읽기 결과를 모듈 전역에 캐싱했는데, GUI 설정 화면에서 저장한 값이 같은 프로세스
// 안에서 바로 반영이 안 되는 문제가 있었다(껐다 켜야만 새 값을 읽음). config.json은 자주
// 읽는 파일도 아니라서 캐싱의 이점보다 이 버그가 더 커서, 매번 새로 읽는 방식으로 바꿨다.
import fs from "fs";
import path from "path";
import type { AnalysisSettings } from "./types";

// 즐겨찾기(여러 채널 동시 감시용). autoStart가 true인 채널은 GUI가 켜질 때(또는 즐겨찾기에
// 막 추가/토글한 시점에) 버튼을 누르지 않아도 자동으로 감시가 시작된다.
export interface FavoriteChannel {
  channelId: string;
  channelName: string;
  autoStart: boolean;
}

export interface LocalConfig {
  favorites?: FavoriteChannel[];
  // chzzk.naver.com 로그인 쿠키 (NID_AUT/NID_SES). 없어도 라이브 감시/공개 채널 조회는 대부분
  // 동작하지만, 다시보기(VOD) 메타데이터 조회(/service/v1/videos/{videoNo})와 연령 제한 방송
  // 채팅은 로그인 없이 접근이 막혀 있어서, 이 값이 있어야만 정상 동작한다.
  nidAuth?: string;
  nidSession?: string;
  // (선택) Claude API 키/모델. 설정 화면에서 사용자가 직접 입력한다 — 이 프로그램이 개인 키를
  // 대신 발급하거나 배포 코드에 내장하지 않는다. 키가 없으면 AI 화면 분석/분위기 코멘트
  // 기능은 자동으로 꺼지고, 카테고리+로컬 화면 변화 감지 기반 분석만으로 정상 동작한다.
  anthropicApiKey?: string;
  anthropicModel?: string;
  // "고급 설정" 화면에서 사용자가 바꾼 값만 저장된다 (건드리지 않은 키는 아예 없음 ->
  // getAnalysisSettings()가 DEFAULT_ANALYSIS_SETTINGS로 채워서 돌려준다). 전체 필드를 다
  // 저장해도 되지만, 부분만 저장해두면 나중에 기본값 자체가 바뀌었을 때 사용자가 안 건드린
  // 값은 자동으로 새 기본값을 따라가는 이점이 있다.
  analysisSettings?: Partial<AnalysisSettings>;
}

// collector.ts/timeline.ts/frame-classifier.ts/motion-detector.ts/mood-llm.ts에 예전엔
// 매직넘버로 박혀있던 값들의 기본값. 이 프로그램을 처음 쓰는 사람에게도 잘 맞도록 튜닝된
// 값들이니, "고급 설정"에서 뭘 만졌다가 이상해지면 언제든 이 값으로 되돌릴 수 있어야 한다.
export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  statusPollMs: 30_000,
  frameIntervalMs: 90_000,
  visionConfidenceThreshold: 0.75,
  visionConfirmCount: 2,
  restCheckIntervalMs: 10_000,
  restSuspectTicks: 2,
  restBurstSamples: 5,
  restBurstGapMs: 2_000,
  restBurstMinStatic: 4,
  motionAbsFloor: 2,
  motionRelativeFactor: 0.25,
  motionRollingWindow: 20,
  timelineBucketMs: 60_000,
  timelineMinSegmentMs: 60_000,
  timelineQuietMinBuckets: 4,
  moodMaxSampleMessages: 200,
};

// 기본은 컴파일된 위치(dist/config.js) 기준 프로젝트 루트. 다만 Electron 설치판(app.asar
// 안)에서는 이 기준으로 계산한 경로가 읽기 전용 아카이브 안이라 쓰기가 아예 안 되므로,
// gui/main.js가 실제 쓰기 가능한 위치(app.getPath("userData"))를 CHZZK_DATA_ROOT 환경변수로
// 먼저 심어두면 그 값을 대신 쓴다. CLI(`node dist/index.js`) 실행 시에는 이 환경변수가 없어서
// 예전과 동일하게 프로젝트 루트를 그대로 쓴다.
const DATA_ROOT = process.env.CHZZK_DATA_ROOT || path.join(__dirname, "..");
const CONFIG_PATH = path.join(DATA_ROOT, "config.json");

function readConfigFile(): LocalConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    console.error(`[config] ${CONFIG_PATH} 파싱에 실패했습니다. 무시하고 진행합니다.`);
    return {};
  }
}

/** 현재 config.json 내용을 그대로 돌려준다 (GUI 설정 화면에서 초기값을 채울 때 사용). */
export function getConfig(): LocalConfig {
  return { ...readConfigFile() };
}

/** 넘어온 값만 기존 config.json에 병합해서 저장한다 (전체를 안 넘겨도 나머지 값은 보존됨).
 * 임시 파일에 먼저 다 쓴 뒤 이름을 바꾸는(rename) 방식이라, 쓰는 도중 프로세스가 죽어도
 * 기존 config.json이 반쯤 쓰인 채로 깨지지 않는다 - 이 파일엔 API 키/로그인 쿠키/즐겨찾기가
 * 전부 들어있어서, 깨지면(readConfigFile이 파싱 실패로 {}를 반환) 설정이 통째로 날아간다. */
export function saveConfig(partial: LocalConfig): void {
  const merged = { ...readConfigFile(), ...partial };
  // userData 기준 경로(CHZZK_DATA_ROOT)로 처음 저장하는 시점엔 그 폴더가 아직 없을 수 있어서
  // (Electron이 알아서 미리 만들어주는 경우가 대부분이지만, 항상 보장되진 않는다) 쓰기 전에
  // 명시적으로 만들어둔다 — 안 그러면 tmp 파일조차 ENOENT로 못 쓴다.
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function getFavorites(): FavoriteChannel[] {
  return readConfigFile().favorites ?? [];
}

export function saveFavorites(favorites: FavoriteChannel[]): void {
  saveConfig({ favorites });
}

/** 저장된 값(사용자가 고급 설정에서 바꾼 것만)과 기본값을 합쳐서 항상 "완전한" 설정을
 * 돌려준다 — 호출부(collector.ts, vod-analyzer.ts 등)가 매번 ?? 기본값을 반복할 필요 없이
 * 이 값을 그대로 쓸 수 있게 하기 위함. */
export function getAnalysisSettings(): AnalysisSettings {
  return { ...DEFAULT_ANALYSIS_SETTINGS, ...(readConfigFile().analysisSettings ?? {}) };
}

/** 넘어온 값만 반영해서 저장한다. saveConfig()는 최상위 키만 얕게 병합하기 때문에,
 * analysisSettings를 부분 객체로 그냥 넘기면 이전에 저장돼 있던 나머지 키가 통째로
 * 사라진다 — 그래서 저장 전에 현재 값(getAnalysisSettings())과 합쳐서 완전한 객체로
 * 만든 뒤 저장한다. */
export function saveAnalysisSettings(partial: Partial<AnalysisSettings>): AnalysisSettings {
  const merged = { ...getAnalysisSettings(), ...partial };
  saveConfig({ analysisSettings: merged });
  return merged;
}

/** "초기값으로 되돌리기" 버튼용. */
export function resetAnalysisSettings(): AnalysisSettings {
  saveConfig({ analysisSettings: { ...DEFAULT_ANALYSIS_SETTINGS } });
  return { ...DEFAULT_ANALYSIS_SETTINGS };
}

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** config.json의 anthropicApiKey를 우선 쓰고, 없으면 환경변수 ANTHROPIC_API_KEY로 대체한다.
 * 둘 다 없으면 undefined를 돌려주고, 호출부(frame-classifier.ts/mood-llm.ts)는 이 경우
 * API 호출 자체를 건너뛰고 조용히 카테고리/로컬 판단으로 대체한다. */
export function getAnthropicApiKey(): string | undefined {
  const fromConfig = readConfigFile().anthropicApiKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

export function getAnthropicModel(): string {
  const fromConfig = readConfigFile().anthropicModel;
  return fromConfig && fromConfig.trim() ? fromConfig.trim() : DEFAULT_ANTHROPIC_MODEL;
}
