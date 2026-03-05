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
//   window.electronAPI.onServerStatus((event, status) => { ... });
// ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {

  // ── 앱 정보 ──────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ── 윈도우 컨트롤 ─────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow:    () => ipcRenderer.send('close-window'),

  // ── 플랫폼 정보 ───────────────────────────────────────────
  platform: process.platform,

  // ── 서버 상태 이벤트 리스너 ───────────────────────────────
  // 버그 수정: ipcRenderer.on 은 컴포넌트 마운트/언마운트마다 중복 등록됨
  //           → 리스너 해제 함수(removeListener)를 함께 반환
  onServerStatus: (callback) => {
    ipcRenderer.on('server-status', callback);
    // 호출 측에서 cleanup 함수를 호출해 리스너 해제
    return () => ipcRenderer.removeListener('server-status', callback);
  },

  // ── 개발 모드 확인 ────────────────────────────────────────
  isDev: process.env.NODE_ENV === 'development',
});

console.log('[Preload] loaded');
