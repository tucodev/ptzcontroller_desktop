# PTZ Controller Desktop - EXE 빌드 가이드

exe로 빌드하기 문서임

# 빌드하기 총정리

1. node_module 설치

```
cd ../ptzcontroller_admin
yarn install
```

2. Next.js 빌드

```
(1) 첫 빌드시
yarn build-cloudtype
또는
yarn build

(2) 재 빌드시
yarn rebuild
```

3. standalone 복사 (.env 포함)

```
cd ../ptzcontroller_desktop

npm install

npm run copy:standalone
```

4. (선택) Node.js 번들 - 설치 환경에 Node 없을 때

```
node scripts/bundle-node.js
```

5. EXE 빌드

```
npm run make:win
```

### 이하는 상세설명임

## 폴더 구조 (전제 조건)

```
(상위 폴더)/
├── ptzcontroller_admin/      ← Next.js 소스 (원본 웹앱)
└── ptzcontroller_desktop/  ← 이 폴더 (Electron 래퍼)
```

---

## 빌드 전 체크리스트

- [ ] Node.js 18+ 설치
- [ ] `ptzcontroller_admin/` 폴더가 상위 디렉토리에 있는지 확인
- [ ] `ptzcontroller_admin/.env` 파일에 `DATABASE_URL`, `NEXTAUTH_SECRET` 설정 확인
- [ ] `assets/icon.ico`, `assets/icon.png` 파일 배치 (256×256 이상)

---

## Step 1: Next.js 빌드

```bash
cd ../ptzcontroller_admin
yarn install   # 첫 실행 시
yarn build
```

빌드 완료 후 `ptzcontroller_admin/.next/standalone/` 폴더가 생성되어야 함.

---

## Step 2: standalone 복사

```bash
cd ../ptzcontroller_desktop
npm install    # 첫 실행 시
npm run copy:standalone
```

완료 후 `ptzcontroller_desktop/standalone/` 폴더 확인.

---

## Step 3: 개발 모드 테스트 (선택사항)

```bash
npm start
```

Electron 창이 열리고 PTZ Controller가 로드되면 정상.

---

## Step 4: EXE 빌드 (Windows)

```bash
npm run make:win
```

빌드 결과물: `out/make/squirrel.windows/x64/PTZControllerSetup.exe`

---

## 자주 발생하는 문제 해결

### ❌ "server.js not found"

**원인:** `npm run copy:standalone` 을 하지 않았거나 Next.js 빌드가 안 된 경우  
**해결:** Step 1, 2 다시 실행

---

### ❌ "Failed to start server: node not found" (패키징 후)

**원인:** 패키지된 EXE 환경에 Node.js가 없음  
**해결 A (권장):** Node.js 포터블을 번들에 포함

```bash
node scripts/bundle-node.js   # node-bin/ 폴더 생성
```

그 다음 `forge.config.js`의 `extraResource`에 `'./node-bin'` 추가:

```js
extraResource: [
    "./standalone",
    "./node-bin", // ← 추가
];
```

`electron/main.js`의 `getNodeExecutable()` 함수에서 `process.resourcesPath/node-bin/node.exe`를 찾도록 이미 설정되어 있음.

**해결 B:** 설치 대상 PC에 Node.js 설치 필수라고 안내

---

### ❌ DATABASE_URL 관련 에러

**원인:** `.env` 파일이 standalone에 복사되지 않음  
**해결:** `npm run copy:standalone` 재실행 (`.env`도 자동 복사됨)

---

### ❌ Prisma "engine not found" 에러

**원인:** `asar: true` 설정 시 native 바이너리가 asar에 묶임  
**해결:** `forge.config.js`의 `asar.unpackDir`에 prisma 경로 포함 (이미 수정됨)

---

### ❌ Squirrel maker 빌드 에러 (`iconUrl` 관련)

**원인:** `iconUrl`에 접근 불가능한 URL 설정  
**해결:** `forge.config.js`에서 `iconUrl` 항목 제거 (이미 수정됨)

---

## 최종 배포 파일

| 파일                                                   | 용도          |
| ------------------------------------------------------ | ------------- |
| `out/make/squirrel.windows/x64/PTZControllerSetup.exe` | 설치 파일     |
| `out/make/zip/win32/x64/PTZ Controller-win32-x64.zip`  | 무설치 포터블 |

---

## 환경변수 (.env) 관리

`.env` 파일은 빌드 시 `standalone/.env`로 복사됩니다.  
`DATABASE_URL`이 외부 PostgreSQL을 가리키므로, 배포 환경에서 DB 접근이 가능해야 합니다.

**오프라인 환경에서 사용하려면:** SQLite로 전환하거나 로컬 PostgreSQL을 함께 배포하세요.
