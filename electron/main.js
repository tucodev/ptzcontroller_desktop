"use strict";

const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    shell,
    ipcMain,
    dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const http = require("http");

// ── Squirrel 설치/업데이트/언인스톨 이벤트 처리 (P-04 수정) ──────
// 반드시 최상단에서 처리해야 함 — 그 이후 어떤 코드도 실행되지 않아야 함
// Windows Squirrel 인스톨러가 설치/업데이트/삭제 시 특수 플래그를 전달:
//   --squirrel-install, --squirrel-updated, --squirrel-uninstall 등
// 이를 처리하지 않으면 Windows 설치 후 앱이 2회 실행되거나 종료가 안 됨
if (require("electron-squirrel-startup")) {
    app.quit();
    process.exit(0);
}

// ── 단일 인스턴스 ─────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}

// ── 경로 계산 ─────────────────────────────────────────────────
function getStandalonePath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "standalone")
        : path.join(__dirname, "..", "standalone");
}

function getNodeExecutable() {
    if (app.isPackaged) {
        const bundled = path.join(
            process.resourcesPath,
            "node-bin",
            process.platform === "win32" ? "node.exe" : "node",
        );
        if (fs.existsSync(bundled)) return bundled;
    }
    return process.platform === "win32" ? "node.exe" : "node";
}

// ── OS별 공유 라이선스/데이터 디렉토리 (P-16 수정) ───────────
// 기존: app.getPath("userData") → 사용자별 경로 (다중 계정 시 분리)
// 수정: OS 공용 경로 사용 (데스크톱 1인용 앱 의도에 부합)
function getSharedDataDir() {
    if (process.platform === "win32") {
        const pd = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
        return path.join(pd, "PTZController", "data");
    } else if (process.platform === "darwin") {
        return path.join("/Library", "Application Support", "PTZController", "data");
    } else {
        return path.join(process.env.HOME || "/etc", ".config", "PTZController", "data");
    }
}

// ── 설정 ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const DEV_MODE = process.env.NODE_ENV === "development";

// ── settings.json 읽기/쓰기 헬퍼 (P-21 수정) ─────────────────
// standalone/data/settings.json 을 읽어 proxyPort 등 PTZ 설정을 제공.
// 앱 실행 중 save-settings IPC 호출 시 파일에 영구 저장.
//
// P-31 수정: DEFAULT_SETTINGS 에 index.html 에서 사용하는
//   startToTray, tokenAuth, webAppUrl 항목 추가.
//   없으면 최초 실행 시 토글 UI 가 초기화되지 않아 설정 손실 발생.
const DEFAULT_SETTINGS = {
    defaultProtocol: "pelcod",
    defaultOperationMode: "direct",
    proxyPort: 9902,
    logLevel: "info",
    theme: "dark",
    // PTZ Proxy UI 설정 (index.html)
    startToTray: false,   // 시작 시 트레이로 실행 여부
    tokenAuth: false,     // 토큰 인증 사용 여부
    webAppUrl: "",        // 토큰 검증 서버 주소 (PTZ Controller 웹앱 URL)
};

function getSettingsPath() {
    const standalonePath = getStandalonePath();
    return path.join(standalonePath, "data", "settings.json");
}

function loadSettings() {
    const settingsPath = getSettingsPath();
    try {
        if (fs.existsSync(settingsPath)) {
            const raw = fs.readFileSync(settingsPath, "utf8");
            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        }
    } catch (e) {
        console.warn("[Desktop] settings.json 읽기 실패:", e.message);
    }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
    const settingsPath = getSettingsPath();
    try {
        const dir = path.dirname(settingsPath);
        fs.mkdirSync(dir, { recursive: true });
        const merged = { ...loadSettings(), ...settings };
        fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf8");
        return merged;
    } catch (e) {
        console.error("[Desktop] settings.json 저장 실패:", e.message);
        return null;
    }
}

// ── 전역 상태 ─────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let nextProcess = null;
let serverReady = false;
let appQuitting = false;

