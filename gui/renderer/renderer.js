// 프레임리스 창의 렌더러. React 없이 순수 DOM API로 상태에 따라 화면을 갱신한다.
// 백엔드(ChannelWatcher, 채널당 하나씩)가 보내는 이벤트(log/chat/session-start/report-ready)를
// 받아서 화면에 반영하는 게 이 파일의 역할 전부다 — 분석/판단 로직은 없음.
//
// 여러 채널을 동시에 감시할 수 있게 되면서(즐겨찾기 기능), 예전엔 전역 변수 하나로 충분했던
// 상태(phase, msgCount, timelineData 등)를 이제 채널ID별로 따로 들고 있어야 한다. 그래서 이
// 파일의 핵심 구조는 "channelsState: Map<channelId, State>" + "selectedChannelId(지금 화면에
// 보여주는 채널)" 두 가지고, 나머지는 그 상태를 그리는 함수들이다.

const el = (id) => document.getElementById(id);

const titlebar = { close: el("winCloseBtn"), min: el("winMinBtn"), max: el("winMaxBtn") };
const selectedChannelName = el("selectedChannelName");
const selectedChannelSub = el("selectedChannelSub");
const stopBtn = el("stopBtn");
const statusBadge = el("statusBadge");
const statusDot = el("statusDot");
const statusText = el("statusText");
const stripChannel = el("stripChannel");
const stripElapsed = el("stripElapsed");
const stripMsgCount = el("stripMsgCount");
const stripDonationCount = el("stripDonationCount");
const visionBadge = el("visionBadge");
const visionBadgeText = el("visionBadgeText");
const chatFeed = el("chatFeed");
const liveIndicator = el("liveIndicator");
const liveVideoEl = el("liveVideoEl");
const liveVideoEmpty = el("liveVideoEmpty");
const liveOpenExternalBtn = el("liveOpenExternalBtn");
const vodMediaPanel = el("vodMediaPanel");
const vodVideoEl = el("vodVideoEl");
const vodVideoEmpty = el("vodVideoEmpty");
const vodOpenExternalBtn = el("vodOpenExternalBtn");
const vodSearchInput = el("vodSearchInput");
const vodSearchBtn = el("vodSearchBtn");
const vodSearchResults = el("vodSearchResults");
const tabLog = el("tabLog");
const tabReport = el("tabReport");
const tabTimeline = el("tabTimeline");
const reportReadyDot = el("reportReadyDot");
const logView = el("logView");
const reportView = el("reportView");
const reportEmpty = el("reportEmpty");
const reportContent = el("reportContent");
const timelineView = el("timelineView");
const timelineEmpty = el("timelineEmpty");
const timelineContent = el("timelineContent");
const settingsBtn = el("settingsBtn");
const settingsOverlay = el("settingsOverlay");
const chzzkLoginStatus = el("chzzkLoginStatus");
const chzzkLoginBtn = el("chzzkLoginBtn");
const settingsCancel = el("settingsCancel");
const settingsSave = el("settingsSave");
const settingsStatus = el("settingsStatus");
const settingsApiKey = el("settingsApiKey");
const settingsApiKeyLink = el("settingsApiKeyLink");
const settingsAutoLaunch = el("settingsAutoLaunch");
const advancedSettingsBtn = el("advancedSettingsBtn");
const advancedSettingsOverlay = el("advancedSettingsOverlay");
const advancedSettingsFields = el("advancedSettingsFields");
const advancedSettingsStatus = el("advancedSettingsStatus");
const advancedSettingsCancel = el("advancedSettingsCancel");
const advancedSettingsSave = el("advancedSettingsSave");
const advancedSettingsReset = el("advancedSettingsReset");
const mainEmpty = el("mainEmpty");
const sidebar = el("sidebar");
const segFavorites = el("segFavorites");
const segVod = el("segVod");
const segPanelFavorites = el("segPanelFavorites");
const segPanelVod = el("segPanelVod");
const favoriteAddInput = el("favoriteAddInput");
const favoriteAddBtn = el("favoriteAddBtn");
const favoriteAddError = el("favoriteAddError");
const favoriteList = el("favoriteList");
const favoriteEmpty = el("favoriteEmpty");
const vodAddInput = el("vodAddInput");
const vodAddBtn = el("vodAddBtn");
const vodAddError = el("vodAddError");
const vodJobList = el("vodJobList");
const vodJobEmpty = el("vodJobEmpty");

// ---- 채널별 상태 ----
// favorites: 서버(config.json)에 저장된 즐겨찾기 목록 [{channelId, channelName, autoStart}]
// vodJobsList: 서버(vodJobs 레지스트리)의 VOD 분석 작업 목록 [{jobId, videoNo, videoTitle,
//   channelName, status, error, progress}] (result/logs는 무거워서 목록엔 안 실려온다)
// channelsState: "채널ID 또는 VOD jobId" -> 화면 상태. 라이브 채널과 VOD 작업을 같은 Map에
//   같은 모양(newChannelState)으로 넣어두고 isVod 플래그로만 구분한다 — 그래야 로그/리포트/
//   타임라인/편집점 내보내기를 그리는 코드를 라이브·VOD 구분 없이 100% 재사용할 수 있다.
let favorites = [];
let vodJobsList = [];
let channelsState = new Map();
let selectedChannelId = null;

// 타임라인 차트 확대 단계(버킷 하나당 픽셀 너비). 방송이 길어질수록 버킷 개수가 늘어나서
// 막대 하나하나가 너무 얇아져 클릭하기 어려워지는 문제를, 고정폭 대신 "막대당 최소 너비를
// 보장 + 넘치면 가로 스크롤" 방식으로 해결한다. 인덱스가 커질수록 더 확대(막대가 굵어짐).
const ZOOM_LEVELS = [3, 4, 6, 9, 13, 19, 28, 40];
const DEFAULT_ZOOM_IDX = 2; // 6px/막대 — 짧은 방송은 대체로 스크롤 없이 한 화면에 들어오는 수준
const TL_BAR_GAP_PX = 2; // #tlVolumeChart의 CSS gap과 반드시 같은 값이어야 스크롤 위치 계산이 맞음

function newChannelState(channelId, channelName) {
  return {
    channelId,
    channelName: channelName || channelId,
    isVod: false,
    phase: "idle", // idle | monitoring | done | fetching | error (fetching/error는 VOD 전용)
    startedAt: null,
    endedAt: null,
    msgCount: 0,
    donationCount: 0,
    logs: [],
    chats: [],
    reportPayload: null,
    activeTab: "log",
    timeline: {
      data: null,
      selectedBucketIdx: null,
      selectedSegmentIdx: null,
      selectedUser: null,
      userTimelineCache: null,
      // 차트 확대 단계(ZOOM_LEVELS의 인덱스)와, 다음 렌더링에서 스크롤을 어디로 맞출지 지정하는
      // 값들. 채널/작업을 넘나들며 렌더링해도 각자의 확대/스크롤 상태가 유지되도록 채널별 상태
      // 안에 같이 둔다(선택된 버킷/구간과 같은 위치).
      zoomIdx: DEFAULT_ZOOM_IDX,
      scrollToSelection: false,
      pendingZoomCenterRatio: null,
    },
    // VOD 전용: 검색창이 비어있을 때 재생 위치와 동기화해서 보여줄 채팅 전체 캐시.
    // loadedFor는 "이 videoNo 기준으로 캐시를 이미 시도/완료했는지" 표시(채팅 수집이 아직 안
    // 끝났으면 messages가 null인 채로 남아있을 수 있음 — loadVodChatSyncMessages 참고).
    vodChatSync: { messages: null, loadedFor: null, lastRenderedIdx: -1 },
    // "종료"/즐겨찾기 토글 끄기로 이 채널의 감시를 막 멈춰달라고 요청했는지. ChannelWatcher는
    // 방송이 끝나면 report-ready를 내보내면서도, 명시적으로 stop()되지 않은 한 계속 다음
    // 방송을 기다리며 폴링을 이어간다 — 그래서 report-ready 핸들러는 원래 phase를 항상
    // "monitoring"(다음 방송 대기)으로 되돌렸는데, 사용자가 그 사이 토글/종료로 진짜 멈춰달라고
    // 했을 때도 이걸 무시하고 "monitoring"으로 되돌려버려서 종료 버튼/영상 분석 배지가 안
    // 꺼지는 것처럼 보이는 버그가 있었다. 이 플래그로 그 두 경우를 구분한다.
    stopRequested: false,
  };
}

function getOrCreateState(channelId, channelName) {
  let s = channelsState.get(channelId);
  if (!s) {
    s = newChannelState(channelId, channelName);
    channelsState.set(channelId, s);
  } else if (channelName) {
    s.channelName = channelName;
  }
  return s;
}

/** VOD 작업용. getOrCreateState()와 거의 같지만 isVod 플래그를 붙인다. */
function getOrCreateVodState(jobId, title) {
  const s = getOrCreateState(jobId, title);
  s.isVod = true;
  return s;
}

function currentState() {
  return selectedChannelId ? channelsState.get(selectedChannelId) : null;
}

const ACTIVITY_COLORS = {
  게임중: { bar: "#e15b64", soft: "rgba(225,91,100,0.16)", line: "rgba(225,91,100,0.45)" },
  대화중: { bar: "#5b8def", soft: "rgba(91,141,239,0.16)", line: "rgba(91,141,239,0.45)" },
  휴식중: { bar: "#5ee6a3", soft: "rgba(94,230,163,0.16)", line: "rgba(94,230,163,0.45)" },
};

const STATUS = {
  idle: { text: "대기 중", color: "#8a8d96", bg: "#1a1c22", border: "#2a2d34", anim: "none" },
  monitoring: {
    text: "감시 중",
    color: "#5ee6a3",
    bg: "rgba(94,230,163,0.1)",
    border: "rgba(94,230,163,0.35)",
    anim: "pulse 1.6s infinite",
  },
  done: {
    text: "리포트 생성 완료",
    color: "#7ea3f2",
    bg: "rgba(91,141,239,0.12)",
    border: "rgba(91,141,239,0.35)",
    anim: "none",
  },
  // VOD 분석 전용 상태 (라이브 감시엔 없음).
  fetching: {
    text: "채팅 수집 중",
    color: "#f5c542",
    bg: "rgba(245,197,66,0.1)",
    border: "rgba(245,197,66,0.35)",
    anim: "pulse 1.6s infinite",
  },
  error: {
    text: "분석 실패",
    color: "#f28a90",
    bg: "rgba(225,91,100,0.1)",
    border: "rgba(225,91,100,0.35)",
    anim: "none",
  },
};

const TAG_COLORS = { INFO: "#5b8def", CONN: "#5ee6a3", DONA: "#f5a623", WARN: "#e6b95e", ERROR: "#e15b64" };

function pad2(n) { return String(n).padStart(2, "0"); }

function nowTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function nickColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 72%)`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClockSec(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 자정을 넘긴 날짜 수. 방송이 하루 안에서 끝나면 0. fmtClock()이 시:분만 보여줘서, 자정을
 * 넘긴 방송은 "23:28 – 07:38"처럼 끝 시각이 시작 시각보다 숫자가 작아 보여 마치 시간이
 * 거꾸로 된 것처럼 헷갈릴 수 있다 — 실제로는 정상(그 다음 날 아침까지 이어진 방송)이라,
 * 며칠 지났는지 표시해서 헷갈리지 않게 한다. */
function daysBetween(startMs, endMs) {
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endMs);
  end.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((end - start) / 86400000));
}

/** "23:28 – 07:38" 처럼 시작/끝이 다른 날짜에 걸쳐 있으면 "(+1일)"을 붙여서, 시간이 거꾸로
 * 된 게 아니라 자정을 넘겨 이어진 방송이라는 걸 명확히 한다. */
function fmtClockRange(startMs, endMs) {
  const diffDays = daysBetween(startMs, endMs);
  const dayMark = diffDays > 0 ? ` (+${diffDays}일)` : "";
  return `${fmtClock(startMs)} – ${fmtClock(endMs)}${dayMark}`;
}

/** "8시간 10분"처럼 사람이 읽기 편한 형태로 방송 시간을 표시한다. */
function formatDurationKor(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** 채널ID나 방송 URL을 통째로 붙여넣어도 채널ID만 뽑아 쓸 수 있게 한다. */
function extractChannelId(value) {
  const trimmed = (value || "").trim();
  const match = trimmed.match(/\/live\/([a-zA-Z0-9]+)/);
  return match ? match[1] : trimmed;
}

// ---- 화면 갱신: 선택된 채널이 바뀌거나, 그 채널 상태가 바뀔 때마다 호출 ----

function updateMainVisibility() {
  const s = currentState();
  const has = !!s;
  // VOD 작업을 볼 땐 '실시간 채팅' 패널 대신 영상+검색 패널을 보여준다. 둘 다 40% 너비라
  // visibility만 바꾸면 레이아웃이 겹치니, 안 쓰는 쪽은 display:none으로 완전히 빼야 한다.
  const showVod = has && s.isVod;
  mainEmpty.style.display = has ? "none" : "flex";
  el("chatPanel").style.display = showVod ? "none" : "flex";
  el("chatPanel").style.visibility = has ? "visible" : "hidden";
  vodMediaPanel.style.display = showVod ? "flex" : "none";
  el("rightPanel").style.visibility = has ? "visible" : "hidden";
}

function updateTopbar() {
  const s = currentState();
  if (!s) {
    selectedChannelName.textContent = "채널을 선택해주세요";
    selectedChannelSub.textContent = "왼쪽 즐겨찾기 목록에서 선택하거나 채널을 추가하세요";
    stopBtn.disabled = true;
    setStatusBadge(null);
    return;
  }
  selectedChannelName.textContent = s.channelName;
  selectedChannelSub.textContent = s.isVod ? `영상 번호: ${s.channelId}` : `채널ID: ${s.channelId}`;
  // VOD 분석은 "종료" 버튼으로 중단하는 개념이 없다(감시처럼 계속 도는 게 아니라 한 번
  // 실행하면 끝까지 실행됨) — phase가 monitoring이 될 일이 없으니 자연히 항상 비활성화된다.
  stopBtn.disabled = s.phase !== "monitoring";
  setStatusBadge(s.phase);
}

function setStatusBadge(phase) {
  const key = phase && STATUS[phase] ? phase : "idle";
  const st = STATUS[key];
  statusBadge.style.background = st.bg;
  statusBadge.style.borderColor = st.border;
  statusBadge.style.color = st.color;
  statusText.textContent = phase ? st.text : "-";
  statusDot.style.animation = st.anim;
  liveIndicator.style.display = phase === "monitoring" ? "flex" : "none";
}

function statusLineFor(s) {
  if (s.phase === "monitoring") {
    if (s.startedAt) return `감시 중 · ${formatElapsed(Date.now() - s.startedAt)}`;
    // 방송 시작 전(처음 토글을 켠 직후)과, 리포트가 이미 한 번 나온 뒤 다음 방송을 기다리는
    // 중 둘 다 여기 해당한다 — 백엔드가 리포트를 만든 뒤에도 폴링을 멈추지 않고 계속 다음
    // 방송을 자동으로 기다리기 때문에, 후자도 "꺼진 상태"가 아니라 이 대기 상태로 표시한다.
    return s.reportPayload ? "다음 방송 대기 중" : "라이브 대기 중";
  }
  if (s.phase === "done") return "리포트 완료";
  return "대기 중";
}

function switchTab(tab) {
  const s = currentState();
  if (s) s.activeTab = tab;
  tabLog.classList.toggle("active", tab === "log");
  tabReport.classList.toggle("active", tab === "report");
  tabTimeline.classList.toggle("active", tab === "timeline");
  logView.style.display = tab === "log" ? "flex" : "none";
  reportView.style.display = tab === "report" ? "block" : "none";
  timelineView.style.display = tab === "timeline" ? "block" : "none";
  if (tab === "timeline") refreshTimeline();
}

function createLogRow(entry) {
  const row = document.createElement("div");
  row.className = "log-row";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = entry.time;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = `[${entry.tag}]`;
  tag.style.color = TAG_COLORS[entry.tag] || "#9a9da5";
  const text = document.createElement("span");
  text.className = "text";
  text.textContent = entry.text;
  row.append(time, tag, text);
  return row;
}

function renderLogView() {
  logView.innerHTML = "";
  const s = currentState();
  if (!s) return;
  s.logs.forEach((entry) => logView.appendChild(createLogRow(entry)));
  logView.scrollTop = logView.scrollHeight;
}

function createChatRow(preview) {
  const row = document.createElement("div");
  if (preview.isDonation) {
    row.className = "chat-row donation";
    const top = document.createElement("div");
    top.className = "top";
    const nick = document.createElement("span");
    nick.className = "nick";
    nick.textContent = `🎁 ${preview.nickname}`;
    top.appendChild(nick);
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = preview.message;
    row.append(top, text);
  } else {
    row.className = "chat-row";
    const nick = document.createElement("span");
    nick.className = "nick";
    nick.style.color = nickColor(preview.nickname);
    nick.textContent = preview.nickname;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = preview.message;
    row.append(nick, text);
  }
  return row;
}

function renderChatFeed() {
  [...chatFeed.children].forEach((child) => {
    if (child !== liveIndicator) chatFeed.removeChild(child);
  });
  const s = currentState();
  if (!s) return;
  s.chats.forEach((preview) => chatFeed.insertBefore(createChatRow(preview), liveIndicator));
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

// ---- 라이브 전용: 실제 방송 영상 재생 ----
// VOD와 같은 위(영상)/아래(채팅) 레이아웃이지만, 재생 주소를 구하는 방식은 훨씬 간단하다 —
// 우리가 이미 쓰고 있는 chzzk 패키지의 공식 지원 메서드(client.live.detail())가
// livePlayback.media[].path로 바로 재생 가능한 HLS 주소를 내려줘서, VOD 때처럼 비공식 API를
// 역공학할 필요가 없었다(src/live-playback.ts 참고). 재생 자체는 이미 번들해둔 hls.js를
// 그대로 재사용한다.
let liveHlsPlayer = null;

function teardownLivePlayer() {
  if (liveHlsPlayer) {
    try {
      liveHlsPlayer.destroy();
    } catch {}
    liveHlsPlayer = null;
  }
  liveVideoEl.removeAttribute("src");
  liveVideoEl.load();
  delete liveVideoEl.dataset.loadedChannel;
}

liveVideoEl.addEventListener("loadedmetadata", () => {
  liveVideoEmpty.style.display = "none";
  liveVideoEl.style.display = "block";
  // 자동재생은 muted일 때만 브라우저가 허용해주는 경우가 많아서 <video muted>로 뒀다 —
  // 재생이 안 걸리는 환경이면 사용자가 컨트롤 바에서 직접 눌러도 된다.
  liveVideoEl.play().catch(() => {});
});
liveVideoEl.addEventListener("error", () => {
  liveVideoEmpty.textContent = "영상을 재생하지 못했어요. 위 '브라우저에서 열기'로 직접 확인해주세요.";
  liveVideoEmpty.style.display = "flex";
  liveVideoEl.style.display = "none";
});

liveOpenExternalBtn.addEventListener("click", () => {
  const url = liveOpenExternalBtn.dataset.url;
  if (url) window.api.openExternal(url);
});

/** 라이브 채널 선택/방송 시작/종료 시 호출. 방송 중이 아니면(또는 조회 실패하면) 안내
 * 문구만 보여주고 조용히 넘어간다 — 채팅 감시 자체는 영상 재생 성공 여부와 무관하게 계속
 * 동작해야 하므로 여기서 에러를 던지지 않는다. */
async function renderLiveVideoPanel() {
  const s = currentState();
  if (!s || s.isVod) return;
  const channelId = s.channelId;
  const channelUrl = `https://chzzk.naver.com/live/${channelId}`;
  liveOpenExternalBtn.dataset.url = channelUrl;

  if (s.phase !== "monitoring" || !s.startedAt) {
    // 감시는 하고 있지만 지금 방송 중이 아닌 상태(다음 방송 대기 등) — 재생 시도할 게 없다.
    teardownLivePlayer();
    liveVideoEmpty.textContent = "방송 중이 아니에요.";
    liveVideoEmpty.style.display = "flex";
    return;
  }

  if (liveVideoEl.dataset.loadedChannel === channelId) return; // 이미 이 채널 재생 중

  teardownLivePlayer();
  liveVideoEl.dataset.loadedChannel = channelId;
  liveVideoEmpty.textContent = "영상을 불러오는 중...";
  liveVideoEmpty.style.display = "flex";
  liveVideoEl.style.display = "none";

  const playback = await window.api.getLivePlayback(channelId);
  // 조회하는 동안 다른 채널로 전환했거나 방송이 끝났으면 지금 응답은 버린다.
  if (liveVideoEl.dataset.loadedChannel !== channelId) return;
  if (!playback) {
    liveVideoEmpty.textContent = "영상 주소를 찾지 못했어요. 위 '브라우저에서 열기'로 봐주세요.";
    liveVideoEmpty.style.display = "flex";
    return;
  }

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    liveHlsPlayer = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data && data.fatal) {
        console.warn("[라이브 재생] hls.js 치명적 오류:", data);
      }
    });
    hls.loadSource(playback.url);
    hls.attachMedia(liveVideoEl);
  } else if (liveVideoEl.canPlayType("application/vnd.apple.mpegurl")) {
    liveVideoEl.src = playback.url;
  } else {
    liveVideoEmpty.textContent = "이 브라우저 환경에서는 영상 재생을 지원하지 않아요.";
    liveVideoEmpty.style.display = "flex";
  }
}

// ---- VOD 전용: 영상 재생 + 채팅 검색 패널 ----
// '실시간 채팅' 패널은 VOD 작업엔 아무 이벤트도 안 와서 항상 빈 채로 떠 있었는데, 그 자리를
// 다시보기 영상 재생 + 채팅 검색으로 채운다.
//
// 처음엔 실제 chzzk 다시보기 페이지를 <webview>(iframe과 비슷한 개념)로 그대로 띄우는 방식으로
// 만들었는데, 로그인 배너/추천 영상 등 chzzk 페이지 UI가 그대로 다 딸려와서 화면이 지저분하고
// 어색했다("iframe으로 하니까 이상해" 피드백) — 그래서 실제 재생 가능한 스트림 주소를 직접
// 알아내서 순수 <video> 태그로 재생하는 방식으로 바꿨다. 스트림 주소는 메인 프로세스의
// get-vod-playback IPC(src/vod-playback.ts, yt-dlp의 CHZZKVideoIE 구현 참고)가 알아내 오고,
// 방식(HLS .m3u8 / DASH .mpd)에 따라 hls.js 또는 dash.js로 재생한다. 이제 진짜 <video> 태그를
// 우리가 직접 들고 있으므로, 타임라인 클릭 시 영상 이동도 currentTime을 직접 설정하면 되고
// (예전 webview 버전처럼 스크립트를 주입해서 chzzk 플레이어 내부 DOM을 추측할 필요가 없다),
// 훨씬 신뢰도가 높다.
let vodHlsPlayer = null; // Hls 인스턴스 (HLS 재생 중일 때만)
let vodDashPlayer = null; // dashjs MediaPlayer 인스턴스 (DASH 재생 중일 때만)

/** 이전에 재생하던 영상의 hls.js/dash.js 플레이어 인스턴스를 정리한다. 다른 VOD 작업으로
 * 넘어갈 때 안 하면 리소스가 계속 쌓이고, 예전 영상의 세그먼트를 계속 받아오려는 네트워크
 * 요청이 새 영상 재생과 뒤섞일 수 있다. */
function teardownVodPlayer() {
  if (vodHlsPlayer) {
    try {
      vodHlsPlayer.destroy();
    } catch {}
    vodHlsPlayer = null;
  }
  if (vodDashPlayer) {
    try {
      vodDashPlayer.reset();
    } catch {}
    vodDashPlayer = null;
  }
  vodVideoEl.removeAttribute("src");
  vodVideoEl.load();
}

vodVideoEl.addEventListener("loadedmetadata", () => {
  vodVideoEmpty.style.display = "none";
  vodVideoEl.style.display = "block";
});
vodVideoEl.addEventListener("error", () => {
  vodVideoEmpty.textContent = "영상을 재생하지 못했어요. 위 '브라우저에서 열기'로 직접 확인해주세요.";
  vodVideoEmpty.style.display = "flex";
  vodVideoEl.style.display = "none";
});

vodOpenExternalBtn.addEventListener("click", () => {
  const url = vodOpenExternalBtn.dataset.url;
  if (url) window.api.openExternal(url);
});

/** 채널 선택이 VOD 작업으로 바뀔 때마다 호출. 같은 작업을 다시 보는 거면 재생을 새로
 * 시작하지 않는다(재생 위치가 날아가지 않게). */
async function renderVodMediaPanel() {
  const s = currentState();
  if (!s || !s.isVod) return;
  const videoNo = s.channelId;
  const videoUrl = `https://chzzk.naver.com/video/${videoNo}`;
  vodOpenExternalBtn.dataset.url = videoUrl;
  vodSearchInput.value = "";
  loadVodChatSyncMessages(s); // 캐시/진행 상태에 따라 알아서 판단 (fire-and-forget)
  renderVodChatSyncFeed();

  if (vodVideoEl.dataset.loadedVideo === videoNo) return; // 이미 같은 영상 재생 중

  teardownVodPlayer();
  vodVideoEl.dataset.loadedVideo = videoNo;
  vodVideoEmpty.textContent = "영상을 불러오는 중...";
  vodVideoEmpty.style.display = "flex";
  vodVideoEl.style.display = "none";

  const playback = await window.api.getVodPlayback(videoNo);
  // 조회하는 동안 다른 작업으로 전환했으면 지금 응답은 버린다.
  if (vodVideoEl.dataset.loadedVideo !== videoNo) return;

  if (!playback) {
    vodVideoEmpty.textContent = "이 영상은 자동 재생 주소를 찾지 못했어요. 위 '브라우저에서 열기'로 봐주세요.";
    vodVideoEmpty.style.display = "flex";
    return;
  }

  if (playback.type === "hls") {
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      vodHlsPlayer = hls;
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data && data.fatal) {
          console.warn("[VOD 재생] hls.js 치명적 오류:", data);
        }
      });
      hls.loadSource(playback.url);
      hls.attachMedia(vodVideoEl);
    } else if (vodVideoEl.canPlayType("application/vnd.apple.mpegurl")) {
      // hls.js를 못 쓰는 환경(사파리 계열)이면 브라우저 네이티브 HLS 지원에 맡긴다.
      vodVideoEl.src = playback.url;
    } else {
      vodVideoEmpty.textContent = "이 브라우저 환경에서는 영상 재생을 지원하지 않아요.";
      vodVideoEmpty.style.display = "flex";
      return;
    }
  } else if (playback.type === "dash") {
    if (window.dashjs) {
      const player = window.dashjs.MediaPlayer().create();
      vodDashPlayer = player;
      player.initialize(vodVideoEl, playback.url, false);
    } else {
      vodVideoEmpty.textContent = "영상 재생 라이브러리를 불러오지 못했어요.";
      vodVideoEmpty.style.display = "flex";
      return;
    }
  }
}

/** 타임라인에서 특정 시각(방송 시작 기준 epoch ms)을 선택했을 때, VOD 작업이면 영상도
 * 그 지점으로 옮긴다. 세션 시작 시각은 타임라인 탭을 아직 안 열어서 s.timeline.data가 없을
 * 수도 있으니, 그 경우 VOD 작업 완료 시 채워지는 s.startedAt으로 대체한다. */
function maybeSeekVodToEpochMs(epochMs) {
  const s = currentState();
  if (!s || !s.isVod) return;
  const sessionStart = s.timeline.data ? s.timeline.data.sessionStart : s.startedAt;
  if (sessionStart == null) return;
  const elapsedSec = Math.max(0, (epochMs - sessionStart) / 1000);
  seekVodVideo(elapsedSec);
}

