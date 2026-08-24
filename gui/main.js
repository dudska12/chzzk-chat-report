// Electron 메인 프로세스.
// 핵심 로직(ChannelWatcher)은 ../dist/collector.js 를 그대로 가져다 쓴다.
// 즉, GUI는 껍데기일 뿐이고 실제 채팅 수집/분석/리포트 로직은 CLI와 100% 공유한다.
// 먼저 프로젝트 루트에서 `npm run build`로 dist를 만들어둬야 한다.
//
// 여러 채널을 동시에 감시할 수 있다(즐겨찾기 기능). ChannelWatcher는 원래부터 인스턴스마다
// 독립적으로 동작하게 설계돼 있어서(내부 상태를 전역으로 공유하지 않음) 여러 개를 동시에
// 띄우는 데 core 쪽 변경은 필요 없었고, 이 파일이 channelId별로 인스턴스를 관리하는
// 레지스트리 역할만 새로 맡는다.
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, session } = require("electron");
const { ChzzkClient } = require("chzzk");
const path = require("path");
const fs = require("fs");

// 설치판(installer로 깐 뒤)에서는 이 파일도, dist/*.js도 전부 읽기 전용 app.asar 아카이브
// 안에 들어간다. config.ts/store.ts가 예전처럼 "컴파일된 위치 기준으로 한 칸 위(프로젝트
// 루트)"에 config.json/data/를 쓰려고 하면, 그 경로가 resources/app.asar/config.json 같은
// 곳이 돼서 ENOENT로 조용히 실패한다(asar는 쓰기가 아예 안 됨) — 로그인 유지, 즐겨찾기,
// 수집된 채팅 데이터, 리포트가 전부 재시작하면 날아가는 문제로 이어진다.
// 그래서 패키징된 상태(app.isPackaged)일 땐 Electron이 OS별로 제공하는 실제 쓰기 가능한
// 사용자 데이터 폴더(Windows 기준 %APPDATA%\chzzk-chat-report)를 쓰고, 개발 중(`npm start`)
// 에는 지금까지처럼 프로젝트 루트를 그대로 써서 reports/ 등을 프로젝트 폴더에서 바로 볼 수
// 있게 한다. 이 값은 dist/config.js·dist/store.js를 require하기 "전에" 환경변수로 심어둬야
// 그 모듈들의 최상단 상수(CONFIG_PATH/DATA_DIR)가 계산될 때 반영된다.
const dataRoot = app.isPackaged ? app.getPath("userData") : path.join(__dirname, "..");
process.env.CHZZK_DATA_ROOT = dataRoot;

let ChannelWatcher;
let getConfig;
let saveConfig;
let getFavorites;
let saveFavorites;
let getAnalysisSettings;
let saveAnalysisSettings;
let resetAnalysisSettings;
let DEFAULT_ANALYSIS_SETTINGS;
let buildEditPointsCsv;
let VodAnalyzer;
let extractVideoNo;
let resolveVodPlayback;
let resolveLivePlayback;
try {
  ({ ChannelWatcher } = require(path.join(__dirname, "..", "dist", "collector.js")));
  ({
    getConfig,
    saveConfig,
    getFavorites,
    saveFavorites,
    getAnalysisSettings,
    saveAnalysisSettings,
    resetAnalysisSettings,
    DEFAULT_ANALYSIS_SETTINGS,
  } = require(path.join(__dirname, "..", "dist", "config.js")));
  ({ buildEditPointsCsv } = require(path.join(__dirname, "..", "dist", "edit-points.js")));
  ({ VodAnalyzer, extractVideoNo } = require(path.join(__dirname, "..", "dist", "vod-analyzer.js")));
  ({ resolveVodPlayback } = require(path.join(__dirname, "..", "dist", "vod-playback.js")));
  ({ resolveLivePlayback } = require(path.join(__dirname, "..", "dist", "live-playback.js")));
} catch (err) {
  console.error(
    "dist/collector.js 를 찾을 수 없습니다. 프로젝트 루트에서 `npm run build`를 먼저 실행하세요."
  );
  throw err;
}

let win = null;
let tray = null;
// 트레이 메뉴의 "종료"를 눌렀을 때만 true로 바뀐다. 커스텀 타이틀바의 닫기(X) 버튼은 이 값이
// false인 상태로 win.close()를 부르므로, 아래 win.on("close") 핸들러가 가로채서 완전히 끄는
// 대신 트레이로 숨긴다 (백그라운드에서 감시를 계속하기 위해).
let isQuitting = false;

// channelId -> { watcher: ChannelWatcher|null, lastWatcher: ChannelWatcher|null }
// watcher는 "지금 감시 중"일 때만 값이 있고, reportReady가 오면(=세션 종료) null로 정리해서
// 그 채널을 다시 감시 시작할 수 있게 한다. lastWatcher는 리포트가 나온 뒤에도 타임라인 탭에서
// 계속 조회할 수 있도록 별도로 붙잡아둔다.
const channels = new Map();

function getEntry(channelId) {
  let entry = channels.get(channelId);
  if (!entry) {
    entry = { watcher: null, lastWatcher: null };
    channels.set(channelId, entry);
  }
  return entry;
}

/** 이벤트를 어느 채널 것인지 함께 실어서 렌더러로 보낸다 (여러 채널을 동시에 감시하니 필수). */
function send(channel, channelId, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, { channelId, payload });
}

// videoNo -> { videoNo, videoTitle, channelName, status, error, progress, logs, result }
// 즐겨찾기(채널)와 달리 VOD 분석은 "한 번 실행하면 끝나는 작업"이라 watcher처럼 계속 떠 있지
// 않는다. 앱을 껐다 켜면 이 목록 자체는 사라지지만(= 재실행해도 히스토리 카드가 다시 안 뜸),
// 그동안 만들어진 리포트/편집점 CSV 파일은 reports/ 폴더에 이미 저장돼 있으니 데이터 자체가
// 사라지는 건 아니다.
const vodJobs = new Map();