// ── .env 파싱 (P-14 수정: 인라인 주석 제거) ──────────────────
function parseEnv(filePath) {
    const vars = {};
    if (!fs.existsSync(filePath)) return vars;
    fs.readFileSync(filePath, "utf8")
        .split("\n")
        .forEach((line) => {
            const trimmed = line.trim();
            // 빈 줄 및 주석 줄 제외
            if (!trimmed || trimmed.startsWith("#")) return;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx < 1) return;
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            // 따옴표 제거
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            } else {
                // P-14 수정: 인라인 주석 제거 (따옴표 없는 값의 # 이후 제거)
                val = val.replace(/\s+#.*$/, "").trim();
            }
            vars[key] = val;
        });
    return vars;
}

// ── Prisma 엔진 탐색 ──────────────────────────────────────────
function findPrismaEngine(standalonePath) {
    const clientDir = path.join(
        standalonePath,
        "node_modules",
        ".prisma",
        "client",
    );
    if (!fs.existsSync(clientDir)) return "";
    const arch = process.arch;
    const candidates = {
        win32: ["query_engine-windows.dll.node"],
        darwin: [
            `libquery_engine-darwin-${arch}.dylib.node`,
            "libquery_engine-darwin-arm64.dylib.node",
            "libquery_engine-darwin.dylib.node",
        ],
        linux: [
            `libquery_engine-linux-musl-${arch}-openssl-3.0.x.so.node`,
            "libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node",
            "libquery_engine-linux-musl-openssl-3.0.x.so.node",
            "libquery_engine-rhel-openssl-3.0.x.so.node",
        ],
    };
    for (const name of candidates[process.platform] || []) {
        const full = path.join(clientDir, name);
        if (fs.existsSync(full)) return full;
    }
    return "";
}

// ── Next.js 프로세스 안전 종료 (P-06 수정) ───────────────────
// Windows에서 SIGTERM은 자식 프로세스 트리를 종료하지 못함.
// taskkill /T /F 로 프로세스 트리 전체 강제 종료.
function killNextProcess() {
    if (!nextProcess) return;
    const proc = nextProcess;
    nextProcess = null; // 먼저 null 로 설정하여 중복 호출 방지

    try {
        if (process.platform === "win32") {
            // Windows: taskkill 로 자식 프로세스 트리까지 종료
            const { execSync } = require("child_process");
            execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
        } else {
            // macOS / Linux: SIGTERM → graceful shutdown
            proc.kill("SIGTERM");
        }
        console.log("[Desktop] Next.js 서버 프로세스 종료 완료");
    } catch (e) {
        console.warn("[Desktop] 프로세스 종료 오류:", e.message);
    }
}