function seekVodVideo(seconds) {
  if (!vodVideoEl || vodVideoEl.style.display === "none") return;
  // 실제 <video> 태그를 직접 들고 있어서, currentTime을 그냥 설정하면 된다 — 예전 webview
  // 버전처럼 성공 여부를 알 수 없는 스크립트 주입이 아니라 표준 HTMLMediaElement API다.
  try {
    vodVideoEl.currentTime = Math.max(0, seconds);
  } catch (err) {
    console.warn("[VOD 영상 이동] currentTime 설정 실패:", err);
  }
}

// ---- VOD 전용: 검색 안 할 때는 재생 위치와 동기화된 채팅 보여주기 ----
// 채팅 검색창이 비어있을 때, 아무것도 안 보여주고 놀리는 대신 지금 영상이 재생 중인 시점까지
// 나온 채팅을 라이브 채팅창처럼 스크롤해서 보여준다 — 원래 방송을 다시 보는 느낌을 준다.
// 검색어를 입력하면 이 뷰 대신 검색 결과가 뜨고, 지우면 다시 동기화 뷰로 돌아온다.
const VOD_CHAT_SYNC_WINDOW = 200; // 재생 위치 기준으로 최근 몇 개까지 보여줄지(라이브 chatFeed의 500-cap과 같은 취지)

/** 재생 위치와 동기화하려면 이 VOD 작업의 채팅 전체가 필요하다. 진행 중(phase !== "done")엔
 * 아직 다 안 모였을 수 있어서 시도하지 않고, 완료된 뒤(아래 onVodEvent "done" 핸들러에서도
 * 다시 호출됨) 한 번만 통째로 받아와 시간순으로 캐시해둔다 — 재생 중 매번 IPC를 부르지 않고
 * 클라이언트에서 이진 탐색만 하면 되게 하기 위함이다. */
async function loadVodChatSyncMessages(s) {
  if (!s || !s.isVod || s.phase !== "done") return;
  const videoNo = s.channelId;
  if (s.vodChatSync.loadedFor === videoNo) return; // 이미 이 영상 기준으로 캐시 완료
  s.vodChatSync.loadedFor = videoNo;
  const messages = await window.api.getMessagesInRange(videoNo, 0, Number.MAX_SAFE_INTEGER);
  if (s.vodChatSync.loadedFor !== videoNo) return; // 그 사이 초기화됐으면(방어적 체크) 버림
  s.vodChatSync.messages = Array.isArray(messages) ? messages : [];
  s.vodChatSync.lastRenderedIdx = -1;
  if (currentState() === s && !vodSearchInput.value.trim()) renderVodChatSyncFeed();
}

/** 검색창이 비어있을 때 #vodSearchResults 자리에 재생 위치까지의 채팅을 그린다. 메시지가
 * timestamp 기준 정렬돼 있다는 전제로 이진 탐색만 해서(재생 중 초당 여러 번 호출돼도 가벼움)
 * "지금까지 나온 채팅" 끝 인덱스를 찾고, 안 바뀌었으면 다시 안 그린다. */
function renderVodChatSyncFeed() {
  const s = currentState();
  if (!s || !s.isVod) return;
  if (vodSearchInput.value.trim()) return; // 검색 중이면 이 함수는 관여하지 않는다

  const cache = s.vodChatSync;
  if (s.phase !== "done") {
    vodSearchResults.innerHTML = "";
    const info = document.createElement("div");
    info.id = "vodSearchEmpty";
    info.textContent = "채팅 수집이 끝나야 재생 위치와 동기화된 채팅을 볼 수 있어요.";
    vodSearchResults.appendChild(info);
    return;
  }
  if (!cache.messages) {
    vodSearchResults.innerHTML = "";
    const info = document.createElement("div");
    info.id = "vodSearchEmpty";
    info.textContent = "채팅을 불러오는 중...";
    vodSearchResults.appendChild(info);
    return;
  }
  if (s.startedAt == null) return;

  const currentEpochMs = s.startedAt + (vodVideoEl.currentTime || 0) * 1000;
  const msgs = cache.messages;
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msgs[mid].timestamp <= currentEpochMs) lo = mid + 1;
    else hi = mid;
  }
  const endIdx = lo; // msgs[0, endIdx) 가 지금 재생 위치까지 나온 채팅
  if (endIdx === cache.lastRenderedIdx) return; // 안 바뀌었으면 다시 안 그림(재생 중 매 틱 재렌더 방지)
  cache.lastRenderedIdx = endIdx;

  const windowMsgs = msgs.slice(Math.max(0, endIdx - VOD_CHAT_SYNC_WINDOW), endIdx);
  vodSearchResults.innerHTML = "";
  if (windowMsgs.length === 0) {
    const info = document.createElement("div");
    info.id = "vodSearchEmpty";
    info.textContent = "이 시점 이전엔 채팅이 없어요.";
    vodSearchResults.appendChild(info);
    return;
  }
  windowMsgs.forEach((m) => vodSearchResults.appendChild(createVodChatRow(m, s.startedAt)));
  vodSearchResults.scrollTop = vodSearchResults.scrollHeight;
}

// 재생 중(timeupdate)엔 초당 여러 번 이벤트가 튀므로, 400ms 간격으로만 다시 그린다. 우리가
// 직접 seek(currentTime 설정)할 때도 표준상 timeupdate가 같이 발생해서 이 리스너 하나로
// "자연 재생"과 "타임라인/검색 클릭으로 점프" 둘 다 자동으로 커버된다.
let vodChatSyncThrottleTimer = null;
vodVideoEl.addEventListener("timeupdate", () => {
  if (vodChatSyncThrottleTimer) return;
  vodChatSyncThrottleTimer = setTimeout(() => {
    vodChatSyncThrottleTimer = null;
    renderVodChatSyncFeed();
  }, 400);
});

/** 검색 결과 행/동기화 채팅 행 공용 빌더. 클릭하면 타임라인 탭으로 가서 그 시각으로
 * 이동한다(막대 선택 + VOD면 영상 seek까지 — selectBucket()이 알아서 처리). */
function createVodChatRow(m, sessionStart) {
  const row = document.createElement("div");
  row.className = "vod-search-row";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = sessionStart != null ? formatElapsed(Math.max(0, m.timestamp - sessionStart)) : fmtClockSec(m.timestamp);
  const nick = document.createElement("span");
  nick.className = "nick";
  nick.style.color = nickColor(m.nickname);
  nick.textContent = m.nickname;
  const text = document.createElement("span");
  text.className = "text";
  text.textContent = m.message;
  row.append(time, nick, text);
  row.addEventListener("click", () => {
    switchTab("timeline");
    selectNearestBucket(m.timestamp);
  });
  return row;
}

async function runVodSearch() {
  const s = currentState();
  if (!s || !s.isVod) return;
  const query = vodSearchInput.value.trim();
  if (!query) {
    // 검색어가 없으면(비웠으면) 검색 결과 대신 재생 위치와 동기화된 채팅으로 돌아간다.
    renderVodChatSyncFeed();
    return;
  }
  vodSearchBtn.disabled = true;
  try {
    const results = await window.api.searchMessages(s.channelId, query);
    if (currentState() === s) renderVodSearchResults(results);
  } finally {
    vodSearchBtn.disabled = false;
  }
}

function renderVodSearchResults(results) {
  const s = currentState();
  vodSearchResults.innerHTML = "";
  if (!results || results.length === 0) {
    const empty = document.createElement("div");
    empty.id = "vodSearchEmpty";
    empty.textContent = "검색 결과가 없어요.";
    vodSearchResults.appendChild(empty);
    return;
  }
  const sessionStart = s ? s.startedAt : null;
  results.forEach((m) => vodSearchResults.appendChild(createVodChatRow(m, sessionStart)));
}

vodSearchBtn.addEventListener("click", runVodSearch);
vodSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runVodSearch();
});
// 입력 도중(특히 다 지웠을 때) 버튼을 안 눌러도 바로 반응하도록. 검색어를 지우면 곧장
// 동기화 채팅으로 돌아오고, 그 외엔 건드리지 않는다(엔터/버튼을 눌러야 실제 검색 실행).
vodSearchInput.addEventListener("input", () => {
  if (!vodSearchInput.value.trim()) {
    const s = currentState();
    if (s) s.vodChatSync.lastRenderedIdx = -1; // 검색 화면에서 돌아왔으니 강제로 다시 그리게 함
    renderVodChatSyncFeed();
  }
});

function metricCard(label, value, isDonation) {
  const card = document.createElement("div");
  card.className = "metric-card";
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "value" + (isDonation ? " donation" : "");
  v.textContent = value;
  card.append(l, v);
  return card;
}

function renderReportView() {
  const s = currentState();
  if (!s || !s.reportPayload) {
    reportContent.style.display = "none";
    reportEmpty.style.display = "flex";
    reportReadyDot.style.display = "none";
    return;
  }
  reportReadyDot.style.display = "inline-block";
  renderReport(s.reportPayload);
}

