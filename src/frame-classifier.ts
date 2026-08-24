// 방송 화면을 다루는 모듈. 두 갈래로 나뉜다:
// 1) 화면 "변화량"만 로컬에서 측정하는 순수 함수들(getHlsUrl/captureTinyGrayFrameForChannel/
//    frameDiffScore) — 외부 API를 전혀 호출하지 않는다. motion-detector.ts가 이 값을 해석해서
//    "휴식(자리비움)"인지 판단한다(collector.ts 참고). 완전 무료 경로라 항상 켜져 있다.
// 2) 화면 "내용"을 Claude 비전 API로 직접 판단하는 함수들(classifyBroadcastFrame 등) — 사용자가
//    설정 화면에서 Claude API 키를 입력했을 때만 동작하는 선택 기능이다. 키가 없으면 호출부가
//    이 함수들을 아예 부르지 않고 카테고리/로컬 판단으로 계속 동작한다.
import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChzzkClient } from "chzzk";
import ffmpegPath from "ffmpeg-static";
import { getAnthropicApiKey, getAnthropicModel } from "./config";
import type { ActivityType, VisionEvent } from "./types";

// chzzk/네이버 CDN이 User-Agent/Referer로 요청을 걸러내는 경우가 실제로 있어서(비어있는
// 요청은 브라우저가 아닌 걸로 보고 막힐 수 있음), 브라우저처럼 보이는 헤더를 항상 붙여 보낸다.
const STREAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STREAM_REFERER_HEADER = "Referer: https://chzzk.naver.com/\r\n";

/**
 * 채널의 현재 재생 가능한 HLS 주소를 찾는다. 방송 중이 아니거나, 미디어 정보가 없거나,
 * HLS 트랙 자체가 없으면 null (다른 인코딩만 있는 경우도 있어서 방어적으로 처리).
 */
export async function getHlsUrl(client: ChzzkClient, channelId: string): Promise<string | null> {
  const detail = await client.live.detail(channelId);
  if (!detail || detail.status !== "OPEN") return null;
  const media = detail.livePlayback?.media;
  if (!media || media.length === 0) return null;
  const hls = media.find((m) => m.mediaId === "HLS") ?? media.find((m) => m.protocol === "HLS");
  return hls?.path ?? null;
}

// 화면 "내용"을 이해하려는 게 아니라 "이전 프레임과 비교해서 얼마나 바뀌었는지"만 보면
// 되니까 작은 흑백 프레임으로 충분하고(오히려 작을수록 사소한 인코딩 노이즈에 덜 흔들려서
// 더 낫다), 외부 API를 전혀 안 쓰는 완전 무료 경로다.
const TINY_WIDTH = 32;
const TINY_HEIGHT = 18;
const TINY_FRAME_BYTES = TINY_WIDTH * TINY_HEIGHT; // 8bit 흑백 1픽셀 = 1바이트
const TINY_CAPTURE_TIMEOUT_MS = 15_000;

function captureTinyGrayFrame(hlsUrl: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(null);
      return;
    }
    execFile(
      ffmpegPath,
      [
        "-y",
        // CDN이 UA/Referer로 요청을 걸러내기 시작하면 이 캡처만 조용히 실패해서 휴식 감지가
        // 티도 안 나게 죽을 수 있어, 다른 캡처 경로와 일관되게 헤더를 붙인다.
        "-user_agent",
        STREAM_USER_AGENT,
        "-headers",
        STREAM_REFERER_HEADER,
        "-i",
        hlsUrl,
        "-frames:v",
        "1",
        "-vf",
        `scale=${TINY_WIDTH}:${TINY_HEIGHT},format=gray`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { timeout: TINY_CAPTURE_TIMEOUT_MS, maxBuffer: 1_000_000, encoding: "buffer" },
      (err, stdout) => {
        if (err || !stdout || stdout.length < TINY_FRAME_BYTES) {
          resolve(null);
          return;
        }
        resolve(Buffer.from(stdout.subarray(0, TINY_FRAME_BYTES)));
      }
    );
  });
}

/**
 * 지금 이 채널의 화면에서 아주 작은 흑백 프레임 한 장을 뽑아서 돌려준다. ffmpeg가 없거나
 * HLS 주소를 못 찾거나 캡처가 실패하면 null (호출부가 이번 틱을 조용히 건너뛰게 됨).
 */
export async function captureTinyGrayFrameForChannel(
  client: ChzzkClient,
  channelId: string
): Promise<Buffer | null> {
  try {
    const hlsUrl = await getHlsUrl(client, channelId);
    if (!hlsUrl) return null;
    return await captureTinyGrayFrame(hlsUrl);
  } catch {
    return null;
  }
}

