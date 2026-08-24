// 한국어 형태소 분석기(Kiwi)를 "있으면 쓰고 없으면 조용히 폴백"하는 방식으로 감싼 모듈.
//
// kiwi-nlp(WASM 바인딩) 자체는 npm 의존성으로 항상 설치되지만, 실제 분석에 필요한
// 모델 파일(수십 MB)은 기본으로 받지 않는다 — 모든 사용자가 배포판을 받을 때마다
// 수십 MB를 더 받게 하고 싶지 않아서다. 대신 `npm run setup:kiwi`로 원하는 사람만
// models/kiwi/ 에 내려받게 하고, 여기 있는 코드는 그 폴더가 있는지 확인해서:
//   - 있으면: Kiwi로 명사만 뽑아서 훨씬 깔끔한 키워드를 돌려준다
//   - 없으면: null을 돌려주고, 호출부(analyzer.ts)가 기존 정규식 방식으로 계속 동작한다
//
// 즉 이 모듈이 없어도, 또는 모델을 안 받아도 프로그램은 그대로 잘 동작한다.
import fs from "fs";
import path from "path";
import type { Kiwi, Match as MatchType } from "kiwi-nlp";

// kiwi-nlp WASM 바인딩(bindings/wasm README)이 요구하는 모델 파일 목록.
// npm run setup:kiwi 가 이 파일들을 정확히 이 이름으로 내려받아 놓는다.
const MODEL_FILES = [
  "combiningRule.txt",
  "default.dict",
  "extract.mdl",
  "multi.dict",
  "sj.knlm",
  "sj.morph",
  "skipbigram.mdl",
  "typo.dict",
];

// 컴파일된 위치(dist/kiwi-tokenizer.js) 기준으로 프로젝트 루트의 models/kiwi를 가리킨다.
// process.cwd()에 의존하면 Electron에서 실행 위치에 따라 달라질 수 있어서 피함.
const MODEL_DIR = path.join(__dirname, "..", "models", "kiwi");

export function isKiwiModelInstalled(): boolean {
  return MODEL_FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f)));
}

let kiwiPromise: Promise<Kiwi | null> | null = null;
let kiwiMatch: typeof MatchType | null = null;

async function initKiwi(): Promise<Kiwi | null> {
  if (!isKiwiModelInstalled()) return null;
  try {
    // kiwi-nlp의 컴파일된 진입점(dist/index.js)은 ESM 문법(`export ...`)을 쓰는데,
    // Electron이 번들하는 Node(예: Electron 32 = Node 20)는 require()로 ESM을 불러오는
    // 기능이 없어서, 모듈 최상단에서 정적으로 import하면 모델 설치 여부와 무관하게 GUI가
    // 시작하자마자 크래시한다. 그래서 모델이 실제로 설치되어 있을 때(위 조기 반환을 통과했을
    // 때)만 여기서 지연 로드한다.
    const { KiwiBuilder, Match } = await import("kiwi-nlp");
    kiwiMatch = Match;
    const wasmPath = require.resolve("kiwi-nlp/dist/kiwi-wasm.wasm");
    const builder = await KiwiBuilder.create(wasmPath);

    // fetch() 기반 로딩(문자열 경로)을 피하고, 파일을 직접 읽어서 바이트로 넘긴다.
    // Node 환경에서 file:// URL fetch 지원 여부에 기대지 않기 위함.
    const modelFiles: Record<string, Uint8Array> = {};
    for (const name of MODEL_FILES) {
      modelFiles[name] = fs.readFileSync(path.join(MODEL_DIR, name));
    }

    return await builder.build({ modelFiles });
  } catch (err) {
    console.error("[kiwi] 형태소 분석기 초기화 실패, 정규식 방식으로 대체합니다:", err);
    return null;
  }
}

/** 여러 번 불러도 초기화는 한 번만 하고 결과(성공/실패 모두)를 캐시해서 재사용한다. */
function getKiwi(): Promise<Kiwi | null> {
  if (!kiwiPromise) kiwiPromise = initKiwi();
  return kiwiPromise;
}

/**
 * 명사(NNG: 일반명사, NNP: 고유명사)만 추출한다. 조사/어미가 형태소 분석 단계에서
 * 이미 분리되기 때문에, 기존 정규식 방식보다 훨씬 깨끗한 키워드가 나온다.
 * Kiwi를 쓸 수 없는 상황(모델 미설치, 초기화 실패)이면 null을 반환한다.
 */
export async function tokenizeNouns(text: string): Promise<string[] | null> {
  const kiwi = await getKiwi();
  if (!kiwi || !kiwiMatch) return null;

  const tokens = kiwi.tokenize(text, kiwiMatch.allWithNormalizing);
  return tokens
    .filter((t) => t.tag === "NNG" || t.tag === "NNP")
    .map((t) => t.str)
    .filter((w) => w.length >= 2);
}
