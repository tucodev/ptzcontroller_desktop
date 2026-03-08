/**
 * offline-db.ts (완전 구현)
 *
 * SQLite 기반 오프라인 사용자 저장소
 * 경로: C:\ProgramData\PTZController\offline.db
 *
 * 테이블: offline_users (23개 필드)
 *   - 기본 인증 (7개): id, email, name, passwordHash, role, createdAt, updatedAt
 *   - 확장 정보 (1개): organization
 *   - 동기화 추적 (3개): lastOnlineLoginAt, lastSyncAt, isInOfflineMode
 *   - 라이선스 (4개): machineId, lastMachineId, licenseStatus, licenseExpiresAt
 *   - 보안 (4개): failedLoginAttempts, lastFailedLoginAt, lockedUntil, isActive
 *   - 환경 (4개): offlineSessionToken, offlineStartedAt, platform, appVersion
 */

import Database from "better-sqlite3";
import path from "path";
import { createHash } from "crypto";
import os from "os";

export interface OfflineUserRecord {
    // 기본 인증 정보
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    role: "user" | "admin";
    createdAt: string;
    updatedAt: string;

    // 기본 정보 확장
    organization?: string;

    // 오프라인 동기화 추적
    lastOnlineLoginAt?: string;
    lastSyncAt?: string;
    isInOfflineMode?: number; // 0 = online, 1 = offline

    // 라이선스 & 기기 추적 (P-46)
    machineId?: string;
    lastMachineId?: string;
    licenseStatus?: string; // 'valid' | 'expired' | 'pending' | 'none'
    licenseExpiresAt?: string;

    // 보안 & 감시
    failedLoginAttempts?: number;
    lastFailedLoginAt?: string;
    lockedUntil?: string;
    isActive?: number; // 0 = inactive, 1 = active

    // 오프라인 환경 정보
    offlineSessionToken?: string;
    offlineStartedAt?: string;
    platform?: string; // 'windows' | 'macos' | 'linux'
    appVersion?: string;
}

let db: Database.Database | null = null;

/**
 * SQLite DB 파일 경로 (크로스 플랫폼)
 */
function getOfflineDbPath(): string {
    let dataDir: string;

    if (process.platform === "win32") {
        dataDir = path.join(
            process.env.PROGRAMDATA || "C:\\ProgramData",
            "PTZController",
        );
    } else if (process.platform === "darwin") {
        dataDir = path.join(
            process.env.HOME || os.homedir(),
            "Library/Application Support/PTZController",
        );
    } else {
        // Linux
        dataDir = path.join(
            process.env.HOME || os.homedir(),
            ".config/PTZController",
        );
    }

    return path.join(dataDir, "offline.db");
}

/**
 * SQLite DB 초기화
 */
export function initOfflineDb(): void {
    try {
        const dbPath = getOfflineDbPath();
        db = new Database(dbPath);

        // WAL 모드 활성화 (동시성 증가)
        db.pragma("journal_mode = WAL");

        // 테이블 생성 (없으면)
        db.exec(`
      CREATE TABLE IF NOT EXISTS offline_users (
        -- 기본 인증 정보
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        
        -- 기본 정보 확장
        organization TEXT,
        
        -- 오프라인 동기화 추적
        lastOnlineLoginAt TEXT,
        lastSyncAt TEXT,
        isInOfflineMode INTEGER DEFAULT 0,
        
        -- 라이선스 & 기기 추적 (P-46)
        machineId TEXT,
        lastMachineId TEXT,
        licenseStatus TEXT DEFAULT 'none',
        licenseExpiresAt TEXT,
        
        -- 보안 & 감시
        failedLoginAttempts INTEGER DEFAULT 0,
        lastFailedLoginAt TEXT,
        lockedUntil TEXT,
        isActive INTEGER DEFAULT 1,
        
        -- 오프라인 환경 정보
        offlineSessionToken TEXT,
        offlineStartedAt TEXT,
        platform TEXT,
        appVersion TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_offline_users_email ON offline_users(email);
      CREATE INDEX IF NOT EXISTS idx_offline_users_machineId ON offline_users(machineId);
      CREATE INDEX IF NOT EXISTS idx_offline_users_isActive ON offline_users(isActive);
    `);

        console.log("[OfflineDB] Initialized at:", dbPath);
    } catch (err) {
        console.error("[OfflineDB] Initialization failed:", err);
        throw err;
    }
}

/**
 * DB 연결 종료
 */
export function closeOfflineDb(): void {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * 현재 DB 연결 가져오기
 */
function getDb(): Database.Database {
    if (!db) {
        initOfflineDb();
    }
    return db!;
}

/**
 * 이메일로 사용자 조회
 */
export function getOfflineUser(email: string): OfflineUserRecord | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM offline_users WHERE email = ?");
    const user = stmt.get(email) as OfflineUserRecord | undefined;
    return user ?? null;
}

/**
 * ID로 사용자 조회
 */
export function getOfflineUserById(id: string): OfflineUserRecord | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM offline_users WHERE id = ?");
    const user = stmt.get(id) as OfflineUserRecord | undefined;
    return user ?? null;
}

