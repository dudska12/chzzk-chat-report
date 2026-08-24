// VOD(다시보기) 영상을 GUI 안에서 직접 재생하기 위해, 실제로 재생 가능한 스트림 주소를
// 알아내는 모듈. 처음엔 실제 chzzk 다시보기 페이지를 <webview>로 그대로 띄우는 방식(B안)으로
// 구현했는데, 실제로 써보니 로그인/배너/추천 영상 UI가 다 같이 딸려와서 화면이 지저분하고
// 어색했다("iframe으로 하니까 이상해" 피드백) — 그래서 A안(실제 스트림 URL을 직접 얻어 순수
// <video> 태그로 재생)으로 바꿨다.
//
// chzzk은 이 재생 URL 해석 과정을 공식 문서로 공개하지 않는다. 아래 로직은 활발히 유지되는
// 오픈소스 프로젝트 yt-dlp의 CHZZKVideoIE 구현을 참고해서 맞췄다:
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/chzzk.py
// (yt-dlp는 파트너/일반/수동 업로드 영상 등 여러 케이스를 실제 테스트 케이스로 검증하고
// 있어서, 우리가 임의로 짠 것보다 훨씬 신뢰도가 높다.)
//
// 흐름: videoNo -> /service/v3/videos/{videoNo} 로 videoId/inKey/vodStatus/
// liveRewindPlaybackJson을 받아온 뒤,
//   - vodStatus === "ABR_HLS" 이면: DASH(MPEG-DASH, .mpd) 매니페스트를 내려주는
//     https://apis.naver.com/neonplayer/vodplay/v1/playback/{videoId}?key={inKey}&... 를 쓴다.
//   - 그 외(일반/구버전/수동 업로드 영상)엔: liveRewindPlaybackJson 안의 media[0].path가
//     HLS(.m3u8) 주소다.
//
// 참고: 우리가 이미 쓰고 있는 `chzzk` npm 패키지의 client.video()는 v1 엔드포인트
// (/service/v1/videos/{videoNo})를 호출하는데, v1 응답에 liveRewindPlaybackJson이 포함되는지는
// 이 환경에선 실제 네트워크 접근이 안 돼서 확인할 수 없었다. yt-dlp가 검증해둔 v3 엔드포인트를
// 이 모듈에서 별도로 직접 호출해서 불확실성을 없앴다 — 방송 메타데이터(제목/카테고리 등)는
// 기존처럼 client.video()(v1)를 계속 쓰고, 이 모듈은 재생 URL 해석에만 쓰인다.

const CHZZK_API_BASE = "https://api.chzzk.naver.com";
// chzzk이 User-Agent로 접근을 걸러내는 경우가 있어서(다른 API 호출들도 마찬가지), 일반
// 브라우저처럼 보이는 값을 쓴다. chzzk npm 패키지의 기본 User-Agent와 같은 취지다.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type VodPlaybackType = "dash" | "hls";

export interface VodPlaybackInfo {
  type: VodPlaybackType;
  url: string;
}

interface RawVodVideoMeta {
  videoId?: string;
  inKey?: string;
  vodStatus?: string;
  liveRewindPlaybackJson?: string;
}

export interface ResolveVodPlaybackOptions {
  nidAuth?: string;
  nidSession?: string;
  fetchImpl?: typeof fetch;
}

/** liveRewindPlaybackJson(JSON 문자열) 안에서 재생 가능한 HLS 주소(media[0].path)를 뽑는다.
 * 파싱 실패하거나 형태가 예상과 다르면 null. */
export function extractHlsPathFromRewindJson(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { media?: { path?: string }[] };
    const path = parsed?.media?.[0]?.path;
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
}

/** vodStatus/videoId/inKey/liveRewindPlaybackJson 조합으로 재생 방식(dash/hls)과 URL을
 * 결정한다. 순수 함수라 테스트하기 쉽게 resolveVodPlayback()에서 분리했다. */
export function decideVodPlayback(meta: RawVodVideoMeta): VodPlaybackInfo | null {
  if (!meta.videoId) return null;

  if (meta.vodStatus === "ABR_HLS" && meta.inKey) {
    const params = new URLSearchParams({
      key: meta.inKey,
      env: "real",
      lc: "en_US",
      cpl: "en_US",
    });
    return {
      type: "dash",
      url: `https://apis.naver.com/neonplayer/vodplay/v1/playback/${meta.videoId}?${params.toString()}`,
    };
  }

  const hlsPath = extractHlsPathFromRewindJson(meta.liveRewindPlaybackJson);
  if (hlsPath) return { type: "hls", url: hlsPath };

  return null;
}

/** 실제로 재생 가능한 스트림 주소를 알아낸다. 실패(네트워크 오류, 응답 구조가 예상과 다름,
 * 로그인 필요 등)하면 조용히 null을 돌려준다 — 호출부(GUI)가 "브라우저에서 열기"로 대체한다. */
export async function resolveVodPlayback(
  videoNo: string | number,
  opts: ResolveVodPlaybackOptions = {}
): Promise<VodPlaybackInfo | null> {
  const doFetch = opts.fetchImpl || fetch;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (opts.nidAuth && opts.nidSession) {
    headers["Cookie"] = `NID_AUT=${opts.nidAuth}; NID_SES=${opts.nidSession}`;
  }

  const res = await doFetch(`${CHZZK_API_BASE}/service/v3/videos/${videoNo}`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: RawVodVideoMeta };
  const meta = data.content;
  if (!meta) return null;

  return decideVodPlayback(meta);
}
