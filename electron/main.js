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
    ipcMain,
    dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const http = require("http");
const WebSocket = require("ws");

// ════════════════════════════════════════════════════════════════
// STARTUP CHECKS
// ════════════════════════════════════════════════════════════════

if (require("electron-squirrel-startup")) {
    app.quit();
    process.exit(0);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}

// ════════════════════════════════════════════════════════════════
// PATH UTILITIES
// ════════════════════════════════════════════════════════════════

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

function getLicensePath() {
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

function getLicenseFilePath(filename) {
    return path.join(getLicensePath(), filename);
}

// ════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIG
// ════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || "3000", 10);
const DEV_MODE = process.env.NODE_ENV === "development";

const ONLINE_LICENSE_FILE = "online.ptzlic";
const OFFLINE_LICENSE_FILE = "offline.ptzlic";
const OFFLINE_REQUEST_FILE = "offline.ptzreq";

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

// ════════════════════════════════════════════════════════════════
// SETTINGS MANAGEMENT
// ════════════════════════════════════════════════════════════════

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
        console.warn("[Desktop] settings.json read error:", e.message);
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
        console.error("[Desktop] settings.json save error:", e.message);
        return null;
    }
}

// ════════════════════════════════════════════════════════════════
// LICENSE MANAGEMENT
// ════════════════════════════════════════════════════════════════

function isLicenseValid(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const content = fs.readFileSync(filePath, "utf8").trim();

        // Base64 decode
        let licenseObj;
        try {
            const decoded = Buffer.from(content, "base64").toString("utf8");
            licenseObj = JSON.parse(decoded);
        } catch (e) {
            console.error("[Desktop] License decode error:", e.message);
            return false;
        }

        // Check required fields
        if (!licenseObj.machineId || !licenseObj.expiresAt) {
            console.warn("[Desktop] License missing required fields");
            return false;
        }

        // Check expiry
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

async function isLicenseValidViaPtree(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const content = fs.readFileSync(filePath, "utf8").trim();

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

        fs.mkdirSync(dir, { recursive: true });
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
                    "Content-Length": 2,
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
                            resolve(json.license);
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

            req.setTimeout(10000, () => {
                console.warn("[Desktop] License validation request timeout");
                req.destroy();
                resolve(null);
            });

            req.write("{}");
            req.end();
        });
    } catch (e) {
        console.error("[Desktop] License validation exception:", e.message);
        return null;
    }
}

// ════════════════════════════════════════════════════════════════
// PRISMA ENGINE & NEXT.JS SERVER
// ════════════════════════════════════════════════════════════════

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
        console.log("[Desktop] Next.js process killed");
    } catch (e) {
        console.warn("[Desktop] Process kill error:", e.message);
    }
}

async function startNextServer() {
    const standalonePath = getStandalonePath();
    const serverJs = path.join(standalonePath, "server.js");

    if (!fs.existsSync(serverJs)) {
        showFatalError(
            `server.js not found.\n${serverJs}\n\nRun: npm run copy:standalone`,
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
            : "NOT SET",
    );

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
                    ? `Node.js not found.\n${nodeExe}`
                    : `Server error: ${err.message}`,
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
                    "PTZ Controller — Server Error",
                    `Next.js server exited unexpectedly.\n` +
                        `Exit code: ${code}\n\n` +
                        `Please restart the app.`,
                );
            }
        });

        process.nextTick(() => {
            if (nextProcess) resolve({ ok: true, hostname: serverHostname });
        });
    });
}

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
                            `Server didn't respond in ${(retries * interval) / 1000}sec.\n` +
                                `Ping URL: ${url}`,
                        ),
                    );
                else setTimeout(check, interval);
            });
        };
        check();
    });
}

// ════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════════

let mainWindow = null;
let tray = null;
let nextProcess = null;
let serverReady = false;
let appQuitting = false;

let proxyServer = null;
let proxyWss = null;
let proxyClients = new Set();
let proxyConnections = new Map();
let proxyRunning = false;

// ════════════════════════════════════════════════════════════════
// PTZ PROXY SERVER
// ════════════════════════════════════════════════════════════════

function startProxyServer(port) {
    if (proxyRunning) {
        console.warn("[Proxy] Server already running");
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
                `[Proxy] Client connected: ${clientId} (total: ${proxyClients.size})`,
            );

            updateProxyStatus();

            ws.on("message", (message) => {
                handleProxyMessage(clientId, message);
            });

            ws.on("close", () => {
                proxyClients.delete(clientId);
                proxyConnections.delete(clientId);
                console.log(
                    `[Proxy] Client disconnected: ${clientId} (remaining: ${proxyClients.size})`,
                );
                updateProxyStatus();
            });

            ws.on("error", (error) => {
                console.error(
                    `[Proxy] WebSocket error (${clientId}):`,
                    error.message,
                );
            });
        });

        proxyServer.listen(port, "0.0.0.0", () => {
            proxyRunning = true;
            console.log(
                `[Proxy] WebSocket server started: ws://0.0.0.0:${port}`,
            );
            updateProxyStatus();
        });

        proxyServer.on("error", (err) => {
            console.error("[Proxy] Server error:", err.message);
            proxyRunning = false;
            if (mainWindow) {
                mainWindow.webContents.send("proxy-error", {
                    message: `Port ${port} binding failed: ${err.message}`,
                });
            }
        });

        return true;
    } catch (err) {
        console.error("[Proxy] Start failed:", err.message);
        proxyRunning = false;
        return false;
    }
}

