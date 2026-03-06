const { contextBridge, ipcRenderer } = require('electron');

// ─────────────────────────────────────────────────────────────
// 렌더러 프로세스에 안전하게 API 노출 (contextBridge)
//
//   - nodeIntegration: false 이므로 렌더러에서 Node.js 직접 접근 불가
//   - contextIsolation: true 이므로 window.electronAPI 를 통해서만 접근
//
// 사용 예 (렌더러):
//   const ver = await window.electronAPI.getAppVersion();
//   window.electronAPI.minimizeWindow();
//   window.electronAPI.onStatus((event, status) => { ... });
//
// P-02 수정: require('electron') 직접 호출 제거 → contextBridge 경유로 통일
// P-03 수정: index.html 에서 필요한 모든 IPC 채널 추가 노출
// P-05 수정: onServerStatus → onStatus 로 통합 (main.js 에서 'status' 채널 사용)
// ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {

  // ── 앱 정보 ──────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ── 윈도우 컨트롤 ─────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  // P-19 수정: closeWindow는 트레이로 숨기기(hide) — 명세 명확화
  hideWindow:     () => ipcRenderer.send('hide-window'),
  closeWindow:    () => ipcRenderer.send('close-window'),

  // ── 플랫폼 정보 ───────────────────────────────────────────
  platform: process.platform,

  // ── 개발 모드 확인 ────────────────────────────────────────
  isDev: process.env.NODE_ENV === 'development',

  // ── PTZ Proxy 서버 제어 (P-03 수정) ──────────────────────
  // index.html 의 서버 시작/중지/포트변경 버튼용
  startServer:    (port) => ipcRenderer.send('start-server', port),
  stopServer:     ()     => ipcRenderer.send('stop-server'),
  changePort:     (port) => ipcRenderer.send('change-port', port),
  requestStatus:  ()     => ipcRenderer.send('request-status'),
  saveSettings:   (s)    => ipcRenderer.send('save-settings', s),

  // ── 이벤트 수신 (cleanup 함수 반환으로 메모리 누수 방지) ──
  // P-05 수정: 'status' 채널로 통일 (main.js 와 일치)
  onStatus: (callback) => {
    ipcRenderer.on('status', callback);
    return () => ipcRenderer.removeListener('status', callback);
  },
  onLog: (callback) => {
    ipcRenderer.on('log', callback);
    return () => ipcRenderer.removeListener('log', callback);
  },
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', callback);
    return () => ipcRenderer.removeListener('settings-changed', callback);
  },
  // Next.js 서버 상태용 (웹앱 컴포넌트에서 사용)
  onServerStatus: (callback) => {
    ipcRenderer.on('server-status', callback);
    return () => ipcRenderer.removeListener('server-status', callback);
  },
});

console.log('[Preload] loaded');