// ── Next.js 서버 시작 (P-25 수정: async 전환 및 에러 처리 개선) ──
// 반환값: { ok: true, hostname: serverHostname } | false
//   P-29 수정: serverHostname 을 반환하여 waitForServer() 에 전달
async function startNextServer() {
    const standalonePath = getStandalonePath();
    const serverJs = path.join(standalonePath, "server.js");

    if (!fs.existsSync(serverJs)) {
        showFatalError(
            `server.js 를 찾을 수 없습니다.\n${serverJs}\n\nnpm run copy:standalone 을 먼저 실행하세요.`,
        );
        return false;
    }

    const nodeExe = getNodeExecutable();
    const envVars = parseEnv(path.join(standalonePath, ".env"));
    const enginePath = findPrismaEngine(standalonePath);
    const dataDir = getSharedDataDir();

    // P-20 수정: HOSTNAME 기본값 localhost (보안상 외부 접근 차단)
    // PTZ_HOSTNAME 환경변수로 오버라이드 가능 (VM/WSL 환경 대응)
    const serverHostname = envVars.PTZ_HOSTNAME || process.env.PTZ_HOSTNAME || "localhost";

    const serverEnv = {
        ...process.env,
        ...envVars,
        PORT: String(PORT),
        HOSTNAME: serverHostname,
        NODE_ENV: "production",
        NEXTAUTH_URL: envVars.NEXTAUTH_URL || `http://${serverHostname}:${PORT}`,
        // P-16 수정: 공유 데이터 경로 사용
        PTZ_DATA_DIR: dataDir,
        // P-15 수정: PTZ_FORCE_SHARED 환경변수 전달 (1인용 앱 — userId 무시)
        PTZ_FORCE_SHARED: "true",
        ...(enginePath ? { PRISMA_QUERY_ENGINE_LIBRARY: enginePath } : {}),
    };

    console.log("[Desktop] node      :", nodeExe);
    console.log("[Desktop] server.js :", serverJs);
    console.log("[Desktop] data dir  :", dataDir);
    console.log("[Desktop] NEXTAUTH_URL:", serverEnv.NEXTAUTH_URL);
    console.log("[Desktop] DATABASE_URL:", serverEnv.DATABASE_URL
        ? serverEnv.DATABASE_URL.replace(/:([^:@]+)@/, ":***@") : "❌ NOT SET");

    // P-28 수정: LICENSE_SERVER_URL 이 localhost 를 가리키면 경고 출력
    // 배포 환경에서는 라이선스 서버가 없으므로 localhost URL 은 항상 실패함
    if (serverEnv.LICENSE_SERVER_URL &&
        /127\.0\.0\.1|localhost/.test(serverEnv.LICENSE_SERVER_URL)) {
        console.warn(
            "[Desktop] ⚠️  LICENSE_SERVER_URL 이 localhost 를 가리킵니다:",
            serverEnv.LICENSE_SERVER_URL,
        );
        console.warn(
            "[Desktop]    배포 환경에서는 실제 라이선스 서버 URL 로 변경하거나",
        );
        console.warn(
            "[Desktop]    LICENSE_SERVER_URL 을 설정하지 않으면 오프라인 모드로 동작합니다.",
        );
    }

    // P-25 수정: spawn 에러를 Promise 로 감지
    return new Promise((resolve) => {
        nextProcess = cp.spawn(nodeExe, [serverJs], {
            cwd: standalonePath,
            env: serverEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });

        nextProcess.stdout.on("data", (d) => process.stdout.write("[Next] " + d));
        nextProcess.stderr.on("data", (d) => process.stderr.write("[Next] " + d));

        // spawn 자체 실패 (ENOENT 등) — 비동기 이벤트로 발생
        nextProcess.on("error", (err) => {
            console.error("[Desktop] spawn error:", err.message);
            nextProcess = null;
            showFatalError(
                err.code === "ENOENT"
                    ? `Node.js 실행 파일을 찾을 수 없습니다.\n${nodeExe}`
                    : `서버 실행 오류: ${err.message}`,
            );
            resolve(false);
        });

        // P-12 수정: 서버 비정상 종료 시 사용자에게 dialog 알림
        // P-32 수정: 서버 종료 시 server-status 이벤트 발송하여 렌더러에 알림
        nextProcess.on("exit", (code, signal) => {
            if (appQuitting) return; // 정상 종료 흐름이면 무시
            if (code !== 0 && signal !== "SIGTERM") {
                console.error(`[Desktop] server exited: code=${code} signal=${signal}`);
                // 렌더러에 서버 다운 상태 전파
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("server-status", {
                        ready: false,
                        port: PORT,
                        exitCode: code,
                    });
                }
                serverReady = false;
                dialog.showErrorBox(
                    "PTZ Controller — 서버 오류",
                    `Next.js 서버가 예기치 않게 종료되었습니다.\n` +
                    `종료 코드: ${code}\n\n` +
                    `앱을 재시작해 주세요.`,
                );
            }
        });

        // spawn 이 성공적으로 시작됐으면 resolve({ ok: true, hostname })
        // (error 이벤트가 없으면 성공으로 간주)
        // P-29 수정: hostname 을 함께 반환하여 waitForServer() 에서 사용
        process.nextTick(() => {
            if (nextProcess) resolve({ ok: true, hostname: serverHostname });
        });
    });
}

// ── 서버 준비 대기 (HTTP 폴링) (P-11 수정: 타임아웃 60초로 증가) ──
// P-29 수정: serverHostname 파라미터 추가로 PTZ_HOSTNAME 설정과 일관성 유지.
//   단, 서버가 '0.0.0.0' 또는 '::' 에 바인딩된 경우에도 HTTP 요청은
//   루프백(127.0.0.1 / localhost) 으로 보내야 하므로, 해당 케이스는
//   자동으로 'localhost' 로 대체한다.
function waitForServer(hostname, retries = 120, interval = 500) {
    // 0.0.0.0 / 비어있음 / :: 바인딩이면 루프백으로 폴링
    const pollHost =
        !hostname || hostname === "0.0.0.0" || hostname === "::"
            ? "localhost"
            : hostname;
    const url = `http://${pollHost}:${PORT}`;
    return new Promise((resolve, reject) => {
        let tried = 0;
        const check = () => {
            http.get(url, (res) => {
                res.resume();
                serverReady = true;
                resolve();
            }).on("error", () => {
                if (++tried >= retries)
                    reject(
                        new Error(
                            `서버가 ${(retries * interval) / 1000}초 내에 응답하지 않습니다.\n` +
                            `폴링 URL: ${url}\n` +
                            `Next.js 서버 로그를 확인하세요.`,
                        ),
                    );
                else setTimeout(check, interval);
            });
        };
        check();
    });
}

