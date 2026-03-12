// electron/main.js — PTZ Controller Desktop (Electron)
//
// PTZ Proxy 서버는 별도 프로세스(ptz-proxy-electron)로 실행.
// Desktop 앱은 Proxy에 WebSocket 클라이언트로 접속한다.

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
    session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const http = require("http");
const crypto = require("crypto");

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
// HW ID 수집 (라이선스 검증용 — ptzcontroller_admin/lib/license.ts 동일 로직)
// ════════════════════════════════════════════════════════════════

function safeSpawnLic(cmd, args, timeout) {
    try {
        const result = cp.spawnSync(cmd, args, {
            timeout: timeout || 3000,
            encoding: "utf8",
            windowsHide: true,
        });
        if (result.status === 0 && typeof result.stdout === "string") {
            return result.stdout.trim();
        }
    } catch (e) {
        console.warn("[LicHW] spawnSync failed:", cmd, e.message);
    }
    return null;
}

function getLicOsId() {
    const platform = process.platform;
    let osId = "";
    try {
        if (platform === "win32") {
            const result = cp.spawnSync(
                "reg",
                ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
                { timeout: 3000, encoding: "utf8", windowsHide: true }
            );
            if (result.status === 0 && typeof result.stdout === "string") {
                const match = result.stdout.match(/MachineGuid\s+REG_SZ\s+(.+)/);
                if (match) osId = match[1].trim();
            }
        } else if (platform === "darwin") {
            const out = safeSpawnLic("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
            if (out) {
                const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
                if (match) osId = match[1];
            }
        } else {
            // Linux
            try {
                if (fs.existsSync("/etc/machine-id"))
                    osId = fs.readFileSync("/etc/machine-id", "utf8").trim();
            } catch (e) {}
            if (!osId) {
                try {
                    if (fs.existsSync("/var/lib/dbus/machine-id"))
                        osId = fs.readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
                } catch (e) {}
            }
        }
    } catch (e) {
        console.warn("[LicHW] OS ID 추출 실패:", e.message);
    }
    // fallback
    const os = require("os");
    return osId || `${platform}-${os.arch()}-${os.totalmem()}`;
}

// ── license.ts 와 동일한 상수 salt (OS에 종속되지 않음)
// OS 재설치 시에도 동일 HW라면 동일 코드 → 라이선스 재발급 불필요
const HW_SALT = "PTZ-CTRL-HW-2024";

/** sha256(HW_SALT + '||' + hwKey).slice(0,16).toUpperCase() — license.ts makeHwId 동일 */
function makeLicHwId(hwKey) {
    return crypto
        .createHash("sha256")
        .update(HW_SALT + "||" + hwKey)
        .digest("hex")
        .slice(0, 16)
        .toUpperCase();
}

/**
 * 현재 PC의 MachineID 목록 동기 수집 (license.ts getAllMachineIds 완전 동일 알고리즘)
 * 1단계) NIC MAC (플랫폼별, 비활성 포함)
 * 2단계) HDD Serial (항상, 모든 플랫폼) — OS UUID salt 없이 HW_SALT 사용
 * 3단계) NIC + HDD 모두 없을 때만 OS UUID (최후 수단)
 */
function getAllMachineIdsSync() {
    const platform = process.platform;
    const macs = [];
    const ids = [];

    // ── 1단계: NIC MAC 수집 ──────────────────────────────────────
    try {
        if (platform === "win32") {
            // Windows 8+: PowerShell Get-NetAdapter -Physical (비활성 포함)
            const psOut = safeSpawnLic(
                "powershell",
                ["-NoProfile", "-Command",
                 "Get-NetAdapter -Physical | Select-Object -ExpandProperty MacAddress"],
                5000
            );
            if (psOut) {
                for (const line of psOut.split(/\r?\n/)) {
                    const mac = line.trim().toLowerCase().replace(/-/g, ":");
                    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) && mac !== "00:00:00:00:00:00")
                        macs.push(mac);
                }
            }
            // fallback: getmac (Windows 7 / PS 실패 시)
            if (macs.length === 0) {
                const gmOut = safeSpawnLic("getmac", []);
                if (gmOut) {
                    const matches = gmOut.match(/([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}/g);
                    if (matches) {
                        for (const m of matches) {
                            const mac = m.replace(/-/g, ":").toLowerCase();
                            if (mac !== "00:00:00:00:00:00") macs.push(mac);
                        }
                    }
                }
            }
        } else if (platform === "darwin") {
            const out = safeSpawnLic("ifconfig", ["-a"]); // -a: 비활성 인터페이스 포함
            if (out) {
                const matches = out.match(
                    /ether\s+([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/gi
                );
                if (matches) {
                    for (const m of matches) {
                        const mac = m.split(/\s+/)[1]?.toLowerCase();
                        if (mac && mac !== "00:00:00:00:00:00") macs.push(mac);
                    }
                }
            }
        } else {
            // Linux: /sys/class/net
            const netDir = "/sys/class/net";
            if (fs.existsSync(netDir)) {
                for (const iface of fs.readdirSync(netDir)) {
                    if (iface === "lo" || iface.startsWith("vnet") || iface.startsWith("docker"))
                        continue;
                    try {
                        const addrPath = `${netDir}/${iface}/address`;
                        if (fs.existsSync(addrPath)) {
                            const mac = fs.readFileSync(addrPath, "utf8").trim().toLowerCase();
                            if (mac && mac !== "00:00:00:00:00:00" && !mac.startsWith("02:"))
                                macs.push(mac);
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        console.warn("[LicHW] MAC 수집 실패:", e.message);
    }

    for (const mac of [...new Set(macs)]) {
        ids.push(makeLicHwId(mac));
    }

    // ── 2단계: HDD Serial 수집 (항상, 모든 플랫폼) ─────────────
    // license.ts 와 동일: 조건 없이 항상 수집
    try {
        if (platform === "win32") {
            // diskdrive: 물리 디스크 시리얼 (logicaldisk volume serial 아님)
            const wmicOut = safeSpawnLic("wmic", [
                "diskdrive", "get", "serialnumber", "/format:table",
            ]);
            if (wmicOut) {
                for (const line of wmicOut.split(/\r?\n/)) {
                    const serial = line.trim().replace(/\s+/g, "");
                    if (serial && serial !== "SerialNumber" && serial.length > 2) {
                        ids.push(makeLicHwId(serial));
                    }
                }
            }
        } else if (platform === "darwin") {
            // system_profiler SPStorageDataType: SATA + NVMe 커버
            const out = safeSpawnLic("system_profiler", ["SPStorageDataType"], 8000);
            if (out) {
                const matches = out.match(/Serial Number:\s*(\S+)/g);
                if (matches) {
                    for (const m of matches) {
                        const serial = m.replace(/Serial Number:\s*/, "").trim();
                        if (serial && serial.length > 2) ids.push(makeLicHwId(serial));
                    }
                }
            }
        } else {
            // Linux: /sys/block/*/device/serial
            const blockDir = "/sys/block";
            if (fs.existsSync(blockDir)) {
                for (const dev of fs.readdirSync(blockDir)) {
                    if (dev.startsWith("loop") || dev.startsWith("ram") || dev.startsWith("zram"))
                        continue;
                    try {
                        const serialPath = `${blockDir}/${dev}/device/serial`;
                        if (fs.existsSync(serialPath)) {
                            const serial = fs.readFileSync(serialPath, "utf8").trim();
                            if (serial && serial.length > 2) ids.push(makeLicHwId(serial));
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        console.warn("[LicHW] HDD 시리얼 수집 실패:", e.message);
    }

    console.log(`[LicHW] getAllMachineIdsSync: ${ids.length} IDs (${macs.length} NICs + HDD) on ${platform}`);

    // ── 3단계: NIC + HDD 모두 없을 때만 OS UUID (최후 수단) ────
    if (ids.length === 0) {
        console.warn("[LicHW] No hardware found – OS UUID를 최후 수단으로 사용");
        ids.push(makeLicHwId(getLicOsId()));
    }

    return ids;
}

// ════════════════════════════════════════════════════════════════
// LICENSE MANAGEMENT
// ════════════════════════════════════════════════════════════════

/**
 * 라이선스 파일 완전 검증 (license.ts verifyLicense 동일 알고리즘)
 * 1. Base64 디코드 + JSON 파싱
 * 2. HMAC-SHA256 서명 검증
 * 3. Product ID 확인 (PTZ-OFFLINE)
 * 4. MachineID 배열 매칭 (현재 PC HW ID 중 하나라도 일치)
 * 5. 만료일 확인
 */
function isLicenseValid(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const content = fs.readFileSync(filePath, "utf8").trim();

        // ① Base64 decode + JSON parse
        let lic;
        try {
            const decoded = Buffer.from(content, "base64").toString("utf8");
            lic = JSON.parse(decoded);
        } catch (e) {
            console.error("[Desktop] License decode error:", e.message);
            return false;
        }

        // userOrg 는 서명 제외 메타데이터 — license.ts verifyLicense 동일 처리
        const { sig, userOrg, ...payload } = lic;

        // ② HMAC-SHA256 서명 검증 (license.ts MASTER_SECRET 동일)
        const secret = process.env.LICENSE_SECRET || "TYCHE-PTZ-LICENSE-SECRET-2024";
        const expected = crypto
            .createHmac("sha256", secret)
            .update(JSON.stringify(payload))
            .digest("hex");
        if (sig !== expected) {
            console.warn("[Desktop] ❌ License signature invalid");
            return false;
        }

        // ③ Product 확인
        if (payload.product !== "PTZ-OFFLINE") {
            console.warn("[Desktop] ❌ License product mismatch:", payload.product);
            return false;
        }

        // ④ MachineID 검증 (배열 매칭 — 하나라도 일치하면 OK)
        const currentIds = getAllMachineIdsSync();
        const licenseIds = payload.machineIds?.length ? payload.machineIds : [payload.machineId];
        const matchedIds = currentIds.filter((id) => licenseIds.includes(id));
        if (matchedIds.length === 0) {
            console.warn(
                `[Desktop] ❌ License machine ID mismatch. ` +
                `Current IDs: ${currentIds.length}, License IDs: ${licenseIds.length}, Matched: 0`
            );
            return false;
        }

        // ⑤ 만료일 확인
        // 날짜만 있는 "YYYY-MM-DD" 형식이면 해당일 23:59:59 UTC로 처리
        // (그래야 마지막 날 하루 종일 사용 가능)
        const expiresAtStr = String(payload.expiresAt || '');
        const expiryDate = /^\d{4}-\d{2}-\d{2}$/.test(expiresAtStr)
            ? new Date(expiresAtStr + 'T23:59:59.999Z')
            : new Date(expiresAtStr);
        if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
            console.warn("[Desktop] ❌ License expired:", payload.expiresAt);
            return false;
        }

        console.log("[Desktop] ✅ License valid until:", payload.expiresAt,
            `(matched: ${matchedIds[0]})`);
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

    // ⚠️ parseEnv()는 자식 프로세스(Next.js)용 serverEnv 빌드에만 사용된다.
    // Electron 메인 프로세스의 process.env 에는 자동으로 적용되지 않으므로,
    // isLicenseValid() 등 메인 프로세스에서 직접 읽는 변수를 여기서 주입한다.
    if (envVars.LICENSE_SECRET) process.env.LICENSE_SECRET = envVars.LICENSE_SECRET;

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
        PTZ_DESKTOP_MODE: "true", // ✅ 추가: Desktop 모드 활성화
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

    // 저장된 테마를 preload에 전달 (localStorage 초기화 후에도 올바른 테마 복원)
    const { theme: savedTheme } = loadSettings();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 890,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: "#0f172a",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            additionalArguments: [`--app-theme=${savedTheme}`],
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

/**
 * 오프라인 모드 쿠키 강제 삭제 (라이선스 무효 시 오프라인 진입 차단)
 * - ptz-offline-mode  → 오프라인 세션 생성 트리거 쿠키
 * - ptz-offline-userid → 오프라인 사용자 식별 쿠키
 */
async function clearOfflineCookies() {
    try {
        const ses = session.defaultSession;
        const base = `http://localhost:${PORT}`;
        await ses.cookies.remove(base, "ptz-offline-mode");
        await ses.cookies.remove(base, "ptz-offline-userid");
        console.log("[Desktop] ✅ Offline mode cookies cleared (license invalid)");
    } catch (e) {
        console.warn("[Desktop] Failed to clear offline cookies:", e.message);
    }
}

/**
 * 시작 시 오프라인 라이선스 점검
 *
 * 라이선스 유효 → 아무 조치 없음 (정상 동작)
 * 라이선스 무효 →
 *   1. ptz-offline-mode / ptz-offline-userid 쿠키 삭제
 *      → requireSession() 이 오프라인 세션을 생성하지 않음 (보안 게이트)
 *   2. 경고 다이얼로그:
 *      "계속"   → 온라인 로그인 가능, 오프라인 불가
 *      "앱 종료" → 즉시 종료
 */
async function checkLicenseOnStartup() {
    const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);
    const licValid = isLicenseValid(offlinePath);

    if (licValid) {
        console.log("[Desktop] ✅ Startup license check: valid");
        return;
    }

    const reason = !fs.existsSync(offlinePath)
        ? "오프라인 라이선스 파일이 없습니다."
        : "오프라인 라이선스가 만료되었거나 유효하지 않습니다.";

    console.warn("[Desktop] ⚠️ Startup license check: invalid —", reason);

    // ── 오프라인 쿠키 즉시 삭제: requireSession 이 오프라인 세션을 반환하지 않도록
    await clearOfflineCookies();

    try {
        const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "PTZ Controller — 라이선스 확인",
            message: reason,
            detail:
                "온라인 모드(인터넷 연결)에서는 이 경고를 무시하고 계속 사용할 수 있습니다.\n" +
                "오프라인으로 사용하려면 설정 화면(⚙)에서 라이선스를 발급받으세요.\n\n" +
                "※ 라이선스가 유효하지 않으면 오프라인 모드는 비활성화됩니다.",
            buttons: ["계속 (온라인 전용)", "앱 종료"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 1) {
            quitApp();
        }
        // response === 0: 계속 → 온라인 로그인은 가능, 오프라인 세션은 쿠키 없어서 불가
    } catch (e) {
        console.warn("[Desktop] License startup dialog error:", e.message);
    }
}

// ════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════

// 포트 유효성 검사 (1024~65535, 정수)
function isValidPort(port) {
    const p = Number(port);
    return Number.isInteger(p) && p >= 1024 && p <= 65535;
}

ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("hide-window", () => mainWindow?.hide());
ipcMain.on("close-window", () => mainWindow?.hide());


ipcMain.on("change-port", (_, port) => {
    console.log(`[IPC] change-port: port=${port}`);
    if (!isValidPort(port)) {
        console.warn(`[IPC] change-port: 유효하지 않은 포트 ${port} — 무시됨 (1024~65535)`);
        return;
    }
    const updated = saveSettings({ proxyPort: Number(port) });
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

// ── License Verification IPC (Desktop only)
ipcMain.on("verify-license-for-offline-mode", async (event) => {
    console.log("[IPC] verify-license-for-offline-mode");

    const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);
    const hasFile = fs.existsSync(offlinePath);

    if (!hasFile) {
        console.warn("[Desktop] License file not found");
        event.sender.send("license-verification-result", {
            valid: false,
            hasFile: false,
            message: "No license file - please request one",
        });
        return;
    }

    const isValid = isLicenseValid(offlinePath);
    console.log(
        `[Desktop] License verification: ${isValid ? "valid" : "invalid"}`,
    );

    event.sender.send("license-verification-result", {
        valid: isValid,
        hasFile: true,
        message: isValid
            ? "License valid - offline mode allowed"
            : "License expired or invalid - please renew",
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

        // 재실행마다 로그인 강제: 세션/쿠키 초기화
        try {
            await session.defaultSession.clearStorageData({
                storages: ["cookies", "sessionstorage", "localstorage"],
            });
            console.log("[Desktop] Session cleared — login required on every start");
        } catch (e) {
            console.warn("[Desktop] Session clear failed (non-critical):", e.message);
        }

        // 항목5: 시작 시 오프라인 라이선스 사전 검증 (경고만, 비블로킹)
        await checkLicenseOnStartup();

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