/** job 객체를 IPC로 보낼 수 있는 형태로 정리한다. analyzer는 EventEmitter 인스턴스라 IPC의
 * 구조화 복제(structured clone)를 못 통과하므로(메서드가 있는 클래스 인스턴스 전송 불가)
 * 렌더러로 보내는 모든 job 스냅샷에서 빼야 한다. */
function serializeVodJob(job) {
  const { analyzer, ...rest } = job;
  return rest;
}

/** "job-update" 이벤트로 매번 브로드캐스트하기엔 result(리포트/타임라인 전체)가 클 수 있어서,
 * 사이드바 목록 갱신에 필요한 가벼운 필드만 추린다. 완료 시점에 렌더러가 필요한 전체 데이터는
 * get-vod-job로 별도 조회한다 (즐겨찾기의 report-ready 이벤트와 달리, 완료 이벤트 자체엔
 * result를 안 실어보내는 점이 다르다 — 무거운 데이터를 매 업데이트마다 복제하지 않기 위함). */
function serializeVodJobSummary(job) {
  const { analyzer, logs, result, ...rest } = job;
  return rest;
}

function sendVodEvent(jobId, type, data) {
  if (win && !win.isDestroyed()) win.webContents.send("vod-event", { jobId, type, data });
}

/** VOD 분석 시작. 이미 같은 videoNo로 분석 중이면 새로 시작하지 않는다(완료/에러 상태면
 * 다시 실행 가능 — 같은 jobId 위에 덮어씀). */
async function startVodAnalysis(videoNoOrUrl) {
  const videoNo = extractVideoNo((videoNoOrUrl || "").trim());
  if (!videoNo) return { ok: false, error: "다시보기 URL 또는 영상 번호를 입력해주세요." };

  const existing = vodJobs.get(videoNo);
  if (existing && existing.status === "fetching") {
    return { ok: false, error: "이미 분석 중인 영상입니다." };
  }

  const job = {
    jobId: videoNo,
    videoNo,
    videoTitle: existing?.videoTitle || videoNo,
    channelName: existing?.channelName || "",
    status: "fetching",
    error: null,
    progress: { phase: "video", fetchedCount: 0, percent: 0 },
    logs: [],
    result: null,
    // "정밀분석"(화면 분석, 선택 기능) 상태. 기본 분석(status)과 별개로 관리된다 — 정밀분석은
    // 기본 분석이 끝난 뒤에만 시작할 수 있고, 여러 번 다시 실행할 수도 있다.
    visionStatus: "idle", // "idle" | "running" | "done" | "error"
    visionError: null,
    // 타임라인 탭 조회(get-timeline/get-user-timeline/get-messages-in-range)를 즐겨찾기(라이브)와
    // 동일한 코드 경로로 처리하기 위해 analyzer 인스턴스를 계속 붙잡아둔다 — ChannelWatcher의
    // lastWatcher와 같은 역할. run()이 끝난 뒤에도 조회 메서드는 계속 응답 가능.
    analyzer: null,
  };
  vodJobs.set(videoNo, job);
  sendVodEvent(videoNo, "job-update", serializeVodJobSummary(job));

  // VOD 메타데이터 조회(/service/v1/videos/{videoNo})는 로그인 없이는 공개(exposure:true)
  // 영상도 content가 빈 값으로 오는 경우가 실제로 확인돼서, 설정 화면에 저장해둔 로그인
  // 쿠키(NID_AUT/NID_SES)가 있으면 같이 넘긴다 (없어도 시도는 하되, 그 경우 "영상 정보를
  // 찾을 수 없습니다" 에러가 날 수 있음 — 이 경우 설정에서 로그인 쿠키를 넣어달라고 안내).
  const cfg = getConfig();
  const analysis = getAnalysisSettings();
  const analyzer = new VodAnalyzer({
    videoNo,
    reportDir: path.join(dataRoot, "reports"),
    nidAuth: cfg.nidAuth,
    nidSession: cfg.nidSession,
    timelineBucketMs: analysis.timelineBucketMs,
    timelineMinSegmentMs: analysis.timelineMinSegmentMs,
    timelineQuietMinBuckets: analysis.timelineQuietMinBuckets,
    frameIntervalMs: analysis.frameIntervalMs,
    visionConfidenceThreshold: analysis.visionConfidenceThreshold,
    visionConfirmCount: analysis.visionConfirmCount,
  });
  job.analyzer = analyzer;

  // 이 job이 아직 "살아있는" 작업인지 - 사용자가 카드를 지웠거나(vodJobs.delete) 같은 videoNo로
  // 새 분석을 시작해 다른 job 객체로 교체됐으면 false. 죽은 job의 analyzer가 남긴 이벤트를
  // 그대로 렌더러에 보내면, 지운 카드가 사이드바에 다시 살아나거나(렌더러의 job-update 핸들러가
  // 목록에 없는 jobId를 새로 추가함) 새 작업의 상태를 옛 작업 이벤트가 덮어쓰는 문제가 있었다.
  const isCurrentJob = () => vodJobs.get(videoNo) === job;

  analyzer.on("log", (entry) => {
    if (!isCurrentJob()) return;
    job.logs.push(entry);
    sendVodEvent(videoNo, "log", entry);
  });
  analyzer.on("progress", (progress) => {
    if (!isCurrentJob()) return;
    job.progress = progress;
    sendVodEvent(videoNo, "progress", progress);
  });

  // run()은 시간이 걸릴 수 있어서(채팅이 많은 긴 영상일수록 REST 요청도 많이 나감) IPC 핸들러
  // 자체는 "시작했다"는 응답만 즉시 돌려주고, 결과는 vod-event로 비동기 전달한다.
  analyzer
    .run()
    .then((result) => {
      job.videoTitle = result.videoTitle;
      job.channelName = result.session.channelName;
      job.status = "done";
      job.result = result;
      if (isCurrentJob()) sendVodEvent(videoNo, "job-update", serializeVodJobSummary(job));
    })
    .catch((err) => {
      job.status = "error";
      job.error = String(err && err.message ? err.message : err);
      if (isCurrentJob()) sendVodEvent(videoNo, "job-update", serializeVodJobSummary(job));
    });

  return { ok: true, jobId: videoNo };
}

