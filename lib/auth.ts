import bcrypt from "bcryptjs";
import {
    getOfflineUser,
    saveOfflineUser,
    verifyOfflinePassword,
    updateOfflineModeStatus,
} from "./offline-db";

// NextAuth CredentialsProvider authorize 함수
async function authorize(credentials: any) {
    if (!credentials?.email || !credentials?.password) {
        return null;
    }

    console.log("[Auth] Login attempt:", credentials.email);

    // ptzcontroller_desktop은 Electron 앱이므로 온라인 DB 접근 불가
    // → 오직 오프라인 DB만 사용
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
        }
    } catch (err) {
        console.error("[Auth] Offline authentication error:", err);
    }

    console.warn("[Auth] Login failed:", credentials.email);
    return null;
}

export default authorize;
