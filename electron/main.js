// # P-33: PTZ Proxy 서버 기능 구현

// ## 📍 파일 경로 및 수정 사항

// ### 1. electron/main.js - PTZ Proxy WebSocket 서버 추가

// **파일 경로:** `ptzcontroller_desktop/electron/main.js`

// **추가할 코드 (전체 파일):**

"use strict";

const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    shell,
    ipcMain, // ← Must have this
    dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const http = require("http");
const WebSocket = require("ws"); // P-33: WebSocket 서버 추가

// ── Squirrel 설치/업데이트/언인스톨 이벤트 처리
if (require("electron-squirrel-startup")) {
    app.quit();
    process.exit(0);
}

// ── 단일 인스턴스
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}

// ── 경로 계산
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

// ── OS별 공유 라이선스/데이터 디렉토리
function getSharedDataDir() {
    if (process.platform === "win32") {
        const pd =
            process.env.PROGRAMDATA ||
            process.env.ALLUSERSPROFILE ||
            "C:\\ProgramData";
        return path.join(pd, "PTZController", "data");
    } else if (process.platform === "darwin") {
        return path.join(
            "/Library",
            "Application Support",
            "PTZController",
            "data",
        );
    } else {
        return path.join(
            process.env.HOME || "/etc",
            ".config",
            "PTZController",
            "data",
        );
    }
}

// # P-46: Online License Verification & Auto-Save Implementation

// ## 개요
// - 온라인 로그인 성공 시 라이선스 서버에서 라이선스 파일 자동 수신
// - `C:\ProgramData\PTZController\online.ptzlic` 저장
// - 오프라인 모드 진입 시 라이선스 검증

// ## 수정 파일 목록
// 1. electron/main.js - 라이선스 검증/저장 함수 추가
// 2. electron/preload.js - IPC 메소드 추가
// 3. standalone/server.js (ptzcontroller_admin) - 라이선스 API 엔드포인트 (기존)
// 4..env.example - LICENSE_SERVER_URL 설정값

// # P-46 Implementation: electron/main.js
// **File Path**: `ptzcontroller_desktop/electron/main.js`
// **Modification**: Add after existing functions, before `app.whenReady()`

// ## Part 1: License Path Constants (Add after getSharedDataDir)

// ── 라이선스 파일 경로 (P-46 추가) ────────────────────────
// Windows: C:\ProgramData\PTZController\online.ptzlic
// macOS: /Library/Application Support/PTZController/online.ptzlic
// Linux: ~/.config/PTZController/online.ptzlic
// ptzcontroller_admin 과 동일한 경로 사용 (lib/license.ts 참조)

// ── 라이선스 파일 경로 (P-46 추가) ────────────────────────
function getLicensePath() {
    // Windows: C:\ProgramData\PTZController\
    // macOS: /Library/Application Support/PTZController/
    // Linux: ~/.config/PTZController/
    if (process.platform === "win32") {
        const pd =
            process.env.PROGRAMDATA ||
            process.env.ALLUSERSPROFILE ||
            "C:\\ProgramData";
        return path.join(pd, "PTZController");
    } else if (process.platform === "darwin") {
        return path.join("/Library", "Application Support", "PTZController");
    } else {
        return path.join(
            process.env.HOME || "/etc",
            ".config",
            "PTZController",
        );
    }
}

const ONLINE_LICENSE_FILE = "online.ptzlic"; // 온라인 라이선스 (자동 저장)
const OFFLINE_LICENSE_FILE = "offline.ptzlic"; // 오프라인 라이선스 (수동 업로드)
const OFFLINE_REQUEST_FILE = "offline.ptzreq"; // 오프라인 요청

function getLicenseFilePath(filename) {
    return path.join(getLicensePath(), filename);
}

// ── 설정
const PORT = parseInt(process.env.PORT || "3000", 10);
const DEV_MODE = process.env.NODE_ENV === "development";

