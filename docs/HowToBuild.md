# 빌드하기

## 기본 사항

---

## neon 접속 정보: github로 tucodev@gmail.com

```
# PTZ Controller Desktop — 환경변수 설정 파일
#
# 사용법:
# 1. 이 파일을 .env-in-standalone 이름으로 복사 (또는 standalone/.env 로 직접 복사)
# 2. 아래 항목들을 실제 값으로 채워 넣으세요
# 3. .env-in-standalone / standalone/.env 는 절대 Git에 커밋하지 마세요
#
# copy:standalone 실행 시 ptzcontroller_admin/.env 를 자동으로 standalone/.env 로 복사합니다.
# 이 파일은 개발자 참조용 템플릿입니다.

# Port (admin Server)
#PORT=3000
# Port (license Server)
PORT=4000

# ── SQLite 백업 모드 (DB_TYPE=neon 일 때만 유효) ─────────────
# ptzcontroller_desktop, license_server, ptz_proxy 에서는 의미 없음
#
# on : Neon 저장 + SQLite에도 동기화 (이중 저장)
# off : Neon에만 저장 (기본값)
# DB_TYPE=sqlite 이면 이 값은 무시됨 (SQLite가 유일한 저장소)
STORAGE_MODE=off

# ── DB 선택 ───────────────────────────────────────────────────
# ptzcontroller_desktop, license_server, ptz_proxy 에서는 의미 없음

#
# sqlite : 로컬/온프레미스 (기본값, data/license.db 파일 생성)
# neon : 클라우드 (DATABASE_URL 필수)
# 버그 수정: 기존 파일에 주석 없는 "or" 라인이 있어 dotenv 파싱 오류 발생
# → 두 줄 모두 주석 처리, 사용할 것만 주석 해제
#DB_TYPE=sqlite
# or
DB_TYPE=neon

# ── 데이터베이스 (필수) ───────────────────────────────────────
# PostgreSQL 접속 URL (NeonDB, Supabase, 로컬 PG 등)
DATABASE_URL="postgresql://neondb_owner:npg_cP1qQeFoMkO3@ep-patient-waterfall-a1tk4pzw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"

# ── NextAuth (필수) ───────────────────────────────────────────
# 충분히 길고 랜덤한 문자열 (openssl rand -base64 32)
NEXTAUTH_SECRET="wdaa3EIyANLmrkF4ENZ6WRs8HDD0zQUJ"
# Electron 내장 서버는 반드시 http (https 사용 시 로그인 실패)
NEXTAUTH_URL="http://localhost:3000"

# ── 라이선스 (선택) ───────────────────────────────────────────
# 오프라인 라이선스 서명에 사용하는 시크릿
LICENSE_SECRET="TYCHE-PTZ-GOOD-BLESS-2026"
# 온라인 라이선스 발급 서버 URL (없으면 오프라인 모드만 동작)
LICENSE_SERVER_URL="http://localhost:4000"
# 관리자 대시보드 비밀번호 (Basic Auth)
JWT_SECRET=IMGOINGTOGOODHEAVENHELLOTYCHE23
JWT_EXPIRES=8h

# ── 초기 superadmin 계정 시드 ────────────────────────────────
# admins 테이블이 비어 있을 때 최초 1회만 생성
# 서버 실행 후 대시보드에서 비밀번호 변경 후 아래 항목 제거 권장
INIT_ADMIN_USERNAME=admin
INIT_ADMIN_PASSWORD=hellotyche!

# P-48 추가: 이메일 설정 (SMTP)
#
# 1. Google 계정 → 보안 → 앱 비밀번호
# 2. 앱 선택: Mail
# 3. 기기 선택: Windows PC (또는 해당 OS)
# 4. 생성된 16자리 비밀번호를 SMTP_PASSWORD에 입력
#

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cumtyche@gmail.com
SMTP_PASSWORD=wbjnrgeyonwftrvi
APP_URL=http://localhost:3000

# sms 정보
ALIGO_API_KEY=ave4ls1tcjg1m3gpeybp2mnw07zemjmr
ALIGO_USER_ID=tuco
ALIGO_SENDER=01094832363
```