/** VOD 카드의 "정밀분석"(화면 분석) 버튼용. 기본 분석(run())이 이미 끝난 job 위에서만 실행할
 * 수 있다 — VodAnalyzer.runVisionOnly()가 세션/채팅 정보가 있어야 동작하기 때문. 완료되면
 * 같은 리포트/타임라인/편집점 CSV가 화면 분석 결과로 덮어써진다. */
async function startVodVisionAnalysis(jobId) {
  const job = vodJobs.get(jobId);
  if (!job || !job.analyzer) return { ok: false, error: "작업을 찾을 수 없습니다." };
  if (job.status !== "done") return { ok: false, error: "먼저 기본 분석이 끝나야 정밀분석을 실행할 수 있습니다." };
  if (job.visionStatus === "running") return { ok: false, error: "이미 정밀분석이 진행 중입니다." };

  job.visionStatus = "running";
  job.visionError = null;
  sendVodEvent(jobId, "job-update", serializeVodJobSummary(job));

  const isCurrentJob = () => vodJobs.get(jobId) === job;

  job.analyzer
    .runVisionOnly()
    .then((result) => {
      job.result = result;
      job.visionStatus = "done";
      if (isCurrentJob()) sendVodEvent(jobId, "job-update", serializeVodJobSummary(job));
    })
    .catch((err) => {
      job.visionStatus = "error";
      job.visionError = String(err && err.message ? err.message : err);
      if (isCurrentJob()) sendVodEvent(jobId, "job-update", serializeVodJobSummary(job));
    });

  return { ok: true };
}