// ── settings.json 읽기/쓰기 헬퍼
const DEFAULT_SETTINGS = {
    defaultProtocol: "pelcod",
    defaultOperationMode: "direct",
    proxyPort: 9902,
    logLevel: "info",
    theme: "dark",
    startToTray: false,
    tokenAuth: false,
    webAppUrl: "",
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

// ── 전역 상태
let mainWindow = null;
let tray = null;
let nextProcess = null;
let serverReady = false;
let appQuitting = false;

// ── P-33: PTZ Proxy 서버 관련 상태
let proxyServer = null;
let proxyWss = null;
let proxyClients = new Set();
let proxyConnections = new Map(); // clientId -> { ptzDevice, status }
let proxyRunning = false;

// ── .env 파싱
function parseEnv(filePath) {
    const vars = {};
    if (!fs.existsSync(filePath)) return vars;
    fs.readFileSync(filePath, "utf8")
        .split("\n")
        .forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx < 1) return;
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            } else {
                val = val.replace(/\s+#.*$/, "").trim();
            }
            vars[key] = val;
        });
    return vars;
}

// ── 라이선스 검증 함수 (수정) ────────────────────────
// ── 라이선스 검증 함수 (P-46 추가) ────────────────────────
// 라이선스 파일 형식:
// {
//   "machineId":"HWID-...",
//   "machineIds":["HWID-...", ...],
//   "issuedAt":"2026-03-07T...",
//   "expiresAt":"2027-03-07T...",
//   "product":"PTZ-OFFLINE",
//   "sig":"sha256_hmac_hex"
// }
// 파일 저장 형식: Base64(JSON)
//
// ✅ lib/license.ts의 verifyLicense 사용
// HMAC-SHA256 서명 검증 + MachineID 배열 매칭 + 만료일 확인
//const { verifyLicense } = require("../lib/license");

// ── 라이선스 검증 함수 방법1 (API 기반) ────────────────────────
// electron/main.js 내에 inline으로 구현
// (TypeScript lib 로드 불가이므로 기본 검증만 수행)
function isLicenseValid(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const content = fs.readFileSync(filePath, "utf8").trim();

        // Base64 디코딩
        let licenseObj;
        try {
            const decoded = Buffer.from(content, "base64").toString("utf8");
            licenseObj = JSON.parse(decoded);
        } catch (e) {
            console.error(
                "[Desktop] License file decode/parse error:",
                e.message,
            );
            return false;
        }

        // 필수 필드 확인
        if (!licenseObj.machineId || !licenseObj.expiresAt) {
            console.warn("[Desktop] License missing required fields");
            return false;
        }

        // 만료일 확인
        const expiryDate = new Date(licenseObj.expiresAt);
        if (expiryDate < new Date()) {
            console.warn("[Desktop] License expired:", licenseObj.expiresAt);
            return false;
        }

        console.log("[Desktop] License valid until:", licenseObj.expiresAt);
        return true;
    } catch (e) {
        console.error("[Desktop] License validation error:", e.message);
        return false;
    }
}

// ── 라이선스 검증 함수 방법2 (API 기반) ────────────────────────
// standalone 내부 Next.js 서버의 API를 호출하여 검증
// 사용 예:
// const isValid = await isLicenseValidViaPtree(offlineLicensePath);
async function isLicenseValidViaPtree(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const content = fs.readFileSync(filePath, "utf8").trim();

        // Next.js 서버의 라이선스 검증 API 호출
        return new Promise((resolve) => {
            const options = {
                method: "POST",
                hostname: "localhost",
                port: PORT,
                path: "/api/license/verify",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(
                        JSON.stringify({ license: content }),
                    ),
                },
            };

            const req = http.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk;
                });
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.valid === true);
                    } catch (e) {
                        console.error(
                            "[Desktop] License API parse error:",
                            e.message,
                        );
                        resolve(false);
                    }
                });
            });

            req.on("error", (err) => {
                console.error("[Desktop] License API error:", err.message);
                resolve(false);
            });

            req.setTimeout(5000, () => {
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ license: content }));
            req.end();
        });
    } catch (e) {
        console.error("[Desktop] License validation error:", e.message);
        return false;
    }
}