function handleProxyMessage(clientId, message) {
    try {
        const conn = proxyConnections.get(clientId);
        if (!conn) return;

        const data = JSON.parse(message);

        switch (data.type) {
            case "init":
                conn.protocol = data.protocol || "pelcod";
                conn.ptzDevice = data.device || null;
                conn.status = "authenticated";
                console.log(
                    `[Proxy] Client initialized: ${clientId} (${conn.protocol})`,
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
                handlePTZCommand(clientId, data);
                break;

            case "ping":
                conn.ws.send(
                    JSON.stringify({
                        type: "pong",
                        timestamp: Date.now(),
                    }),
                );
                break;

            default:
                console.warn(`[Proxy] Unknown message type: ${data.type}`);
        }
    } catch (err) {
        console.error("[Proxy] Message handling error:", err.message);
    }
}

function handlePTZCommand(clientId, data) {
    const conn = proxyConnections.get(clientId);
    if (!conn) return;

    const { command, params } = data;
    console.log(`[Proxy] Command: ${clientId} -> ${command}`, params);

    const response = {
        type: "command-ack",
        commandId: data.commandId || null,
        command,
        status: "executed",
        result: { success: true },
    };

    conn.ws.send(JSON.stringify(response));
    broadcastProxyStatus();
}

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
                console.warn("[Proxy] Broadcast failed:", err.message);
            }
        }
    }
}

function stopProxyServer() {
    if (!proxyRunning) {
        console.warn("[Proxy] Server not running");
        return false;
    }

    try {
        for (const [clientId, conn] of proxyConnections) {
            if (conn.ws) {
                conn.ws.close(1000, "Server shutdown");
            }
        }
        proxyConnections.clear();
        proxyClients.clear();

        if (proxyWss) {
            proxyWss.close(() => {
                console.log("[Proxy] WebSocket server closed");
            });
        }

        if (proxyServer) {
            proxyServer.close(() => {
                console.log("[Proxy] HTTP server closed");
            });
        }

        proxyRunning = false;
        proxyServer = null;
        proxyWss = null;
        updateProxyStatus();
        return true;
    } catch (err) {
        console.error("[Proxy] Stop failed:", err.message);
        return false;
    }
}

// ════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT
// ════════════════════════════════════════════════════════════════

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
                    ? `● Running (port ${PORT})`
                    : "○ Starting...",
                enabled: false,
            },
            { type: "separator" },
            { label: "Open", click: () => showWindow() },
            { type: "separator" },
            { label: "Quit", click: () => quitApp() },
        ]),
    );
}

function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
    mainWindow.focus();
}

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

// ════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════

ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("hide-window", () => mainWindow?.hide());
ipcMain.on("close-window", () => mainWindow?.hide());

// ── Proxy Control IPC
ipcMain.on("start-server", (_, port) => {
    const proxyPort = port || loadSettings().proxyPort || 9902;
    console.log(`[IPC] start-server: port=${proxyPort}`);

    if (startProxyServer(proxyPort)) {
        console.log(`[Proxy] Started: ws://0.0.0.0:${proxyPort}`);
        updateProxyStatus();
    } else {
        console.error(`[Proxy] Start failed`);
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
    console.log("[IPC] stop-server");

    if (stopProxyServer()) {
        console.log("[Proxy] Stopped");
        updateProxyStatus();
    } else {
        console.error("[Proxy] Stop failed");
    }
});

ipcMain.on("change-port", (_, port) => {
    console.log(`[IPC] change-port: port=${port}`);
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

// ── License IPC Handlers
ipcMain.on(
    "validate-license-online",
    async (event, { serverUrl, apiPath, sessionToken }) => {
        console.log("[IPC] validate-license-online");

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
                message: saved ? "License saved" : "Save failed",
            });
        } else {
            event.sender.send("license-validated", {
                success: false,
                message: "Server validation failed",
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
        message: saved ? "License uploaded" : "Upload failed",
    });
});

// ════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ════════════════════════════════════════════════════════════════

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
        showFatalError(`Failed to start server\n\n${err.message}`);
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
            "PTZ Controller — Error",
            `Unexpected error.\n\n${err.message}`,
        );
    } catch {}
    quitApp();
});

process.on("unhandledRejection", (reason) => {
    console.error("[Desktop] unhandledRejection:", reason);
});
