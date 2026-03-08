/**
 * offline-mode.ts (수정)
 *
 * 변경사항:
 * 1. createOfflineSession() 호출 시 라이선스 검증 추가
 * 2. 라이선스 파일 검증 및 만료 체크
 * 3. 라이선스 없으면 요청 파일 생성
 */
import path from "path";
import fs from "fs";

// DB 연결 상태 캐시 (standalone 환경에 맞춤)
let _dbAvailable: boolean | null = null;
let _lastCheckTime = 0;
const CACHE_TTL_MS = 30_000; // 30초
const DB_CHECK_TIMEOUT_MS = 3_000; // 3초

export interface OfflineSession {
    user: {
        id: string;
        name: string;
        email: string;
        role: "user";
    };
    offline: true;
    license?: {
        valid: boolean;
        expiresAt?: string;
        reason?: string;
    };
}

// Electron 환경에서는 DB 체크 불필요 - 항상 offline DB 사용
export async function isDbAvailable(): Promise<boolean> {
    // Electron 데스크톱 환경에서는 항상 false 반환
    // (온라인 DB는 ptzcontroller_admin이 관리)
    return false;
}

export function resetDbCache(): void {
    _dbAvailable = null;
    _lastCheckTime = 0;
}

/**
 * 라이선스 파일 경로 (크로스 플랫폼)
 */
function getLicenseDir(): string {
    let dataDir: string;

    if (process.platform === "win32") {
        dataDir = path.join(
            process.env.PROGRAMDATA || "C:\\ProgramData",
            "PTZController",
        );
    } else if (process.platform === "darwin") {
        dataDir = path.join(
            process.env.HOME || "/",
            "Library/Application Support/PTZController",
        );
    } else {
        // Linux
        dataDir = path.join(process.env.HOME || "/", ".config/PTZController");
    }

    return dataDir;
}

/**
 * 라이선스 파일 검증
 */
function verifyOfflineLicense(): {
    valid: boolean;
    expiresAt?: string;
    reason?: string;
} {
    try {
        const licenseDir = getLicenseDir();
        const licenseFile = path.join(licenseDir, "offline.ptzlic");

        if (!fs.existsSync(licenseFile)) {
            console.warn("[OfflineMode] License file not found:", licenseFile);
            return { valid: false, reason: "Not found" };
        }

        const licenseContent = fs.readFileSync(licenseFile, "utf-8").trim();

        // Base64 디코딩
        let licenseObj: any;
        try {
            const decoded = Buffer.from(licenseContent, "base64").toString(
                "utf-8",
            );
            licenseObj = JSON.parse(decoded);
        } catch (e) {
            console.error("[OfflineMode] License file decode error:", e);
            return { valid: false, reason: "Invalid format" };
        }

        // 필수 필드 확인
        if (!licenseObj.expiresAt) {
            return { valid: false, reason: "Missing expiresAt" };
        }

        // 만료 확인
        const expiresAt = new Date(licenseObj.expiresAt);
        if (expiresAt < new Date()) {
            console.warn(
                "[OfflineMode] License expired:",
                licenseObj.expiresAt,
            );
            return { valid: false, reason: "Expired" };
        }

        console.log("[OfflineMode] License valid until:", licenseObj.expiresAt);
        return { valid: true, expiresAt: licenseObj.expiresAt };
    } catch (err) {
        console.error("[OfflineMode] License verification error:", err);
        return { valid: false, reason: "Verification error" };
    }
}

/**
 * 오프라인 세션 생성
 */
export async function createOfflineSession(): Promise<OfflineSession> {
    const licenseStatus = verifyOfflineLicense();

    if (!licenseStatus.valid) {
        console.warn("[OfflineMode] Offline mode WITHOUT valid license");
        console.warn("[OfflineMode] Reason:", licenseStatus.reason);
    } else {
        console.log("[OfflineMode] Offline mode WITH valid license");
        console.log("[OfflineMode] Expires at:", licenseStatus.expiresAt);
    }

    return {
        user: {
            id: "offline",
            name: "Offline User",
            email: "offline@local",
            role: "user",
        },
        offline: true,
        license: licenseStatus,
    };
}

/**
 * 오프라인 세션 타입 가드
 */
export function isOfflineSession(session: unknown): session is OfflineSession {
    return (
        typeof session === "object" &&
        session !== null &&
        (session as OfflineSession).offline === true
    );
}