function renderReport(payload) {
  const r = payload.report;
  reportEmpty.style.display = "none";
  reportContent.style.display = "block";
  reportContent.innerHTML = "";

  const dateStr = new Date(r.session.startedAt).toLocaleDateString("ko-KR");

  const head = document.createElement("div");
  head.className = "report-head";
  const left = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "방송 종료 리포트";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${r.session.channelName} · ${dateStr} · 총 방송 시간 ${formatElapsed(
    r.durationMinutes * 60000
  )}`;
  left.append(title, meta);

  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "display:flex; gap:8px;";

  const exportBtn = document.createElement("button");
  exportBtn.className = "export-btn";
  exportBtn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7,10 12,15 17,10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> 내보내기';
  exportBtn.addEventListener("click", async () => {
    const suggested = `${r.session.channelName}_${dateStr.replace(/\./g, "")}.md`;
    const res = await window.api.exportReport(payload.markdown, suggested);
    if (res.ok) {
      logToChannel(currentState(), { time: nowTime(), tag: "INFO", text: `리포트를 내보냈습니다: ${res.filePath}` });
    }
  });

  const cardBtn = document.createElement("button");
  cardBtn.className = "export-btn";
  cardBtn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg> 카드 이미지';
  cardBtn.addEventListener("click", async () => {
    cardBtn.disabled = true;
    const suggested = `${r.session.channelName}_${dateStr.replace(/\./g, "")}_card.png`;
    const res = await window.api.exportCard(r, suggested);
    cardBtn.disabled = false;
    if (res.ok) {
      logToChannel(currentState(), { time: nowTime(), tag: "INFO", text: `카드 이미지를 내보냈습니다: ${res.filePath}` });
    } else if (res.error !== "취소됨") {
      logToChannel(currentState(), { time: nowTime(), tag: "ERROR", text: `카드 이미지 생성 실패: ${res.error}` });
    }
  });

  btnGroup.append(cardBtn, exportBtn);
  head.append(left, btnGroup);
  reportContent.appendChild(head);

  const metricGrid = document.createElement("div");
  metricGrid.className = "metric-grid";
  metricGrid.appendChild(metricCard("총 채팅 수", r.totalMessages.toLocaleString()));
  metricGrid.appendChild(metricCard("참여 시청자", r.uniqueChatters.toLocaleString()));
  metricGrid.appendChild(
    metricCard("총 후원 금액", `${r.totalDonationAmount.toLocaleString()}원`, true)
  );
  reportContent.appendChild(metricGrid);

  const kingsSection = document.createElement("div");
  kingsSection.className = "section";
  const kingsTitle = document.createElement("div");
  kingsTitle.className = "section-title";
  kingsTitle.textContent = "🏆 채팅왕 TOP 10";
  kingsSection.appendChild(kingsTitle);

  const maxCount = r.topChatters[0]?.count || 1;
  const rankColors = ["#f5c518", "#c9cbd1", "#d99a5b"];
  r.topChatters.forEach((u, i) => {
    const row = document.createElement("div");
    row.className = "king-row";
    row.style.cursor = "pointer";
    row.title = "클릭하면 타임라인 탭에서 이 유저의 채팅 시점을 볼 수 있어요";
    row.addEventListener("click", () => jumpToUserTimeline(u.nickname));
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(i + 1);
    rank.style.color = rankColors[i] || "#8a8d96";
    const nick = document.createElement("span");
    nick.className = "nick";
    nick.textContent = u.nickname;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.round((u.count / maxCount) * 100)}%`;
    track.appendChild(fill);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${u.count}회`;
    row.append(rank, nick, track, count);
    kingsSection.appendChild(row);
  });
  reportContent.appendChild(kingsSection);

  const twoCol = document.createElement("div");
  twoCol.className = "two-col";

  const wordsCol = document.createElement("div");
  const wordsTitle = document.createElement("div");
  wordsTitle.className = "section-title";
  wordsTitle.textContent = "💬 자주 나온 단어";
  wordsCol.appendChild(wordsTitle);
  const cloud = document.createElement("div");
  cloud.className = "word-cloud";
  const counts = r.topWords.map((w) => w.count);
  const maxW = counts.length ? Math.max(...counts) : 1;
  const minW = counts.length ? Math.min(...counts) : 1;
  r.topWords.forEach((w) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    const t = maxW === minW ? 1 : (w.count - minW) / (maxW - minW);
    chip.style.fontSize = `${(11 + t * 5).toFixed(1)}px`;
    chip.style.color = `hsl(220, 8%, ${Math.round(55 + t * 25)}%)`;
    chip.textContent = w.word;
    cloud.appendChild(chip);
  });
  wordsCol.appendChild(cloud);

  const moodCol = document.createElement("div");
  const moodTitle = document.createElement("div");
  moodTitle.className = "section-title";
  moodTitle.textContent = "📊 방송 분위기";
  moodCol.appendChild(moodTitle);
  const moodCard = document.createElement("div");
  moodCard.className = "mood-card";
  const moodRow = document.createElement("div");
  moodRow.className = "row";
  const emoji = document.createElement("span");
  emoji.className = "emoji";
  emoji.textContent = r.mood.emoji;
  const moodTextWrap = document.createElement("div");
  const moodLabel = document.createElement("div");
  moodLabel.className = "label";
  moodLabel.textContent = r.mood.label;
  const moodSub = document.createElement("div");
  moodSub.className = "sub";
  moodSub.textContent = r.mood.subtitle;
  moodTextWrap.append(moodLabel, moodSub);
  moodRow.append(emoji, moodTextWrap);

  const moodBar = document.createElement("div");
  moodBar.className = "mood-bar";
  const pos = document.createElement("div");
  pos.className = "pos";
  pos.style.width = `${r.mood.positivePct}%`;
  const neu = document.createElement("div");
  neu.className = "neu";
  neu.style.width = `${r.mood.neutralPct}%`;
  const neg = document.createElement("div");
  neg.className = "neg";
  neg.style.width = `${r.mood.negativePct}%`;
  moodBar.append(pos, neu, neg);

  const legend = document.createElement("div");
  legend.className = "mood-legend";
  legend.innerHTML = `<span>긍정 ${r.mood.positivePct}%</span><span>중립 ${r.mood.neutralPct}%</span><span>부정 ${r.mood.negativePct}%</span>`;

  moodCard.append(moodRow, moodBar, legend);

  moodCol.appendChild(moodCard);

  twoCol.append(wordsCol, moodCol);
  reportContent.appendChild(twoCol);

  if (r.topDonators.length > 0) {
    const donorSection = document.createElement("div");
    donorSection.className = "section";
    const donorTitle = document.createElement("div");
    donorTitle.className = "section-title";
    donorTitle.textContent = "⭐ 후원 TOP 5";
    donorSection.appendChild(donorTitle);
    r.topDonators.forEach((d, i) => {
      const row = document.createElement("div");
      row.className = "donor-row";
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(i + 1);
      const nick = document.createElement("span");
      nick.className = "nick";
      nick.textContent = d.nickname;
      const amount = document.createElement("span");
      amount.className = "amount";
      amount.textContent = `${d.count.toLocaleString()}원`;
      row.append(rank, nick, amount);
      donorSection.appendChild(row);
    });
    reportContent.appendChild(donorSection);
  }
}

/** 타임라인 탭의 "편집점 내보내기" 버튼. 휴식(자리비움) 구간 + 채팅 폭발/후원 몰림 시점을
 * 방송 시작 기준 경과 시간(HH:MM:SS, VOD 타임코드) CSV로 저장한다 — 이 프로그램의 원래
 * 목적인 "영상 편집할 때 참고할 시점 찾기"에 가장 직접 맞닿아 있는 기능. */
async function exportEditPoints(state, timelineData) {
  const dateStr = new Date(timelineData.sessionStart).toLocaleDateString("ko-KR").replace(/\./g, "").trim();
  const suggested = `${state.channelName}_${dateStr}_editpoints.csv`;
  const res = await window.api.exportEditPoints(timelineData, suggested);
  if (res.ok) {
    logToChannel(state, { time: nowTime(), tag: "INFO", text: `편집점 목록을 내보냈습니다: ${res.filePath}` });
  } else if (res.error !== "취소됨") {
    logToChannel(state, { time: nowTime(), tag: "ERROR", text: `편집점 내보내기 실패: ${res.error}` });
  }
}

// ---- 타임라인 탭 ----

async function refreshTimeline() {
  const s = currentState();
  if (!s) {
    timelineEmpty.style.display = "flex";
    timelineContent.style.display = "none";
    return;
  }
  // 예전엔 phase === "idle"이면 조회조차 안 하고 무조건 "데이터 없음"으로 표시했는데, 즐겨찾기
  // 토글을 꺼서 감시를 종료할 때 진행 중이던 세션이 있어도 phase가(report-ready가 도착해
  // "monitoring"으로 되돌리기 전까지) 잠깐 idle로 반영되는 경우가 있어서, 이미 끝난 방송의
  // 타임라인까지 화면에서 사라지는 버그가 있었다. 백엔드(getTimeline)는 phase와 무관하게
  // lastSessionId 기준으로 항상 정확한 데이터(또는 진짜 없으면 null)를 돌려주므로, phase로
  // 미리 판단하지 말고 항상 조회한 뒤 실제로 데이터가 없을 때만 비어있음으로 표시한다.
  const data = await window.api.getTimeline(s.channelId);
  if (selectedChannelId !== s.channelId) return; // 조회하는 동안 다른 채널로 전환했으면 버림
  if (!data) {
    timelineEmpty.style.display = "flex";
    timelineContent.style.display = "none";
    return;
  }
  s.timeline.data = data;
  timelineEmpty.style.display = "none";
  timelineContent.style.display = "block";

  const t = s.timeline;
  if (t.selectedBucketIdx === null && t.selectedSegmentIdx === null && !t.selectedUser) {
    const burst = data.highlights.find((h) => h.type === "burst");
    if (burst) {
      // 사용자가 직접 클릭한 게 아니라 "타임라인 탭을 처음 열었을 때 가장 채팅 많은 구간을
      // 미리 보여주는" 편의 기능이다 — VOD 영상 seek는 사용자가 실제로 막대/구간/검색 결과를
      // 클릭했을 때만 하고 싶으므로 { seekVideo: false }로 이 자동 선택에서는 영상이 안
      // 움직이게 막는다. (VOD 분석 끝나고 타임라인 탭을 처음 열자마자 클릭도 안 했는데
      // 영상이 제멋대로 이동해있는 버그로 실제 발견됨.)
      selectNearestBucket(burst.time, { seekVideo: false });
      return;
    }
  }
  renderTimeline();
}

function selectNearestBucket(time, opts) {
  const s = currentState();
  if (!s || !s.timeline.data || s.timeline.data.volumeBuckets.length === 0) return;
  const data = s.timeline.data;
  let idx = data.volumeBuckets.findIndex((b) => b.bucketStart + data.bucketMs > time);
  if (idx === -1) idx = data.volumeBuckets.length - 1;
  selectBucket(idx, opts);
}

/** opts.seekVideo가 false면 VOD 영상은 옮기지 않는다(기본값 true). 사용자가 직접 막대/구간을
 * 클릭한 게 아니라 프로그램이 자동으로 선택할 때(예: 타임라인 탭을 처음 열 때 하이라이트로
 * 이동) 쓰기 위한 옵션이다. */
function selectBucket(idx, opts) {
  const s = currentState();
  if (!s) return;
  const t = s.timeline;
  t.selectedBucketIdx = idx;
  t.selectedUser = null;
  t.userTimelineCache = null;
  const bucket = t.data.volumeBuckets[idx];
  const segIdx = t.data.segments.findIndex((seg) => bucket.bucketStart >= seg.start && bucket.bucketStart < seg.end);
  t.selectedSegmentIdx = segIdx === -1 ? null : segIdx;
  // 막대를 직접 클릭했든, 시간 이동 입력이나 하이라이트 카드를 통해 왔든, 선택된 지점이
  // 지금 스크롤 뷰 밖에 있을 수 있으니 다음 렌더링에서 그 지점으로 스크롤해달라고 표시해둔다.
  t.scrollToSelection = true;
  if (!opts || opts.seekVideo !== false) {
    maybeSeekVodToEpochMs(bucket.bucketStart);
  }
  renderTimeline();
}

function selectSegment(idx) {
  const s = currentState();
  if (!s) return;
  const t = s.timeline;
  t.selectedSegmentIdx = idx;
  t.selectedBucketIdx = null;
  t.selectedUser = null;
  t.userTimelineCache = null;
  t.scrollToSelection = true;
  const seg = t.data.segments[idx];
  if (seg) maybeSeekVodToEpochMs(seg.start);
  renderTimeline();
}

/** "1:23:32" / "1시간 23분 32초" / "83:32" / "212" 같은 다양한 입력을 경과 밀리초로 바꾼다.
 * 못 알아들으면 null. */
function parseElapsedMs(raw) {
  const input = (raw || "").trim();
  if (!input) return null;

  const kor = input.match(/^(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?$/);
  if (kor && (kor[1] || kor[2] || kor[3])) {
    const h = Number(kor[1] || 0);
    const m = Number(kor[2] || 0);
    const sec = Number(kor[3] || 0);
    return (h * 3600 + m * 60 + sec) * 1000;
  }

  const parts = input.split(":").map((p) => p.trim());
  if (parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map(Number);
    let h = 0, m = 0, sec = 0;
    if (nums.length === 3) [h, m, sec] = nums;
    else if (nums.length === 2) [m, sec] = nums;
    else [sec] = nums;
    return (h * 3600 + m * 60 + sec) * 1000;
  }

  return null;
}

/** 타임라인 차트 위 "시간 이동" 입력창의 실제 처리. 방송 시작 기준 경과 시간을 받아서
 * 가장 가까운 버킷을 선택 + 스크롤해준다(정확히 그 밀리초짜리 버킷이 없어도 가장 가까운
 * 곳으로 간다 — 버킷 크기가 방송 길이에 따라 1분~수십 분 단위라 딱 떨어지지 않는 게 보통). */
function jumpToTime(inputEl, errorEl) {
  const s = currentState();
  if (!s || !s.timeline.data) return;
  const data = s.timeline.data;
  const elapsedMs = parseElapsedMs(inputEl.value);

  if (elapsedMs === null) {
    errorEl.textContent = "시간 형식을 확인해주세요 (예: 1:23:32 또는 1시간23분32초)";
    errorEl.style.display = "block";
    return;
  }
  const totalMs = data.sessionEnd - data.sessionStart;
  if (elapsedMs > totalMs) {
    errorEl.textContent = `이 방송은 ${formatElapsed(totalMs)}까지만 있어요.`;
    errorEl.style.display = "block";
    return;
  }
  errorEl.style.display = "none";
  selectNearestBucket(data.sessionStart + elapsedMs);
}

/** 확대/축소 버튼. 그냥 다시 그리면 보고 있던 위치를 잃어버리니, 지금 스크롤 뷰의 "가운데가
 * 전체 중 몇 %쯤인지"를 기억해뒀다가 다시 그린 뒤 그 비율 그대로 복원한다 — 지도 확대할 때
 * 보던 위치가 화면 가운데 그대로 있는 것과 같은 느낌을 준다. */
function changeZoom(dir) {
  const s = currentState();
  if (!s || !s.timeline.data) return;
  const t = s.timeline;
  const curIdx = t.zoomIdx ?? DEFAULT_ZOOM_IDX;
  const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, curIdx + (dir === "in" ? 1 : -1)));
  if (nextIdx === curIdx) return;

  const hEl = document.getElementById("tlHScroll");
  let centerRatio = 0.5;
  if (hEl && hEl.scrollWidth > hEl.clientWidth) {
    centerRatio = (hEl.scrollLeft + hEl.clientWidth / 2) / hEl.scrollWidth;
  }
  t.zoomIdx = nextIdx;
  t.pendingZoomCenterRatio = centerRatio;
  renderTimeline();
}

/** 리포트의 채팅왕 행 클릭 등, 다른 탭에서 특정 유저의 타임라인으로 바로 넘어갈 때 쓴다. */
async function jumpToUserTimeline(nickname) {
  const s = currentState();
  if (!s) return;
  switchTabButtonsOnly("timeline");
  s.activeTab = "timeline";
  if (!s.timeline.data) {
    const data = await window.api.getTimeline(s.channelId);
    if (selectedChannelId !== s.channelId) return;
    if (data) {
      s.timeline.data = data;
      timelineEmpty.style.display = "none";
      timelineContent.style.display = "block";
    }
  }
  await selectUser(nickname);
}

/** switchTab()과 달리 refreshTimeline()을 자동으로 트리거하지 않는 버전 (jumpToUserTimeline 전용). */
function switchTabButtonsOnly(tab) {
  tabLog.classList.toggle("active", tab === "log");
  tabReport.classList.toggle("active", tab === "report");
  tabTimeline.classList.toggle("active", tab === "timeline");
  logView.style.display = tab === "log" ? "flex" : "none";
  reportView.style.display = tab === "report" ? "block" : "none";
  timelineView.style.display = tab === "timeline" ? "block" : "none";
}

async function selectUser(nickname) {
  const s = currentState();
  if (!s) return;
  const t = s.timeline;
  if (t.selectedUser === nickname) {
    clearUserSelection();
    return;
  }
  t.selectedUser = nickname;
  t.selectedBucketIdx = null;
  t.selectedSegmentIdx = null;
  t.userTimelineCache = await window.api.getUserTimeline(s.channelId, nickname);
  if (selectedChannelId !== s.channelId) return;
  renderTimeline();
}

function clearUserSelection() {
  const s = currentState();
  if (!s) return;
  s.timeline.selectedUser = null;
  s.timeline.userTimelineCache = null;
  renderTimeline();
}

async function renderTimeline() {
  const s = currentState();
  if (!s || !s.timeline.data) return;
  const data = s.timeline.data;
  const t = s.timeline;
  // 감시 중엔 5초마다 자동 갱신되는데, 그때마다 아래 innerHTML = ""로 통째로 지웠다가
  // 다시 그리기 때문에 스크롤 위치도 같이 0으로 리셋돼버린다. 다시 그리기 전에 기억해뒀다가
  // 다 그린 뒤 복원해서, 스크롤해서 보던 중에 자동 갱신이 와도 튕기지 않게 한다.
  const scrollPos = timelineView.scrollTop;
  // 가로 스크롤(확대된 채팅량 차트)도 같은 이유로 다시 그리기 전에 기억해둔다. 다만 이번
  // 렌더링이 "시간 이동/막대 클릭/확대축소"에 의한 것이면 이 값 대신 그 요청이 원하는
  // 위치로 스크롤해야 하므로, 아래에서 t.scrollToSelection / t.pendingZoomCenterRatio를
  // 우선 확인한다.
  const existingHScroll = document.getElementById("tlHScroll");
  const savedHScrollLeft = existingHScroll ? existingHScroll.scrollLeft : 0;
  timelineContent.innerHTML = "";

  const head = document.createElement("div");
  head.className = "tl-head";
  const left = document.createElement("div");
  left.className = "tl-head-left";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "방송 히스토리";
  const meta = document.createElement("div");
  meta.className = "meta";
  const sourceLabel =
    data.activitySource === "vision"
      ? "🎥 영상 분석 기반"
      : data.activitySource === "category"
      ? "📋 카테고리 기반(추정)"
      : "정보 없음";
  meta.textContent = `${fmtClockRange(data.sessionStart, data.sessionEnd)} · 총 ${formatDurationKor(
    data.sessionEnd - data.sessionStart
  )} · 게임중/대화중 판단: ${sourceLabel}`;
  left.append(title, meta);

  const legend = document.createElement("div");
  legend.className = "tl-legend";
  const legendTotals = { 게임중: 0, 대화중: 0, 휴식중: 0 };
  data.segments.forEach((seg) => {
    legendTotals[seg.type] = (legendTotals[seg.type] || 0) + (seg.end - seg.start);
  });
  Object.keys(ACTIVITY_COLORS).forEach((type) => {
    const mins = Math.round((legendTotals[type] || 0) / 60000);
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<span class="swatch" style="background:${ACTIVITY_COLORS[type].bar}"></span>${type} <b>${mins}분</b>`;
    legend.appendChild(item);
  });

  const rightGroup = document.createElement("div");
  rightGroup.className = "tl-head-right";
  const editPointsBtn = document.createElement("button");
  editPointsBtn.className = "export-btn";
  editPointsBtn.title = "휴식(자리비움) 구간과 채팅 폭발·후원 몰림 시점을 방송 경과 시간 기준 CSV로 내보냅니다 (영상 편집 참고용)";
  editPointsBtn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7,10 12,15 17,10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> 편집점 내보내기';
  editPointsBtn.addEventListener("click", () => exportEditPoints(s, data));
  rightGroup.append(legend, editPointsBtn);
  head.append(left, rightGroup);
  timelineContent.appendChild(head);

  const chartBox = document.createElement("div");
  chartBox.className = "tl-chart-box";

  // 시간 직접 이동 + 확대/축소 컨트롤. 방송이 길어서 버킷이 많아지면(막대가 얇아지면) 이걸로
  // 원하는 시점을 정확히 찾아가거나 막대를 더 굵게 확대해서 클릭할 수 있다.
  const controls = document.createElement("div");
  controls.className = "tl-controls";
  const jumpBox = document.createElement("div");
  jumpBox.className = "tl-jump";
  const jumpInput = document.createElement("input");
  jumpInput.type = "text";
  jumpInput.placeholder = "예: 1:23:32";
  const jumpBtn = document.createElement("button");
  jumpBtn.textContent = "이동";
  const jumpError = document.createElement("span");
  jumpError.className = "tl-jump-error";
  jumpError.style.display = "none";
  jumpBtn.addEventListener("click", () => jumpToTime(jumpInput, jumpError));
  jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToTime(jumpInput, jumpError);
  });
  jumpBox.append(jumpInput, jumpBtn, jumpError);

  const zoomIdx = t.zoomIdx ?? DEFAULT_ZOOM_IDX;
  const zoomPx = ZOOM_LEVELS[zoomIdx];
  const zoomBox = document.createElement("div");
  zoomBox.className = "tl-zoom";
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.className = "tl-zoom-btn";
  zoomOutBtn.textContent = "−";
  zoomOutBtn.disabled = zoomIdx === 0;
  zoomOutBtn.title = "축소 (막대 얇게, 스크롤 줄이기)";
  zoomOutBtn.addEventListener("click", () => changeZoom("out"));
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "tl-zoom-label";
  zoomLabel.textContent = `${zoomPx}px`;
  const zoomInBtn = document.createElement("button");
  zoomInBtn.className = "tl-zoom-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.disabled = zoomIdx === ZOOM_LEVELS.length - 1;
  zoomInBtn.title = "확대 (막대 굵게, 클릭하기 편하게)";
  zoomInBtn.addEventListener("click", () => changeZoom("in"));
  zoomBox.append(zoomOutBtn, zoomLabel, zoomInBtn);

  controls.append(jumpBox, zoomBox);
  chartBox.appendChild(controls);

  const hint = document.createElement("div");
  hint.className = "tl-chart-hint";
  const bucketMinutes = Math.max(1, Math.round(data.bucketMs / 60000));
  hint.innerHTML = `<span class="label">채팅량 (${bucketMinutes}분당)</span><span class="hint">막대/구간 클릭 또는 시간 입력으로 이동 · 방송이 길면 확대(+)해서 클릭하세요</span>`;
  chartBox.appendChild(hint);

  // 막대/구간을 실제 시간 비율(px per ms)로 그린다 — 확대할수록, 방송이 길수록 전체 너비가
  // 화면보다 커지므로 .tl-hscroll이 가로 스크롤을 담당한다.
  const stepPx = zoomPx + TL_BAR_GAP_PX;
  const pxPerMs = stepPx / data.bucketMs;

  const hScroll = document.createElement("div");
  hScroll.className = "tl-hscroll";
  hScroll.id = "tlHScroll";

  const volChart = document.createElement("div");
  volChart.id = "tlVolumeChart";
  const maxCount = Math.max(1, ...data.volumeBuckets.map((b) => b.count));
  data.volumeBuckets.forEach((b, i) => {
    const bar = document.createElement("div");
    bar.className = "tl-bar";
    bar.style.width = `${zoomPx}px`;
    bar.style.height = `${Math.max(3, Math.round((b.count / maxCount) * 88))}px`;
    const isSelected = t.selectedBucketIdx === i;
    const base = b.count > maxCount * 0.75 ? "#f5a623" : b.count > maxCount * 0.35 ? "#5b8def" : "#2f3d5c";
    bar.style.background = isSelected ? "#ffffff" : base;
    bar.style.opacity = t.selectedBucketIdx === null || isSelected ? "1" : "0.45";
    bar.title = `${fmtClock(b.bucketStart)} · ${b.count}건`;
    bar.addEventListener("click", () => selectBucket(i));
    volChart.appendChild(bar);
  });
  hScroll.appendChild(volChart);

  const segRow = document.createElement("div");
  segRow.id = "tlSegments";
  data.segments.forEach((seg, i) => {
    const c = ACTIVITY_COLORS[seg.type] || ACTIVITY_COLORS["대화중"];
    const wrap = document.createElement("div");
    wrap.className = "tl-segment";
    const widthPx = Math.max(8, (seg.end - seg.start) * pxPerMs);
    wrap.style.width = `${widthPx}px`;
    const on = t.selectedSegmentIdx === i;
    const block = document.createElement("div");
    block.className = "block";
    block.style.background = c.soft;
    block.style.borderColor = on ? c.bar : c.line;
    if (on) block.style.boxShadow = `0 0 0 1px ${c.bar}`;
    if (widthPx >= 50) {
      const span = document.createElement("span");
      span.style.color = c.bar;
      span.textContent = seg.label;
      block.appendChild(span);
    }
    const label = document.createElement("div");
    label.className = "time-label";
    label.style.color = on ? c.bar : "#8a8d96";
    label.textContent = fmtClock(seg.start);
    wrap.append(block, label);
    wrap.addEventListener("click", () => selectSegment(i));
    segRow.appendChild(wrap);
  });
  hScroll.appendChild(segRow);

  if (t.selectedUser && t.userTimelineCache) {
    const markWrap = document.createElement("div");
    markWrap.id = "tlUserMarks";
    markWrap.style.display = "block";
    const lbl = document.createElement("div");
    lbl.className = "label";
    lbl.textContent = `${t.selectedUser} 님의 채팅 시점`;
    const track = document.createElement("div");
    track.className = "track";
    track.style.width = `${Math.max(1, data.volumeBuckets.length * stepPx)}px`;
    const baseline = document.createElement("div");
    baseline.className = "baseline";
    track.appendChild(baseline);
    t.userTimelineCache.messages.forEach((m) => {
      const px = Math.max(0, (m.time - data.sessionStart) * pxPerMs);
      const mark = document.createElement("div");
      mark.className = "mark";
      mark.style.left = `${px}px`;
      mark.style.background = nickColor(t.selectedUser);
      track.appendChild(mark);
    });
    markWrap.append(lbl, track);
    hScroll.appendChild(markWrap);
  }

  chartBox.appendChild(hScroll);
  timelineContent.appendChild(chartBox);

  // 가로 스크롤 위치 결정: 시간 이동/막대·구간 클릭으로 방금 선택이 바뀌었으면 그 지점이
  // 보이게, 확대/축소 버튼을 눌렀으면 이전에 보던 위치 비율을 유지하게, 그것도 아니면(예:
  // 5초 주기 자동 갱신) 원래 스크롤 위치를 그대로 복원한다.
  if (t.scrollToSelection && t.selectedBucketIdx !== null) {
    const barCenter = t.selectedBucketIdx * stepPx + zoomPx / 2;
    hScroll.scrollLeft = Math.max(0, barCenter - hScroll.clientWidth / 2);
    t.scrollToSelection = false;
  } else if (t.pendingZoomCenterRatio !== null && t.pendingZoomCenterRatio !== undefined) {
    hScroll.scrollLeft = Math.max(0, t.pendingZoomCenterRatio * hScroll.scrollWidth - hScroll.clientWidth / 2);
    t.pendingZoomCenterRatio = null;
  } else {
    hScroll.scrollLeft = savedHScrollLeft;
  }

  const chipsRow = document.createElement("div");
  chipsRow.id = "tlUserChips";
  const caption = document.createElement("span");
  caption.className = "caption";
  caption.textContent = "유저 지정:";
  chipsRow.appendChild(caption);
  data.topUsers.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "tl-user-chip" + (t.selectedUser === u.nickname ? " active" : "");
    chip.textContent = u.nickname;
    chip.addEventListener("click", () => selectUser(u.nickname));
    chipsRow.appendChild(chip);
  });
  if (t.selectedUser) {
    const clear = document.createElement("span");
    clear.id = "tlUserClear";
    clear.textContent = "해제 ✕";
    clear.addEventListener("click", clearUserSelection);
    chipsRow.appendChild(clear);
  }
  timelineContent.appendChild(chipsRow);

  if (t.selectedUser && t.userTimelineCache) {
    const u = t.userTimelineCache;
    const color = nickColor(t.selectedUser);
    const summary = document.createElement("div");
    summary.id = "tlUserSummary";
    summary.style.display = "block";
    summary.innerHTML = `
      <div class="head">
        <span class="dot" style="background:${color}"></span>
        <span class="name" style="color:${color}">${t.selectedUser}</span>
        <span class="sub">주 활동 · ${u.mainActivity}</span>
      </div>
      <div class="grid">
        <div><div class="k">총 채팅</div><div class="v">${u.totalMessages}회</div></div>
        <div><div class="k">첫 채팅</div><div class="v">${fmtClock(u.firstMessageAt)}</div></div>
        <div><div class="k">마지막 채팅</div><div class="v">${fmtClock(u.lastMessageAt)}</div></div>
        <div><div class="k">후원</div><div class="v" style="color:#f5a623;">${u.donationAmount.toLocaleString()}원</div></div>
      </div>`;
    timelineContent.appendChild(summary);
  } else if (t.selectedUser) {
    const empty = document.createElement("div");
    empty.style.cssText = "margin-top:12px; font-size:11.5px; color:#4a4d55;";
    empty.textContent = "이 유저의 채팅 기록을 찾을 수 없습니다.";
    timelineContent.appendChild(empty);
  }

  const moments = document.createElement("div");
  moments.className = "tl-moments";
  data.highlights.forEach((h) => {
    const card = document.createElement("div");
    card.className = "tl-moment-card";
    const color = h.type === "quiet" ? "#6b6f78" : "#f5a623";
    card.innerHTML = `<div class="time" style="color:${color}">${fmtClock(h.time)}</div><div class="label">${h.label}</div><div class="detail">${h.detail}</div>`;
    card.addEventListener("click", () => selectNearestBucket(h.time));
    moments.appendChild(card);
  });
  timelineContent.appendChild(moments);

  await renderTimelineDetail();
  timelineView.scrollTop = scrollPos;
}

