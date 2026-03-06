# PTZ Controller Desktop — 동작 구조 분석

> 작성일: 2026-03-06  
> 분석 대상: `ptzcontroller_desktop` (Electron 래퍼 앱)  
> 연관 프로젝트: `ptzcontroller_admin` (Next.js 웹앱)

---

## 1. 전체 아키텍처 개요

```
┌──────────────────────────────────────────────────────────────┐
│                        Electron 앱                            │
│                                                              │
│  ┌──────────────────┐        ┌────────────────────────────┐  │
│  │  Main Process    │        │  Renderer Process          │  │
│  │  (main.js)       │◄─IPC──►│  BrowserWindow             │  │
│  │                  │        │  http://localhost:3000     │  │
│  └────────┬─────────┘        └────────────────────────────┘  │
│           │                                                   │
│           │ child_process.spawn()                             │
│           ▼                                                   │
│  ┌──────────────────┐                                        │
│  │  Next.js 서버     │  ← standalone/server.js               │
│  │  (Node.js)       │  ← PORT 3000                           │
│  └────────┬─────────┘                                        │
│           │                                                   │
└───────────┼──────────────────────────────────────────────────┘
            │ Prisma ORM (HTTPS)
            ▼
     ┌─────────────┐
     │   NeonDB    │  ← 클라우드 PostgreSQL (ap-southeast-1)
     │ (PostgreSQL)│
     └─────────────┘
```

**핵심 개념:**  
Electron이 Next.js 서버를 내장 자식 프로세스로 실행하고, BrowserWindow로 그 웹앱을 표시하는 구조입니다.  
실제 앱 로직은 전부 Next.js(React + API Route) 안에 있고, **Electron은 "데스크톱 껍데기 + 서버 실행기" 역할**입니다.

---

## 2. 앱 시작 순서 (Step-by-step)

```
Electron 실행 (ptz-controller.exe)
        │
        ▼
① Squirrel 이벤트 처리
   Windows 설치/업데이트/삭제 플래그 감지 시 즉시 종료
   (electron-squirrel-startup)
        │
        ▼
② 단일 인스턴스 잠금
   이미 실행 중이면 기존 창을 포커스하고 현재 프로세스 종료
        │
        ▼
③ 시스템 트레이 아이콘 생성
   "시작 중..." 상태 표시
        │
        ▼
④ Next.js 서버 spawn
   - standalone/server.js 를 node(또는 번들된 node.exe)로 실행
   - standalone/.env 파일을 읽어 환경변수 주입
     · DATABASE_URL   : NeonDB PostgreSQL 접속 URL
     · NEXTAUTH_SECRET: JWT 서명키
     · NEXTAUTH_URL   : http://localhost:3000
     · LICENSE_SECRET : 라이선스 서명키
     · PTZ_DATA_DIR   : 공유 데이터 경로 (ProgramData/PTZController/data)
     · PTZ_FORCE_SHARED: "true" (1인용 앱 — userId 무시)
   - Prisma 엔진 바이너리 자동 탐색
     · Windows : query_engine-windows.dll.node
     · macOS   : libquery_engine-darwin-*.dylib.node
     · Linux   : libquery_engine-linux-musl-*.so.node
        │
        ▼
⑤ 서버 준비 대기 (HTTP 폴링)
   http://localhost:3000 에 응답할 때까지 폴링
   최대 60초 (120회 × 500ms 간격)
   타임아웃 시 오류 다이얼로그 표시
        │
        ▼
⑥ BrowserWindow 생성
   loadURL('http://localhost:3000') 로드
   Next.js 웹앱을 Electron 창(1280×800)에 표시
        │
        ▼
⑦ 트레이 메뉴 업데이트
   "● 실행 중 (포트 3000)" 상태로 변경
        │
        ▼
⑧ 정상 사용
```

---

## 3. 핵심 구성 요소

### 3-1. Electron Main Process (`electron/main.js`)

