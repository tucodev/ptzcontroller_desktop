/**
 * lib/license.ts (최종 개선 버전 – NIC 다중화 + 크로스 플랫폼 최적화)
 *
 * ── 설계 원칙 ────────────────────────────────────────────────────────
 *
 * 문제: 활성화 NIC이 변할 때마다 MAC이 바뀌어 라이선스가 무효화됨
 *
 * 해결:
 * 1. 모든 물리 NIC (활성/비활성)의 MAC 수집
 * 2. 각 NIC별로 MachineID 생성 → 배열로 저장
 * 3. 라이선스 발급: 수집된 모든 NIC ID 포함
 * 4. 라이선스 검증: 배열 중 하나라도 일치하면 통과
 * 5. NIC이 없으면: OS UUID 기반 발급 (fallback)
 *
 * + 크로스 플랫폼 적용 +
 *
 * Windows:
 *   - Windows 8+ : PowerShell Get-NetAdapter (비활성 포함)
 *   - Windows 7  : getmac (활성만) + HDD 시리얼 보완
 *
 * macOS: ifconfig (모든 어댑터)
 * Linux: /sys/class/net (모든 어댑터)
 *
 *
 * 결과:
 * - 한 개 NIC → 1개 ID로 발급
 * - 여러 개 NIC → 모든 NIC ID로 발급 (한 개만 일치해도 OK)
 * - NIC 교체 → 새 ID 추가 가능 (기존 ID도 유효)
 * - NIC 비활성화 → 기존 ID는 여전히 유효
 *
 */

import * as crypto from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";

const MASTER_SECRET =
    process.env.LICENSE_SECRET ?? "TYCHE-PTZ-LICENSE-SECRET-2024";
const PRODUCT_ID = "PTZ-OFFLINE";