async function renderTimelineDetail() {
  const s = currentState();
  if (!s || !s.timeline.data) return;
  const data = s.timeline.data;
  const t = s.timeline;

  const detailWrap = document.createElement("div");

  const detailHead = document.createElement("div");
  detailHead.className = "tl-detail-head";
  const detailTitle = document.createElement("span");
  detailTitle.className = "section-title";
  detailTitle.textContent = "선택 구간 상세";
  detailHead.appendChild(detailTitle);

  let rangeStart;
  let rangeEnd;
  let badgeText;
  let badgeColor;
  let badgeSoft;
  let rangeLabel;
  let focusLabel;

  if (t.selectedUser) {
    rangeStart = data.sessionStart;
    rangeEnd = data.sessionEnd;
    badgeText = "유저";
    badgeColor = "#5b8def";
    badgeSoft = "rgba(91,141,239,0.16)";
    rangeLabel = `${t.selectedUser} 님의 채팅 기록`;
    focusLabel = "유저 필터";
  } else if (t.selectedBucketIdx !== null && data.volumeBuckets[t.selectedBucketIdx]) {
    const b = data.volumeBuckets[t.selectedBucketIdx];
    rangeStart = b.bucketStart;
    rangeEnd = b.bucketStart + data.bucketMs;
    const seg = t.selectedSegmentIdx !== null ? data.segments[t.selectedSegmentIdx] : null;
    const c = seg ? ACTIVITY_COLORS[seg.type] : ACTIVITY_COLORS["대화중"];
    badgeText = seg ? seg.type : "구간";
    badgeColor = c.bar;
    badgeSoft = c.soft;
    rangeLabel = `${fmtClock(rangeStart)} 전후`;
    focusLabel = `${b.count}건/분`;
  } else if (t.selectedSegmentIdx !== null && data.segments[t.selectedSegmentIdx]) {
    const seg = data.segments[t.selectedSegmentIdx];
    rangeStart = seg.start;
    rangeEnd = seg.end;
    const c = ACTIVITY_COLORS[seg.type] || ACTIVITY_COLORS["대화중"];
    badgeText = seg.type;
    badgeColor = c.bar;
    badgeSoft = c.soft;
    rangeLabel = `${fmtClockRange(seg.start, seg.end)} · ${seg.label}`;
    focusLabel = "구간 전체";
  } else {
    rangeStart = data.sessionStart;
    rangeEnd = data.sessionEnd;
    badgeText = "전체";
    badgeColor = "#8a8d96";
    badgeSoft = "#1a1c22";
    rangeLabel = "막대 또는 활동 구간을 클릭해 시간대를 선택해주세요";
    focusLabel = "전체 방송";
  }

  const badge = document.createElement("span");
  badge.className = "tl-detail-badge";
  badge.style.color = badgeColor;
  badge.style.background = badgeSoft;
  badge.textContent = badgeText;
  const range = document.createElement("span");
  range.className = "tl-detail-range";
  range.textContent = rangeLabel;
  const focus = document.createElement("span");
  focus.className = "tl-focus-label";
  focus.textContent = focusLabel;
  detailHead.append(badge, range, focus);
  detailWrap.appendChild(detailHead);

  const entries = t.selectedUser && t.userTimelineCache ? t.userTimelineCache.messages : null;
  const messages = entries ? null : await window.api.getMessagesInRange(s.channelId, rangeStart, rangeEnd);
  if (selectedChannelId !== s.channelId) return;

  const count = entries ? entries.length : messages.length;
  const uniqueUsers = entries ? (count > 0 ? 1 : 0) : new Set(messages.map((m) => m.userIdHash)).size;
  const donationSum = entries
    ? entries.reduce((sum, m) => sum + (m.isDonation ? m.donationAmount || 0 : 0), 0)
    : messages.reduce((sum, m) => sum + (m.isDonation ? m.donationAmount || 0 : 0), 0);

  const metricGrid = document.createElement("div");
  metricGrid.className = "metric-grid";
  metricGrid.style.marginBottom = "12px";
  metricGrid.appendChild(metricCard(t.selectedUser ? "총 채팅" : "구간 채팅", count.toLocaleString()));
  metricGrid.appendChild(metricCard("참여자", uniqueUsers.toLocaleString()));
  metricGrid.appendChild(metricCard(t.selectedUser ? "후원" : "구간 후원", `${donationSum.toLocaleString()}원`, true));
  detailWrap.appendChild(metricGrid);

  const logBox = document.createElement("div");
  logBox.id = "tlLog";
  const logHead = document.createElement("div");
  logHead.className = "head";
  logHead.textContent = t.selectedUser ? `${t.selectedUser} 님의 채팅 기록` : "누가 · 언제 · 무엇을 말했는지";
  logBox.appendChild(logHead);

  const rows = entries
    ? entries.map((m) => ({
        time: m.time,
        nickname: t.selectedUser,
        message: m.message,
        isDonation: m.isDonation,
        act: m.activityType,
      }))
    : messages
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((m) => ({ time: m.timestamp, nickname: m.nickname, message: m.message, isDonation: m.isDonation, act: null }));

  const MAX_ROWS = 300;
  const shown = rows.slice(-MAX_ROWS);
  if (rows.length > MAX_ROWS) {
    const notice = document.createElement("div");
    notice.style.cssText = "padding:8px 12px; font-size:10.5px; color:#5c6069;";
    notice.textContent = `최근 ${MAX_ROWS}건만 표시합니다 (전체 ${rows.length}건)`;
    logBox.appendChild(notice);
  }
  shown.forEach((r) => {
    const row = document.createElement("div");
    row.className = "tl-log-row";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtClockSec(r.time);
    row.appendChild(time);
    if (r.act) {
      const actTag = document.createElement("span");
      actTag.className = "act";
      const c = ACTIVITY_COLORS[r.act] || ACTIVITY_COLORS["대화중"];
      actTag.style.color = c.bar;
      actTag.style.background = c.soft;
      actTag.textContent = r.act;
      row.appendChild(actTag);
    } else {
      const nick = document.createElement("span");
      nick.className = "nick";
      nick.style.color = nickColor(r.nickname);
      nick.textContent = r.nickname;
      row.appendChild(nick);
    }
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = r.isDonation ? `🎁 ${r.message}` : r.message;
    row.appendChild(text);
    logBox.appendChild(row);
  });
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:14px 12px; font-size:11.5px; color:#4a4d55;";
    empty.textContent = "이 구간에는 채팅이 없습니다.";
    logBox.appendChild(empty);
  }

  detailWrap.appendChild(logBox);
  timelineContent.appendChild(detailWrap);
}