| 함수 | 역할 |
|---|---|
| `getStandalonePath()` | 패키징 여부에 따라 standalone 경로 결정 |
| `getNodeExecutable()` | 번들된 node.exe 또는 시스템 node 선택 |
| `getSharedDataDir()` | OS별 공유 데이터 경로 반환 |
| `parseEnv()` | `.env` 파일 파싱 (인라인 주석 제거 포함) |
| `findPrismaEngine()` | 플랫폼별 Prisma 엔진 바이너리 탐색 |
| `killNextProcess()` | Windows: taskkill /T /F, Unix: SIGTERM |
| `startNextServer()` | Next.js 서버 spawn (async, 에러 Promise 반환) |
| `waitForServer()` | HTTP 폴링으로 서버 준비 대기 |
| `createWindow()` | BrowserWindow 생성 및 설정 |
| `createTray()` | 시스템 트레이 아이콘 및 메뉴 생성 |
| `loadSettings()` | settings.json 읽기 (기본값 병합) |
| `saveSettings()` | settings.json 쓰기 (원자적 저장) |
| `showFatalError()` | 치명적 오류 다이얼로그 + 앱 종료 |
| `quitApp()` | 안전 종료 (before-quit → killNextProcess) |

### 3-2. Next.js 서버 (`standalone/server.js`)

- **Next.js 14 standalone 빌드** 결과물
- `startServer()` 함수로 HTTP 서버 실행
- `process.env.__NEXT_PRIVATE_STANDALONE_CONFIG` 에 빌드 설정 내장
- `outputFileTracingRoot` 는 런타임 `__dirname` 으로 동적 교체 (P-09 패치)
- Prisma ORM을 통해 NeonDB(PostgreSQL)에 연결
- NextAuth로 세션/인증 처리

### 3-3. Preload Script (`electron/preload.js`)

보안 격리(`contextIsolation: true`, `nodeIntegration: false`) 환경에서  
`contextBridge`를 통해 `window.electronAPI`를 렌더러에 노출:

| API | 동작 |
|---|---|
| `getAppVersion()` | 앱 버전 반환 |
| `minimizeWindow()` | 창 최소화 |
| `maximizeWindow()` | 창 최대화/복원 |
| `hideWindow()` | 트레이로 숨기기 |
| `closeWindow()` | 트레이로 숨기기 (트레이 앱 특성) |
| `startServer(port)` | PTZ Proxy 서버 시작 요청 |
| `stopServer()` | PTZ Proxy 서버 중지 요청 |
| `changePort(port)` | PTZ Proxy 포트 변경 |
| `saveSettings(obj)` | 설정 저장 |
| `requestStatus()` | 현재 상태 요청 |
| `onStatus(cb)` | 상태 업데이트 수신 |
| `onLog(cb)` | 로그 메시지 수신 |
| `onSettingsChanged(cb)` | 설정 변경 수신 |
| `onServerStatus(cb)` | 서버 상태 변경 수신 |
| `platform` | 현재 OS 플랫폼 |
| `isDev` | 개발 모드 여부 |

### 3-4. PTZ Proxy UI (`index.html`)

- PTZ 프록시 WebSocket 서버 제어 전용 UI
- 포트 설정, 시작/중지, 로그, 토큰 인증, 트레이 설정
- **현재 Main Process에 Proxy 서버 미구현** (stub 핸들러만 존재)
- `settings.json`의 `proxyPort` 값을 `request-status` IPC로 읽어 표시

---

## 4. 데이터 흐름

```
사용자 조작 (마우스/키보드)
        │
        ▼
BrowserWindow (Next.js React UI)
        │
        ├── 일반 웹앱 기능
        │       │
        │       ▼
        │   Next.js API Route (/api/*)
        │       │
        │       ▼
        │   Prisma ORM
        │       │
        │       ▼
        │   NeonDB (PostgreSQL) ← 카메라 설정, 사용자, 라이선스 등
        │
        └── Electron 전용 기능
                │
                ▼
            window.electronAPI (preload.js contextBridge)
                │
                ▼
            ipcRenderer → ipcMain
                │
                ▼
            main.js IPC 핸들러
            (창 제어, 설정 읽기/쓰기, 버전 조회 등)
                │
                ▼
            settings.json (로컬 파일)
```