// ── 안전한 명령어 실행 ────────────────────────────────────────────────
function safeSpawn(
    cmd: string,
    args: string[],
    timeout: number = 3000,
): string | null {
    try {
        const result = spawnSync(cmd, args, {
            timeout,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        if (result.status === 0 && result.stdout) {
            return result.stdout.trim();
        }
        return null;
    } catch (e) {
        return null;
    }
}

function safeReadFile(filePath: string): string | null {
    try {
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, "utf8").trim();
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ── OS ID 추출 ──────────────────────────────────────────────────────
function getOsId(): string {
    const platform = os.platform();
    let osId = "";

    try {
        if (platform === "win32") {
            const out = spawnSync("reg", [
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                "/v",
                "MachineGuid",
            ]).stdout as string;
            if (out) {
                const match = out.match(/MachineGuid\s+REG_SZ\s+(.+)/);
                if (match) osId = match[1].trim();
            }
        } else if (platform === "darwin") {
            const out = safeSpawn("ioreg", [
                "-rd1",
                "-c",
                "IOPlatformExpertDevice",
            ]);
            if (out) {
                const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
                if (match) osId = match[1];
            }
        } else {
            osId =
                safeReadFile("/etc/machine-id") ||
                safeReadFile("/var/lib/dbus/machine-id") ||
                "";
        }
    } catch (e) {
        console.warn("[license] OS ID 추출 실패:", e);
    }

    return osId || `${platform}-${os.arch()}-${os.totalmem()}`;
}

function makeHwId(osId: string, hwKey: string): string {
    return crypto
        .createHash("sha256")
        .update([osId, hwKey].join("||"))
        .digest("hex")
        .slice(0, 16)
        .toUpperCase();
}

// ── Windows NIC 수집 (버전별 전략) ──────────────────────────────────
function getWindowsOsVersion(): "win7" | "win8+" {
    try {
        // Windows 버전 감지: ver 명령 또는 레지스트리
        const out = spawnSync("cmd", ["/c", "ver"]).stdout as string;
        if (out && out.includes("Windows 7")) return "win7";
        // Windows 8, 10, 11 등
        return "win8+";
    } catch {
        // 폴백: PowerShell이 작동하면 Win8+, 아니면 Win7
        return "win8+";
    }
}

/**
 * Windows 8+ : PowerShell로 모든 어댑터 (비활성 포함) 수집
 */
function getWindowsMacsModern(): string[] {
    const macs: string[] = [];

    const psOut = safeSpawn(
        "powershell",
        [
            "-NoProfile",
            "-Command",
            "Get-NetAdapter -Physical | Select-Object -ExpandProperty MacAddress",
        ],
        5000,
    );

    if (psOut) {
        for (const line of psOut.split(/\r?\n/)) {
            const mac = line.trim().toLowerCase();
            if (
                /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) &&
                mac !== "00:00:00:00:00:00"
            ) {
                macs.push(mac);
            }
        }
    }

    return macs;
}

/**
 * Windows 7 : getmac로 활성 어댑터만 수집
 * (비활성은 불가능하지만, HDD 시리얼로 보완)
 */
function getWindowsMacsLegacy(): string[] {
    const macs: string[] = [];

    const getmacOut = safeSpawn("getmac", []);
    if (getmacOut) {
        const matches = getmacOut.match(/([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}/g);
        if (matches) {
            for (const match of matches) {
                const mac = match.replace(/-/g, ":").toLowerCase();
                if (mac !== "00:00:00:00:00:00") macs.push(mac);
            }
        }
    }

    return [...new Set(macs)];
}

function getWindowsMacs(): string[] {
    const version = getWindowsOsVersion();

    if (version === "win8+") {
        console.log(
            "[license] Windows 8+ detected – using PowerShell (비활성 어댑터 포함)",
        );
        const macs = getWindowsMacsModern();
        if (macs.length > 0) return macs;

        // PowerShell 실패 시 폴백
        console.warn("[license] PowerShell 실패 – getmac 폴백");
        return getWindowsMacsLegacy();
    } else {
        console.log("[license] Windows 7 detected – using getmac (활성만)");
        return getWindowsMacsLegacy();
    }
}

// ── macOS NIC 수집 ──────────────────────────────────────────────────
function getMacOsMacs(): string[] {
    const macs: string[] = [];

    const out = safeSpawn("ifconfig", []);
    if (out) {
        const matches = out.match(
            /ether\s+([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/gi,
        );
        if (matches) {
            for (const match of matches) {
                const mac = match.split(" ")[1].toLowerCase();
                if (mac !== "00:00:00:00:00:00") macs.push(mac);
            }
        }
    }

    return [...new Set(macs)];
}

// ── Linux NIC 수집 ──────────────────────────────────────────────────
function getLinuxMacs(): string[] {
    const macs: string[] = [];

    try {
        const netDir = "/sys/class/net";
        if (!fs.existsSync(netDir)) return macs;

        const ifaces = fs.readdirSync(netDir);
        for (const iface of ifaces) {
            if (
                iface === "lo" ||
                iface.startsWith("vnet") ||
                iface.startsWith("docker")
            )
                continue;

            const addressPath = path.join(netDir, iface, "address");
            const mac = safeReadFile(addressPath);

            if (mac && mac !== "00:00:00:00:00:00" && !mac.startsWith("02:")) {
                macs.push(mac.toLowerCase());
            }
        }
    } catch (e) {
        console.warn("[license] Linux MAC 수집 실패:", e);
    }

    return [...new Set(macs)];
}

// ── HDD 시리얼 수집 (Windows 7용 보완) ──────────────────────────────
function getWindowsHddSerials(): string[] {
    const serials: string[] = [];

    // wmic (Windows 7-10)
    try {
        const out = safeSpawn("wmic", [
            "logicaldisk",
            "get",
            "volumeserialnumber",
            "/format:table",
        ]);
        if (out) {
            const matches = out.match(/[0-9A-Fa-f]{8}/g);
            if (matches) {
                for (const match of matches) {
                    serials.push(match);
                }
            }
        }
    } catch (e) {
        console.warn("[license] HDD 시리얼 수집 실패:", e);
    }

    return [...new Set(serials)];
}

// ── 모든 MachineID 수집 (핵심) ──────────────────────────────────────
export function getAllMachineIds(): string[] {
    const platform = os.platform();
    const osId = getOsId();
    const ids: string[] = [];

    // 1단계: NIC MAC 수집
    let macs: string[] = [];
    if (platform === "win32") {
        macs = getWindowsMacs();
    } else if (platform === "darwin") {
        macs = getMacOsMacs();
    } else {
        macs = getLinuxMacs();
    }

    // 2단계: MAC → MachineID
    for (const mac of macs) {
        ids.push(makeHwId(osId, mac));
    }

    // 3단계: Windows 7 보완 (NIC 부족 시 HDD 시리얼 추가)
    if (platform === "win32" && ids.length < 2) {
        console.log("[license] NIC 부족 – HDD 시리얼로 보완");
        const serials = getWindowsHddSerials();
        for (const serial of serials) {
            ids.push(makeHwId(osId, serial));
        }
    }

    console.log(
        `[license] getAllMachineIds: ${ids.length} IDs (${macs.length} NICs + ${
            ids.length - macs.length
        } HDDs) on ${platform}`,
    );

    // 폴백
    if (ids.length === 0) {
        console.warn("[license] No hardware found – using OS UUID");
        ids.push(makeHwId(osId, "NO_HW_FALLBACK"));
    }

    return ids;
}

// ── 라이선스 요청/발급/검증 (기존 코드) ────────────────────────────
export interface LicensePayload {
    machineId: string;
    machineIds: string[];
    issuedAt: string;
    expiresAt: string;
    product: string;
}

export interface LicenseFile extends LicensePayload {
    sig: string;
}

export interface RequestPayload {
    machineId: string;
    machineIds: string[];
    requestedAt: string;
    product: string;
    sig: string;
}

export interface VerifyResult {
    valid: boolean;
    reason?: string;
    expiresAt?: string;
    machineId?: string;
    matchedIds?: string[];
}

// ── 라이선스 파일 경로 ────────────────────────────────────────────────
function getLicenseDir(): string {
    if (process.platform === "win32") {
        const programData =
            process.env.PROGRAMDATA ||
            process.env.ALLUSERSPROFILE ||
            "C:\\ProgramData";
        return path.join(programData, "PTZController");
    } else if (process.platform === "darwin") {
        return "/Library/Application Support/PTZController";
    } else {
        return path.join(
            process.env.HOME || "/etc",
            ".config",
            "PTZController",
        );
    }
}

export const LICENSE_FILE_PATH = path.join(getLicenseDir(), "offline.ptzlic");
export const REQUEST_FILE_PATH = path.join(getLicenseDir(), "license.ptzreq");

// ── 라이선스 요청 생성 ────────────────────────────────────────────────
export function createLicenseRequest(): RequestPayload {
    const machineIds = getAllMachineIds();
    const machineId = machineIds[0] ?? "UNKNOWN";
    const requestedAt = new Date().toISOString();
    const payload = { machineId, machineIds, requestedAt, product: PRODUCT_ID };
    const sig = crypto
        .createHmac("sha256", MASTER_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex")
        .slice(0, 16);

    return { ...payload, sig };
}

export function saveRequestFile(): string {
    const request = createLicenseRequest();
    const content = Buffer.from(JSON.stringify(request, null, 2)).toString(
        "base64",
    );
    fs.mkdirSync(path.dirname(REQUEST_FILE_PATH), { recursive: true });
    fs.writeFileSync(REQUEST_FILE_PATH, content, "utf8");
    return REQUEST_FILE_PATH;
}

// ── 라이선스 발급 (제공자용) ────────────────────────────────────────────
export function issueLicense(
    machineId: string,
    machineIds: string[],
    expiresAt: string,
): string {
    const payload: LicensePayload = {
        machineId,
        machineIds: machineIds?.length > 0 ? machineIds : [machineId],
        issuedAt: new Date().toISOString(),
        expiresAt,
        product: PRODUCT_ID,
    };
    const sig = crypto
        .createHmac("sha256", MASTER_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex");

    const licenseFile: LicenseFile = { ...payload, sig };
    return Buffer.from(JSON.stringify(licenseFile)).toString("base64");
}

// ── 라이선스 검증 (핵심) ────────────────────────────────────────────────
export function verifyLicense(licenseB64: string): VerifyResult {
    try {
        const raw = Buffer.from(licenseB64, "base64").toString("utf8");
        const lic = JSON.parse(raw) as LicenseFile;
        const { sig, ...payload } = lic;

        // 1. HMAC 서명 검증
        const expected = crypto
            .createHmac("sha256", MASTER_SECRET)
            .update(JSON.stringify(payload))
            .digest("hex");
        if (sig !== expected) {
            return {
                valid: false,
                reason: "라이선스 서명이 올바르지 않습니다",
            };
        }

        // 2. Product 확인
        if (payload.product !== PRODUCT_ID) {
            return {
                valid: false,
                reason: "라이선스 제품이 일치하지 않습니다",
            };
        }

        // 3. MachineID 검증 (배열 매칭)
        const currentIds = getAllMachineIds();
        const licenseIds = payload.machineIds?.length
            ? payload.machineIds
            : [payload.machineId];
        const matchedIds = currentIds.filter((cur) => licenseIds.includes(cur));

        if (matchedIds.length === 0) {
            return {
                valid: false,
                reason: `이 PC에 발급된 라이선스가 아닙니다 (현재: ${currentIds.length}, 라이선스: ${licenseIds.length}, 일치: 0)`,
            };
        }

        // 4. 만료일 확인
        if (new Date(payload.expiresAt) < new Date()) {
            return {
                valid: false,
                reason: `라이선스가 만료됨 (${payload.expiresAt.slice(0, 10)})`,
            };
        }

        return {
            valid: true,
            expiresAt: payload.expiresAt,
            machineId: matchedIds[0],
            matchedIds,
        };
    } catch {
        return { valid: false, reason: "라이선스 파일을 읽을 수 없습니다" };
    }
}

export function verifyLicenseFile(): VerifyResult {
    if (!fs.existsSync(LICENSE_FILE_PATH)) {
        return { valid: false, reason: "NOT_FOUND" };
    }
    try {
        const content = fs.readFileSync(LICENSE_FILE_PATH, "utf8").trim();
        return verifyLicense(content);
    } catch {
        return { valid: false, reason: "라이선스 파일을 읽을 수 없습니다" };
    }
}