/**
 * 기기 ID로 사용자 조회 (P-46)
 */
export function getOfflineUserByMachineId(
    machineId: string,
): OfflineUserRecord | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM offline_users WHERE machineId = ?");
    const user = stmt.get(machineId) as OfflineUserRecord | undefined;
    return user ?? null;
}

/**
 * 모든 사용자 조회 (admin용)
 */
export function getAllOfflineUsers(): OfflineUserRecord[] {
    const db = getDb();
    const stmt = db.prepare(
        "SELECT * FROM offline_users WHERE isActive = 1 ORDER BY createdAt DESC",
    );
    return stmt.all() as OfflineUserRecord[];
}

/**
 * 활성 사용자만 조회
 */
export function getActiveOfflineUsers(): OfflineUserRecord[] {
    return getAllOfflineUsers(); // 이미 isActive = 1 필터링됨
}

/**
 * 사용자 저장/업데이트
 */
export function saveOfflineUser(
    user: Omit<OfflineUserRecord, "createdAt" | "updatedAt"> & {
        id?: string;
        createdAt?: string;
    },
): OfflineUserRecord {
    const db = getDb();

    const id = user.id || generateId();
    const now = new Date().toISOString();
    const existing = getOfflineUser(user.email);

    if (existing) {
        // 업데이트 (모든 필드 업데이트 가능)
        const stmt = db.prepare(`
      UPDATE offline_users
      SET 
        name = ?,
        organization = ?,
        passwordHash = ?,
        role = ?,
        machineId = ?,
        lastMachineId = ?,
        licenseStatus = ?,
        licenseExpiresAt = ?,
        lastOnlineLoginAt = ?,
        lastSyncAt = ?,
        isInOfflineMode = ?,
        offlineSessionToken = ?,
        offlineStartedAt = ?,
        platform = ?,
        appVersion = ?,
        failedLoginAttempts = ?,
        lastFailedLoginAt = ?,
        lockedUntil = ?,
        isActive = ?,
        updatedAt = ?
      WHERE email = ?
    `);

        stmt.run(
            user.name,
            user.organization || null,
            user.passwordHash,
            user.role,
            user.machineId || null,
            user.lastMachineId || null,
            user.licenseStatus || null,
            user.licenseExpiresAt || null,
            user.lastOnlineLoginAt || null,
            user.lastSyncAt || null,
            user.isInOfflineMode ?? 0,
            user.offlineSessionToken || null,
            user.offlineStartedAt || null,
            user.platform || null,
            user.appVersion || null,
            user.failedLoginAttempts ?? 0,
            user.lastFailedLoginAt || null,
            user.lockedUntil || null,
            user.isActive ?? 1,
            now,
            user.email,
        );

        return getOfflineUser(user.email)!;
    } else {
        // 삽입 (새 사용자)
        const stmt = db.prepare(`
      INSERT INTO offline_users (
        id, email, name, organization, passwordHash, role,
        machineId, lastMachineId, licenseStatus, licenseExpiresAt,
        lastOnlineLoginAt, lastSyncAt, isInOfflineMode,
        offlineSessionToken, offlineStartedAt, platform, appVersion,
        failedLoginAttempts, lastFailedLoginAt, lockedUntil, isActive,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        stmt.run(
            id,
            user.email,
            user.name,
            user.organization || null,
            user.passwordHash,
            user.role,
            user.machineId || null,
            user.lastMachineId || null,
            user.licenseStatus || null,
            user.licenseExpiresAt || null,
            user.lastOnlineLoginAt || null,
            user.lastSyncAt || null,
            user.isInOfflineMode ?? 0,
            user.offlineSessionToken || null,
            user.offlineStartedAt || null,
            user.platform || null,
            user.appVersion || null,
            user.failedLoginAttempts ?? 0,
            user.lastFailedLoginAt || null,
            user.lockedUntil || null,
            user.isActive ?? 1,
            user.createdAt || now,
            now,
        );

        return getOfflineUser(user.email)!;
    }
}

/**
 * 비밀번호 검증 (bcrypt 필요)
 */
export async function verifyOfflinePassword(
    email: string,
    password: string,
    bcryptModule: any, // bcryptjs import 필요
): Promise<OfflineUserRecord | null> {
    const user = getOfflineUser(email);
    if (!user) return null;

    // 계정 잠금 확인
    if (user.lockedUntil) {
        const lockTime = new Date(user.lockedUntil);
        if (lockTime > new Date()) {
            console.warn("[OfflineDB] Account locked until:", user.lockedUntil);
            return null;
        }
    }

    // 비활성 계정 확인
    if (user.isActive !== 1) {
        console.warn("[OfflineDB] Account is inactive");
        return null;
    }

    // 비밀번호 검증
    const isValid = await bcryptModule.compare(password, user.passwordHash);

    if (!isValid) {
        // 실패 횟수 증가
        const failedCount = (user.failedLoginAttempts ?? 0) + 1;
        const shouldLock = failedCount >= 5; // 5회 실패 시 잠금

        const updateStmt = db!.prepare(`
      UPDATE offline_users
      SET 
        failedLoginAttempts = ?,
        lastFailedLoginAt = ?,
        lockedUntil = ?
      WHERE email = ?
    `);

        updateStmt.run(
            failedCount,
            new Date().toISOString(),
            shouldLock
                ? new Date(Date.now() + 30 * 60 * 1000).toISOString()
                : null, // 30분 잠금
            email,
        );

        return null;
    }

    // 로그인 성공 – 실패 횟수 초기화
    const successStmt = db!.prepare(`
    UPDATE offline_users
    SET 
      failedLoginAttempts = 0,
      lastFailedLoginAt = NULL,
      lockedUntil = NULL,
      lastOnlineLoginAt = ?,
      updatedAt = ?
    WHERE email = ?
  `);

    successStmt.run(new Date().toISOString(), new Date().toISOString(), email);

    return getOfflineUser(email);
}

/**
 * 라이선스 상태 업데이트 (P-46)
 */
export function updateLicenseStatus(
    email: string,
    status: "valid" | "expired" | "pending" | "none",
    expiresAt?: string,
): void {
    const db = getDb();
    const stmt = db.prepare(`
    UPDATE offline_users
    SET licenseStatus = ?, licenseExpiresAt = ?, updatedAt = ?
    WHERE email = ?
  `);

    stmt.run(status, expiresAt || null, new Date().toISOString(), email);
}

/**
 * 기기 ID 업데이트 (P-46)
 */
export function updateMachineId(email: string, machineId: string): void {
    const db = getDb();

    // 이전 machineId를 lastMachineId로 저장
    const user = getOfflineUser(email);
    if (user?.machineId) {
        const stmt = db.prepare(`
      UPDATE offline_users
      SET machineId = ?, lastMachineId = ?, updatedAt = ?
      WHERE email = ?
    `);
        stmt.run(machineId, user.machineId, new Date().toISOString(), email);
    }
}

/**
 * 오프라인 모드 상태 업데이트
 */
export function updateOfflineModeStatus(
    email: string,
    isOffline: boolean,
    machineId?: string,
): void {
    const db = getDb();

    const stmt = db.prepare(`
    UPDATE offline_users
    SET 
      isInOfflineMode = ?,
      offlineStartedAt = ?,
      machineId = ?,
      platform = ?,
      appVersion = ?,
      updatedAt = ?
    WHERE email = ?
  `);

    stmt.run(
        isOffline ? 1 : 0,
        isOffline ? new Date().toISOString() : null,
        machineId || null,
        process.platform,
        process.env.npm_package_version || null,
        new Date().toISOString(),
        email,
    );
}

/**
 * 동기화 시간 업데이트
 */
export function updateSyncTime(email: string): void {
    const db = getDb();
    const stmt = db.prepare(`
    UPDATE offline_users
    SET lastSyncAt = ?, updatedAt = ?
    WHERE email = ?
  `);

    stmt.run(new Date().toISOString(), new Date().toISOString(), email);
}

/**
 * 사용자 삭제 (admin용)
 */
export function deleteOfflineUser(email: string): boolean {
    const db = getDb();
    const stmt = db.prepare("DELETE FROM offline_users WHERE email = ?");
    const result = stmt.run(email);
    return result.changes > 0;
}

/**
 * 사용자 비활성화 (완전 삭제 대신 사용)
 */
export function deactivateOfflineUser(email: string): void {
    const db = getDb();
    const stmt = db.prepare(`
    UPDATE offline_users
    SET isActive = 0, updatedAt = ?
    WHERE email = ?
  `);

    stmt.run(new Date().toISOString(), email);
}

/**
 * ID 생성
 */
function generateId(): string {
    return `offline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * DB 통계 (디버깅용)
 */
export function getOfflineDbStats(): {
    totalUsers: number;
    activeUsers: number;
    lockedUsers: number;
    usersWithLicense: number;
    usersInOfflineMode: number;
} {
    const db = getDb();

    const totalStmt = db.prepare("SELECT COUNT(*) as count FROM offline_users");
    const activeStmt = db.prepare(
        "SELECT COUNT(*) as count FROM offline_users WHERE isActive = 1",
    );
    const lockedStmt = db.prepare(
        'SELECT COUNT(*) as count FROM offline_users WHERE lockedUntil IS NOT NULL AND lockedUntil > datetime("now")',
    );
    const licenseStmt = db.prepare(
        'SELECT COUNT(*) as count FROM offline_users WHERE licenseStatus IS NOT NULL AND licenseStatus != "none"',
    );
    const offlineStmt = db.prepare(
        "SELECT COUNT(*) as count FROM offline_users WHERE isInOfflineMode = 1",
    );

    return {
        totalUsers: (totalStmt.get() as { count: number }).count,
        activeUsers: (activeStmt.get() as { count: number }).count,
        lockedUsers: (lockedStmt.get() as { count: number }).count,
        usersWithLicense: (licenseStmt.get() as { count: number }).count,
        usersInOfflineMode: (offlineStmt.get() as { count: number }).count,
    };
}
