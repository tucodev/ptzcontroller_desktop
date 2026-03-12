const { contextBridge, ipcRenderer } = require("electron");

// ── 테마 복원 ──────────────────────────────────────────────────
// Electron은 매 시작마다 localStorage를 초기화하므로, main.js에서 넘겨받은
// 저장된 테마를 페이지 JS 실행 전에 localStorage에 미리 주입한다.
// 이렇게 하면 next-themes가 초기 hydration 시 올바른 테마를 읽어 flash가 없다.
try {
    const themeArg = process.argv.find((a) => a.startsWith("--app-theme="));
    if (themeArg) {
        const savedTheme = themeArg.split("=")[1];
        // localStorage에 값이 없을 때만 주입한다.
        // - 앱 최초 진입: clearStorageData 직후라 비어 있음 → 주입 ✓
        // - 세션 내 페이지 리로드(로그아웃 등): 이미 현재 테마가 저장돼 있음 → 덮어쓰지 않음 ✓
        if (savedTheme && !localStorage.getItem("theme")) {
            localStorage.setItem("theme", savedTheme);
        }
    }
} catch (_) {}
// ──────────────────────────────────────────────────────────────

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
// P-46 수정: 라이선스 검증 관련 메소드 추가
// ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("electronAPI", {
    // ── 앱 정보 ──────────────────────────────────────────────
    getAppVersion: () => ipcRenderer.invoke("get-app-version"),

    // ── 윈도우 컨트롤 ─────────────────────────────────────────
    minimizeWindow: () => ipcRenderer.send("minimize-window"),
    maximizeWindow: () => ipcRenderer.send("maximize-window"),
    // P-19 수정: closeWindow는 트레이로 숨기기(hide) — 명세 명확화
    hideWindow: () => ipcRenderer.send("hide-window"),
    closeWindow: () => ipcRenderer.send("close-window"),

    // ── 플랫폼 정보 ───────────────────────────────────────────
    platform: process.platform,

    // ── 개발 모드 확인 ────────────────────────────────────────
    isDev: process.env.NODE_ENV === "development",

    // ── 설정 ────────────────────────────────────────────────
    changePort: (port) => ipcRenderer.send("change-port", port),
    requestStatus: () => ipcRenderer.send("request-status"),
    saveSettings: (s) => ipcRenderer.send("save-settings", s),

    // ── 라이선스 검증 API (P-46 추가) ──────────────────────────
    // 온라인 라이선스 검증 요청
    // @param serverUrl: http://localhost:3000
    // @param apiPath: /api/license/request-online
    // @param sessionToken: NextAuth 세션 토큰
    validateLicenseOnline: (serverUrl, apiPath, sessionToken) =>
        ipcRenderer.send("validate-license-online", {
            serverUrl,
            apiPath,
            sessionToken,
        }),

    // 저장된 오프라인 라이선스 확인
    checkOfflineLicense: () => ipcRenderer.send("check-offline-license"),

    // 현재 라이선스 상태 조회 (온라인/오프라인 모두)
    getLicenseStatus: () => ipcRenderer.send("get-license-status"),

    // 사용자가 업로드한 라이선스 파일 저장
    // @param filename: 파일명 (예: 'offline.ptzlic')
    // @param content: 파일 내용 (base64-encoded)
    uploadLicenseFile: (filename, content) =>
        ipcRenderer.send("upload-license-file", { filename, content }),

    // ── 이벤트 수신 (cleanup 함수 반환으로 메모리 누수 방지) ──
    // P-05 수정: 'status' 채널로 통일 (main.js 와 일치)
    onStatus: (callback) => {
        ipcRenderer.on("status", callback);
        return () => ipcRenderer.removeListener("status", callback);
    },
    onLog: (callback) => {
        ipcRenderer.on("log", callback);
        return () => ipcRenderer.removeListener("log", callback);
    },
    onSettingsChanged: (callback) => {
        ipcRenderer.on("settings-changed", callback);
        return () => ipcRenderer.removeListener("settings-changed", callback);
    },
    // Next.js 서버 상태용 (웹앱 컴포넌트에서 사용)
    onServerStatus: (callback) => {
        ipcRenderer.on("server-status", callback);
        return () => ipcRenderer.removeListener("server-status", callback);
    },
    // ── 라이선스 이벤트 (P-46 추가) ────────────────────────────
    // 온라인 라이선스 검증 결과
    // @param callback: (event, { success: bool, license?: string, message?: string }) => {}
    onLicenseValidated: (callback) => {
        ipcRenderer.on("license-validated", callback);
        return () => ipcRenderer.removeListener("license-validated", callback);
    },

    // 오프라인 라이선스 상태 확인 결과
    // @param callback: (event, { valid: bool, content?: string, hasFile: bool }) => {}
    onOfflineLicenseChecked: (callback) => {
        ipcRenderer.on("offline-license-checked", callback);
        return () =>
            ipcRenderer.removeListener("offline-license-checked", callback);
    },

    // 라이선스 상태 조회 결과
    // @param callback: (event, { online: {...}, offline: {...} }) => {}
    onLicenseStatus: (callback) => {
        ipcRenderer.on("license-status", callback);
        return () => ipcRenderer.removeListener("license-status", callback);
    },

    // 라이선스 파일 업로드 결과
    // @param callback: (event, { success: bool, message?: string }) => {}
    onLicenseUploaded: (callback) => {
        ipcRenderer.on("license-uploaded", callback);
        return () => ipcRenderer.removeListener("license-uploaded", callback);
    },
});

console.log("[Preload] loaded");
