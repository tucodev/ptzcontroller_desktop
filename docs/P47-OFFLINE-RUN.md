완벽합니다! 이제 분석했습니다.

📊 현재 상태 분석
✅ 이미 구현된 것
Copy✅ lib/auth.ts: DB 타임아웃 처리 (3초)
✅ lib/offline-mode.ts: createOfflineSession() 함수
✅ lib/auth-utils.ts: requireSession() - 오프라인 세션 지원
✅ Prisma schema: User 모델 (id, email, password, role)
⚠️ 부족한 것
Copy❌ 오프라인 모드 사용자 저장소 (캐시)
❌ 오프라인 사용자 인증 (password 검증)
❌ P-47 완전 구현
🔧 P-47 구현 계획
Step 1: 오프라인 사용자 저장소 (SQLite/JSON)
Copy// lib/offline-users.ts (NEW)

- getOfflineUser(email, password)
- saveOfflineUser(user)
- updateOfflineUser(user)
  Step 2: 오프라인 인증 수정
  Copy// lib/auth.ts (MODIFY)
  authorize() 함수에서:
- DB 실패 시 → 오프라인 사용자 저장소에서 조회
- password 검증 후 반환
  Step 3: 오프라인 라이선스 검증
  Copy// lib/offline-mode.ts (MODIFY)
- 오프라인 진입 시 라이선스 파일 검증
- 라이선스 없으면 요청 생성
  🎯 다음 단계
  P-47 구현을 위해:

lib/offline-mode.ts 전체 코드 보기
Prisma User 모델 확인 완료
새로운 파일 작성:
lib/offline-users.ts (오프라인 사용자 관리)
lib/offline-auth.ts (오프라인 인증 로직)

완벽합니다! 이제 P‑47 오프라인 모드의 전체 구조가 명확합니다.

📊 P‑47 오프라인 모드 분석
현재 ptzcontroller_admin 상태
✅ lib/offline-mode.ts – DB 연결 감지 및 오프라인 세션 생성
✅ lib/auth-utils.ts – requireSession() 은 오프라인 세션 허용
❌ 문제: lib/auth.ts 의 authorize() 함수가 DB 오류 시 null 반환 → 로그인 불가
필요한 개선사항
1단계: 오프라인 사용자 저장소 구현

Copy// lib/offline-users.ts (새 파일)
// 로컬 JSON 기반 사용자 저장소
interface OfflineUser {
id: string;
email: string;
name: string;
passwordHash: string;
role: 'user' | 'admin';
createdAt: string;
offline: true;
}

function getOfflineUser(email: string): OfflineUser | null { ... }
function saveOfflineUser(user: OfflineUser): void { ... }
function verifyOfflinePassword(email: string, password: string): OfflineUser | null { ... }
2단계: auth.ts 수정 – 오프라인 폴백

Copy// lib/auth.ts authorize() 함수
async authorize(credentials) {
if (!credentials?.email || !credentials?.password) return null;

try {
const user = await Promise.race([
prisma.user.findUnique({...}),
new Promise(resolve => setTimeout(() => resolve(null), 3000))
]);

    if (user && await bcrypt.compare(credentials.password, user.password)) {
      return { id: user.id, email: user.email, ... };
    }

} catch (err) {
// DB 오류 → 오프라인 사용자 저장소 확인
const offlineUser = verifyOfflinePassword(credentials.email, credentials.password);
if (offlineUser) return offlineUser;
}

return null;
}
3단계: 오프라인 진입 시 라이선스 검증

Copy// lib/offline-mode.ts 수정
export async function createOfflineSession(): OfflineSession {
// 오프라인 모드 진입 시:
// 1. 라이선스 파일 검증
// 2. 만료되었으면 warning 로그
// 3. 없으면 요청 파일 생성
await verifyOfflineLicense();

return {
user: { id: 'offline', ... },
offline: true,
};
}

📋 P-47 구현 계획 (SQLite + 자동 저장 + 라이선스 필수)
아키텍처
C:\ProgramData\PTZController\
 ├─ offline.db (SQLite - 오프라인 사용자 저장소)
├─ offline.ptzlic (라이선스 파일)
└─ data/
└─ settings.json
구현 순서

온라인 로그인
사용자 입력 (email, password)
↓
Prisma User 테이블 조회 (bcrypt 검증)
↓
✅ 성공 → offline.db에 저장 (추가 필드 포함)
├─ lastOnlineLoginAt = 현재 시간
├─ lastSyncAt = 현재 시간
├─ platform = 'windows' | 'macos' | 'linux'
└─ appVersion = 앱 버전
↓
NextAuth JWT 세션 생성
오프라인 로그인
사용자 입력 (email, password)
↓
Prisma User 테이블 조회 실패 (DB 타임아웃)
↓
offline.db에서 조회 (bcrypt 검증)
↓
✅ 성공 → 상태 업데이트
├─ isInOfflineMode = 1
├─ offlineStartedAt = 현재 시간
├─ failedLoginAttempts = 0 (초기화)
└─ lockedUntil = NULL (해제)
↓
NextAuth JWT 세션 생성
라이선스 검증 (P-46)
오프라인 진입
↓
verifyOfflineLicense() 호출
↓
updateLicenseStatus(email, 'valid', expiresAt)
↓
offline.db 업데이트
├─ licenseStatus = 'valid'
└─ licenseExpiresAt = 만료 시간
✅ 준비 완료
이제 offline.db는 다음을 저장합니다:

카테고리 필드 수 예시
기본 인증 7개 id, email, passwordHash, ...
확장 정보 1개 organization
동기화 추적 3개 lastOnlineLoginAt, lastSyncAt, isInOfflineMode
라이선스 (P-46) 4개 machineId, licenseStatus, licenseExpiresAt, ...
보안 & 감시 4개 failedLoginAttempts, lockedUntil, ...
환경 정보 4개 platform, appVersion, ...
합계 23개

📊 최종 offline_users 테이블 스키마

CREATE TABLE offline_users (
-- 기본 인증 정보 (필수)
id TEXT PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
name TEXT NOT NULL,
passwordHash TEXT NOT NULL,
role TEXT NOT NULL DEFAULT 'user',

-- 기본 정보 확장
organization TEXT,

-- 시간 정보 (필수)
createdAt TEXT NOT NULL,
updatedAt TEXT NOT NULL,

-- 오프라인 동기화 추적
lastOnlineLoginAt TEXT, -- 마지막 온라인 로그인
lastSyncAt TEXT, -- 마지막 동기화
isInOfflineMode INTEGER DEFAULT 0, -- 현재 오프라인 여부

-- 라이선스 & 기기 추적 (P-46)
machineId TEXT, -- 현재 기기 HWID
lastMachineId TEXT, -- 마지막 기기 ID
licenseStatus TEXT, -- 라이선스 상태
licenseExpiresAt TEXT, -- 라이선스 만료 시간

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

CREATE INDEX idx_offline_users_email ON offline_users(email);
CREATE INDEX idx_offline_users_machineId ON offline_users(machineId);
CREATE INDEX idx_offline_users_isActive ON offline_users(isActive);