/** 감시 시작 로직 본체. IPC 핸들러와 "즐겨찾기 자동 시작" 둘 다 이걸 공유해서 쓴다. */
async function startWatcherFor(channelId) {
  const entry = getEntry(channelId);
  if (entry.watcher) {
    return { ok: false, error: "이미 감시 중입니다." };
  }

  const watcherCfg = getConfig();
  const analysis = getAnalysisSettings();
  const watcher = new ChannelWatcher({
    channelId,
    reportDir: path.join(dataRoot, "reports"),
    nidAuth: watcherCfg.nidAuth,
    nidSession: watcherCfg.nidSession,
    statusPollMs: analysis.statusPollMs,
    restCheckIntervalMs: analysis.restCheckIntervalMs,
    restSuspectTicks: analysis.restSuspectTicks,
    restBurstSamples: analysis.restBurstSamples,
    restBurstGapMs: analysis.restBurstGapMs,
    restBurstMinStatic: analysis.restBurstMinStatic,
    motionAbsFloor: analysis.motionAbsFloor,
    motionRelativeFactor: analysis.motionRelativeFactor,
    motionRollingWindow: analysis.motionRollingWindow,
    timelineBucketMs: analysis.timelineBucketMs,
    timelineMinSegmentMs: analysis.timelineMinSegmentMs,
    timelineQuietMinBuckets: analysis.timelineQuietMinBuckets,
    frameIntervalMs: analysis.frameIntervalMs,
    visionConfidenceThreshold: analysis.visionConfidenceThreshold,
    visionConfirmCount: analysis.visionConfirmCount,
    moodMaxSampleMessages: analysis.moodMaxSampleMessages,
  });
  entry.watcher = watcher;
  entry.lastWatcher = watcher;

  watcher.on("log", (entry_) => send("log", channelId, entry_));
  watcher.on("chat", (preview) => send("chat", channelId, preview));
  watcher.on("sessionStart", (session) => send("session-start", channelId, session));
  watcher.on("reportReady", (payload) => {
    send("report-ready", channelId, payload);
    // 주의: 여기서 entry.watcher를 null로 지우면 안 된다. ChannelWatcher는 방송 종료를
    // 감지해서 리포트를 만든 뒤에도 내부 폴링(statusTimer)을 스스로 멈추지 않고 계속 돌면서
    // "다음 방송 시작"을 자동으로 기다리도록 설계돼 있다(CLI에서 `watch` 한 번 실행해두면
    // 방송을 몇 번 하든 계속 리포트가 나오는 것과 같은 원리). 예전엔 여기서 null 처리를 해서
    // 레지스트리가 "이 채널은 더 이상 감시 안 함"이라고 착각했는데, 실제 watcher는 안 죽고
    // 백그라운드에서 계속 돌고 있어서 (1) 즐겨찾기 토글을 꺼도 실제로 안 꺼지고, (2) 그 상태로
    // 다시 켜면 죽지 않은 예전 watcher 위에 새 watcher를 하나 더 만들어 채널 하나를 이중으로
    // 감시하는 버그가 있었다. entry.watcher를 그대로 살려둬야 stopWatcherFor()가 실제로 이
    // watcher를 찾아서 멈출 수 있다.
    updateTrayMenu();
  });

  try {
    await watcher.start();
    updateTrayMenu();
    return { ok: true };
  } catch (err) {
    entry.watcher = null;
    updateTrayMenu();
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** 감시 종료 로직 본체. 진행 중이던 세션이 있으면 watcher.stop() 내부에서 리포트까지 만든다. */
async function stopWatcherFor(channelId) {
  const entry = channels.get(channelId);
  if (!entry || !entry.watcher) {
    return { ok: false, error: "현재 감시 중이 아닙니다." };
  }
  const hadSession = entry.watcher.isSessionActive;
  await entry.watcher.stop();
  entry.watcher = null;
  updateTrayMenu();
  return { ok: true, hadSession };
}

/** 앱 시작 시 자동시작 켜진 즐겨찾기들을 전부 감시 시작한다. 하나 실패해도 나머지는 계속 진행. */
async function autoStartFavorites() {
  const favorites = getFavorites();
  for (const fav of favorites) {
    if (!fav.autoStart) continue;
    try {
      const result = await startWatcherFor(fav.channelId);
      if (!result.ok) {
        console.error(`즐겨찾기 자동 시작 실패 (${fav.channelName}/${fav.channelId}):`, result.error);
      }
    } catch (err) {
      console.error(`즐겨찾기 자동 시작 중 오류 (${fav.channelName}/${fav.channelId}):`, err);
    }
  }
  updateTrayMenu();
}

/** 즐겨찾기의 자동시작 토글 본체. GUI 사이드바 토글(IPC)과 트레이 메뉴 클릭 둘 다 이걸 공유해서
 * 쓴다 — 어느 쪽에서 켜고 끄든 "지금 감시 시작/종료" + "다음 실행 시 자동시작 여부 저장"이
 * 동일하게 동작해야 하기 때문. */
async function setFavoriteAutoStartFor(channelId, autoStart) {
  const favorites = getFavorites();
  const idx = favorites.findIndex((f) => f.channelId === channelId);
  if (idx === -1) return { ok: false, error: "즐겨찾기에 없는 채널입니다." };

  const next = favorites.slice();
  next[idx] = { ...next[idx], autoStart: !!autoStart };
  saveFavorites(next);

  // hadSession: 껐을 때(autoStart=false) 마침 진행 중이던 방송 세션이 있었는지. 렌더러가 이 값을
  // 몰라서 무조건 phase를 "idle"로 낙관 반영해버리면, 곧 이어질 reportReady로 phase가
  // "monitoring"(다음 방송 대기)으로 되돌아오기 전까지 잠깐이라도 타임라인 탭이 "데이터
  // 없음"으로 잘못 표시되는 버그가 있었다 — 사이드바 토글로 껐을 때만 재현되고, "종료" 버튼은
  // stopWatch/stop-watch IPC가 이미 hadSession을 돌려주고 있어서 문제 없었다.
  let hadSession = false;
  if (autoStart) {
    await startWatcherFor(channelId); // 이미 감시 중이면 내부에서 조용히 실패 처리됨(무시해도 무방)
  } else {
    const stopRes = await stopWatcherFor(channelId).catch(() => null);
    hadSession = !!(stopRes && stopRes.hadSession);
  }
  updateTrayMenu();
  return { ok: true, favorites: next, hadSession };
}

/** 창을 트레이에서 다시 꺼내 보여준다 (트레이 아이콘 클릭 / "창 열기" 메뉴 공용). */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 즐겨찾기별 감시 상태를 반영해서 트레이 컨텍스트 메뉴를 새로 만든다. 즐겨찾기가 바뀌거나
 * (추가/삭제/토글) 감시 상태가 바뀔 때(방송 시작/리포트 완료)마다 updateTrayMenu()로 다시 그린다. */
function buildTrayMenu() {
  const favorites = getFavorites();
  const items = [
    { label: "창 열기", click: showWindow },
    { type: "separator" },
  ];

  if (favorites.length === 0) {
    items.push({ label: "즐겨찾기한 채널이 없습니다", enabled: false });
  } else {
    favorites.forEach((fav) => {
      const entry = channels.get(fav.channelId);
      // running: watcher가 떠 있는지(폴링 중 포함) / live: 그중에서도 지금 실제로 방송 중인지.
      // running만 켜져 있고 live는 아닐 수 있다(방송 시작을 기다리는 중, 또는 이전 방송 리포트를
      // 만들고 나서 다음 방송을 기다리는 중 — 둘 다 watcher는 계속 살아서 폴링하고 있다).
      const running = !!(entry && entry.watcher);
      const live = running && entry.watcher.isSessionActive;
      const label = live ? "감시 중" : running ? "대기 중" : "꺼짐";
      items.push({
        label: `${live ? "● " : running ? "◐ " : "○ "}${fav.channelName} — ${label}`,
        click: async () => {
          await setFavoriteAutoStartFor(fav.channelId, !running);
        },
      });
    });
  }

  items.push({ type: "separator" });
  items.push({
    label: "종료",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

function updateTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("치지직 채팅 감시 & 리포트");
  tray.on("click", showWindow);
  updateTrayMenu();
}

// 로그인 창 전용 세션. 별도 partition을 써서 메인 창(설정 없는 익명 요청)과 완전히 분리해두고,
// "persist:"를 붙여 디스크에 남겨서 다음에 로그인 창을 열었을 때 네이버가 기기를 기억해
// 비밀번호 재입력 없이 바로 로그인되는 경우가 많게 한다. 실제로 감시/분석에 쓰는 쿠키는 여기서
// 값만 뽑아 config.json에 저장해두고 쓰므로, 이 세션 자체가 매 요청마다 쓰이는 건 아니다.
const LOGIN_PARTITION = "persist:chzzk-login";
let loginWin = null;

/**
 * 실제 네이버/치지직 로그인 페이지를 그대로 띄운다. 비밀번호를 이 프로그램이 다루거나 저장하는
 * 게 아니라, 사용자가 그 페이지에 직접 입력하는 방식이라 안전하다 — 로그인이 끝났는지는 화면을
 * 스크래핑하는 대신, 로그인 성공 시 네이버가 심어주는 NID_AUT/NID_SES 쿠키가 생겼는지로
 * 판단한다(이 쿠키 두 개가 곧 chzzk API 인증에 필요한 값 전부다).
 */
async function openChzzkLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return { ok: false, error: "이미 로그인 창이 열려 있습니다." };
  }

  const loginSession = session.fromPartition(LOGIN_PARTITION);

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWin && !loginWin.isDestroyed()) loginWin.destroy();
      loginWin = null;
      resolve(result);
    };

    loginWin = new BrowserWindow({
      width: 480,
      height: 700,
      parent: win || undefined,
      autoHideMenuBar: true,
      title: "치지직(네이버) 로그인",
      webPreferences: { session: loginSession },
    });
    loginWin.setMenuBarVisibility(false);
    loginWin.loadURL("https://chzzk.naver.com/");

    // 2초마다 로그인 쿠키가 생겼는지 확인한다. DOM을 읽거나 특정 화면 전환을 기다리는 것보다
    // 훨씬 안정적이다 — chzzk/네이버가 로그인 UI를 바꿔도 이 로직은 안 깨진다.
    pollTimer = setInterval(async () => {
      try {
        const [authCookie] = await loginSession.cookies.get({ url: "https://chzzk.naver.com", name: "NID_AUT" });
        const [sesCookie] = await loginSession.cookies.get({ url: "https://chzzk.naver.com", name: "NID_SES" });
        if (authCookie && sesCookie) {
          saveConfig({ nidAuth: authCookie.value, nidSession: sesCookie.value });
          finish({ ok: true });
        }
      } catch (err) {
        // 창이 막 닫히는 중 등 일시적 오류는 무시하고 다음 틱에 다시 시도.
      }
    }, 2000);

    loginWin.on("closed", () => {
      finish({ ok: false, error: "로그인 창이 닫혔습니다." });
    });
  });
}

