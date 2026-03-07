# PTZ Controller Desktop - 최종 깊이 있는 분석 및 이해

## 📋 프로젝트 개요

**ptzcontroller_desktop**은 웹 기반 PTZ(Pan-Tilt-Zoom) 카메라 컨트롤러인 `ptzcontroller_admin`을 데스크톱 애플리케이션(EXE)으로 패키징하는 Electron 래퍼 프로젝트입니다.

프로젝트 구조: 
```
ptzcontroller_admin/ ← Next.js 기반 웹앱 (원본) 
                   ├── pages/ 
                   ├── components/ 
                   ├── public/ 
                   ├── prisma/ 
                   ├── .next/standalone/ ← 독립실행형 번들 (빌드 결과) 
                   ├── package.json 
                   └── .env ← DB 자격증명, NextAuth 시크릿 등

ptzcontroller_desktop/ ← Electron 데스크톱 래퍼 
                   ├── electron/ 
                   │     ├── main.js ← Electron 메인 프로세스 (서버 관리, IPC) 
                   │     └── preload.js ← 보안 브릿지 (contextIsolation) 
                   ├── scripts/
                   │     ├── copy-standalone.js ← Next.js 번들을 standalone/로 복사 
                   │     └── bundle-node.js ← 노드 바이너리 포터블 생성 
                   ├── standalone/ ← Next.js standalone 실행 환경 
                   ├── assets/ 
                   │     ├── icon.ico ← Windows 아이콘 
                   │     ├── icon.png ← 공용 아이콘 
                   │     └── icon.icns ← macOS 아이콘 
                   ├── index.html ← PTZ Proxy UI (현재 미사용) 
                   ├── package.json 
                   ├── forge.config.js ← Electron Forge 빌드 설정 
                   └── BUILD.md ← 빌드 가이드

```

## 🏗️ 아키텍처 및 실행 흐름

### 1. 빌드 파이프라인

[Step 1] Next.js 빌드 (ptzcontroller_admin/) cd ptzcontroller_admin && yarn build → 결과: .next/standalone/, .next/static/, public/

[Step 2] standalone 복사 (ptzcontroller_desktop/) npm run copy:standalone → scripts/copy-standalone.js 실행 → standalone/ 폴더 생성 및 필요 파일 배치 → .env 파일 복사 및 NEXTAUTH_URL 보정 → Prisma 엔진 바이너리 복사

[Step 3] (선택) Node.js 포터블 번들 node scripts/bundle-node.js → node-bin/ 폴더 생성 (node.exe, node 바이너리) → 배포 대상이 Node.js 미설치 환경일 때 필요

[Step 4] Electron 패키징 npm run make:win (Windows) npm run make:mac (macOS) npm run make:linux (Linux) → Electron Forge 실행 → electron/main.js를 진입점으로 exe/dmg/deb 생성


### 2. 런타임 실행 흐름
```
[1] Electron 앱 시작 
         ↓ 
[2] app.whenReady() → electron/main.js의 메인 로직 시작
       ├─ createTray() → 시스템 트레이 아이콘 생성 
       └─ startNextServer() 
              ├─ standalone/server.js 실행 (Node.js 자식 프로세스)
              │ (Next.js 서버가 포트 3000에서 대기) 
              ├─ 환경변수 로드: 
              │       ├─ DATABASE_URL (PostgreSQL/NeonDB 연결) 
              │       ├─ NEXTAUTH_URL="http://localhost:3000" (강제)
              │       ├─ NEXTAUTH_SECRET (JWT 서명 키)
              │       ├─ PTZ_FORCE_SHARED="true" (1인용 앱 — userId 무시)
              │       ├─ PTZ_DATA_DIR (공유 라이선스/설정 디렉토리) 
              │       └─ PRISMA_QUERY_ENGINE_LIBRARY (경로가 명시된 경우)
              └─ Prisma 엔진 탐색 (Windows: query_engine-windows.dll.node macOS: libquery_engine-darwin-arm64.dylib.node 등)
        ↓
[3] waitForServer() → HTTP 폴링으로 서버 준비 대기 (최대 60초, 500ms 간격 × 120회) 
        ↓
[4] createWindow() 
        ├─ BrowserWindow 생성 (1280×800, 최소 900×600)
        ├─ mainWindow.loadURL("http://localhost:3000") 
        └─ preload.js 로드 (contextIsolation:true, nodeIntegration:false) → window.electronAPI 객체 노출 
        ↓
[5] Next.js 웹앱 렌더링 
        ├─ DB 연결 시도 
        │      ├─ 성공 → 정상 로그인 플로우 
        │      └─ 실패 → 오프라인 모드
        │                 └─ 라이선스 파일 확인
        ├─ 사용자 인증 (NextAuth) 
                └─ PTZ 카메라 컨트롤 UI 표시
         ↓
[6] 서버 상태 모니터링 
        ├─ nextProcess.on("exit") → 비정상 종료 시 dialog 표시
        ├─ nextProcess.on("error") → spawn 실패 감지
        └─ appQuitting 플래그로 정상/비정상 종료 구분 
        ↓ 
[7] 종료 시퀀스 quitApp() → app.quit() 
        ↓
     app.on("before-quit") 
        ├─ killNextProcess() 실행 (SIGTERM/taskkill) 
        └─ appQuitting=true 설정 
        ↓ 
     app.on("will-quit") 
        └─ tray.destroy()
```