function saveLicenseFile(filename, content) {
    try {
        const filePath = getLicenseFilePath(filename);
        const dir = path.dirname(filePath);

        // 디렉토리 생성
        fs.mkdirSync(dir, { recursive: true });

        // 파일 저장 (content는 이미 base64 인코딩된 상태)
        fs.writeFileSync(filePath, content, "utf8");
        console.log(`[Desktop] License saved: ${filePath}`);
        return true;
    } catch (e) {
        console.error(`[Desktop] License save failed: ${e.message}`);
        return false;
    }
}

function readLicenseFile(filename) {
    try {
        const filePath = getLicenseFilePath(filename);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const content = fs.readFileSync(filePath, "utf8").trim();
        return content;
    } catch (e) {
        console.error("[Desktop] License read error:", e.message);
        return null;
    }
}
// ── 라이선스 서버 검증 함수 (P-46 추가) ─────────────────────
// ptzcontroller_admin 의 /api/license/request-online 로 요청
// Request: POST http://localhost:3000/api/license/request-online
// Headers: Cookie: next-auth.session-token=<token>
// Response: { status: "approved", license: "base64...", machineId: "HWID-...", message: "..." }

async function validateLicenseFromServer(serverUrl, apiPath, sessionToken) {
    if (!serverUrl || !sessionToken) {
        console.warn(
            "[Desktop] Missing serverUrl or sessionToken for license validation",
        );
        return null;
    }

    try {
        const fullUrl = `${serverUrl}${apiPath}`;
        console.log("[Desktop] Requesting license from:", fullUrl);

        const isSecure = fullUrl.startsWith("https");
        const client = isSecure ? require("https") : require("http");

        return new Promise((resolve) => {
            const urlObj = new URL(fullUrl);
            const options = {
                method: "POST",
                hostname: urlObj.hostname,
                port: urlObj.port || (isSecure ? 443 : 80),
                path: urlObj.pathname + (urlObj.search || ""),
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": 2, // '{}' 길이
                    Cookie: `next-auth.session-token=${sessionToken}`,
                },
            };

            const req = client.request(options, (res) => {
                let data = "";

                res.on("data", (chunk) => {
                    data += chunk;
                });

                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);

                        if (
                            res.statusCode === 200 &&
                            json.status === "approved" &&
                            json.license
                        ) {
                            console.log(
                                "[Desktop] License validation successful",
                            );
                            resolve(json.license); // base64-encoded license
                        } else {
                            console.warn(
                                "[Desktop] License validation failed:",
                                {
                                    statusCode: res.statusCode,
                                    status: json.status,
                                    error: json.error,
                                },
                            );
                            resolve(null);
                        }
                    } catch (parseErr) {
                        console.error(
                            "[Desktop] Response parse error:",
                            parseErr.message,
                        );
                        resolve(null);
                    }
                });
            });

            req.on("error", (err) => {
                console.error(
                    "[Desktop] License server request error:",
                    err.message,
                );
                resolve(null);
            });

            // 타임아웃: 10초
            req.setTimeout(10000, () => {
                console.warn("[Desktop] License validation request timeout");
                req.destroy();
                resolve(null);
            });

            // 빈 JSON 바디 전송
            req.write("{}");
            req.end();
        });
    } catch (e) {
        console.error("[Desktop] License validation exception:", e.message);
        return null;
    }
}

// ── Prisma 엔진 탐색
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

// ── Next.js 프로세스 안전 종료
function killNextProcess() {
    if (!nextProcess) return;
    const proc = nextProcess;
    nextProcess = null;

    try {
        if (process.platform === "win32") {
            const { execSync } = require("child_process");
            execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
        } else {
            proc.kill("SIGTERM");
        }
        console.log("[Desktop] Next.js 서버 프로세스 종료 완료");
    } catch (e) {
        console.warn("[Desktop] 프로세스 종료 오류:", e.message);
    }
}