/** 저장된 로그인 쿠키를 지운다. 로그인 창 세션 자체(네이버가 기기를 기억하는 상태)는 남겨둬서,
 * 다시 로그인할 때 비밀번호를 또 칠 필요가 없게 한다 — 여기선 이 프로그램이 들고 있는
 * 값(config.json의 nidAuth/nidSession)만 지운다. */
function chzzkLogout() {
  saveConfig({ nidAuth: "", nidSession: "" });
  return { ok: true };
}

/** 저장된 chzzk 로그인 쿠키가 "저장돼 있다"는 것과 "아직 유효하다"는 건 다른 얘기다 — 네이버
 * 세션은 시간이 지나면 만료되는데, config.json엔 그 값이 여전히 문자열로 남아있어서 설정
 * 화면은 계속 "로그인됨"이라고 보여주고, 정작 VOD 분석 같은 로그인 필요한 기능만 "영상 정보를
 * 찾을 수 없습니다" 같은 알쏭달쏭한 에러로 실패하는 문제가 있었다. 그래서 실제로 로그인 전용
 * 엔드포인트(/v1/user/getUserStatus, 비로그인이면 content가 null로 옴)를 한 번 찔러봐서
 * 진짜 유효한지 확인한다.
 * 반환값: "none"(쿠키 자체가 없음) | "valid"(쿠키 있고 유효) | "expired"(쿠키는 있는데 무효). */
async function checkChzzkLoginValidity() {
  const cfg = getConfig();
  if (!cfg.nidAuth || !cfg.nidSession) return { state: "none" };
  try {
    const client = new ChzzkClient({ nidAuth: cfg.nidAuth, nidSession: cfg.nidSession });
    const user = await client.user();
    return { state: user ? "valid" : "expired" };
  } catch (err) {
    // 네트워크 오류 등 판단 자체를 못한 경우엔 "만료됐다"고 성급하게 단정하지 않는다 —
    // 설정에 저장된 값은 그대로 두고 확인만 실패했다고 알린다.
    return { state: "unknown", error: String(err && err.message ? err.message : err) };
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0c0f",
    icon: path.join(__dirname, "assets", "app-icon.png"),
    // 목업 디자인이 커스텀 타이틀바(진한 배경 + 장식용 점 3개)를 쓰는 프레임리스 창이라
    // OS 기본 타이틀바를 끄고 렌더러에서 직접 그린다. 대신 창 컨트롤(닫기/최소화/최대화)은
    // 아래 IPC로 렌더러의 점 3개 버튼과 연결해둔다.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 여러 채널을 동시에 감시하다가 창을 실수로(또는 그냥 잠깐) 닫아도 감시가 끊기지 않도록,
  // 닫기(X)는 완전 종료가 아니라 트레이로 숨기는 것으로 바꾼다. 실제 종료는 트레이 메뉴의
  // "종료"로만 한다 (isQuitting이 그때만 true로 바뀜).
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  // 렌더러가 로그/채팅 리스너를 등록하기 전에 이벤트가 먼저 발생하면 그대로 유실되니
  // (session/store 데이터 자체는 파일로 남아서 나중에 조회 가능하지만, 실시간 로그 몇 줄은
  // 놓칠 수 있음), 페이지 로드가 끝난 뒤에 자동 시작을 건다.
  win.webContents.once("did-finish-load", () => {
    autoStartFavorites();
  });
});