// ---- 즐겨찾기 사이드바 ----

function logToChannel(state, entry) {
  if (!state) return;
  state.logs.push(entry);
  if (state.logs.length > 1000) state.logs.shift();
  if (selectedChannelId === state.channelId) logView.appendChild(createLogRow(entry));
  logView.scrollTop = logView.scrollHeight;
}

async function renderSidebar() {
  favoriteList.innerHTML = "";
  if (favorites.length === 0) {
    favoriteList.appendChild(favoriteEmpty);
    return;
  }
  favorites.forEach((fav) => {
    const s = getOrCreateState(fav.channelId, fav.channelName);
    const row = document.createElement("div");
    row.className = "fav-row" + (selectedChannelId === fav.channelId ? " selected" : "");

    const dot = document.createElement("span");
    dot.className = "fav-dot" + (s.phase === "monitoring" ? " monitoring" : s.phase === "done" ? " done" : "");

    const info = document.createElement("div");
    info.className = "fav-info";
    const name = document.createElement("div");
    name.className = "fav-name";
    name.textContent = fav.channelName;
    const status = document.createElement("div");
    status.className = "fav-status";
    status.textContent = statusLineFor(s);
    info.append(name, status);

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "fav-toggle";
    toggleLabel.title = "켜면 지금 바로 감시를 시작하고, 다음에 앱을 켤 때도 자동으로 시작합니다";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = !!fav.autoStart;
    toggleInput.addEventListener("click", (e) => e.stopPropagation());
    toggleInput.addEventListener("change", async () => {
      toggleInput.disabled = true;
      const checked = toggleInput.checked;
      if (!checked) s.stopRequested = true; // report-ready 도착 시 진짜로 멈춰달라는 요청이었음을 알려줌
      const res = await window.api.setFavoriteAutoStart(fav.channelId, checked);
      toggleInput.disabled = false;
      if (res && res.ok) {
        favorites = res.favorites;
        // stopWatcherFor/startWatcherFor 응답을 따로 기다리지 않고, 이전 감시 시작/종료 버튼과
        // 같은 방식으로 낙관적으로 상태를 반영한다 (실제 세션 시작은 session-start 이벤트로 확정).
        // 껐을 때(!checked) 진행 중이던 세션이 있었으면(res.hadSession) "종료" 버튼과 동일하게
        // phase를 바로 idle로 바꾸지 않는다 — 곧 report-ready 이벤트가 phase를 "monitoring"
        // (다음 방송 대기)으로 되돌려놓는데, 그 사이에 idle로 잘못 반영해두면 refreshTimeline()이
        // "데이터 없음"으로 착각해서 이미 끝난 방송의 타임라인이 잠깐(또는 다시 안 켜질 때까지)
        // 사라져 보이는 버그가 있었다.
        if (checked) {
          s.phase = "monitoring";
        } else if (!res.hadSession) {
          s.phase = "idle";
          s.startedAt = null;
        }
      }
      renderSidebar();
      if (selectedChannelId === fav.channelId) updateTopbar();
    });
    const slider = document.createElement("span");
    slider.className = "fav-toggle-slider";
    toggleLabel.append(toggleInput, slider);

    const removeBtn = document.createElement("button");
    removeBtn.className = "fav-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "즐겨찾기에서 삭제";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm(`'${fav.channelName}'을(를) 즐겨찾기에서 삭제할까요? 감시 중이면 함께 종료됩니다.`)) return;
      const res = await window.api.removeFavorite(fav.channelId);
      if (res && res.ok) {
        favorites = res.favorites;
        if (selectedChannelId === fav.channelId) {
          selectedChannelId = null;
          teardownLivePlayer();
          updateTopbar();
          updateMainVisibility();
        }
        renderSidebar();
      }
    });

    row.append(dot, info, toggleLabel, removeBtn);
    row.addEventListener("click", () => selectChannel(fav.channelId));
    favoriteList.appendChild(row);
  });
}

/** 사이드바 두 목록(즐겨찾기/VOD) 전부 다시 그린다. 선택 상태(row.selected)가 두 목록
 * 어디에도 걸쳐 있을 수 있어서, 세그먼트가 안 보이는 쪽도 항상 같이 갱신해둔다. */
function renderSidebarAll() {
  renderSidebar();
  renderVodJobList();
}

// ---- VOD 분석 사이드바 ----

function vodStatusLineFor(job) {
  if (job.status === "fetching") {
    const p = job.progress || {};
    if (p.phase === "chat") {
      const count = (p.fetchedCount || 0).toLocaleString();
      return typeof p.percent === "number" ? `채팅 수집 중 · ${count}개 (${p.percent}%)` : `채팅 수집 중 · ${count}개`;
    }
    if (p.phase === "report") return "리포트 생성 중...";
    return "영상 정보 조회 중...";
  }
  if (job.visionStatus === "running") {
    const p = job.progress || {};
    if (p.phase === "vision") {
      const count = (p.fetchedCount || 0).toLocaleString();
      return typeof p.percent === "number" ? `정밀분석 중 · ${count}회 호출 (${p.percent}%)` : `정밀분석 중 · ${count}회 호출`;
    }
    return "정밀분석 중...";
  }
  if (job.status === "done") return job.visionStatus === "done" ? "분석 완료 (정밀분석 반영됨)" : "분석 완료";
  if (job.status === "error") return job.error ? `실패: ${job.error}` : "분석 실패";
  return "대기 중";
}

