/**
 * auth.ts
 *
 * Electron 데스크톱용 NextAuth CredentialsProvider
 * (오프라인 DB만 사용)
 */

import bcrypt from "bcryptjs";
import {
    getOfflineUser,
    saveOfflineUser,
    verifyOfflinePassword,
    updateOfflineModeStatus,
} from "./offline-db";

export async function authorize(credentials: any) {
    if (!credentials?.email || !credentials?.password) {
        return null;
    }

    console.log("[Auth] Login attempt:", credentials.email);

    // Electron은 Prisma 접근 불가 → 오프라인 DB만 사용
    try {
        const offlineUser = await verifyOfflinePassword(
            credentials.email,
            credentials.password,
            bcrypt,
        );

        if (offlineUser) {
            console.log("[Auth] Offline login successful:", credentials.email);
            updateOfflineModeStatus(offlineUser.email, true);

            return {
                id: offlineUser.id,
                email: offlineUser.email,
                name: offlineUser.name,
                role: offlineUser.role,
            };
        }
    } catch (err) {
        console.error("[Auth] Offline authentication error:", err);
    }

    console.warn("[Auth] Login failed:", credentials.email);
    return null;
}

export default authorize;