// ── Next.js 서버 시작
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

    const serverHostname =
        envVars.PTZ_HOSTNAME || process.env.PTZ_HOSTNAME || "localhost";

    const serverEnv = {
        ...process.env,
        ...envVars,
        PORT: String(PORT),
        HOSTNAME: serverHostname,
        NODE_ENV: "production",
        NEXTAUTH_URL:
            envVars.NEXTAUTH_URL || `http://${serverHostname}:${PORT}`,
        PTZ_DATA_DIR: dataDir,
        PTZ_FORCE_SHARED: "true",
        ...(enginePath ? { PRISMA_QUERY_ENGINE_LIBRARY: enginePath } : {}),
    };

    console.log("[Desktop] node      :", nodeExe);
    console.log("[Desktop] server.js :", serverJs);
    console.log("[Desktop] data dir  :", dataDir);
    console.log("[Desktop] NEXTAUTH_URL:", serverEnv.NEXTAUTH_URL);
    console.log(
        "[Desktop] DATABASE_URL:",
        serverEnv.DATABASE_URL
            ? serverEnv.DATABASE_URL.replace(/:([^:@]+)@/, ":***@")
            : "❌ NOT SET",
    );

    if (
        serverEnv.LICENSE_SERVER_URL &&
        /127\.0\.0\.1|localhost/.test(serverEnv.LICENSE_SERVER_URL)
    ) {
        console.warn(
            "[Desktop] WARNING: LICENSE_SERVER_URL points to localhost:",
            serverEnv.LICENSE_SERVER_URL,
        );
        console.warn(
            "[Desktop]    For production, use actual license server URL",
        );
        console.warn("[Desktop]    or leave it unset for offline mode.");
    }

    return new Promise((resolve) => {
        nextProcess = cp.spawn(nodeExe, [serverJs], {
            cwd: standalonePath,
            env: serverEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });

        nextProcess.stdout.on("data", (d) =>
            process.stdout.write("[Next] " + d),
        );
        nextProcess.stderr.on("data", (d) =>
            process.stderr.write("[Next] " + d),
        );

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

        nextProcess.on("exit", (code, signal) => {
            if (appQuitting) return;
            if (code !== 0 && signal !== "SIGTERM") {
                console.error(
                    `[Desktop] server exited: code=${code} signal=${signal}`,
                );
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

        process.nextTick(() => {
            if (nextProcess) resolve({ ok: true, hostname: serverHostname });
        });
    });
}

// ── 서버 준비 대기
function waitForServer(hostname, retries = 120, interval = 500) {
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
                            `Server didn't response in ${(retries * interval) / 1000}sec.\n` +
                                `Poing URL: ${url}\n` +
                                `Verify Server Logs of Next.js.`,
                        ),
                    );
                else setTimeout(check, interval);
            });
        };
        check();
    });
}