app.on("window-all-closed", () => {
  // 창을 닫아도(트레이로 숨기는 것과 별개로, 혹시 다른 경로로 완전히 닫히는 경우) 트레이가
  //떠 있는 한 앱 자체는 계속 백그라운드에서 감시를 이어간다. macOS뿐 아니라 모든 플랫폼에서
  // 트레이 상주가 이 기능의 핵심이라 quitOnWindowAllClosed 관례를 따르지 않는다.
  // 실제 종료는 트레이 메뉴 "종료"(isQuitting = true 경로)로만 이뤄진다.
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  // 진행 중인 "정밀분석"(VOD 화면 분석)이 있으면 창을 닫아도 ffmpeg/Claude 호출이 백그라운드에서
  // 계속 돌지 않도록 먼저 취소 신호를 보낸다. cancelVision()은 자식 ffmpeg 프로세스를 동기적으로
  // SIGKILL만 하고 끝나므로(Windows는 부모가 죽어도 자식이 안 죽어서 직접 죽여야 함) 따로
  // 기다릴 필요는 없다.
  for (const job of vodJobs.values()) {
    if (job.analyzer && job.analyzer.isVisionRunning) job.analyzer.cancelVision();
  }
  const activeEntries = [...channels.values()].filter((e) => e.watcher);
  if (activeEntries.length > 0) {
    event.preventDefault();
    await Promise.all(activeEntries.map((e) => e.watcher.stop().catch(() => {})));
    channels.clear();
    app.quit();
  }
});

ipcMain.handle("start-watch", async (_event, channelId) => {
  if (!channelId || !channelId.trim()) {
    return { ok: false, error: "채널ID를 입력해주세요." };
  }
  return startWatcherFor(channelId.trim());
});

ipcMain.handle("stop-watch", async (_event, channelId) => {
  if (!channelId || !channelId.trim()) {
    return { ok: false, error: "채널ID가 없습니다." };
  }
  return stopWatcherFor(channelId.trim());
});

ipcMain.handle("export-report", async (_event, { markdown, suggestedName }) => {
  if (!win) return { ok: false, error: "창을 찾을 수 없습니다." };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "리포트 내보내기",
    defaultPath: suggestedName || "chzzk-report.md",
    filters: [
      { name: "마크다운", extensions: ["md"] },
      { name: "모든 파일", extensions: ["*"] },
    ],
  });
  if (canceled || !filePath) return { ok: false, error: "취소됨" };
  try {
    fs.writeFileSync(filePath, markdown, "utf-8");
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// 편집점(휴식/채팅 폭발/후원 몰림 시점) CSV 내보내기. 타임라인 탭이 이미 화면에 들고 있는
// timeline 데이터를 그대로 넘겨받아 CSV로 바꾸기만 하므로, watcher를 다시 조회할 필요가 없다.
ipcMain.handle("export-edit-points", async (_event, { timeline, suggestedName }) => {
  if (!win) return { ok: false, error: "창을 찾을 수 없습니다." };
  if (!timeline) return { ok: false, error: "타임라인 데이터가 없습니다." };

  let csv;
  try {
    csv = buildEditPointsCsv(timeline);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "편집점 목록 내보내기",
    defaultPath: suggestedName || "chzzk-editpoints.csv",
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "모든 파일", extensions: ["*"] },
    ],
  });
  if (canceled || !filePath) return { ok: false, error: "취소됨" };
  try {
    fs.writeFileSync(filePath, csv, "utf-8");
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("export-card", async (_event, { report, suggestedName }) => {
  if (!win) return { ok: false, error: "창을 찾을 수 없습니다." };

  // SNS 공유용 이미지 카드는 화면에 보이지 않는 별도 창에 card-template.html을 그린 다음
  // 그 창을 통째로 스크린샷(capturePage) 떠서 PNG로 저장하는 방식이다. Puppeteer 같은
  // 무거운 의존성 없이 Electron 자체 크로미움만으로 처리할 수 있어서 이렇게 했다.
  const cardWin = new BrowserWindow({
    width: 1080,
    height: 1350,
    show: false,
  });

  try {
    await cardWin.loadFile(path.join(__dirname, "renderer", "card-template.html"));
    await cardWin.webContents.executeJavaScript(
      `renderCard(${JSON.stringify(report)})`
    );
    // 폰트/레이아웃이 자리잡을 시간을 살짝 준다 (renderCard는 동기적으로 DOM만 채우므로
    // 브라우저의 다음 페인트 사이클까지 한 박자 기다려주는 정도면 충분함).
    await new Promise((resolve) => setTimeout(resolve, 150));

    const image = await cardWin.webContents.capturePage();
    const png = image.toPNG();

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "이미지 카드로 내보내기",
      defaultPath: suggestedName || "chzzk-report-card.png",
      filters: [{ name: "PNG 이미지", extensions: ["png"] }],
    });
    if (canceled || !filePath) return { ok: false, error: "취소됨" };

    fs.writeFileSync(filePath, png);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    cardWin.destroy();
  }
});

// 타임라인 탭용 조회 3종. entry.watcher가 없어도(리포트가 나와서 정리된 뒤에도) lastWatcher가
// 그 방송의 Store를 그대로 들고 있어서 계속 조회할 수 있다.
//
// VOD 분석 작업도 getTimeline/getUserTimeline/getMessagesInRange를 똑같은 시그니처로 구현해뒀기
// 때문에(vod-analyzer.ts), 여기서는 "이 id가 즐겨찾기(라이브) 채널인지 VOD 작업인지"만 구분해서
// 같은 메서드 이름을 호출해주면 된다 — 렌더러 쪽 타임라인 탭 코드는 라이브/VOD를 구분할 필요
// 없이 완전히 동일하게 재사용된다.
function resolveTimelineSource(id) {
  const entry = channels.get(id);
  if (entry && entry.lastWatcher) return entry.lastWatcher;
  const job = vodJobs.get(id);
  if (job && job.analyzer) return job.analyzer;
  return null;
}

ipcMain.handle("get-timeline", async (_event, id) => {
  const source = resolveTimelineSource(id);
  if (!source) return null;
  try {
    return source.getTimeline();
  } catch (err) {
    console.error("get-timeline 실패:", err);
    return null;
  }
});

