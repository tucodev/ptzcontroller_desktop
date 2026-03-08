/**
 * offline-mode.ts (수정)
 * 
 * 변경사항:
 * 1. createOfflineSession() 호출 시 라이선스 검증 추가
 * 2. 라이선스 파일 검증 및 만료 체크
 * 3. 라이선스 없으면 요청 파일 생성
 */

import { prisma } from './db';
import { verifyLicense, getLicenseDir, createLicenseRequest, saveRequestFile } from './license';
import path from 'path';
import fs from 'fs';

// ... (기존 코드 유지)

export interface OfflineSession {
  user: {
    id:    string;
    name:  string;
    email: string;
    role:  'user'; // 오프라인은 항상 user 고정
  };
  offline: true;
  license?: {
    valid: boolean;
    expiresAt?: string;
    reason?: string;
  };
}

// ... (기존 캐시 코드 유지)

export async function isDbAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_dbAvailable !== null && now - _lastCheckTime < CACHE_TTL_MS) {
    return _dbAvailable;
  }

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB check timeout')), DB_CHECK_TIMEOUT_MS)
      ),
    ]);
    _dbAvailable = true;
  } catch (err) {
    _dbAvailable = false;
    console.warn('[OfflineMode] DB connection failed — offline mode activated:', (err as Error).message);
  }

  _lastCheckTime = Date.now();
  return _dbAvailable;
}

export function resetDbCache(): void {
  _dbAvailable   = null;
  _lastCheckTime = 0;
}

/**
 * 라이선스 파일 검증 (P-46)
 * 
 * 반환:
 *   { valid: true, expiresAt: "2027-03-07T..." }  – 라이선스 유효
 *   { valid: false, reason: "Expired" }           – 라이선스 만료
 *   { valid: false, reason: "Not found" }         – 라이선스 없음
 */
async function verifyOfflineLicense(): Promise<{ valid: boolean; expiresAt?: string; reason?: string }> {
  try {
    const licenseDir = getLicenseDir();
    const licenseFile = path.join(licenseDir, 'offline.ptzlic');
    
    // 라이선스 파일 존재 여부 확인
    if (!fs.existsSync(licenseFile)) {
      console.warn('[OfflineMode] License file not found. Creating license request...');
      
      // 요청 파일 생성
      try {
        const request = await createLicenseRequest();
        await saveRequestFile(request);
        console.log('[OfflineMode] License request saved. Please upload to license server.');
      } catch (err) {
        console.warn('[OfflineMode] Failed to create license request:', err);
      }
      
      return { valid: false, reason: 'Not found' };
    }
    
    // 라이선스 파일 검증
    const licenseContent = fs.readFileSync(licenseFile, 'utf-8').trim();
    const result = verifyLicense(licenseContent);
    
    if (!result.valid) {
      console.warn('[OfflineMode] License validation failed:', result.reason);
      return result;
    }
    
    // 라이선스 만료 시간까지의 남은 시간 로깅
    const expiresAt = new Date(result.expiresAt || '');
    const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 30) {
      console.warn(`[OfflineMode] License expires in ${daysLeft} days`);
    }
    
    return result;
  } catch (err) {
    console.error('[OfflineMode] License verification error:', err);
    return { valid: false, reason: 'Verification error' };
  }
}

/**
 * 오프라인 세션 생성
 * 라이선스 검증 포함 (필수)
 */
export async function createOfflineSession(): Promise<OfflineSession> {
  // P-47: 라이선스 검증
  const licenseStatus = await verifyOfflineLicense();
  
  // 라이선스 검증 실패 시 경고 로그 (하지만 앱은 실행됨)
  if (!licenseStatus.valid) {
    console.warn('[OfflineMode] Offline mode activated WITHOUT valid license');
    console.warn('[OfflineMode] Reason:', licenseStatus.reason);
  } else {
    console.log('[OfflineMode] Offline mode activated WITH valid license');
    console.log('[OfflineMode] Expires at:', licenseStatus.expiresAt);
  }
  
  return {
    user: {
      id:    'offline',
      name:  'Offline User',
      email: 'offline@local',
      role:  'user',
    },
    offline: true,
    license: licenseStatus,
  };
}

/**
 * 주어진 세션이 오프라인 세션인지 확인
 */
export function isOfflineSession(session: unknown): session is OfflineSession {
  return (
    typeof session === 'object' &&
    session !== null &&
    (session as OfflineSession).offline === true
  );
}
