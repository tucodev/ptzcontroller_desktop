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

    const serverEnv = {
        ...process.env,
        ...envVars,
        PORT: String(PORT),
        HOSTNAME: "localhost",
        NODE_ENV: "production",
        NEXTAUTH_URL: envVars.NEXTAUTH_URL || `http://localhost:${PORT}`,
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
        nextProcess.on("exit", (code, signal) => {
            if (appQuitting) return; // 정상 종료 흐름이면 무시
            if (code !== 0 && signal !== "SIGTERM") {
                console.error(`[Desktop] server exited: code=${code} signal=${signal}`);
                dialog.showErrorBox(
                    "PTZ Controller — 서버 오류",
                    `Next.js 서버가 예기치 않게 종료되었습니다.\n` +
                    `종료 코드: ${code}\n\n` +
                    `앱을 재시작해 주세요.`,
                );
            }
        });

        // spawn 이 성공적으로 시작됐으면 resolve(true)
        // (error 이벤트가 없으면 성공으로 간주)
        process.nextTick(() => {
            if (nextProcess) resolve(true);
        });
    });
}

// ── 서버 준비 대기 (HTTP 폴링) (P-11 수정: 타임아웃 60초로 증가) ──
function waitForServer(retries = 120, interval = 500) {
    return new Promise((resolve, reject) => {
        let tried = 0;
        const check = () => {
            http.get(`http://localhost:${PORT}`, (res) => {
                res.resume();
                serverReady = true;
                resolve();
            }).on("error", () => {
                if (++tried >= retries)
                    reject(
                        new Error(
                            `서버가 ${(retries * interval) / 1000}초 내에 응답하지 않습니다.\n` +
                            `포트: ${PORT}\n` +
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
// PTZ Proxy 서버 제어용 — 현재 main.js 에는 Proxy 서버가 없으므로
// 향후 구현을 위한 스텁(stub) 핸들러 등록 (무시하지 않고 로그 출력)
ipcMain.on("start-server", (_, port) => {
    console.log(`[IPC] start-server 요청: port=${port} (Proxy 서버 미구현)`);
    // TODO: PTZ Proxy WebSocket 서버 시작 로직 (P-21 구현 시 채울 것)
    if (mainWindow) {
        mainWindow.webContents.send("status", {
            running: false, port, clients: 0, connections: 0,
        });
    }
});
ipcMain.on("stop-server", () => {
    console.log("[IPC] stop-server 요청 (Proxy 서버 미구현)");
    // TODO: PTZ Proxy WebSocket 서버 중지 로직
});
ipcMain.on("change-port", (_, port) => {
    console.log(`[IPC] change-port 요청: port=${port}`);
    // TODO: 포트 변경 후 재시작
});
ipcMain.on("save-settings", (_, settings) => {
    console.log("[IPC] save-settings:", settings);
    // TODO: settings.json 저장 로직
    if (mainWindow) {
        mainWindow.webContents.send("settings-changed", settings);
    }
});
ipcMain.on("request-status", () => {
    // 현재 상태를 index.html 로 전송 (Proxy 서버 미구현이므로 기본값 반환)
    if (mainWindow) {
        mainWindow.webContents.send("status", {
            running: false,
            port: 9902,
            clients: 0,
            connections: 0,
        });
    }
});

// ── 앱 시작 ───────────────────────────────────────────────────
app.whenReady().then(async () => {
    createTray();

    // P-25 수정: startNextServer 를 await 로 호출 (에러 감지 가능)
    const started = await startNextServer();
    if (!started) return; // showFatalError 에서 종료 처리됨

    try {
        await waitForServer();
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