---

## 5. IPC 채널 전체 목록

| 채널 | 방향 | 처리 위치 | 설명 |
|---|---|---|---|
| `get-app-version` | renderer→main | `ipcMain.handle` | 앱 버전 반환 |
| `minimize-window` | renderer→main | `ipcMain.on` | 창 최소화 |
| `maximize-window` | renderer→main | `ipcMain.on` | 창 최대화/복원 토글 |
| `hide-window` | renderer→main | `ipcMain.on` | 창을 트레이로 숨기기 |
| `close-window` | renderer→main | `ipcMain.on` | 창을 트레이로 숨기기 (호환) |
| `start-server` | renderer→main | `ipcMain.on` | PTZ Proxy 시작 (stub) |
| `stop-server` | renderer→main | `ipcMain.on` | PTZ Proxy 중지 (stub) |
| `change-port` | renderer→main | `ipcMain.on` | 포트 변경 + settings.json 저장 |
| `save-settings` | renderer→main | `ipcMain.on` | settings.json 저장 |
| `request-status` | renderer→main | `ipcMain.on` | 현재 상태 요청 |
| `status` | main→renderer | `webContents.send` | 서버 상태 전송 |
| `log` | main→renderer | `webContents.send` | 로그 메시지 전송 |
| `settings-changed` | main→renderer | `webContents.send` | 설정 변경 알림 |
| `server-status` | main→renderer | `webContents.send` | Next.js 서버 상태 |

---

## 6. 데이터 저장 위치

| 데이터 종류 | 저장 위치 | 설명 |
|---|---|---|
| 카메라 설정, 사용자 DB | NeonDB (클라우드) | Prisma ORM 경유 |
| PTZ 프록시 설정 | `C:\ProgramData\PTZController\data\settings.json` (Win) | `loadSettings()`/`saveSettings()` |
| 앱 환경변수 | `standalone/.env` | `copy:standalone` 시 자동 생성 |
| Next.js 서버 번들 | `resources/standalone/` | extraResource |
| 번들된 Node.js | `resources/node-bin/` | `bundle-node.js`로 생성 (선택) |
| Electron 앱 코드 | `resources/app.asar` | Forge 빌드 산출물 |

**OS별 공유 데이터 경로:**

| OS | 경로 |
|---|---|
| Windows | `%PROGRAMDATA%\PTZController\data\` |
| macOS | `/Library/Application Support/PTZController/data/` |
| Linux | `~/.config/PTZController/data/` |

---

## 7. 패키징 구조 (빌드 후)

```
PTZControllerSetup.exe 설치 후:

설치 디렉토리/
├── ptz-controller.exe          ← Electron 실행 파일
└── resources/
    ├── app.asar                ← Electron 코드 패키지
    │   ├── electron/main.js
    │   ├── electron/preload.js
    │   ├── index.html
    │   └── package.json
    ├── app.asar.unpacked/
    │   └── node_modules/       ← native 모듈 (Prisma 엔진 등)
    │       ├── .prisma/client/
    │       │   └── query_engine-windows.dll.node
    │       └── @prisma/client/
    ├── standalone/             ← Next.js 서버 전체 (extraResource)
    │   ├── server.js           ← 진입점
    │   ├── .env                ← 환경변수 (DB 접속 등)
    │   ├── .next/              ← Next.js 빌드 산출물
    │   ├── public/             ← 정적 파일
    │   └── node_modules/       ← Next.js 의존성
    └── node-bin/               ← 번들 Node.js (선택)
        └── node.exe
```

---

## 8. 앱 종료 흐름

```
트레이 "종료" 클릭 또는 quitApp() 호출
        │
        ▼
