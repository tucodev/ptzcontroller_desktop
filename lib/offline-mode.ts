/**
 * offline-mode.ts (Desktop 버전 - 수정)
 *
 * Admin과 동일한 로직:
 * 1. Prisma로 DB 연결 확인 (3초 타임아웃)
 * 2. lib/license.ts의 verifyLicense() 호출
 * 3. HMAC 서명 + MachineID 배열 검증
 */

import {
    verifyLicense,
    getLicenseDir,
    createLicenseRequest,
    saveRequestFile,
} from "./license";
import path from "path";
import fs from "fs";

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

// ── DB 연결 상태 캐시 ────────────────────────────────────────────────
let _dbAvailable: boolean | null = null;
let _lastCheckTime = 0;
const CACHE_TTL_MS = 30_000;
const DB_CHECK_TIMEOUT_MS = 3_000;

/**
 * DB 연결 가능 여부 확인
 * 결과는 30초간 캐시됨
 */
export async function isDbAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_dbAvailable !== null && now - _lastCheckTime < CACHE_TTL_MS) {
        return _dbAvailable;
    }

    try {
        // ✅ Prisma 연결 확인
        const { prisma } = await import("./db");

        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error("DB check timeout")),
                    DB_CHECK_TIMEOUT_MS,
                ),
            ),
        ]);
        _dbAvailable = true;
        console.log("[OfflineMode] DB is available");
    } catch (err) {
        _dbAvailable = false;
        console.warn(
            "[OfflineMode] DB connection failed – offline mode activated:",
            (err as Error).message,
        );
    }

    _lastCheckTime = Date.now();
    return _dbAvailable;
}

/**
 * DB 연결 캐시 강제 초기화
 */
export function resetDbCache(): void {
    _dbAvailable = null;
    _lastCheckTime = 0;
    console.log("[OfflineMode] DB cache reset");
}

/**
 * 라이선스 파일 검증 (✅ Admin과 동일)
 * lib/license.ts의 verifyLicense 호출
 */
async function verifyOfflineLicense(): Promise<{
    valid: boolean;
    expiresAt?: string;
    reason?: string;
}> {
    try {
        const licenseDir = getLicenseDir();
        const licenseFile = path.join(licenseDir, "offline.ptzlic");

        if (!fs.existsSync(licenseFile)) {
            console.warn(
                "[OfflineMode] License file not found. Creating license request...",
            );

            try {
                const request = createLicenseRequest();
                const content = Buffer.from(
                    JSON.stringify(request, null, 2),
                ).toString("base64");
                fs.mkdirSync(licenseDir, { recursive: true });
                fs.writeFileSync(
                    path.join(licenseDir, "license.ptzreq"),
                    content,
                    "utf-8",
                );
                console.log(
                    "[OfflineMode] License request saved at:",
                    path.join(licenseDir, "license.ptzreq"),
                );
            } catch (err) {
                console.warn(
                    "[OfflineMode] Failed to create license request:",
                    err,
                );
            }

            return { valid: false, reason: "Not found" };
        }

        // ✅ Admin과 동일한 verifyLicense 함수 사용
        const licenseContent = fs.readFileSync(licenseFile, "utf-8").trim();
        const result = verifyLicense(licenseContent);

        if (!result.valid) {
            console.warn(
                "[OfflineMode] License validation failed:",
                result.reason,
            );
            return result;
        }

        // 라이선스 만료 시간까지의 남은 시간 로깅
        if (result.expiresAt) {
            const expiresAt = new Date(result.expiresAt);
            const daysLeft = Math.floor(
                (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
            );

            if (daysLeft <= 0) {
                console.warn("[OfflineMode] License has expired");
                return { valid: false, reason: "Expired" };
            } else if (daysLeft <= 30) {
                console.warn(
                    `[OfflineMode] License expires in ${daysLeft} days`,
                );
            } else {
                console.log(
                    `[OfflineMode] License valid for ${daysLeft} more days`,
                );
            }
        }

        return result;
    } catch (err) {
        console.error("[OfflineMode] License verification error:", err);
        return { valid: false, reason: "Verification error" };
    }
}

/**
 * 오프라인 세션 생성
 * DB 연결 확인 → 라이선스 검증
 */
export async function createOfflineSession(): Promise<OfflineSession> {
    // ✅ 라이선스 검증 (필수)
    const licenseStatus = await verifyOfflineLicense();

    if (!licenseStatus.valid) {
        console.warn(
            "[OfflineMode] ⚠️  Offline mode activated WITHOUT valid license",
        );
        console.warn("[OfflineMode] Reason:", licenseStatus.reason);
        console.warn(
            "[OfflineMode] Please upload a valid license file to enable offline mode",
        );
    } else {
        console.log(
            "[OfflineMode] ✅ Offline mode activated WITH valid license",
        );
        if (licenseStatus.expiresAt) {
            console.log(
                "[OfflineMode] License expires at:",
                licenseStatus.expiresAt,
            );
        }
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

export function isOfflineSession(session: unknown): session is OfflineSession {
    return (
        typeof session === "object" &&
        session !== null &&
        (session as OfflineSession).offline === true
    );
}