---

## 빌드 순서 (총정리)

---

### 요약 최종

#### 의존성 설치

npm install

#### 개발 모드로 실행해보기

npm run dev

#### 빌드

npm run prebuild

#### 데스크톱 앱 패키징

node scripts/bundle-node.js

npm run make:win # Windows
npm run make:mac # macOS
npm run make:linux # Linux

---

### 요약

#### 먼저 ptzcontroller_admin 을 빌드해야함. (standalone 사용을 위해)

```
# 이미 빌드시 생략 가능
cd ../ptzcontroller_admin
yarn install        # 최초 1회
yarn build          # prisma generate + next build
  or
yarn rebuild        # next build 만

# 다음

```

````
cd ../ptzcontroller_desktop
npm install # 최초 1회
npm run copy:standalone

node scripts/bundle-node.js

# 인스톨러(.exe) + Portable(.zip) 동시 생성
npm run make:win:portable

# ZIP이 이미 있을 때 Portable만 생성
npm run make:portable

# Windows exe, setup 만 생성
npm run make:win

```

## 상세 플로우 (테스트 명령 등 포함)

### Step 1: 먼저 바탕이되는 ptzcontroller_admin 빌드

이미 빌드시 생략

```bash
cd ../ptzcontroller_admin
yarn install        # 최초 1회
yarn build          # prisma generate + next build
````

빌드 완료 후 `ptzcontroller_admin/.next/standalone/` 폴더가 생성되어야 합니다.

> **재빌드 시 (의존성 변경 없을 때):**
>
> ```bash
> yarn rebuild    # next build만 실행 (빠름)
> ```

### Step 2: standalone 복사

```bash
cd ../ptzcontroller_desktop
npm install         # 최초 1회 (주의: yarn install 로 하지 말것)
npm run copy:standalone
```

이 스크립트는 다음을 수행합니다:

| 단계  | 내용                                   |
| ----- | -------------------------------------- |
| [1/6] | `standalone/` 복사                     |
| [2/6] | `.next/static/` 복사                   |
| [3/6] | `public/` 복사                         |
| [4/6] | `data/` 복사                           |
| [5/6] | `.env` 복사 + `NEXTAUTH_URL` 자동 추가 |
| [6/6] | Prisma 엔진 바이너리 강제 복사         |

완료 후 `ptzcontroller_desktop/standalone/` 폴더를 확인하세요.

### Step 3: 개발 모드 테스트 (권장)

```bash
npm start
```

Electron 창이 열리고 PTZ Controller가 정상 로드되면 OK.

### Step 4: (선택) Node.js 포터블 번들

설치 대상 PC에 Node.js가 없을 경우 Node.js를 함께 번들합니다.

```bash
node scripts/bundle-node.js
```

완료 후 `node-bin/` 폴더 생성. 그 다음 `forge.config.js`의 `extraResource`에 추가:

```javascript
extraResource: [
    "./standalone",
    "./node-bin",   // ← 추가
],
```

> `electron/main.js`의 `getNodeExecutable()` 함수가 이미 `process.resourcesPath/node-bin/node.exe`를 우선 탐색하도록 구현되어 있습니다.

### Step 5: EXE 빌드

```bash
# Windows Squirrel 설치 파일 + ZIP
npm run make:win

# macOS
npm run make:mac

# Linux
npm run make:linux
```

### Step 6: Portable 빌드

```bash
# 인스톨러(.exe) + Portable(.zip) 동시 생성
npm run make:win:portable

# ZIP이 이미 있을 때 Portable만 생성
npm run make:portable
```

### 기타 디버깅

```
DEV_MODE 소스내 변수 (node env "development" 일때 디버깅 브라우져가 뜬다)
소스 수정으로 pack 되지 않았을 때만 디버깅모드로
```