// ── BrowserWindow 생성 ────────────────────────────────────────
function createWindow() {
    const assetsDir = path.join(__dirname, "..", "assets");
    let iconPath;
    if (process.platform === "darwin") {
        const icns = path.join(assetsDir, "icon.icns");
        iconPath = fs.existsSync(icns)
            ? icns
            : path.join(assetsDir, "icon.png");
    } else if (process.platform === "win32") {
        const ico = path.join(assetsDir, "icon.ico");
        iconPath = fs.existsSync(ico) ? ico : path.join(assetsDir, "icon.png");
    } else {
        iconPath = path.join(assetsDir, "icon.png");
    }
    if (!fs.existsSync(iconPath)) iconPath = undefined;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: "#0f172a",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
        },
        icon: iconPath,
        title: "PTZ Controller",
        autoHideMenuBar: true,
        show: false,
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);

    mainWindow.webContents.on("did-finish-load", () => {
        if (!mainWindow.isVisible()) mainWindow.show();
        // P-32 수정: 페이지 로드 완료 시 Next.js 서버 상태를 렌더러에 전달.
        // admin 앱(Next.js)이 window.electronAPI.onServerStatus() 로 이 이벤트를 받아
        // 서버 준비 상태를 UI에 반영할 수 있음.
        mainWindow.webContents.send("server-status", {
            ready: serverReady,
            port: PORT,
        });
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(`http://localhost:${PORT}`))
            shell.openExternal(url);
        return { action: "deny" };
    });

    mainWindow.on("close", (e) => {
        if (!appQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    if (DEV_MODE) mainWindow.webContents.openDevTools({ mode: "detach" });
}

// ── 트레이 ────────────────────────────────────────────────────
function createTray() {
    const icoPath = path.join(__dirname, "..", "assets", "icon.ico");
    const pngPath = path.join(__dirname, "..", "assets", "icon.png");
    let icon = nativeImage.createEmpty();
    if (process.platform === "win32" && fs.existsSync(icoPath))
        icon = nativeImage.createFromPath(icoPath);
    else if (fs.existsSync(pngPath))
        icon = nativeImage
            .createFromPath(pngPath)
            .resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("PTZ Controller");
    tray.on("click", () => showWindow());
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "PTZ Controller", enabled: false },
            {
                label: serverReady
                    ? `● 실행 중 (포트 ${PORT})`
                    : "○ 시작 중...",
                enabled: false,
            },
            { type: "separator" },
            { label: "열기", click: () => showWindow() },
            { type: "separator" },
            { label: "종료", click: () => quitApp() },
        ]),
    );
}

function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
    mainWindow.focus();
}

// ── 종료 (P-07 수정: 종료 로직을 before-quit 한 곳으로 통합) ─
function quitApp() {
    appQuitting = true;
    app.quit();
}

function showFatalError(msg) {
    console.error("[Desktop] FATAL:", msg);
    try {
        dialog.showErrorBox("PTZ Controller 오류", msg);
    } catch {}
    quitApp();
}

// ── IPC ───────────────────────────────────────────────────────
// P-02/03 수정: index.html 에서 require('electron') 직접 호출 제거 후
//              window.electronAPI 경유 → 아래 핸들러들이 반드시 존재해야 함
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
// P-19 수정: close-window(닫기)와 hide-window(트레이)를 분리
ipcMain.on("hide-window",  () => mainWindow?.hide());   // 트레이로 숨기기
ipcMain.on("close-window", () => mainWindow?.hide());   // 기존 호환 유지 (트레이 앱 특성상 hide)

