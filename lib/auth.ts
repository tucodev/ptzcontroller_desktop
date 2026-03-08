/**
 * auth.ts (Desktop 버전 - 수정)
 *
 * ✅ 변경사항:
 * - Prisma 온라인 로그인 시도 (3초 타임아웃)
 * - 온라인 성공 → 오프라인 DB에 저장 (설정값 동기화)
 * - 온라인 실패 → 오프라인 DB 폴백
 */

import bcrypt from "bcryptjs";
import {
    getOfflineUser,
    saveOfflineUser,
    verifyOfflinePassword,
    updateOfflineModeStatus,
    initOfflineDb,
} from "./offline-db";

// 앱 시작 시 오프라인 DB 초기화
try {
    initOfflineDb();
    console.log("[Auth] Offline DB initialized successfully");
} catch (err) {
    console.warn(
        "[Auth] Offline DB initialization failed (non-critical):",
        err,
    );
}

export async function authorize(credentials: any) {
    if (!credentials?.email || !credentials?.password) {
        console.warn("[Auth] Missing email or password");
        return null;
    }

    console.log("[Auth] Login attempt:", credentials.email);

    const DB_AUTH_TIMEOUT_MS = 3_000;

    try {
        // ✅ 온라인 로그인 시도 (Prisma + 3초 타임아웃)
        console.log(
            "[Auth] Attempting online authentication for:",
            credentials.email,
        );

        const { prisma } = await import("./db");

        const user = await Promise.race([
            prisma.user.findUnique({
                where: { email: credentials.email },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    password: true,
                    role: true,
                    organization: true,
                },
            }),
            new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), DB_AUTH_TIMEOUT_MS),
            ),
        ]);

        if (user && user.password) {
            const isValid = await bcrypt.compare(
                credentials.password,
                user.password,
            );
            if (isValid) {
                console.log(
                    "[Auth] Online login successful:",
                    credentials.email,
                );

                // ✅ 온라인 로그인 성공 → 오프라인 DB에 저장 (설정값 동기화)
                try {
                    await saveOfflineUser({
                        email: user.email,
                        name: user.name || "User",
                        organization: user.organization || undefined,
                        passwordHash: user.password,
                        role: (user.role as "user" | "admin") || "user",
                        lastOnlineLoginAt: new Date().toISOString(),
                        lastSyncAt: new Date().toISOString(),
                        platform: process.platform,
                        appVersion: process.env.npm_package_version,
                    });
                    console.log("[Auth] Offline user saved:", user.email);
                } catch (err) {
                    console.warn("[Auth] Failed to save offline user:", err);
                }

                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                };
            } else {
                console.warn(
                    "[Auth] Online login failed - invalid password:",
                    credentials.email,
                );
            }
        } else {
            if (user) {
                console.warn(
                    "[Auth] Online login failed - no password hash:",
                    credentials.email,
                );
            } else {
                console.warn(
                    "[Auth] Online login failed - user not found:",
                    credentials.email,
                );
            }
        }
    } catch (error) {
        console.error("[Auth] Online DB error:", (error as Error).message);
    }

    // ✅ DB 오프라인 또는 온라인 로그인 실패 → 오프라인 저장소 확인
    console.log("[Auth] Attempting offline authentication...");
    try {
        const offlineUser = await verifyOfflinePassword(
            credentials.email,
            credentials.password,
            bcrypt,
        );

        if (offlineUser) {
            console.log("[Auth] Offline login successful:", credentials.email);

            // 오프라인 모드 상태 업데이트
            updateOfflineModeStatus(offlineUser.email, true);

            return {
                id: offlineUser.id,
                email: offlineUser.email,
                name: offlineUser.name,
                role: offlineUser.role,
            };
        } else {
            console.warn("[Auth] Offline login failed:", credentials.email);
        }
    } catch (err) {
        console.error("[Auth] Offline authentication error:", err);
    }

    console.warn("[Auth] Login failed for:", credentials.email);
    return null;
}

export default authorize;