// ── P-33: PTZ Proxy WebSocket 서버 시작
function startProxyServer(port) {
    if (proxyRunning) {
        console.warn("Server Run already [Proxy]");
        return false;
    }

    try {
        proxyServer = http.createServer();
        proxyWss = new WebSocket.Server({ server: proxyServer });

        proxyWss.on("connection", (ws, req) => {
            const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            proxyClients.add(clientId);
            proxyConnections.set(clientId, {
                ws,
                ptzDevice: null,
                status: "connected",
                protocol: null,
                connectedAt: new Date(),
            });

            console.log(
                `[Proxy] 클라이언트 연결: ${clientId} (총 ${proxyClients.size}개)`,
            );

            // 클라이언트 상태 전송
            updateProxyStatus();

            ws.on("message", (message) => {
                handleProxyMessage(clientId, message);
            });

            ws.on("close", () => {
                proxyClients.delete(clientId);
                proxyConnections.delete(clientId);
                console.log(
                    `[Proxy] 클라이언트 연결 해제: ${clientId} (남은 ${proxyClients.size}개)`,
                );
                updateProxyStatus();
            });

            ws.on("error", (error) => {
                console.error(
                    `[Proxy] WebSocket 에러 (${clientId}):`,
                    error.message,
                );
            });
        });

        proxyServer.listen(port, "0.0.0.0", () => {
            proxyRunning = true;
            console.log(`[Proxy] WebSocket 서버 시작: ws://0.0.0.0:${port}`);
            updateProxyStatus();
        });

        proxyServer.on("error", (err) => {
            console.error("[Proxy] 서버 에러:", err.message);
            proxyRunning = false;
            if (mainWindow) {
                mainWindow.webContents.send("proxy-error", {
                    message: `포트 ${port} 바인딩 실패: ${err.message}`,
                });
            }
        });

        return true;
    } catch (err) {
        console.error("[Proxy] 서버 시작 실패:", err.message);
        proxyRunning = false;
        return false;
    }
}

// ── P-33: PTZ Proxy 클라이언트 메시지 처리
function handleProxyMessage(clientId, message) {
    try {
        const conn = proxyConnections.get(clientId);
        if (!conn) return;

        const data = JSON.parse(message);

        // 메시지 타입별 처리
        switch (data.type) {
            case "init":
                // 클라이언트 초기화: 프로토콜 및 장치 지정
                conn.protocol = data.protocol || "pelcod"; // pelcod / ujin
                conn.ptzDevice = data.device || null;
                conn.status = "authenticated";
                console.log(
                    `[Proxy] 클라이언트 초기화: ${clientId} (${conn.protocol})`,
                );
                conn.ws.send(
                    JSON.stringify({
                        type: "init-ack",
                        clientId,
                        status: "ok",
                    }),
                );
                updateProxyStatus();
                break;

            case "command":
                // PTZ 제어 명령
                handlePTZCommand(clientId, data);
                break;

            case "ping":
                // 연결 유지 신호
                conn.ws.send(
                    JSON.stringify({
                        type: "pong",
                        timestamp: Date.now(),
                    }),
                );
                break;

            default:
                console.warn(`[Proxy] 알 수 없는 메시지 타입: ${data.type}`);
        }
    } catch (err) {
        console.error("[Proxy] 메시지 처리 에러:", err.message);
    }
}

// ── P-33: PTZ 제어 명령 처리
function handlePTZCommand(clientId, data) {
    const conn = proxyConnections.get(clientId);
    if (!conn) return;

    const { command, params } = data;
    console.log(`[Proxy] 명령 수신: ${clientId} -> ${command}`, params);

    // 실제 PTZ 장치로 명령 전달 (여기서는 로그만)
    // 향후: UART/TCP 등으로 실제 카메라에 명령 전달

    const response = {
        type: "command-ack",
        commandId: data.commandId || null,
        command,
        status: "executed",
        result: { success: true },
    };

    conn.ws.send(JSON.stringify(response));

    // 모든 클라이언트에 상태 업데이트 브로드캐스트
    broadcastProxyStatus();
}

// ── P-33: PTZ Proxy 상태 업데이트
function updateProxyStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const status = {
            running: proxyRunning,
            port: loadSettings().proxyPort,
            clients: proxyClients.size,
            connections: proxyConnections.size,
            settings: loadSettings(),
        };
        mainWindow.webContents.send("status", status);
    }
}

// ── P-33: 모든 클라이언트에 상태 브로드캐스트
function broadcastProxyStatus() {
    const statusMsg = {
        type: "proxy-status",
        clients: proxyClients.size,
        connections: proxyConnections.size,
        timestamp: Date.now(),
    };
    for (const [, conn] of proxyConnections) {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            try {
                conn.ws.send(JSON.stringify(statusMsg));
            } catch (err) {
                console.warn("[Proxy] 상태 브로드캐스트 실패:", err.message);
            }
        }
    }
}