// P-03 수정: index.html 에서 사용하는 누락된 IPC 핸들러 추가
// P-21 수정: settings.json 실제 읽기/쓰기 구현 (proxyPort 등 설정값 반영)
ipcMain.on("start-server", (_, port) => {
    console.log(`[IPC] start-server 요청: port=${port} (Proxy 서버 미구현)`);
    // TODO: PTZ Proxy WebSocket 서버 시작 로직
    if (mainWindow) {
        const settings = loadSettings();
        mainWindow.webContents.send("status", {
            running: false,
            port: port || settings.proxyPort,
            clients: 0,
            connections: 0,
            settings,
        });
    }
});
ipcMain.on("stop-server", () => {
    console.log("[IPC] stop-server 요청 (Proxy 서버 미구현)");
    // TODO: PTZ Proxy WebSocket 서버 중지 로직
    if (mainWindow) {
        const settings = loadSettings();
        mainWindow.webContents.send("status", {
            running: false,
            port: settings.proxyPort,
            clients: 0,
            connections: 0,
            settings,
        });
    }
});
ipcMain.on("change-port", (_, port) => {
    console.log(`[IPC] change-port 요청: port=${port}`);
    // P-21 수정: proxyPort 를 settings.json 에 저장
    const updated = saveSettings({ proxyPort: port });
    if (updated && mainWindow) {
        mainWindow.webContents.send("settings-changed", updated);
    }
});
ipcMain.on("save-settings", (_, settings) => {
    console.log("[IPC] save-settings:", settings);
    // P-21 수정: settings.json 에 실제 저장
    const updated = saveSettings(settings);
    if (updated && mainWindow) {
        mainWindow.webContents.send("settings-changed", updated);
    }
});
ipcMain.on("request-status", () => {
    // P-21 수정: settings.json 에서 proxyPort 읽어 반환
    if (mainWindow) {
        const settings = loadSettings();
        mainWindow.webContents.send("status", {
            running: false,
            port: settings.proxyPort,
            clients: 0,
            connections: 0,
            settings,
        });
    }
});

// ── 앱 시작 ───────────────────────────────────────────────────
app.whenReady().then(async () => {
    createTray();

    // P-25 수정: startNextServer 를 await 로 호출 (에러 감지 가능)
    // P-29 수정: startNextServer 가 반환하는 hostname 을 waitForServer 에 전달
    const started = await startNextServer();
    if (!started) return; // showFatalError 에서 종료 처리됨

    // started 가 { ok: true, hostname } 형태인 경우 hostname 추출
    // 이전 버전 호환 (true 반환 시)을 위해 fallback 처리
    const resolvedHostname =
        started && typeof started === "object" ? started.hostname : "localhost";

    try {
        await waitForServer(resolvedHostname);
        console.log(`[Desktop] Ready → http://localhost:${PORT}`);
        updateTrayMenu();
        createWindow();
    } catch (err) {
        showFatalError(`서버 시작 실패\n\n${err.message}`);
    }
});

// P-10 수정: macOS Dock 클릭 시 창 복원 (activate 핸들러 추가)
app.on("activate", () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    } else if (serverReady) {
        createWindow();
    }
});

app.on("second-instance", () => showWindow());

// 트레이 앱이므로 모든 창이 닫혀도 앱 유지
app.on("window-all-closed", (e) => e.preventDefault());

// P-07 수정: 종료 로직을 before-quit 한 곳으로 통합
// quitApp() → app.quit() → before-quit → will-quit → 앱 종료
// 이전: quitApp()에서 kill 후 will-quit 에서도 kill 시도 (중복)
// 수정: before-quit 에서만 프로세스 종료 처리
app.on("before-quit", () => {
    appQuitting = true;
    // P-06 수정: Windows SIGTERM → taskkill 로 교체
    killNextProcess();
});

// will-quit 에서는 tray 정리만 수행 (프로세스 종료는 before-quit 에서 완료)
app.on("will-quit", () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

// P-13 수정: 처리되지 않은 예외 발생 시 사용자에게 알림
process.on("uncaughtException", (err) => {
    console.error("[Desktop] uncaughtException:", err);
    try {
        dialog.showErrorBox("PTZ Controller — 오류", `예기치 않은 오류가 발생했습니다.\n\n${err.message}`);
    } catch {}
    // 치명적 오류이면 앱 종료
    quitApp();
});

process.on("unhandledRejection", (reason) => {
    console.error("[Desktop] unhandledRejection:", reason);
});