/** 두 흑백 프레임 사이의 평균 절대 픽셀 차이(0~255)를 계산한다. 작을수록 화면이 그대로라는 뜻.
 * 크기가 다른 프레임이 섞여 들어오면(캡처 해상도가 바뀌는 등 이례적 상황) 비교가 무의미하니
 * 최댓값(=완전히 다른 화면)으로 취급해서 안전하게 처리한다. */
export function frameDiffScore(a: Buffer, b: Buffer): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** ffmpeg-static이 이 환경에 실제로 바이너리를 갖고 있는지 (npm install 시 다운로드 실패 가능성 있음). */
export function isFfmpegAvailable(): boolean {
  return typeof ffmpegPath === "string" && fs.existsSync(ffmpegPath);
}

// ==================================================================================
// ---- 여기부터 Claude 비전 API 기반 화면 상태 분류 (선택 기능, API 키 필요) ----
// ==================================================================================

// 단순히 "게임 화면이야, 대화 화면이야?" 이진 분류로 물어보면 로딩 화면이나 게임 메뉴/로비를
// 게임 플레이로 잘못 묶는 등 오차가 쉽게 생긴다. 그래서 화면 상태를 먼저 세분화해서 판단하게
// 하고, 그 결과를 ActivityType(게임중/대화중/휴식중) 3분류로 묶는다. EATING은 스트리머가
// 게임 카테고리를 유지한 채 식사 방송을 하는 경우(사용자 피드백으로 발견)를 잡기 위해 나중에
// 추가된 상태다.
export const SCREEN_STATES = [
  "GAMEPLAY",
  "CHAT",
  "MENU",
  "LOADING",
  "CUTSCENE",
  "VIDEO",
  "WEB",
  "DESKTOP",
  "EATING",
  "UNKNOWN",
] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

const STATE_TO_ACTIVITY: Record<Exclude<ScreenState, "UNKNOWN">, ActivityType> = {
  GAMEPLAY: "게임중",
  MENU: "게임중",
  LOADING: "게임중",
  CUTSCENE: "게임중",
  CHAT: "대화중",
  VIDEO: "대화중",
  WEB: "대화중",
  DESKTOP: "대화중",
  EATING: "휴식중",
};

/** ScreenState -> ActivityType 매핑을 외부(vod-analyzer.ts의 촘촘한 캡처 재분류 등)에서도
 * 쓸 수 있게 노출한다. UNKNOWN이면 null (호출부가 이번 신호를 버려야 한다는 뜻). */
export function activityTypeForScreenState(state: ScreenState): ActivityType | null {
  return state === "UNKNOWN" ? null : STATE_TO_ACTIVITY[state];
}

const CLASSIFY_PROMPT = `이 이미지는 인터넷 방송(스트리밍)의 화면 캡처 한 장입니다. 지금 화면이 다음 중
어떤 상태인지 딱 하나만 골라주세요.

- GAMEPLAY: 실제 게임을 플레이하고 있는 화면 (HUD, 인게임 캐릭터/맵 등이 보임)
- MENU: 게임 메뉴, 로비, 캐릭터 선택 화면 등 (플레이 중이 아님)
- LOADING: 로딩 화면, 로딩 스피너
- CUTSCENE: 게임 내 컷신/연출 영상
- CHAT: 스트리머 얼굴/상반신이 크게 보이며 시청자와 대화하는 "저스트채팅" 형태 화면
- EATING: 스트리머가 화면에 나와 음식을 먹고 있는 장면(먹방) — 얼굴과 음식이 화면 중심
- VIDEO: 유튜브 영상, 방송 다시보기 등 다른 영상 콘텐츠를 트는 화면
- WEB: 브라우저, 인터넷 서핑 화면
- DESKTOP: 게임이 아닌 데스크탑 프로그램(코딩, 그림 그리기 등) 화면
- UNKNOWN: 위 어디에도 확실히 속하지 않거나 판단하기 애매한 화면

절대 추측으로 억지로 끼워맞추지 마세요 — 애매하면 UNKNOWN을 고르고 confidence를 낮게
주세요. 오직 아래 형식의 JSON 한 줄로만 답하세요. 다른 설명은 절대 붙이지 마세요.

{"state": "GAMEPLAY", "confidence": 0.9}`;

const CLASSIFY_MAX_TOKENS = 100;
const VISION_REQUEST_TIMEOUT_MS = 20_000;

/** JPEG 프레임 하나를 Claude 비전 API에 보내서 화면 상태를 판단한다. API 키가 없거나
 * 요청이 실패하거나 응답 파싱에 실패하면 null (호출부는 이번 회차 신호를 조용히 버린다). */