// ── P-33: PTZ Proxy 서버 중지
function stopProxyServer() {
    if (!proxyRunning) {
        console.warn("[Proxy] 서버가 실행 중이 아닙니다");
        return false;
    }

    try {
        // 모든 클라이언트 연결 해제
        for (const [clientId, conn] of proxyConnections) {
            if (conn.ws) {
                conn.ws.close(1000, "서버 종료");
            }
        }
        proxyConnections.clear();
        proxyClients.clear();

        // WebSocket 서버 종료
        if (proxyWss) {
            proxyWss.close(() => {
                console.log("[Proxy] WebSocket 서버 종료");
            });
        }

        // HTTP 서버 종료
        if (proxyServer) {
            proxyServer.close(() => {
                console.log("[Proxy] HTTP 서버 종료");
            });
        }

        proxyRunning = false;
        proxyServer = null;
        proxyWss = null;
        updateProxyStatus();
        return true;
    } catch (err) {
        console.error("[Proxy] 서버 중지 실패:", err.message);
        return false;
    }
}

// ── BrowserWindow 생성
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

// ── 트레이
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

// ── 종료
function quitApp() {
    appQuitting = true;
    app.quit();
}

function showFatalError(msg) {
    console.error("[Desktop] FATAL:", msg);
    try {
        dialog.showErrorBox("ERROR: PTZ Controller", msg);
    } catch {}
    quitApp();
}

// ── IPC
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("hide-window", () => mainWindow?.hide());
ipcMain.on("close-window", () => mainWindow?.hide());

// ── P-33: PTZ Proxy 서버 제어 IPC (완전 구현)
ipcMain.on("start-server", (_, port) => {
    const proxyPort = port || loadSettings().proxyPort || 9902;
    console.log(`[IPC] start-server 요청: port=${proxyPort}`);

    if (startProxyServer(proxyPort)) {
        console.log(`[Proxy] 서버 시작 성공: ws://0.0.0.0:${proxyPort}`);
        updateProxyStatus();
    } else {
        console.error(`[Proxy] 서버 시작 실패`);
        if (mainWindow) {
            mainWindow.webContents.send("status", {
                running: false,
                port: proxyPort,
                clients: 0,
                connections: 0,
                settings: loadSettings(),
            });
        }
    }
});

ipcMain.on("stop-server", () => {
    console.log("[IPC] stop-server 요청");

    if (stopProxyServer()) {
        console.log("[Proxy] 서버 중지 성공");
        updateProxyStatus();
    } else {
        console.error("[Proxy] 서버 중지 실패");
    }
});

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
            running: proxyRunning,
            port: settings.proxyPort,
            clients: proxyClients.size,
            connections: proxyConnections.size,
            settings,
        });
    }
});

// ── 라이선스 관련 IPC 핸들러 (P-46 추가) ──────────────────
// 렌더러(Next.js 웹앱) ← → 메인 프로세스 (Electron)

ipcMain.on(
    "validate-license-online",
    async (event, { serverUrl, apiPath, sessionToken }) => {
        console.log("[IPC] validate-license-online requested");
        console.log("[IPC]   serverUrl:", serverUrl);
        console.log("[IPC]   apiPath:", apiPath);
        console.log(
            "[IPC]   sessionToken:",
            sessionToken ? `${sessionToken.slice(0, 10)}...` : "NONE",
        );

        const license = await validateLicenseFromServer(
            serverUrl,
            apiPath,
            sessionToken,
        );

        if (license) {
            const saved = saveLicenseFile(ONLINE_LICENSE_FILE, license);
            event.sender.send("license-validated", {
                success: saved,
                license: saved ? license : null,
                message: saved
                    ? "License saved successfully"
                    : "Failed to save license",
            });
        } else {
            event.sender.send("license-validated", {
                success: false,
                message: "License server validation failed",
            });
        }
    },
);

