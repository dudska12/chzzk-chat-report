const { contextBridge, ipcRenderer } = require("electron");

// 렌더러(웹 페이지)에서 window.api.xxx 형태로 안전하게 IPC를 쓸 수 있게 노출.
// 여러 채널을 동시에 감시할 수 있게 되면서, on* 콜백들은 이제 { channelId, payload } 형태로
// 전달된다 (어느 채널에서 온 이벤트인지 렌더러가 구분해야 하기 때문).
contextBridge.exposeInMainWorld("api", {
  startWatch: (channelId) => ipcRenderer.invoke("start-watch", channelId),
  stopWatch: (channelId) => ipcRenderer.invoke("stop-watch", channelId),
  exportReport: (markdown, suggestedName) =>
    ipcRenderer.invoke("export-report", { markdown, suggestedName }),
  exportCard: (report, suggestedName) =>
    ipcRenderer.invoke("export-card", { report, suggestedName }),
  exportEditPoints: (timeline, suggestedName) =>
    ipcRenderer.invoke("export-edit-points", { timeline, suggestedName }),

  getTimeline: (channelId) => ipcRenderer.invoke("get-timeline", channelId),
  getUserTimeline: (channelId, nickname) =>
    ipcRenderer.invoke("get-user-timeline", { channelId, nickname }),
  getMessagesInRange: (channelId, start, end) =>
    ipcRenderer.invoke("get-messages-in-range", { channelId, start, end }),
  searchMessages: (channelId, query) => ipcRenderer.invoke("search-messages", { channelId, query }),
  getVodPlayback: (videoNo) => ipcRenderer.invoke("get-vod-playback", videoNo),
  getLivePlayback: (channelId) => ipcRenderer.invoke("get-live-playback", channelId),

  getFavorites: () => ipcRenderer.invoke("get-favorites"),
  addFavorite: (channelId) => ipcRenderer.invoke("add-favorite", channelId),
  removeFavorite: (channelId) => ipcRenderer.invoke("remove-favorite", channelId),
  setFavoriteAutoStart: (channelId, autoStart) =>
    ipcRenderer.invoke("set-favorite-auto-start", { channelId, autoStart }),

  // VOD(다시보기) 분석. 즐겨찾기와 별개의 "한 번 실행" 작업 목록.
  startVodAnalysis: (videoNoOrUrl) => ipcRenderer.invoke("start-vod-analysis", videoNoOrUrl),
  getVodJobs: () => ipcRenderer.invoke("get-vod-jobs"),
  getVodJob: (jobId) => ipcRenderer.invoke("get-vod-job", jobId),
  removeVodJob: (jobId) => ipcRenderer.invoke("remove-vod-job", jobId),
  onVodEvent: (cb) => ipcRenderer.on("vod-event", (_e, evt) => cb(evt)),

  // VOD "정밀분석"(화면 분석, 선택 기능). 기본 분석이 끝난 뒤에만 실행할 수 있고, 진행 상황은
  // 위 onVodEvent의 "progress"(phase="vision")/"job-update" 이벤트로 그대로 실려온다.
  startVodVisionAnalysis: (jobId) => ipcRenderer.invoke("start-vod-vision-analysis", jobId),
  cancelVodVisionAnalysis: (jobId) => ipcRenderer.invoke("cancel-vod-vision-analysis", jobId),

  // AI 화면 분석 상태/비용 배지용. id는 즐겨찾기 channelId 또는 VOD jobId(videoNo) 둘 다 받는다.
  getVisionStats: (id) => ipcRenderer.invoke("get-vision-stats", id),

  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (partial) => ipcRenderer.invoke("save-config", partial),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // "고급 설정" (로컬 휴식 감지/타임라인 판단 로직 세부값). 바뀐 값은 그 다음
  // 새로 시작하는 감시/VOD 분석부터 적용된다 (이미 돌고 있는 감시는 다시 시작해야 반영됨).
  getAnalysisSettings: () => ipcRenderer.invoke("get-analysis-settings"),
  saveAnalysisSettings: (partial) => ipcRenderer.invoke("save-analysis-settings", partial),
  resetAnalysisSettings: () => ipcRenderer.invoke("reset-analysis-settings"),

  // chzzk(네이버) 로그인. 실제 로그인 페이지를 새 창으로 띄우고 완료되면 쿠키를 자동 저장한다.
  openChzzkLogin: () => ipcRenderer.invoke("open-chzzk-login"),
  chzzkLogout: () => ipcRenderer.invoke("chzzk-logout"),
  checkChzzkLogin: () => ipcRenderer.invoke("check-chzzk-login"),

  // 컴퓨터 부팅 시 자동 실행 (트레이 상주 + 즐겨찾기 자동시작과 조합해서 쓰는 기능).
  getLaunchAtLogin: () => ipcRenderer.invoke("get-launch-at-login"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("set-launch-at-login", enabled),

  // 콜백은 { channelId, payload } 객체 하나를 그대로 받는다.
  onLog: (cb) => ipcRenderer.on("log", (_e, evt) => cb(evt)),
  onChat: (cb) => ipcRenderer.on("chat", (_e, evt) => cb(evt)),
  onSessionStart: (cb) => ipcRenderer.on("session-start", (_e, evt) => cb(evt)),
  onReportReady: (cb) => ipcRenderer.on("report-ready", (_e, evt) => cb(evt)),

  closeWindow: () => ipcRenderer.invoke("window-close"),
  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window-maximize-toggle"),
});