### 3. 프로세스 아키텍처
```
메인 프로세스 (electron/main.js)
     ├─ 역할: 윈도우 관리, IPC 처리, 자식 프로세스 제어
     ├─ 권한: Node.js, fs, cp, http 접근 가능 
     ├─ 생명주기: 앱 시작~종료까지 
     └─ 자식 프로세스: 
           └─ Node.js (standalone/server.js) 
                 ├─ 역할: Next.js 서버 실행, DB 쿼리 
                 ├─ 바인딩: http://localhost:3000 
                 └─ 환경변수: DATABASE_URL, NEXTAUTH_URL 등

렌더러 프로세스 (http://localhost:3000)
    ├─ 역할: UI 렌더링, 사용자 상호작용
    ├─ 권한: window.electronAPI 경유 IPC만 가능 
    ├─ contextIsolation:true → 직접 Node.js/fs 접근 불가
    └─ Next.js 프런트엔드 + API 라우트

```
---

## 🔑 핵심 파일 상세 분석

### 1. electron/main.js — 메인 프로세스의 중추

#### 1-1. Squirrel 설치 이벤트 처리 (P-04)

```javascript
// ❌ 문제: Windows Squirrel 설치 시 특수 플래그를 처리하지 않으면
//         앱이 2회 실행되거나 정상 종료되지 않음
// ✅ 수정: 최상단에서 처리

if (require("electron-squirrel-startup")) {
    app.quit();
    process.exit(0);
}
설명:

Windows 설치 프로그램이 --squirrel-install, --squirrel-updated 등의 플래그를 전달
이를 처리하지 않으면 멀티플 인스턴스 실행 또는 정상 종료 불가
electron-squirrel-startup 패키지가 이를 자동 감지하고 처리
1-2. 단일 인스턴스 보장 (이미 구현됨)
Copyconst gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}
app.on("second-instance", () => showWindow());
설명:

동시에 2개 이상의 앱 인스턴스 실행 방지
이미 실행 중일 때는 기존 윈도우 활성화
1-3. 경로 계산 헬퍼
Copyfunction getStandalonePath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "standalone")
        : path.join(__dirname, "..", "standalone");
}
// 패키징 상태에 따라 경로 자동 결정
// 개발: __dirname/../standalone
// 패키징: resources/standalone (exe 내부)
1-4. OS별 공유 라이선스 디렉토리 (P-16)
Copyfunction getSharedDataDir() {
    if (process.platform === "win32") {
        const pd = process.env.PROGRAMDATA || "C:\\ProgramData";
        return path.join(pd, "PTZController", "data");
    } else if (process.platform === "darwin") {
        return path.join("/Library", "Application Support", "PTZController", "data");
    } else {
        return path.join(process.env.HOME || "/etc", ".config", "PTZController", "data");
    }
}
목적:

1인용 데스크톱 앱이므로 사용자별 데이터 분리 불필요
OS 공용 경로 사용 → 동일 PC에서 다른 Windows 계정 로그인 시에도 데이터 공유
Windows: C:\ProgramData\PTZController\data\ (관리자/일반사용자 모두 접근 가능)
macOS: /Library/Application Support/PTZController/data/
Linux: ~/.config/PTZController/data/
1-5. 설정 파일 관리 (P-21, P-31)
Copyconst DEFAULT_SETTINGS = {
    defaultProtocol: "pelcod",
    defaultOperationMode: "direct",
    proxyPort: 9902,
    logLevel: "info",
    theme: "dark",
    // UI 토글 설정 (P-31 추가)
    startToTray: false,
    tokenAuth: false,
    webAppUrl: "",
};

function loadSettings() {
    const settingsPath = getSettingsPath(); // standalone/data/settings.json
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
Copy
특징:

설정을 JSON 파일로 영구 저장
새로운 설정 키 추가 시 DEFAULT_SETTINGS에 반드시 포함
IPC save-settings 호출로 동적 업데이트 가능
1-6. .env 파싱 (P-14)
Copyfunction parseEnv(filePath) {
    const vars = {};
    if (!fs.existsSync(filePath)) return vars;
    fs.readFileSync(filePath, "utf8")
        .split("\n")
        .forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return; // 빈 줄 및 주석 제외
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx < 1) return;
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            // 따옴표 제거
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            } else {
                // P-14 수정: 인라인 주석 제거
                val = val.replace(/\s+#.*$/, "").trim();
            }
            vars[key] = val;
        });
    return vars;
}
개선사항:

기본 dotenv 구문 지원
인라인 주석 처리 (P-14):
PORT=3000 # default port → vars.PORT = "3000"
KEY="value # not a comment" → 따옴표 내부는 주석 아님
1-7. Prisma 엔진 탐색
Copyfunction findPrismaEngine(standalonePath) {
    const clientDir = path.join(
        standalonePath,
        "node_modules",
        ".prisma",
        "client",
    );
    if (!fs.existsSync(clientDir)) return "";
    const arch = process.arch; // arm64, x64 등
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
목적:

Prisma의 네이티브 바이너리 자동 탐색
플랫폼/아키텍처별로 올바른 엔진 파일 선택
못 찾으면 빈 문자열 반환 (시스템 환경변수에 의존)
1-8. Next.js 서버 시작 (P-25, P-29)
Copyasync function startNextServer() {
    const standalonePath = getStandalonePath();
    const serverJs = path.join(standalonePath, "server.js");

    if (!fs.existsSync(serverJs)) {
        showFatalError(
            `server.js 를 찾을 수 없습니다.\n${serverJs}\n\n` +
            `npm run copy:standalone 을 먼저 실행하세요.`,
        );
        return false;
    }

    const nodeExe = getNodeExecutable();
    const envVars = parseEnv(path.join(standalonePath, ".env"));
    const enginePath = findPrismaEngine(standalonePath);
    const dataDir = getSharedDataDir();

    // P-20 수정: localhost 바인딩 (보안상 외부 접근 차단)
    // PTZ_HOSTNAME 환경변수로 오버라이드 가능 (VM/WSL 환경)
    const serverHostname = envVars.PTZ_HOSTNAME || process.env.PTZ_HOSTNAME || "localhost";

    const serverEnv = {
        ...process.env,
        ...envVars,
        PORT: String(PORT),
        HOSTNAME: serverHostname,
        NODE_ENV: "production",
        NEXTAUTH_URL: envVars.NEXTAUTH_URL || `http://${serverHostname}:${PORT}`,
        // P-16 수정: 공유 데이터 경로
        PTZ_DATA_DIR: dataDir,
        // P-15 수정: 1인용 앱 — userId 무시
        PTZ_FORCE_SHARED: "true",
        ...(enginePath ? { PRISMA_QUERY_ENGINE_LIBRARY: enginePath } : {}),
    };

    console.log("[Desktop] node      :", nodeExe);
    console.log("[Desktop] server.js :", serverJs);
    console.log("[Desktop] data dir  :", dataDir);
    console.log("[Desktop] NEXTAUTH_URL:", serverEnv.NEXTAUTH_URL);
    console.log("[Desktop] DATABASE_URL:", serverEnv.DATABASE_URL
        ? serverEnv.DATABASE_URL.replace(/:([^:@]+)@/, ":***@") : "❌ NOT SET");

    // P-28 수정: LICENSE_SERVER_URL 경고
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
            "[Desktop]    설정하지 않으면 오프라인 모드로 동작합니다.",
        );
    }

    return new Promise((resolve) => {
        nextProcess = cp.spawn(nodeExe, [serverJs], {
            cwd: standalonePath,
            env: serverEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });

        nextProcess.stdout.on("data", (d) => process.stdout.write("[Next] " + d));
        nextProcess.stderr.on("data", (d) => process.stderr.write("[Next] " + d));

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

        // P-32 수정: 서버 종료 시 렌더러에 상태 전파
        nextProcess.on("exit", (code, signal) => {
            if (appQuitting) return;
            if (code !== 0 && signal !== "SIGTERM") {
                console.error(`[Desktop] server exited: code=${code} signal=${signal}`);
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

        // P-29 수정: hostname 을 반환하여 waitForServer() 에 전달
        process.nextTick(() => {
            if (nextProcess) resolve({ ok: true, hostname: serverHostname });
        });
    });
}
Copy
주요 특징:

async 함수로 Promise 반환 (에러 감지 용이)
cp.spawn 으로 자식 프로세스 생성
stdout/stderr를 메인 프로세스로 포워드
Prisma 엔진 경로 자동 설정
PTZ_FORCE_SHARED, PTZ_DATA_DIR 환경변수 자동 주입
1-9. 서버 준비 대기 (P-11, P-29)
Copyfunction waitForServer(hostname, retries = 120, interval = 500) {
    // 0.0.0.0 / :: 바인딩이면 localhost 로 폴링
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
개선사항:

P-11: 타임아웃을 20초 → 60초로 증가
P-29: hostname 파라미터 추가로 PTZ_HOSTNAME과 일관성 유지
0.0.0.0 바인딩 시 자동으로 localhost로 폴링
1-10. 윈도우 생성
Copyfunction createWindow() {
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
        // P-32 수정: 페이지 로드 완료 시 서버 상태 전달
        mainWindow.webContents.send("server-status", {
            ready: serverReady,
            port: PORT,
        });
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(`http://localhost:${PORT}`))
            shell.openExternal(url); // 외부 링크는 기본 브라우저로 열기
        return { action: "deny" };
    });

    mainWindow.on("close", (e) => {
        if (!appQuitting) {
            e.preventDefault();
            mainWindow.hide(); // 트레이 앱이므로 숨기기만 함
        }
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    if (DEV_MODE) mainWindow.webContents.openDevTools({ mode: "detach" });
}
Copy
특징:

보안: nodeIntegration: false, contextIsolation: true
아이콘: OS별로 자동 선택 (없으면 생략)
preload.js 로드로 안전한 IPC 제공
윈도우 닫기 → 숨기기 (트레이 앱 특성)
1-11. 프로세스 종료 (P-06, P-07)
Copyfunction killNextProcess() {
    if (!nextProcess) return;
    const proc = nextProcess;
    nextProcess = null; // 중복 호출 방지

    try {
        if (process.platform === "win32") {
            // Windows: taskkill 로 자식 프로세스 트리 강제 종료
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
개선사항:

P-06: Windows에서 SIGTERM 미지원 → taskkill 사용
taskkill /T: 자식 프로세스까지 함께 종료
taskkill /F: 강제 종료
macOS/Linux: SIGTERM으로 graceful shutdown 유도
1-12. 앱 시작 및 종료 (P-07)
Copyapp.whenReady().then(async () => {
    createTray();

    const started = await startNextServer();
    if (!started) return;

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

// P-10 수정: macOS Dock 클릭 시 창 복원
app.on("activate", () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    } else if (serverReady) {
        createWindow();
    }
});

app.on("second-instance", () => showWindow());

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 앱이므로 앱 유지

// P-07 수정: 종료 로직을 before-quit 한 곳으로 통합
app.on("before-quit", () => {
    appQuitting = true;
    killNextProcess(); // ← 여기서만 종료 처리
});

app.on("will-quit", () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

// P-13 수정: 처리되지 않은 예외 발생 시 알림
process.on("uncaughtException", (err) => {
    console.error("[Desktop] uncaughtException:", err);
    try {
        dialog.showErrorBox("PTZ Controller — 오류", 
            `예기치 않은 오류가 발생했습니다.\n\n${err.message}`);
    } catch {}
    quitApp();
});
Copy
시퀀스:

app.quit() 호출
before-quit 이벤트 → killNextProcess() 실행
자식 프로세스 종료 완료
will-quit 이벤트 → tray 정리
앱 종료
1-13. IPC 핸들러 (P-03, P-21)
CopyipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

// P-19 수정: hide-window(트레이)와 close-window(숨기기) 분리
ipcMain.on("hide-window",  () => mainWindow?.hide());
ipcMain.on("close-window", () => mainWindow?.hide());

// P-03 수정: 누락된 PTZ Proxy 서버 제어 IPC 추가
ipcMain.on("start-server", (_, port) => {
    console.log(`[IPC] start-server 요청: port=${port}`);
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
    console.log("[IPC] stop-server 요청");
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

// P-21 수정: proxyPort를 settings.json에 저장
ipcMain.on("change-port", (_, port) => {
    console.log(`[IPC] change-port 요청: port=${port}`);
    const updated = saveSettings({ proxyPort: port });
    if (updated && mainWindow) {
        mainWindow.webContents.send("settings-changed", updated);
    }
});

ipcMain.on("save-settings", (_, settings) => {
    console.log("[IPC] save-settings:", settings);
    const updated = saveSettings(settings);
    if (updated && mainWindow) {
        mainWindow.webContents.send("settings-changed", updated);
    }
});

ipcMain.on("request-status", () => {
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
Copy
2. electron/preload.js — 보안 브릿지
Copyconst { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    // ── 앱 정보
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // ── 윈도우 제어
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    hideWindow:     () => ipcRenderer.send('hide-window'),     // 트레이 숨기기
    closeWindow:    () => ipcRenderer.send('close-window'),    // 기존 호환 (hide)

    // ── 플랫폼 정보
    platform: process.platform,
    isDev: process.env.NODE_ENV === 'development',

    // ── PTZ Proxy 서버 제어
    startServer:    (port) => ipcRenderer.send('start-server', port),
    stopServer:     ()     => ipcRenderer.send('stop-server'),
    changePort:     (port) => ipcRenderer.send('change-port', port),
    requestStatus:  ()     => ipcRenderer.send('request-status'),
    saveSettings:   (s)    => ipcRenderer.send('save-settings', s),

    // ── 이벤트 수신 (cleanup 함수 반환)
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
    // P-32: Next.js 서버 상태용
    onServerStatus: (callback) => {
        ipcRenderer.on('server-status', callback);
        return () => ipcRenderer.removeListener('server-status', callback);
    },
});

console.log('[Preload] loaded');
Copy
특징:

contextBridge로 안전하게 API 노출
모든 IPC 채널을 명시적으로 정의
cleanup 함수 반환으로 메모리 누수 방지
3. forge.config.js — 빌드 설정
Copyconst fs   = require('fs');
const path = require('path');

// ── P-08: node-bin 조건부 포함 ────────────
const nodeBinPath = path.resolve(__dirname, 'node-bin');
const hasNodeBin  = fs.existsSync(nodeBinPath);

if (hasNodeBin) {
  console.log('[forge] node-bin 폴더 감지 → extraResource 에 포함');
} else {
  console.warn(
    '[forge] ⚠️  node-bin 폴더 없음 — 번들 없이 빌드합니다.\n' +
    '         배포 대상 PC 에 Node.js 가 설치돼 있어야 합니다.\n' +
    '         번들 Node.js 포함 시: node scripts/bundle-node.js',
  );
}

// ── P-30: macOS icon.icns 조건부 처리 ───
const icnsPath = path.resolve(__dirname, 'assets', 'icon.icns');
const hasIcns  = fs.existsSync(icnsPath);

if (!hasIcns) {
  console.warn(
    '[forge] ⚠️  assets/icon.icns 없음 — macOS DMG 아이콘이 기본값으로 설정됩니다.\n' +
    '         공식 macOS 배포 시 iconutil 로 icon.icns 를 생성하세요.',
  );
}

const extraResources = ['./standalone'];
if (hasNodeBin) extraResources.push('./node-bin');

module.exports = {
  packagerConfig: {
    // asar 설정: native 모듈이 asar 밖으로 나감
    asar: {
      unpackDir: '{node_modules/.prisma,node_modules/@prisma,node_modules/bufferutil,node_modules/utf-8-validate}',
    },

    name:           'PTZ Controller',
    executableName: 'ptz-controller',
    icon:           './assets/icon',
    appBundleId:    'com.ptzcontroller.app',
    appCopyright:   'Copyright © 2024 TYCHE. All rights reserved.',

    win32metadata: {
      CompanyName:     'TYCHE',
      ProductName:     'PTZ Controller',
      FileDescription: 'PTZ Camera Controller Application',
    },

    // extraResource에 standalone / node-bin(조건부) 포함
    extraResource: extraResources,

    ignore: [
      /^\/\.git/,
      /node_modules\/\.cache/,
      /^\/standalone/,  // extraResource로 처리
      /^\/node-bin/,    // extraResource로 처리
    ],
  },

  rebuildConfig: {},

  makers: [
    // Windows: Squirrel 설치 패키지
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name:      'PTZController',
        setupIcon: './assets/icon.ico',
      },
    },
    // 모든 플랫폼: ZIP
    {
      name:      '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    // macOS: DMG (P-26, P-30 수정)
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name:   'PTZ Controller',
        ...(hasIcns ? { icon: './assets/icon.icns' } : {}),
        format: 'ULFO',
      },
      platforms: ['darwin'],
    },
    // Linux: Debian
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          maintainer: 'Tyche PTZ Controller Team',
          homepage:   'https://www.tyche.pro/',
        },
      },
    },
    // Linux: RPM
    {
      name:   '@electron-forge/maker-rpm',
      config: {},
    },
  ],

  plugins: [
    {
      name:   '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
Copy
주요 포인트:

P-08: node-bin 없으면 빌드 경고만 출력
P-30: icon.icns 없으면 icon 필드 제거 (빌드 실패 방지)
extraResource: standalone과 node-bin(조건부)을 exe에 포함
asar.unpackDir: Prisma 네이티브 모듈을 asar 밖으로
4. scripts/copy-standalone.js — Next.js 번들 복사
Copy/**
 * copy-standalone.js
 * 
 * 역할:
 *   [1] .next/standalone → standalone/ (Next.js 서버 번들)
 *   [2] .next/static → standalone/.next/static (정적 자산)
 *   [3] public → standalone/public (공개 파일)
 *   [4] data → standalone/data (사용자 설정, 보존)
 *   [5] .env → standalone/.env (환경변수)
 *   [6] Prisma 엔진 파일 복사
 *   [7] server.js 패치 (outputFileTracingRoot 수정, P-09)
 */

// ── P-18: data 폴더 원자적 교체 ──────────────────────────
let dataTmpBackup = null;
const existingDataDir = path.join(destDir, 'data');

if (fs.existsSync(existingDataDir)) {
  // 임시 디렉토리에 백업 (os.tmpdir 사용)
  dataTmpBackup = path.join(os.tmpdir(), `ptz-data-backup-${Date.now()}`);
  try {
    fs.renameSync(existingDataDir, dataTmpBackup);
    console.log(`[INFO] data 폴더 임시 백업: ${dataTmpBackup}`);
  } catch (e) {
    // rename 실패(cross-device) → 복사 방식으로 대체
    copyDir(existingDataDir, dataTmpBackup);
  }
}

// 기존 standalone 전체 삭제
if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true });
}

// ... 복사 작업 ...

// data 폴더 복원 (기존 설정 보호)
if (dataTmpBackup && fs.existsSync(dataTmpBackup)) {
  try {
    fs.renameSync(dataTmpBackup, dataDest);
  } catch (e) {
    copyDir(dataTmpBackup, dataDest);
    fs.rmSync(dataTmpBackup, { recursive: true });
  }
  
  // 소스에만 있는 신규 파일 병합
  if (fs.existsSync(dataSrc)) {
    for (const entry of fs.readdirSync(dataSrc, { withFileTypes: true })) {
      const s = path.join(dataSrc, entry.name);
      const d = path.join(dataDest, entry.name);
      if (!fs.existsSync(d)) {
        entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
      }
    }
  }
}

// ── P-17: NEXTAUTH_URL 동적 결정 ────────────────────────
let port = 3000;
const portMatch = envContent.match(/^PORT\s*=\s*["']?(\d+)["']?/m);
if (portMatch) {
  port = parseInt(portMatch[1], 10);
}

const correctNextAuthUrl = `http://localhost:${port}`;
envContent = envContent.replace(
  /^NEXTAUTH_URL=.*$/m,
  `NEXTAUTH_URL="${correctNextAuthUrl}"`,
);

// ── P-09: server.js outputFileTracingRoot 패치 ─────────
// 하드코딩된 Windows 경로 제거 + __dirname으로 런타임 대체
if (serverContent.includes('outputFileTracingRoot')) {
  serverContent = serverContent.replace(
    /"outputFileTracingRoot"\s*:\s*"(?:[^"\\]|\\.)*"/g,
    '"outputFileTracingRoot":""',
  );
  
  // __dirname으로 덮어쓰기 코드 삽입
  const patchCode = `
try {
  const _cfg = JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG || "{}");
  if (_cfg.experimental) _cfg.experimental.outputFileTracingRoot = __dirname;
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(_cfg);
} catch(_e) {}`;
  
  serverContent = serverContent.replace(
    'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)',
    'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)' + patchCode
  );
}
Copy
특징:

P-18: data 폴더를 임시 백업 후 복원 → 중단 시 데이터 손실 방지
P-17: .env의 PORT를 읽어 NEXTAUTH_URL 자동 조정
P-09: server.js의 하드코딩된 경로를 __dirname으로 교체
Prisma 엔진 파일 강제 복사 (누락 방지)
5. index.html — PTZ Proxy UI (현재 사용 중)
Copy<!-- 
  index.html 은 ptzcontroller_desktop 내 PTZ Proxy 관리 UI.
  Electron 창에서 next.js 웹앱 대신 이 HTML을 로드할 수도 있음.
  (현재 구조: loadURL("http://localhost:3000") → 웹앱 로드)
  
  기능:
  - 서버 시작/중지 토글
  - 포트 설정 (기본 9902)
  - 클라이언트/연결 통계
  - 실시간 로그
  - 토글 설정 (시작 시 트레이, 토큰 인증)
-->

<style>
  :root {
    --bg: #0f0f13;
    --surface: #16161d;
    --accent: #00e5a0;
    --red: #ff4d6a;
    --text: #e8e8f0;
    --text-muted: #6b6b85;
  }
  
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 42px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    -webkit-app-region: drag;  /* macOS 드래그 영역 */
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .status-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 16px;
  }

  .status-card.running {
    border-color: var(--accent);
    box-shadow: 0 0 30px rgba(0, 229, 160, 0.08);
  }

  .btn {
    background: var(--accent);
    color: #000;
    border: none;
    padding: 10px 18px;
    border-radius: 10px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:hover {
    background: #00ffc0;
  }

  .toggle {
    position: relative;
    width: 44px;
    height: 24px;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    position: absolute;
    inset: 0;
    background: var(--border);
    border-radius: 24px;
    cursor: pointer;
    transition: background 0.25s;
  }

  .toggle-track::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: transform 0.25s;
  }

  .toggle input:checked + .toggle-track {
    background: var(--accent);
  }

  .toggle input:checked + .toggle-track::after {
    transform: translateX(20px);
    background: #000;
  }

  .log-entry {
    font-size: 11px;
    line-height: 1.5;
    padding: 2px 6px;
    border-radius: 5px;
    animation: fadeIn 0.2s ease;
  }

  .log-entry.error {
    color: var(--red);
  }

  .log-entry.connect {
    color: var(--accent);
  }
</style>

<body>

<div class="titlebar">
  <span class="titlebar-title">PTZ PROXY</span>
  <button class="titlebar-btn" onclick="hideToTray()">✕</button>
</div>

<div class="content">
  <!-- 상태 카드 -->
  <div class="status-card" id="statusCard">
    <div class="status-header">
      <span class="status-label">SERVER STATUS</span>
      <div class="status-badge" id="statusBadge">
        <span id="statusText">중지됨</span>
      </div>
    </div>
    <div class="status-url" id="statusUrl">
      ws://0.0.0.0:<span class="port" id="portDisplay">9902</span>
    </div>
    <div class="status-stats">
      <div>클라이언트: <span id="clientCount">0</span></div>
      <div>카메라 연결: <span id="connCount">0</span></div>
    </div>
  </div>

  <!-- 제어 버튼 -->
  <button class="btn" id="btnStart" onclick="startServer()">▶ 서버 시작</button>
  <button class="btn" id="btnStop" onclick="stopServer()" style="display:none;">■ 서버 중지</button>

  <!-- 설정 토글 -->
  <div class="settings-row">
    <span>시작 시 트레이로 실행</span>
    <label class="toggle">
      <input type="checkbox" id="toggleStartToTray" onchange="onToggleStartToTray(this.checked)">
      <span class="toggle-track"></span>
    </label>
  </div>

  <!-- 로그 -->
  <div class="log-container">
    <div class="log-body" id="logBody">
      <div class="log-empty">로그가 없습니다</div>
    </div>
  </div>
</div>

<script>
const api = window.electronAPI;

// 상태 업데이트
function updateUI(status) {
  document.getElementById('portDisplay').textContent = status.port;
  document.getElementById('clientCount').textContent = status.clients;
  document.getElementById('connCount').textContent = status.connections;
  
  if (status.running) {
    document.getElementById('statusCard').classList.add('running');
    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display = 'flex';
  } else {
    document.getElementById('statusCard').classList.remove('running');
    document.getElementById('btnStart').style.display = 'flex';
    document.getElementById('btnStop').style.display = 'none';
  }
}

// 서버 제어
function startServer() {
  const port = parseInt(document.getElementById('portInput').value) || 9902;
  api.startServer(port);
}

function stopServer() {
  api.stopServer();
}

function hideToTray() {
  api.hideWindow();
}

// 설정 토글
function onToggleStartToTray(checked) {
  api.saveSettings({ startToTray: checked });
}

// IPC 리스너
api.onStatus((_, status) => updateUI(status));
api.requestStatus();
</script>

</body>
</html>
Copy
📊 실행 환경 및 의존성
런타임 의존성 (package.json)
Copy{
  "dependencies": {
    "electron-squirrel-startup": "^1.0.0"  // Windows Squirrel 설치 처리
  },
  "devDependencies": {
    "@electron-forge/cli": "^7.2.0",
    "@electron-forge/maker-squirrel": "^7.2.0",  // Windows exe
    "@electron-forge/maker-dmg": "^7.2.0",       // macOS dmg
    "@electron-forge/maker-deb": "^7.2.0",       // Linux deb
    "@electron-forge/maker-rpm": "^7.2.0",       // Linux rpm
    "@electron-forge/maker-zip": "^7.2.0",       // 포터블 zip
    "electron": "^40.6.1",
    "ws": "^8.19.0"  // WebSocket (현재 미사용, PTZ Proxy 재활성화 시 필요)
  }
}
Next.js 의존성 (ptzcontroller_admin 기준)
- Next.js 14+
- Prisma (PostgreSQL ORM)
- NextAuth (인증)
- React 18+
- TypeScript
- PostgreSQL (또는 Neon, Supabase)
🚀 빌드 및 배포 가이드
Step 1: Next.js 빌드
Copycd ../ptzcontroller_admin
yarn install
yarn build  # .next/standalone 생성
Step 2: standalone 복사
Copycd ../ptzcontroller_desktop
npm install
npm run copy:standalone  # standalone/ 폴더 생성
결과:

standalone/
├── server.js         ← Next.js 엔트리포인트
├── .env             ← 환경변수 (copy:standalone에서 복사)
├── .next/static/    ← 정적 자산
├── public/          ← 공개 파일
├── node_modules/    ← Next.js 의존성 (최소화)
│   ├── .prisma/client/
│   └── @prisma/client/
└── data/            ← 사용자 설정 (보존)
Step 3: (선택) Node.js 포터블 번들
배포 환경에 Node.js가 없는 경우:

Copynode scripts/bundle-node.js  # node-bin/ 생성
결과:

node-bin/
├── node.exe  (Windows)
├── node      (macOS/Linux)
└── ...
Step 4: Electron 빌드
Copy# Windows
npm run make:win
# 결과: out/make/squirrel.windows/x64/PTZControllerSetup.exe

# macOS
npm run make:mac
# 결과: out/make/dmg/PTZ Controller-1.0.0-darwin-arm64.dmg

# Linux
npm run make:linux
# 결과: out/make/deb/.../ptzcontroller_1.0.0_amd64.deb
⚙️ 환경변수 상세 설명
필수 환경변수 (.env)
변수	값 예시	설명
DATABASE_URL	postgresql://user:pass@host/dbname	PostgreSQL 연결 (NeonDB, Supabase)
NEXTAUTH_SECRET	(32자 이상 랜덤)	JWT 서명 키 (openssl rand -base64 32)
권장 환경변수
변수	값 예시	설명
NEXTAUTH_URL	http://localhost:3000	자동 설정됨 (copy:standalone에서)
PORT	3000	Next.js 서버 포트 (자동 인식, 변경 불필요)
NODE_ENV	production	자동 설정됨 (배포 빌드)
라이선스 관련
변수	값 예시	설명
LICENSE_SECRET	(32자 이상 랜덤)	오프라인 라이선스 서명
LICENSE_SERVER_URL	https://license.example.com	온라인 라이선스 발급 서버
Electron 독자 환경변수
변수	값	설명
PTZ_DATA_DIR	(자동 설정)	공유 라이선스/설정 디렉토리
PTZ_FORCE_SHARED	"true"	1인용 앱 — userId 무시
PTZ_HOSTNAME	localhost (기본)	서버 바인딩 주소 (VM 환경에서 변경 가능)
PRISMA_QUERY_ENGINE_LIBRARY	(자동 탐색)	Prisma 네이티브 엔진 경로
🔧 문제 해결
"server.js not found"
원인: npm run copy:standalone 미실행 또는 Next.js 빌드 실패
해결:

Copycd ../ptzcontroller_admin && yarn build
cd ../ptzcontroller_desktop && npm run copy:standalone
"node not found" (패키징 후)
원인: exe 환경에 Node.js 미포함
해결 A (권장):

Copynode scripts/bundle-node.js
npm run make:win
해결 B: 배포 가이드에 Node.js 설치 필수 명시

DATABASE_URL 연결 오류
원인: .env 파일이 standalone에 복사되지 않음
해결:

Copynpm run copy:standalone  # .env도 자동 복사
Prisma "engine not found"
원인: Prisma 네이티브 바이너리 누락
해결:

Copycd ../ptzcontroller_admin
npx prisma generate  # 엔진 생성
yarn build
cd ../ptzcontroller_desktop && npm run copy:standalone
Squirrel 빌드 실패
원인: forge.config.js에 유효하지 않은 설정
해결: iconUrl 제거, 올바른 setupIcon 경로 확인

📝 주요 수정 이력 (P-01 ~ P-32)
ID	심각도	문제	수정 방법
P-01	🔴	Git에 민감정보 노출	.gitignore에 .env 추가
P-02	🔴	require('electron') 미동작	preload.js / contextBridge 사용
P-03	🔴	IPC 핸들러 6개 누락	main.js에 핸들러 추가
P-04	🔴	Squirrel 설치 미처리	main.js 최상단에 처리 코드 추가
P-05	🔴	server-status 이벤트 미발송	did-finish-load / exit 이벤트에서 발송
P-06	🟠	Windows SIGTERM 미지원	taskkill /T /F 사용
P-07	🟠	종료 로직 중복	before-quit에 통합
P-08	🟠	node-bin 없으면 빌드 실패	forge.config.js에 조건부 처리
P-09	🟠	server.js 하드코딩 경로	copy-standalone.js에서 __dirname으로 교체
P-10	🟠	macOS activate 핸들러 누락	app.on("activate") 추가
P-11	🟠	타임아웃 20초 부족	60초로 증가 (retries=120)
P-12	🟠	서버 비정상 종료 알림 없음	dialog.showErrorBox() 추가
P-13	🟠	uncaughtException 미처리	process.on("uncaughtException") 추가
P-14	🟡	인라인 주석 미처리	parseEnv에서 # 이후 제거
P-15	🟡	PTZ_FORCE_SHARED 미전달	serverEnv에 추가
P-16	🟡	공유 데이터 경로 잘못됨	getSharedDataDir() 구현
P-17	🟡	NEXTAUTH_URL 포트 고정	copy-standalone에서 .env 기준 결정
P-18	🟡	data 폴더 손실 위험	임시 백업 및 복원 메커니즘
P-19	🟡	closeWindow 동작 혼동	명세 명확화 (hide)
P-20	🟡	localhost 하드코딩	HOSTNAME 환경변수 지원
P-21	🟡	proxyPort 미사용	IPC 저장 및 로드 구현
P-22	🔵	백업 파일 Git 추적	.gitignore 추가
P-23	🔵	버전 하드코딩	getAppVersion() 동적 로드
P-24	🔵	ws 미사용 의존성	devDependencies 이동 고려
P-25	🔵	startNextServer 에러 처리 미흡	async/Promise 전환
P-26	🔵	macOS DMG 패키저 없음	maker-dmg 추가
P-27	🔵	크로스 컴파일 미지원	플랫폼 타겟 인자 추가 고려
P-28	🔵	LICENSE_SERVER_URL localhost	배포 환경에서 수정
P-29	🟠	waitForServer localhost 하드코딩	hostname 파라미터 추가
P-30	🟠	icon.icns 없으면 빌드 실패	forge.config.js 조건부 처리
P-31	🟡	DEFAULT_SETTINGS 누락	startToTray, tokenAuth, webAppUrl 추가
P-32	🟡	server-status 발송 미구현	did-finish-load / exit에서 발송
🎯 최종 정리
ptzcontroller_desktop은:

Next.js 웹앱을 Electron 데스크톱 애플리케이션으로 패키징

1인용 데스크톱 앱 → 공유 라이선스/설정 디렉토리 사용
트레이 아이콘 지원 → 최소화 시 트레이로 숨김
강력한 보안 및 프로세스 관리

contextIsolation + preload.js로 렌더러 보안 보장
자식 프로세스(Next.js 서버) 안전 종료
비정상 종료 시 사용자 알림
크로스 플랫폼 지원

Windows: Squirrel 설치 패키지 + Portable ZIP
macOS: DMG 설치 패키지
Linux: Debian/RPM 패키지
의존성 유연성

Node.js 번들 가능 (배포 대상이 Node.js 미설치 환경)
Prisma 엔진 자동 탐색
환경변수 기반 구성
최종 목표: 웹앱 개발자가 복잡한 Electron 설정 없이 npm run make:win 한 줄로 exe를 생성할 수 있는 프레임워크 제공.