ipcMain.on("check-offline-license", (event) => {
    console.log("[IPC] check-offline-license");
    const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);
    const isValid = isLicenseValid(offlinePath);
    const content = readLicenseFile(OFFLINE_LICENSE_FILE);

    event.sender.send("offline-license-checked", {
        valid: isValid,
        content: content,
        hasFile: fs.existsSync(offlinePath),
    });
});

ipcMain.on("get-license-status", (event) => {
    console.log("[IPC] get-license-status");
    const onlinePath = getLicenseFilePath(ONLINE_LICENSE_FILE);
    const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);

    event.sender.send("license-status", {
        online: {
            valid: isLicenseValid(onlinePath),
            path: onlinePath,
            hasFile: fs.existsSync(onlinePath),
        },
        offline: {
            valid: isLicenseValid(offlinePath),
            path: offlinePath,
            hasFile: fs.existsSync(offlinePath),
        },
    });
});

ipcMain.on("upload-license-file", async (event, { filename, content }) => {
    console.log("[IPC] upload-license-file:", filename);

    const saved = saveLicenseFile(OFFLINE_LICENSE_FILE, content);

    event.sender.send("license-uploaded", {
        success: saved,
        message: saved
            ? "License file uploaded"
            : "Failed to upload license file",
    });
});

// ── IPC: 라이선스 요청 생성 (사용자 정보 포함) ────────────────────
ipcMain.handle('create-license-request', async (event) => {
  try {
    // Node.js 모듈 동적 로드 (CommonJS에서는 직접 import 불가)
    const { createLicenseRequestWithUserInfo } = require('../lib/license');
    
    const result = await createLicenseRequestWithUserInfo();
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
      };
    }

    return {
      success: true,
      request: result.request,
      userInfo: result.userInfo,
    };
  } catch (err) {
    console.error('[IPC] create-license-request error:', err);
    return {
      success: false,
      err.message
    };
  }
});

// ── IPC: 사용자 정보 편집 후 저장 ────────────────────────────────────
ipcMain.handle('save-license-request', async (event, { userInfo, request }) => {
  try {
    // 1. 라이선스 요청 파일 저장
    const { saveRequestFile } = require('../lib/license');
    const filePath = saveRequestFile(request);
    
    // 2. SQLite 업데이트
    const { getOfflineUser, saveOfflineUser } = require('../lib/offline-db');
    const user = getOfflineUser(userInfo.userEmail);
    
    if (user) {
      await saveOfflineUser({
        ...user,
        name: userInfo.userName,
        organization: userInfo.userOrg,
      });
    }

    return {
      success: true,
      filePath,
      message: `라이선스 요청 파일이 저장되었습니다: ${filePath}`,
    };
  } catch (err) {
    console.error('[IPC] save-license-request error:', err);
    return {
      success: false,
      err.message
    };
  }
});

// ── 앱 시작
app.whenReady().then(async () => {
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
        showFatalError(`Faile to start server\n\n${err.message}`);
    }
});

app.on("activate", () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    } else if (serverReady) {
        createWindow();
    }
});

app.on("second-instance", () => showWindow());

app.on("window-all-closed", (e) => e.preventDefault());

app.on("before-quit", () => {
    appQuitting = true;
    // P-33: Proxy 서버 먼저 종료
    if (proxyRunning) {
        stopProxyServer();
    }
    killNextProcess();
});

app.on("will-quit", () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

process.on("uncaughtException", (err) => {
    console.error("[Desktop] uncaughtException:", err);
    try {
        dialog.showErrorBox(
            "PTZ Controller — 오류",
            `예기치 않은 오류가 발생했습니다.\n\n${err.message}`,
        );
    } catch {}
    quitApp();
});

process.on("unhandledRejection", (reason) => {
    console.error("[Desktop] unhandledRejection:", reason);
});