export async function classifyImageBuffer(
  imageBuffer: Buffer
): Promise<{ state: ScreenState; confidence: number } | null> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;
  const model = getAnthropicModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: CLASSIFY_MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: imageBuffer.toString("base64") },
              },
              { type: "text", text: CLASSIFY_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    const state: ScreenState = (SCREEN_STATES as readonly string[]).includes(parsed.state)
      ? parsed.state
      : "UNKNOWN";
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { state, confidence };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const CAPTURE_JPEG_QUALITY = "4"; // ffmpeg -q:v (2~5가 고화질, 비용 절감을 위해 640px로 축소하므로 이 정도로 충분)
const CAPTURE_SCALE_WIDTH = 640;

interface CaptureFrameJpegOptions {
  seekSeconds?: number; // VOD에서 특정 시점을 캡처할 때만 지정 (라이브는 항상 "지금")
  timeoutMs?: number;
  onError?: (message: string) => void; // ffmpeg 실패 원인(stderr)을 호출부 로그로 넘기기 위함
}

/** 주어진 재생 URL(HLS/DASH)에서 JPEG 프레임 한 장을 캡처한다. 비용 절감을 위해 폭 640px로
 * 축소해서 반환한다(분류 정확도엔 거의 영향 없음). 실패하면 null이고, onError가 있으면 실제
 * ffmpeg 오류 메시지를 넘겨준다(원인 진단용). */
function captureFrameJpeg(url: string, opts: CaptureFrameJpegOptions = {}): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      opts.onError?.("ffmpeg 바이너리를 찾을 수 없습니다 (설치 실패했을 수 있음)");
      resolve(null);
      return;
    }
    const args = ["-y", "-user_agent", STREAM_USER_AGENT, "-headers", STREAM_REFERER_HEADER];
    if (typeof opts.seekSeconds === "number" && opts.seekSeconds > 0) {
      args.push("-ss", String(opts.seekSeconds));
    }
    args.push(
      "-i",
      url,
      "-frames:v",
      "1",
      "-vf",
      `scale=${CAPTURE_SCALE_WIDTH}:-2`,
      "-q:v",
      CAPTURE_JPEG_QUALITY,
      "-f",
      "image2",
      "pipe:1"
    );
    execFile(
      ffmpegPath,
      args,
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 20_000_000, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err || !stdout || stdout.length === 0) {
          opts.onError?.(stderr ? stderr.toString().slice(-800) : String(err ?? "빈 응답"));
          resolve(null);
          return;
        }
        resolve(Buffer.from(stdout));
      }
    );
  });
}

/** 지금 이 채널의 방송 화면을 캡처해서 분류한다. 라이브 감시(collector.ts)의 주기 호출용. */
export async function classifyBroadcastFrame(
  client: ChzzkClient,
  channelId: string
): Promise<VisionEvent | null> {
  const hlsUrl = await getHlsUrl(client, channelId);
  if (!hlsUrl) return null;
  const frame = await captureFrameJpeg(hlsUrl);
  if (!frame) return null;
  const result = await classifyImageBuffer(frame);
  if (!result) return null;
  if (result.state === "UNKNOWN") return null;
  return {
    time: Date.now(),
    activityType: STATE_TO_ACTIVITY[result.state],
    confidence: result.confidence,
    screenState: result.state,
  };
}

/** VOD 재생 URL의 특정 시점(offsetSeconds)을 캡처해서 분류한다. VOD 정밀분석(vod-analyzer.ts)이
 * 성긴 샘플을 훑을 때 쓴다. */
export async function classifyVodFrameAt(
  playbackUrl: string,
  offsetSeconds: number,
  opts: { timeoutMs?: number; onError?: (message: string) => void } = {}
): Promise<VisionEvent | null> {
  const frame = await captureFrameJpeg(playbackUrl, { seekSeconds: offsetSeconds, ...opts });
  if (!frame) return null;
  const result = await classifyImageBuffer(frame);
  if (!result) return null;
  if (result.state === "UNKNOWN") return null;
  return {
    time: offsetSeconds * 1000,
    activityType: STATE_TO_ACTIVITY[result.state],
    confidence: result.confidence,
    screenState: result.state,
  };
}

const CONFIRM_REST_PROMPT = `이 이미지는 인터넷 방송 화면 캡처입니다. 화면이 오래 안 바뀌고 있다고
감지됐는데, 이게 "스트리머가 실제로 자리를 비웠다(자리비움)"는 뜻인지, 아니면 "원래 정적인 화면
(로딩 화면, 메뉴 화면, 정지된 카메라 앵글 등)이라서 그냥 그 상태 그대로인 것"인지 판단해주세요.

오직 아래 형식의 JSON 한 줄로만 답하세요.
{"isAway": true, "confidence": 0.9}`;