appQuitting = true
app.quit()
        │
        ▼
before-quit 이벤트
  └── killNextProcess()
        · Windows: taskkill /pid {PID} /T /F
        · Unix   : proc.kill('SIGTERM')
        │
        ▼
will-quit 이벤트
  └── tray.destroy()
        │
        ▼
프로세스 종료
```

> **참고:** 창의 X 버튼은 앱을 종료하지 않고 **트레이로 숨깁니다** (트레이 앱 특성).  
> 완전 종료는 트레이 우클릭 → "종료" 를 사용해야 합니다.

---

## 9. 환경변수 상세

| 변수 | 필수 | 설명 | 예시 |
|---|---|---|---|
| `DATABASE_URL` | ✅ 필수 | PostgreSQL 접속 URL | `postgresql://user:pass@host/db?sslmode=require` |
| `NEXTAUTH_SECRET` | ✅ 필수 | JWT 서명키 (랜덤 32자+) | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ 자동 | NextAuth 리다이렉트 URL | `http://localhost:3000` (자동 설정) |
| `LICENSE_SECRET` | 권장 | 오프라인 라이선스 서명키 | `TYCHE-PTZ-GOOD-BLESS-2026` |
| `LICENSE_SERVER_URL` | 권장 | 온라인 라이선스 서버 URL | `https://license.tyche.pro` |
| `STORAGE_MODE` | 선택 | 스토리지 모드 | `db` 또는 `file` |
| `PORT` | 선택 | Next.js 포트 (기본 3000) | `3000` |
| `PTZ_HOSTNAME` | 선택 | 서버 바인딩 호스트 (기본 localhost) | `localhost` |
| `PTZ_FORCE_SHARED` | 자동 | 공유 모드 강제 (항상 true) | `true` |
| `PTZ_DATA_DIR` | 자동 | 공유 데이터 경로 (자동 결정) | `C:\ProgramData\PTZController\data` |

---

## 10. 빌드 및 배포 흐름

```
[개발]
ptzcontroller_admin/
  └── yarn build          ← Next.js standalone 빌드
        │
        ▼
ptzcontroller_desktop/
  └── npm run copy:standalone
        ① standalone/     ← 서버 번들 복사
        ② .next/static/   ← 정적 파일 복사
        ③ public/         ← 공개 파일 복사
        ④ data/           ← 카메라 설정 (기존 보존)
        ⑤ .env            ← 환경변수 복사 (NEXTAUTH_URL 자동 수정)
        ⑥ Prisma 엔진     ← .prisma/client, @prisma/client 복사
        ⑦ server.js 패치  ← outputFileTracingRoot → __dirname 교체
        │
        ▼
  (선택) node scripts/bundle-node.js
        ← 배포 PC에 Node.js 없는 경우 번들 포함
        ← --platform=win32 --arch=x64 크로스 빌드 가능
        │
        ▼
  npm run make:win
        ← electron-forge 빌드
        ← out/make/squirrel.windows/x64/PTZControllerSetup.exe
        ← out/make/zip/win32/x64/*.zip (포터블)

[배포]
PTZControllerSetup.exe 실행 → Squirrel 설치 → 앱 실행
```

---

## 11. 알려진 제약사항 및 TODO

| 항목 | 상태 | 설명 |
|---|---|---|
| PTZ Proxy WebSocket 서버 | 🔲 미구현 | `main.js.ok` 참조하여 구현 필요 |
| 오프라인 DB 지원 | 🔲 미지원 | 현재 NeonDB 클라우드 전용 |
| 자동 업데이트 (Squirrel) | 🔲 미구현 | `iconUrl` 제거로 비활성화 상태 |
| macOS 코드 서명 | 🔲 미설정 | 배포 시 Gatekeeper 경고 발생 |
| Linux AppImage | 🔲 미설정 | deb/rpm 만 지원 |

---

*문서 생성: 2026-03-06 | PTZ Controller Desktop v1.0.0*