ipcMain.handle("get-user-timeline", async (_event, { channelId, nickname }) => {
  const source = resolveTimelineSource(channelId);
  if (!source || !nickname) return null;
  try {
    return source.getUserTimeline(nickname);
  } catch (err) {
    console.error("get-user-timeline 실패:", err);
    return null;
  }
});

ipcMain.handle("get-messages-in-range", async (_event, { channelId, start, end }) => {
  const source = resolveTimelineSource(channelId);
  if (!source) return [];
  try {
    return source.getMessagesInRange(start, end);
  } catch (err) {
    console.error("get-messages-in-range 실패:", err);
    return [];
  }
});

// VOD 검색 패널용. 별도 검색 인덱스 없이 이미 메모리(또는 store)에 있는 전체 메시지를
// getMessagesInRange(0, Infinity)로 통째로 가져와 닉네임/본문 부분일치로 필터링한다 —
// VOD 채팅량이 아주 많은 방송(수만 개)도 있을 수 있어 결과는 최대 200개로 자르고,
// 너무 짧은 검색어(공백만 있거나 1글자 미만)는 결과가 너무 많아질 수 있어 그대로 빈 배열.
ipcMain.handle("search-messages", async (_event, { channelId, query }) => {
  const source = resolveTimelineSource(channelId);
  const q = (query || "").trim().toLowerCase();
  if (!source || !q) return [];
  try {
    const all = source.getMessagesInRange(0, Number.POSITIVE_INFINITY);
    const matches = all.filter(
      (m) => m.nickname?.toLowerCase().includes(q) || m.message?.toLowerCase().includes(q)
    );
    return matches.slice(0, 200);
  } catch (err) {
    console.error("search-messages 실패:", err);
    return [];
  }
});

// 즐겨찾기(여러 채널 동시 감시) CRUD. 실제 감시 시작/종료는 토글 시점에 startWatcherFor /
// stopWatcherFor를 같이 호출해서, "즐겨찾기 자동시작 켜기" == "바로 감시 시작"이 되게 한다.
ipcMain.handle("get-favorites", async () => {
  try {
    return getFavorites();
  } catch (err) {
    console.error("get-favorites 실패:", err);
    return [];
  }
});

ipcMain.handle("add-favorite", async (_event, channelIdRaw) => {
  const channelId = (channelIdRaw || "").trim();
  if (!channelId) return { ok: false, error: "채널ID를 입력해주세요." };

  const favorites = getFavorites();
  if (favorites.some((f) => f.channelId === channelId)) {
    return { ok: false, error: "이미 즐겨찾기에 있는 채널입니다." };
  }

  let channelName = channelId;
  try {
    const cfg = getConfig();
    const client = new ChzzkClient({ nidAuth: cfg.nidAuth, nidSession: cfg.nidSession });
    const channel = await client.channel(channelId);
    channelName = channel?.channelName ?? channelId;
  } catch (err) {
    return { ok: false, error: "채널 정보를 찾을 수 없습니다. 채널ID를 확인해주세요." };
  }

  const next = [...favorites, { channelId, channelName, autoStart: false }];
  saveFavorites(next);
  updateTrayMenu();
  return { ok: true, favorites: next };
});

ipcMain.handle("remove-favorite", async (_event, channelId) => {
  const favorites = getFavorites().filter((f) => f.channelId !== channelId);
  saveFavorites(favorites);
  await stopWatcherFor(channelId).catch(() => {});
  updateTrayMenu();
  return { ok: true, favorites };
});

// 실제 로직은 트레이 메뉴 클릭과 공유하는 setFavoriteAutoStartFor()에 있다.
ipcMain.handle("set-favorite-auto-start", async (_event, { channelId, autoStart }) => {
  return setFavoriteAutoStartFor(channelId, autoStart);
});

// VOD(다시보기) 분석. 즐겨찾기와 달리 토글이 아니라 "한 번 실행" 방식이라 별도 레지스트리
// (vodJobs)로 관리한다. 결과 화면(로그/리포트/타임라인/편집점)은 라이브와 완전히 같은 데이터
// 형태라 렌더러 쪽에서 그대로 재사용한다.
ipcMain.handle("start-vod-analysis", async (_event, videoNoOrUrl) => {
  return startVodAnalysis(videoNoOrUrl);
});

ipcMain.handle("get-vod-jobs", async () => {
  // 결과(result)는 용량이 클 수 있어 목록 조회엔 안 실어 보낸다 (필요할 때 get-vod-job으로).
  return [...vodJobs.values()].map(serializeVodJobSummary);
});

ipcMain.handle("get-vod-job", async (_event, jobId) => {
  const job = vodJobs.get(jobId);
  return job ? serializeVodJob(job) : null;
});

ipcMain.handle("remove-vod-job", async (_event, jobId) => {
  vodJobs.delete(jobId);
  return { ok: true };
});

// "정밀분석"(화면 분석) 시작/취소. 진행 상황(phase="vision")은 기존 "progress" 이벤트로 그대로
// 실려오므로(analyzer.on("progress", ...)가 이미 위에서 모든 phase를 relay하고 있음) 별도
// 이벤트 채널이 필요 없다 — 완료/에러는 job-update로, 중간 진행률은 progress로 온다.
ipcMain.handle("start-vod-vision-analysis", async (_event, jobId) => {
  return startVodVisionAnalysis(jobId);
});

ipcMain.handle("cancel-vod-vision-analysis", async (_event, jobId) => {
  const job = vodJobs.get(jobId);
  if (!job || !job.analyzer) return { ok: false, error: "작업을 찾을 수 없습니다." };
  job.analyzer.cancelVision();
  return { ok: true };
});