function renderVodJobList() {
  vodJobList.innerHTML = "";
  if (vodJobsList.length === 0) {
    vodJobList.appendChild(vodJobEmpty);
    return;
  }
  vodJobsList.forEach((job) => {
    const row = document.createElement("div");
    row.className = "vod-row" + (selectedChannelId === job.jobId ? " selected" : "");

    const dot = document.createElement("span");
    dot.className =
      "vod-dot" +
      (job.status === "fetching" ? " running" : job.status === "done" ? " done" : job.status === "error" ? " error" : "");

    const info = document.createElement("div");
    info.className = "vod-info";
    const name = document.createElement("div");
    name.className = "vod-name";
    name.textContent = job.videoTitle || job.videoNo || job.jobId;
    const status = document.createElement("div");
    status.className = "vod-status";
    status.textContent = vodStatusLineFor(job);
    info.append(name, status);
    if (job.status === "fetching" && job.progress && typeof job.progress.percent === "number") {
      const bar = document.createElement("div");
      bar.className = "vod-progress-bar";
      const fill = document.createElement("div");
      fill.style.width = `${Math.max(0, Math.min(100, job.progress.percent))}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }

    // "정밀분석"(화면 분석) 버튼. 기본 분석(status=done)이 끝난 뒤에만 시작할 수 있고, 진행
    // 중이면 취소 버튼으로 바뀐다. 완료됐으면 다시 눌러서 재실행할 수도 있다(예: 신뢰도 설정을
    // 바꾼 뒤 다시 돌려보고 싶을 때).
    let visionBtn = null;
    if (job.status === "done") {
      visionBtn = document.createElement("button");
      visionBtn.className = "vod-vision-btn";
      if (job.visionStatus === "running") {
        visionBtn.textContent = "정밀분석 취소";
        visionBtn.classList.add("running");
        visionBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await window.api.cancelVodVisionAnalysis(job.jobId);
        });
      } else {
        visionBtn.textContent = job.visionStatus === "done" ? "정밀분석 다시 실행" : "정밀분석";
        visionBtn.title = "실제 방송 화면을 Claude 비전 API로 분석해서 게임중/대화중/휴식중(먹방 포함) 판단 정확도를 높입니다. 호출마다 비용이 조금씩 발생합니다.";
        visionBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const res = await window.api.startVodVisionAnalysis(job.jobId);
          if (!res || !res.ok) window.alert((res && res.error) || "정밀분석을 시작하지 못했습니다.");
        });
      }
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "vod-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "목록에서 삭제";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (job.status === "fetching") {
        if (!window.confirm("아직 채팅을 수집하는 중입니다. 목록에서만 지울까요? (진행 중인 수집 자체는 계속됩니다)")) return;
      }
      await window.api.removeVodJob(job.jobId);
      vodJobsList = vodJobsList.filter((j) => j.jobId !== job.jobId);
      channelsState.delete(job.jobId);
      if (selectedChannelId === job.jobId) {
        selectedChannelId = null;
        updateTopbar();
        updateMainVisibility();
      }
      renderVodJobList();
    });

    row.append(dot, info);
    if (visionBtn) row.appendChild(visionBtn);
    row.appendChild(removeBtn);
    row.addEventListener("click", () => selectChannel(job.jobId));
    vodJobList.appendChild(row);
  });
}

/** 사이드바 상단 세그먼트("즐겨찾기" / "VOD 분석") 전환. 목록 자체는 항상 최신 상태로 그려져
 * 있으니 여기선 그냥 보여줄 패널만 바꾼다. */
function switchSegment(seg) {
  segFavorites.classList.toggle("active", seg === "favorites");
  segVod.classList.toggle("active", seg === "vod");
  segPanelFavorites.style.display = seg === "favorites" ? "flex" : "none";
  segPanelVod.style.display = seg === "vod" ? "flex" : "none";
}

async function addVodAnalysis() {
  const raw = vodAddInput.value;
  vodAddError.style.display = "none";
  if (!raw || !raw.trim()) return;
  vodAddBtn.disabled = true;
  const res = await window.api.startVodAnalysis(raw);
  vodAddBtn.disabled = false;
  if (!res || !res.ok) {
    vodAddError.textContent = (res && res.error) || "VOD 분석 시작에 실패했습니다.";
    vodAddError.style.display = "block";
    return;
  }
  vodAddInput.value = "";
  const jobId = res.jobId;
  getOrCreateVodState(jobId, jobId);
  if (!vodJobsList.some((j) => j.jobId === jobId)) {
    vodJobsList.unshift({
      jobId,
      videoNo: jobId,
      videoTitle: jobId,
      channelName: "",
      status: "fetching",
      error: null,
      progress: { phase: "video", fetchedCount: 0, percent: 0 },
    });
  }
  renderVodJobList();
  selectChannel(jobId);
}

function selectChannel(channelId) {
  if (selectedChannelId === channelId) return;
  selectedChannelId = channelId;
  const s = currentState();
  updateMainVisibility();
  updateTopbar();
  renderSidebarAll();
  if (!s) return;

  stripChannel.textContent = s.channelName;
  stripMsgCount.textContent = s.msgCount.toLocaleString();
  stripDonationCount.textContent = s.donationCount.toLocaleString();
  stripElapsed.textContent = s.startedAt ? formatElapsed((s.endedAt || Date.now()) - s.startedAt) : "00:00:00";
  updateVisionBadge();

  renderLogView();
  if (s.isVod) {
    teardownLivePlayer(); // VOD 화면으로 넘어왔으니, 이전에 보고 있던 라이브 채널의 영상은 정리한다.
    renderVodMediaPanel();
  } else {
    renderChatFeed();
    renderLiveVideoPanel();
  }
  renderReportView();

  switchTab(s.activeTab || "log");
}

// ---- 편의 기능: 설정 ----

// chzzk 로그인 상태(로그인 창 여닫는 것과 무관하게, 설정 화면이 열려있는 동안 버튼/문구를
// 갱신하는 데 쓰는 로컬 플래그). chzzkLoggedIn의 출처는 config.json의 nidAuth/nidSession
// "존재 여부"이고, chzzkLoginExpired는 그 값이 실제로 아직 유효한지 서버에 물어본 결과다 —
// 둘을 나눈 이유는 쿠키가 저장은 돼 있지만 만료된 경우("영상 정보를 찾을 수 없습니다" 같은
// 알쏭달쏭한 에러로만 드러나던 문제)를 설정 화면에서 미리 보여주기 위함.
let chzzkLoggedIn = false;
let chzzkLoginExpired = false;

function updateChzzkLoginUI() {
  chzzkLoginStatus.classList.remove("on", "expired");
  if (chzzkLoginExpired) {
    chzzkLoginStatus.textContent = "로그인 만료됨 (다시 로그인 필요)";
    chzzkLoginStatus.classList.add("expired");
    chzzkLoginBtn.textContent = "다시 로그인";
  } else {
    chzzkLoginStatus.textContent = chzzkLoggedIn ? "로그인됨" : "로그인 안 됨";
    chzzkLoginStatus.classList.toggle("on", chzzkLoggedIn);
    chzzkLoginBtn.textContent = chzzkLoggedIn ? "로그아웃" : "chzzk 로그인";
  }
}

function openSettings() {
  settingsStatus.style.display = "none";
  window.api.getConfig().then((cfg) => {
    chzzkLoggedIn = !!(cfg && cfg.nidAuth && cfg.nidSession);
    chzzkLoginExpired = false;
    updateChzzkLoginUI();
    settingsApiKey.value = (cfg && cfg.anthropicApiKey) || "";
    settingsOverlay.style.display = "flex";
    // 쿠키가 저장돼 있으면 실제로 아직 유효한지 백그라운드에서 확인한다. 네트워크 요청이라
    // 시간이 좀 걸릴 수 있어서, 켜져 있는 동안엔 "확인 중..."을 잠깐 보여준다.
    if (chzzkLoggedIn) {
      chzzkLoginStatus.textContent = "로그인 상태 확인 중...";
      window.api.checkChzzkLogin().then((res) => {
        if (settingsOverlay.style.display === "none") return; // 그 사이 설정 창을 닫았으면 무시
        if (res && res.state === "expired") {
          chzzkLoginExpired = true;
        } else if (res && res.state === "none") {
          chzzkLoggedIn = false;
        }
        updateChzzkLoginUI();
      });
    }
  });
  window.api.getLaunchAtLogin().then((res) => {
    settingsAutoLaunch.checked = !!(res && res.ok && res.enabled);
  });
}

function closeSettings() {
  settingsOverlay.style.display = "none";
}

// ---- 고급 설정 (로컬 분석 로직 세부값) ----
// 예전엔 collector.ts/timeline.ts/motion-detector.ts에 매직넘버로 박혀있던 값들을 여기서
// 직접 조절할 수 있게 한다. 필드가 여러 개라 화면에 일일이 마크업을 쓰는 대신, 아래
// 목록(그룹/키/라벨/단위) 하나로 렌더링+읽기+저장을 전부 처리한다.
// unit: "sec"면 저장 시 ms로 환산(×1000), 화면엔 초 단위로 보여준다. "raw"는 그대로.
const ADVANCED_SETTINGS_FIELDS = [
  {
    group: "상태 확인",
    fields: [{ key: "statusPollMs", label: "방송 상태 확인 주기", unit: "sec", step: 1, min: 5 }],
  },
  {
    group: "휴식(자리비움) 감지",
    fields: [
      { key: "restCheckIntervalMs", label: "휴식 감지 체크 주기", unit: "sec", step: 1, min: 2 },
      { key: "restSuspectTicks", label: "휴식 의심 전환까지 필요한 연속 정지 횟수", unit: "raw", step: 1, min: 1 },
      { key: "restBurstSamples", label: "재확인 샘플 개수", unit: "raw", step: 1, min: 1 },
      { key: "restBurstGapMs", label: "재확인 샘플 간격", unit: "sec", step: 0.5, min: 0.5 },
      { key: "restBurstMinStatic", label: "재확인 중 최소 정지 샘플 수", unit: "raw", step: 1, min: 1 },
      { key: "motionAbsFloor", label: "노이즈 무시 최소 변화량 (0~255)", unit: "raw", step: 1, min: 0, max: 255 },
      {
        key: "motionRelativeFactor",
        label: "정지 판단 민감도 (최근 평균 대비 비율)",
        unit: "raw",
        step: 0.05,
        min: 0.01,
        max: 1,
      },
      { key: "motionRollingWindow", label: "정지 판단 기준선 계산 샘플 개수", unit: "raw", step: 1, min: 3 },
    ],
  },
  {
    group: "타임라인(채팅 기반) 판단",
    fields: [
      { key: "timelineBucketMs", label: "채팅량 집계 기본 단위시간", unit: "sec", step: 10, min: 10 },
      { key: "timelineMinSegmentMs", label: "최소 구간 길이 (이보다 짧으면 병합)", unit: "sec", step: 10, min: 10 },
      { key: "timelineQuietMinBuckets", label: "휴식 후보 최소 연속 잠잠 구간 수", unit: "raw", step: 1, min: 1 },
    ],
  },
  {
    group: "AI 화면 분석 (Claude API 키가 있을 때만 동작)",
    fields: [
      { key: "frameIntervalMs", label: "화면 분류 기본 간격", unit: "sec", step: 10, min: 10 },
      {
        key: "visionConfidenceThreshold",
        label: "신뢰도 임계값 (이보다 낮은 응답은 버림, 0~1)",
        unit: "raw",
        step: 0.05,
        min: 0,
        max: 1,
      },
      { key: "visionConfirmCount", label: "상태 확정까지 필요한 연속 동일 판정 횟수", unit: "raw", step: 1, min: 1 },
      { key: "moodMaxSampleMessages", label: "AI 분위기 요약에 넘길 최대 채팅 샘플 수", unit: "raw", step: 10, min: 10 },
    ],
  },
];

let advancedSettingsCurrent = null; // 마지막으로 불러온 값 (취소 시 복원용, 저장은 안 함)

function renderAdvancedSettingsFields(values) {
  advancedSettingsFields.innerHTML = "";
  for (const group of ADVANCED_SETTINGS_FIELDS) {
    const groupEl = document.createElement("div");
    groupEl.className = "adv-group";
    const titleEl = document.createElement("div");
    titleEl.className = "adv-group-title";
    titleEl.textContent = group.group;
    groupEl.appendChild(titleEl);

    for (const field of group.fields) {
      const rowEl = document.createElement("div");
      rowEl.className = "adv-field";
      const labelEl = document.createElement("label");
      labelEl.textContent = field.label;
      if (field.unit === "sec") {
        const unitEl = document.createElement("span");
        unitEl.className = "unit";
        unitEl.textContent = "(초)";
        labelEl.appendChild(unitEl);
      }
      const inputEl = document.createElement("input");
      inputEl.type = "number";
      inputEl.step = String(field.step ?? 1);
      if (field.min !== undefined) inputEl.min = String(field.min);
      if (field.max !== undefined) inputEl.max = String(field.max);
      inputEl.dataset.key = field.key;
      inputEl.dataset.unit = field.unit;
      const raw = values[field.key];
      inputEl.value = field.unit === "sec" ? String(raw / 1000) : String(raw);
      rowEl.appendChild(labelEl);
      rowEl.appendChild(inputEl);
      groupEl.appendChild(rowEl);
    }
    advancedSettingsFields.appendChild(groupEl);
  }
}

function collectAdvancedSettingsValues() {
  const result = {};
  const inputs = advancedSettingsFields.querySelectorAll("input[data-key]");
  for (const input of inputs) {
    const num = Number(input.value);
    if (Number.isNaN(num)) continue; // 잘못된 입력은 조용히 건너뜀 (기존 저장값 유지)
    result[input.dataset.key] = input.dataset.unit === "sec" ? Math.round(num * 1000) : num;
  }
  return result;
}

async function openAdvancedSettings() {
  advancedSettingsStatus.style.display = "none";
  const res = await window.api.getAnalysisSettings();
  advancedSettingsCurrent = (res && res.current) || {};
  renderAdvancedSettingsFields(advancedSettingsCurrent);
  advancedSettingsOverlay.style.display = "flex";
}

function closeAdvancedSettings() {
  advancedSettingsOverlay.style.display = "none";
}

advancedSettingsBtn.addEventListener("click", openAdvancedSettings);
advancedSettingsCancel.addEventListener("click", closeAdvancedSettings);
advancedSettingsOverlay.addEventListener("click", (e) => {
  if (e.target === advancedSettingsOverlay) closeAdvancedSettings();
});
advancedSettingsSave.addEventListener("click", async () => {
  advancedSettingsSave.disabled = true;
  const partial = collectAdvancedSettingsValues();
  const res = await window.api.saveAnalysisSettings(partial);
  advancedSettingsSave.disabled = false;
  if (res && res.ok) {
    advancedSettingsCurrent = res.settings;
    advancedSettingsStatus.textContent = "저장했습니다. 다음에 새로 시작하는 감시/분석부터 적용됩니다.";
    advancedSettingsStatus.style.display = "block";
  } else {
    advancedSettingsStatus.textContent = (res && res.error) || "저장에 실패했습니다.";
    advancedSettingsStatus.style.display = "block";
  }
});
advancedSettingsReset.addEventListener("click", async () => {
  advancedSettingsReset.disabled = true;
  const res = await window.api.resetAnalysisSettings();
  advancedSettingsReset.disabled = false;
  if (res && res.ok) {
    advancedSettingsCurrent = res.settings;
    renderAdvancedSettingsFields(advancedSettingsCurrent);
    advancedSettingsStatus.textContent = "초기값으로 되돌렸습니다.";
    advancedSettingsStatus.style.display = "block";
  }
});

// ---- 즐겨찾기 추가 ----

async function addFavorite() {
  const channelId = extractChannelId(favoriteAddInput.value);
  favoriteAddError.style.display = "none";
  if (!channelId) return;
  favoriteAddBtn.disabled = true;
  const res = await window.api.addFavorite(channelId);
  favoriteAddBtn.disabled = false;
  if (!res || !res.ok) {
    favoriteAddError.textContent = (res && res.error) || "즐겨찾기 추가에 실패했습니다.";
    favoriteAddError.style.display = "block";
    return;
  }
  favorites = res.favorites;
  favoriteAddInput.value = "";
  renderSidebar();
  selectChannel(channelId);
}

// ---- 이벤트 연결 ----

titlebar.close.addEventListener("click", () => window.api.closeWindow());
titlebar.min.addEventListener("click", () => window.api.minimizeWindow());
titlebar.max.addEventListener("click", () => window.api.maximizeWindow());

tabLog.addEventListener("click", () => switchTab("log"));
tabReport.addEventListener("click", () => switchTab("report"));
tabTimeline.addEventListener("click", () => switchTab("timeline"));

settingsBtn.addEventListener("click", openSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
settingsApiKeyLink.addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://console.anthropic.com/settings/keys");
});
// 현재는 API 키만 명시적 저장이 필요하다(로그인/자동실행/고급설정은 각자 조작 시점에 바로
// 저장됨). 그래도 "설정" 화면 전체를 대표하는 저장 버튼이라 향후 필드가 늘어나도 여기 모아
// 저장하면 된다.
settingsSave.addEventListener("click", async () => {
  settingsSave.disabled = true;
  const res = await window.api.saveConfig({ anthropicApiKey: settingsApiKey.value.trim() });
  settingsSave.disabled = false;
  settingsStatus.style.display = "block";
  settingsStatus.textContent =
    res && res.ok ? "저장했습니다. 다음에 새로 시작하는 감시/분석부터 적용됩니다." : (res && res.error) || "저장에 실패했습니다.";
});
chzzkLoginBtn.addEventListener("click", async () => {
  chzzkLoginBtn.disabled = true;
  // 유효한 로그인 상태일 때만 버튼이 "로그아웃"으로 동작한다. 만료됐거나(expired) 애초에
  // 로그인 안 된 상태에서는 로그아웃할 게 없으니 바로 로그인 창을 연다.
  if (chzzkLoggedIn && !chzzkLoginExpired) {
    await window.api.chzzkLogout();
    chzzkLoggedIn = false;
    chzzkLoginExpired = false;
    chzzkLoginBtn.disabled = false;
    updateChzzkLoginUI();
    return;
  }
  chzzkLoginStatus.classList.remove("on", "expired");
  chzzkLoginStatus.textContent = "로그인 창을 여는 중...";
  const res = await window.api.openChzzkLogin();
  chzzkLoggedIn = !!(res && res.ok);
  chzzkLoginExpired = false;
  chzzkLoginBtn.disabled = false;
  updateChzzkLoginUI();
});
settingsAutoLaunch.addEventListener("change", async () => {
  const checked = settingsAutoLaunch.checked;
  settingsAutoLaunch.disabled = true;
  const res = await window.api.setLaunchAtLogin(checked);
  settingsAutoLaunch.disabled = false;
  if (!res || !res.ok) settingsAutoLaunch.checked = !checked; // 실패하면 원래 상태로 되돌림
});
favoriteAddBtn.addEventListener("click", addFavorite);
favoriteAddInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFavorite();
});

segFavorites.addEventListener("click", () => switchSegment("favorites"));
segVod.addEventListener("click", () => switchSegment("vod"));
vodAddBtn.addEventListener("click", addVodAnalysis);
vodAddInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addVodAnalysis();
});

stopBtn.addEventListener("click", async () => {
  const s = currentState();
  if (!s) return;
  stopBtn.disabled = true;
  s.stopRequested = true; // report-ready 도착 시 진짜로 멈춰달라는 요청이었음을 알려줌
  const fav = favorites.find((f) => f.channelId === s.channelId);
  const res = fav
    ? await window.api.setFavoriteAutoStart(s.channelId, false)
    : await window.api.stopWatch(s.channelId);
  if (fav && res && res.ok) favorites = res.favorites;
  // 세션이 있었으면 곧 'report-ready' 이벤트가 따라와서 done 상태로 넘어간다.
  // 세션이 아직 없었으면(방송 시작 전에 종료를 누른 경우) 바로 대기 상태로 되돌린다.
  const hadSession = res && (res.hadSession || (fav && s.startedAt));
  if (!hadSession) {
    s.phase = "idle";
    s.startedAt = null;
  }
  renderSidebar();
  if (selectedChannelId === s.channelId) updateTopbar();
});

window.api.onLog((evt) => {
  const s = getOrCreateState(evt.channelId);
  logToChannel(s, evt.payload);
});

window.api.onChat((evt) => {
  const s = getOrCreateState(evt.channelId);
  const preview = evt.payload;
  s.msgCount += 1;
  if (preview.isDonation) s.donationCount += 1;
  s.chats.push(preview);
  if (s.chats.length > 500) s.chats.shift();
  if (selectedChannelId === evt.channelId) {
    stripMsgCount.textContent = s.msgCount.toLocaleString();
    stripDonationCount.textContent = s.donationCount.toLocaleString();
    chatFeed.insertBefore(createChatRow(preview), liveIndicator);
    chatFeed.scrollTop = chatFeed.scrollHeight;
    while (chatFeed.childElementCount > 500) {
      const first = chatFeed.firstElementChild;
      if (first && first !== liveIndicator) chatFeed.removeChild(first);
      else break;
    }
  }
});

window.api.onSessionStart((evt) => {
  const session = evt.payload;
  const s = getOrCreateState(evt.channelId, session.channelName || session.channelId);
  s.phase = "monitoring";
  s.startedAt = session.startedAt;
  s.endedAt = null;
  s.msgCount = 0;
  s.donationCount = 0;
  s.logs = [];
  s.chats = [];
  s.reportPayload = null;
  s.stopRequested = false; // 새 방송이 시작됐으니 이전에 남아있을 수 있는 "종료 요청됨" 플래그를 안전하게 초기화
  s.timeline = newChannelState(s.channelId).timeline;
  renderSidebar();
  if (selectedChannelId === evt.channelId) {
    stripChannel.textContent = s.channelName;
    stripMsgCount.textContent = "0";
    stripDonationCount.textContent = "0";
    logView.innerHTML = "";
    renderChatFeed();
    reportContent.style.display = "none";
    reportEmpty.style.display = "flex";
    reportReadyDot.style.display = "none";
    timelineEmpty.style.display = "flex";
    timelineContent.style.display = "none";
    timelineContent.innerHTML = "";
    updateTopbar();
    switchTab("log");
    renderLiveVideoPanel(); // 방송이 막 시작됐으니 영상도 이제 재생 시도할 수 있다.
  }
});

window.api.onReportReady((evt) => {
  const s = getOrCreateState(evt.channelId);
  const payload = evt.payload;
  s.reportPayload = payload;
  s.endedAt = payload.report.session.endedAt || Date.now();
  const elapsedText = formatElapsed(s.endedAt - (s.startedAt || s.endedAt));
  // 백엔드(ChannelWatcher)는 리포트를 만든 뒤에도 폴링을 스스로 멈추지 않고 계속 다음 방송을
  // 기다리도록 설계돼 있다 (즐겨찾기 토글을 다시 켤 필요 없이 다음 방송도 자동으로 잡히게
  // 하기 위함). 그래서 여기서 phase를 "done"으로 고정하지 않고 다시 "라이브 대기 중"과 같은
  // monitoring 상태로 되돌린다 — 다만 이 report-ready 직전에 사용자가 토글/종료 버튼으로
  // 진짜 감시 중단을 요청했다면(s.stopRequested) watcher는 실제로 멈췄으므로 monitoring으로
  // 되돌리면 안 되고 idle로 완전히 꺼진 상태를 반영해야 한다 (종료 버튼이 계속 켜져
  // 보이던 버그의 원인).
  if (s.stopRequested) {
    s.phase = "idle";
    s.startedAt = null;
    s.stopRequested = false;
  } else {
    s.phase = "monitoring";
    s.startedAt = null;
  }
  renderSidebar();
  if (selectedChannelId === evt.channelId) {
    stripElapsed.textContent = elapsedText;
    renderReportView();
    switchTab("report");
    updateTopbar();
    if (timelineView.style.display !== "none") refreshTimeline();
    renderLiveVideoPanel(); // 방송이 끝났으니(s.startedAt=null) 영상은 정리되고 대기 문구가 뜬다.
  }
});

// VOD 분석 작업 이벤트. type별로 하는 일이 다르다:
//  - "log": 그 작업의 동작 로그 한 줄 (라이브의 onLog와 동일하게 처리)
//  - "progress": 채팅 수집 진행률 (사이드바 진행 바 + 상단 스트립의 수집 메시지 수 갱신)
//  - "job-update": 상태 전이(fetching/done/error). done이면 get-vod-job으로 전체 결과(리포트/
//    타임라인/편집점 경로)를 마저 받아와서 report-ready와 동일한 화면 갱신을 해준다.
window.api.onVodEvent((evt) => {
  const { jobId, type, data } = evt;
  const s = getOrCreateVodState(jobId, jobId);

  if (type === "log") {
    logToChannel(s, data);
    return;
  }

  if (type === "progress") {
    if (data.phase === "chat") s.msgCount = data.fetchedCount;
    if (selectedChannelId === jobId) stripMsgCount.textContent = s.msgCount.toLocaleString();
    const idx = vodJobsList.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) vodJobsList[idx] = { ...vodJobsList[idx], progress: data };
    renderVodJobList();
    return;
  }

  if (type === "job-update") {
    s.channelName = data.videoTitle || jobId;
    const idx = vodJobsList.findIndex((j) => j.jobId === jobId);
    const prev = idx !== -1 ? vodJobsList[idx] : null;
    if (idx === -1) vodJobsList.unshift(data);
    else vodJobsList[idx] = data;

    if (data.status === "fetching") {
      s.phase = "fetching";
    } else if (data.status === "error") {
      s.phase = "error";
      logToChannel(s, { time: nowTime(), tag: "ERROR", text: `VOD 분석 실패: ${data.error}` });
    } else if (data.status === "done") {
      s.phase = "done";
      // 기본 분석이 막 끝난 시점(justFinishedBase)에만 반응한다 - 같은 done 상태로 오는 중복
      // job-update 이벤트마다 매번 리포트를 다시 받아오거나 탭을 강제 전환하면 안 되기 때문.
      const justFinishedBase = !prev || prev.status !== "done";
      if (justFinishedBase) {
        window.api.getVodJob(jobId).then((full) => {
          // 그 사이 목록에서 삭제됐을 수 있으니(사용자가 완료 직전에 지운 경우), 여전히 같은
          // state 객체가 등록돼 있을 때만 반영한다.
          if (!full || !full.result || channelsState.get(jobId) !== s) return;
          s.reportPayload = full.result; // {report, markdown, editPointsPath, ...} - renderReport()가 그대로 재사용
          s.startedAt = full.result.session.startedAt;
          s.endedAt = full.result.session.endedAt || Date.now();
          s.msgCount = full.result.report.totalMessages;
          renderVodJobList();
          // 채팅 수집이 방금 끝났으니(기본 분석이 done이 됐으니) 재생 동기화 채팅 캐시를 이제
          // 시도할 수 있다. 패널을 "fetching" 상태일 때 이미 열어봤다면 loadVodChatSyncMessages()가
          // 그때는 조용히 아무것도 안 했을 텐데, 여기서 다시 불러서 채워준다.
          loadVodChatSyncMessages(s);
          if (selectedChannelId === jobId) {
            renderReportView();
            switchTab("report");
            updateTopbar();
            if (timelineView.style.display !== "none") refreshTimeline();
          }
        });
      }
    }

    // "정밀분석"(화면 분석)이 막 끝난 시점에도 done 때와 똑같이 리포트/타임라인을 새로
    // 받아온다 — runVisionOnly()가 끝나면 리포트/타임라인이 화면 분석 결과로 덮어써지기
    // 때문에, 보고 있던 화면을 최신 결과로 갱신해야 한다.
    const justFinishedVision = data.visionStatus === "done" && (!prev || prev.visionStatus !== "done");
    if (justFinishedVision) {
      window.api.getVodJob(jobId).then((full) => {
        if (!full || !full.result || channelsState.get(jobId) !== s) return;
        s.reportPayload = full.result;
        loadVodChatSyncMessages(s);
        if (selectedChannelId === jobId) {
          renderReportView();
          updateTopbar();
          if (timelineView.style.display !== "none") refreshTimeline();
        }
      });
    }

    renderVodJobList();
    if (selectedChannelId === jobId) updateTopbar();
  }
});

// 1초마다: 선택된 채널의 경과 시간 표시 + 감시 중인 채널이 있으면 사이드바 상태 텍스트 갱신.
setInterval(() => {
  const s = currentState();
  if (s && s.phase === "monitoring" && s.startedAt) {
    stripElapsed.textContent = formatElapsed(Date.now() - s.startedAt);
  }
  if ([...channelsState.values()].some((st) => st.phase === "monitoring")) {
    renderSidebar();
  }
}, 1000);

// 실제로 방송 중(startedAt 있음)이고 타임라인 탭을 보고 있으면 5초마다 최신 데이터로 갱신.
// (다음 방송을 기다리기만 하는 상태에선 어차피 데이터가 안 바뀌므로 불필요한 조회를 건너뛴다.)
setInterval(() => {
  const s = currentState();
  if (s && s.phase === "monitoring" && s.startedAt && timelineView.style.display !== "none") refreshTimeline();
}, 5000);

// AI 화면 분석 상태/비용 배지(상단 스트립). 선택된 채널/VOD 작업 기준으로 조회하며, 감시 중엔
// 호출 횟수가 계속 늘어날 수 있고 VOD는 "정밀분석" 진행 중에 늘어날 수 있어서 주기적으로 다시
// 물어본다. API 키가 없거나 ffmpeg이 없으면 서버가 enabled:false를 내려준다.
async function updateVisionBadge() {
  if (!selectedChannelId) {
    visionBadgeText.textContent = "AI 분석: -";
    visionBadge.classList.remove("on");
    visionBadge.classList.add("off");
    return;
  }
  const id = selectedChannelId;
  try {
    const stats = await window.api.getVisionStats(id);
    if (selectedChannelId !== id) return; // 응답 오는 사이 다른 채널로 옮겼으면 무시
    if (!stats || !stats.enabled) {
      visionBadgeText.textContent = `AI 분석: 꺼짐${stats && stats.reason ? ` (${stats.reason})` : ""}`;
      visionBadge.classList.remove("on");
      visionBadge.classList.add("off");
    } else {
      visionBadgeText.textContent = `영상 분석: 켜짐 · ${stats.callCount.toLocaleString()}회 · 약 $${stats.estimatedCostUsd.toFixed(4)}`;
      visionBadge.classList.remove("off");
      visionBadge.classList.add("on");
    }
  } catch {
    // 조용히 무시 (다음 폴링에서 재시도)
  }
}
setInterval(updateVisionBadge, 5000);

// ---- 초기 로드 ----

async function init() {
  updateMainVisibility();
  updateTopbar();
  switchTabButtonsOnly("log");
  try {
    favorites = await window.api.getFavorites();
  } catch {
    favorites = [];
  }
  favorites.forEach((fav) => getOrCreateState(fav.channelId, fav.channelName));

  try {
    vodJobsList = await window.api.getVodJobs();
  } catch {
    vodJobsList = [];
  }
  vodJobsList.forEach((job) => {
    const s = getOrCreateVodState(job.jobId, job.videoTitle || job.jobId);
    if (job.status === "fetching") s.phase = "fetching";
    else if (job.status === "error") s.phase = "error";
    else if (job.status === "done") {
      s.phase = "done";
      window.api.getVodJob(job.jobId).then((full) => {
        if (!full || !full.result) return;
        s.reportPayload = full.result;
        s.startedAt = full.result.session.startedAt;
        s.endedAt = full.result.session.endedAt || Date.now();
        s.msgCount = full.result.report.totalMessages;
        loadVodChatSyncMessages(s); // 앱 재시작 후 이미 완료된 작업이면 미리 캐시를 준비해둔다.
        if (selectedChannelId === job.jobId) {
          renderReportView();
          updateTopbar();
        }
      });
    }
  });

  renderSidebarAll();
}

init();