/** 로컬 픽셀 비교(motion-detector.ts)로 "휴식 의심"이 확정되기 직전에, Claude에게 한 번 더
 * 화면을 보여줘서 로딩/메뉴 화면처럼 원래 정적인 화면을 자리비움으로 오판하는 걸 걸러낸다.
 * API 키가 없거나 실패하면 null을 돌려주고, 호출부(collector.ts)는 이 경우 로컬 판단을 그대로
 * 믿고 진행한다(휴식 감지 자체가 멈추지는 않음) — 이 함수는 어디까지나 오탐을 "줄이는" 보조
 * 수단이지, 이게 없으면 휴식 감지가 아예 안 되는 게 아니다. */
export async function confirmRestByVision(
  client: ChzzkClient,
  channelId: string
): Promise<boolean | null> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;
  const hlsUrl = await getHlsUrl(client, channelId);
  if (!hlsUrl) return null;
  const frame = await captureFrameJpeg(hlsUrl);
  if (!frame) return null;
  const model = getAnthropicModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: CLASSIFY_MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") },
              },
              { type: "text", text: CONFIRM_REST_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return typeof parsed.isAway === "boolean" ? parsed.isAway : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VodFrameSequenceOptions {
  intervalMs: number; // 캡처 간격 (촘촘한 간격 - "정밀 재확인"용)
  maxFrames?: number; // 상한 (디스크 보호용, 기본 2000)
  timeoutMs?: number; // 전체 캡처 타임아웃 (기본 영상 길이의 2배, 최소 10분 최대 90분은 호출부가 계산해서 넘김)
  onProgress?: (fetchedCount: number, percent: number | undefined) => void;
  /** 캡처 시작 직후 ffmpeg 자식 프로세스를 넘겨준다 — 호출부(vod-analyzer.ts)가 "정밀분석"
   * 취소 시 SIGKILL로 즉시 중단할 수 있게 하기 위함. Windows는 부모가 죽어도 자식 ffmpeg가
   * 안 죽어서, 이 훅이 없으면 취소해도 최대 90분짜리 캡처가 좀비로 남아 계속 돈다. */
  onChildProcess?: (child: ReturnType<typeof spawn>) => void;
}

/** VOD 영상을 처음부터 끝까지 한 번만 순차로 읽으면서, 그 김에 필요한 간격마다 프레임을
 * 한꺼번에 뽑아둔다(ffmpeg의 fps 필터). 프레임마다 개별적으로 -ss 시킹하면 이 CDN 기준으로
 * 총 처리 시간이 영상 길이의 제곱에 가깝게 느려지는 문제가 있어서(오프셋이 클수록 그 오프셋만큼
 * 시간이 걸림), 한 번의 순차 읽기로 필요한 프레임을 전부 뽑는 방식으로 바꿨다. */
export function captureVodFrameSequence(
  playbackUrl: string,
  totalDurationSec: number,
  opts: VodFrameSequenceOptions
): Promise<Buffer[]> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve([]);
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzzk-vod-frames-"));
    const outPattern = path.join(tmpDir, "f%06d.jpg");
    const fps = 1 / Math.max(1, opts.intervalMs / 1000);
    const maxFrames = opts.maxFrames ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const args = [
      "-y",
      "-user_agent",
      STREAM_USER_AGENT,
      "-headers",
      STREAM_REFERER_HEADER,
      "-i",
      playbackUrl,
      "-vf",
      `fps=${fps},scale=${CAPTURE_SCALE_WIDTH}:-2`,
      "-q:v",
      CAPTURE_JPEG_QUALITY,
      "-frames:v",
      String(maxFrames),
      outPattern,
    ];
    const cleanup = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 정리 실패는 무시 (OS 임시 폴더라 언젠가 청소됨)
      }
    };
    let settled = false;
    const finish = (frames: Buffer[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(frames);
    };
    const child = spawn(ffmpegPath, args);
    opts.onChildProcess?.(child);
    let stderrTail = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      const m = stderrTail.match(/frame=\s*(\d+)/);
      if (m && opts.onProgress) {
        const count = parseInt(m[1], 10);
        const percent =
          totalDurationSec > 0 ? Math.min(100, Math.round((count / fps / totalDurationSec) * 100)) : undefined;
        opts.onProgress(count, percent);
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const files = fs
          .readdirSync(tmpDir)
          .filter((f) => f.endsWith(".jpg"))
          .sort();
        const frames = files.map((f) => fs.readFileSync(path.join(tmpDir, f)));
        finish(frames);
      } catch {
        finish([]);
      }
    });
  });
}