// AI 화면 분석 상태/비용 배지(상단 표시)용. id는 즐겨찾기 channelId 또는 VOD jobId(videoNo) 모두
// 받는다 — resolveTimelineSource가 이미 그 둘을 구분해서 같은 형태로 조회해준다.
ipcMain.handle("get-vision-stats", async (_event, id) => {
  const source = resolveTimelineSource(id);
  if (!source) return { enabled: false, callCount: 0, estimatedCostUsd: 0, reason: "대상을 찾을 수 없음" };
  try {
    return source.getVisionStats();
  } catch (err) {
    console.error("get-vision-stats 실패:", err);
    return { enabled: false, callCount: 0, estimatedCostUsd: 0, reason: "조회 실패" };
  }
});

// VOD 영상 임베드용. chzzk 다시보기 페이지를 <webview>로 그대로 띄우던 방식(iframe)이 로그인
// 배너/추천 영상 UI가 같이 딸려와서 화면이 지저분해서(사용자 피드백), 실제 재생 가능한
// 스트림 주소를 직접 얻어 순수 <video> 태그(+hls.js/dash.js)로 재생하는 방식으로 바꿨다.
// 비공식 API라 실패할 수 있고, 그 경우 렌더러가 null을 받아서 "브라우저에서 열기"로 대체한다.
ipcMain.handle("get-vod-playback", async (_event, videoNo) => {
  try {
    const cfg = getConfig();
    return await resolveVodPlayback(videoNo, { nidAuth: cfg.nidAuth, nidSession: cfg.nidSession });
  } catch (err) {
    console.error("get-vod-playback 실패:", err);
    return null;
  }
});

// 라이브 방송 영상 임베드용. VOD와 달리 chzzk 패키지의 공식 지원 메서드(client.live.detail())가
// 재생 가능한 HLS 주소를 바로 내려주므로 비공식 API 역공학이 필요 없다. 방송 중이 아니면(또는
// 조회 실패하면) null — 렌더러가 "방송 중이 아님" 등으로 표시한다.
ipcMain.handle("get-live-playback", async (_event, channelId) => {
  try {
    const cfg = getConfig();
    return await resolveLivePlayback(channelId, { nidAuth: cfg.nidAuth, nidSession: cfg.nidSession });
  } catch (err) {
    console.error("get-live-playback 실패:", err);
    return null;
  }
});

// 설정 화면 용. config.json을 직접 편집하지 않아도 되게 한다.
ipcMain.handle("get-config", async () => {
  try {
    return getConfig();
  } catch (err) {
    console.error("get-config 실패:", err);
    return {};
  }
});

ipcMain.handle("save-config", async (_event, partial) => {
  try {
    saveConfig(partial || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// "고급 설정" 화면(로컬 휴식 감지/타임라인 판단 세부값 조절)용 IPC. current는 항상
// 완전한(빠진 필드 없는) 값이고, defaults는 "초기값으로 되돌리기" 버튼이 화면에 무엇으로
// 되돌아갈지 미리 보여주거나 리셋 확인에 쓸 수 있도록 같이 내려준다.
ipcMain.handle("get-analysis-settings", async () => {
  try {
    return { current: getAnalysisSettings(), defaults: DEFAULT_ANALYSIS_SETTINGS };
  } catch (err) {
    console.error("get-analysis-settings 실패:", err);
    return { current: DEFAULT_ANALYSIS_SETTINGS, defaults: DEFAULT_ANALYSIS_SETTINGS };
  }
});

ipcMain.handle("save-analysis-settings", async (_event, partial) => {
  try {
    const settings = saveAnalysisSettings(partial || {});
    return { ok: true, settings };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("reset-analysis-settings", async () => {
  try {
    const settings = resetAnalysisSettings();
    return { ok: true, settings };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// 라이브/VOD "브라우저에서 열기" 등, 외부 URL은 기본 브라우저로 열어준다.
ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return; // http(s) 중 https만, 임의 스킴 방지
  await shell.openExternal(url);
});

// chzzk 로그인. 설정 화면의 "chzzk 로그인" 버튼이 이걸 호출한다 — 실제 네이버 로그인 페이지를
// 새 창으로 띄우고, 로그인 완료 시 생기는 쿠키를 자동으로 읽어 config.json에 저장한다(자세한
// 설명은 openChzzkLoginWindow() 주석 참고). VOD 메타데이터 조회, 연령 제한 방송 채팅 등
// 로그인 없이는 막혀있는 기능들이 이 값으로 동작한다.
ipcMain.handle("open-chzzk-login", async () => {
  try {
    return await openChzzkLoginWindow();
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("chzzk-logout", async () => {
  try {
    return chzzkLogout();
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("check-chzzk-login", async () => {
  try {
    return await checkChzzkLoginValidity();
  } catch (err) {
    return { state: "unknown", error: String(err && err.message ? err.message : err) };
  }
});

// 컴퓨터 부팅 시 자동 실행(OS 로그인 항목) 설정. 즐겨찾기 자동시작과 조합하면, 컴퓨터를 켜기만
// 해도 즐겨찾기해둔 채널 감시가 다시 시작되는 구조가 완성된다. 트레이 상주(닫기=숨김)와 짝을
// 이루는 기능이라, 이 프로그램을 "백그라운드 상주 프로그램"처럼 쓰고 싶은 사람을 위한 것이다.
ipcMain.handle("get-launch-at-login", async () => {
  try {
    return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("set-launch-at-login", async (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// 프레임리스 창이라 렌더러의 커스텀 타이틀바(점 3개)에서 이 세 개를 호출해 창을 제어한다.
ipcMain.handle("window-close", () => win?.close());
ipcMain.handle("window-minimize", () => win?.minimize());
ipcMain.handle("window-maximize-toggle", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
