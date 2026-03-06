# PTZ Controller Desktop — 문제점 리스트

> 분석 기준일: 2026-03-05  
> 분석 대상: `/home/user/webapp` (ptzcontroller_desktop)

---

## 🔴 CRITICAL (즉시 수정 필요)

---

### P-01. `standalone/.env` 및 `.env-in-standalone` 민감정보 Git 추적 중

**파일:** `.gitignore`, `standalone/.env`, `.env-in-standalone`  
**현상:**  
```
git ls-files → standalone/.env, .env-in-standalone 모두 tracked
```
아래 민감정보가 Git 히스토리에 평문으로 노출되어 있음:
- `DATABASE_URL` — NeonDB PostgreSQL 접속 자격증명 (비밀번호 포함)
- `NEXTAUTH_SECRET` — JWT 서명키
- `LICENSE_SECRET` — 라이선스 서명키

**원인:** `.gitignore`에 `standalone/.env`, `.env-in-standalone`, `*.env` 항목 누락  
**위험도:** 레포지토리 접근자 전원이 DB 및 인증 시스템에 접근 가능  
**수정:**
```gitignore
# .gitignore 에 추가
.env
.env.*
.env-in-standalone
standalone/.env
```
Git 히스토리에서도 제거 필요: `git filter-branch` 또는 `BFG Repo-Cleaner`

---

### P-02. `index.html`의 `require('electron')` 직접 호출 — 동작 불가

**파일:** `index.html` (line 559), `electron/main.js` (line 200-201)  
**현상:**
```js
// index.html
const { ipcRenderer } = require('electron');  // ← nodeIntegration:false 환경에서 ReferenceError
```
`BrowserWindow`가 `nodeIntegration: false`, `contextIsolation: true`로 생성되므로
렌더러에서 `require()` 자체가 존재하지 않음 → `ReferenceError: require is not defined`  
**원인:** `index.html`이 구버전 아키텍처(`nodeIntegration:true` 시절) 코드를 그대로 유지  
**추가 문제:** 현재 `main.js`가 `index.html`을 `loadFile()`로 로드하지 않고 `loadURL(localhost:3000)`을 로드하므로 `index.html` 자체가 사용되지 않는 파일임  
**수정:** `index.html`을 현재 구조에 맞게 전면 재작성하거나 삭제/분리 처리

---

### P-03. `index.html`의 IPC 채널과 `main.js` 핸들러 불일치

**파일:** `index.html`, `electron/main.js`  
**현상:** `index.html`에서 호출하는 IPC 채널 중 `main.js`에 핸들러가 없는 것들:

| `index.html` 송신 채널 | `main.js` 핸들러 | 상태 |
|---|---|---|
| `hide-window` | ❌ 없음 | 무응답 |
| `save-settings` | ❌ 없음 | 무응답 |
| `start-server` | ❌ 없음 | 무응답 |
| `stop-server` | ❌ 없음 | 무응답 |
| `change-port` | ❌ 없음 | 무응답 |
| `request-status` | ❌ 없음 | 무응답 |
| `minimize-window` | ✅ 있음 | 정상 |

**원인:** `index.html`은 `main.js.ok` 시절의 UI이며, 현재 `main.js`로 교체 시 대응 핸들러를 추가하지 않음  
**수정:** `main.js`에 해당 IPC 핸들러를 구현하거나, `index.html`을 현재 구조에 맞게 재작성

---

### P-04. `electron-squirrel-startup` 미처리 — Windows 설치 시 충돌

**파일:** `electron/main.js` (누락), `package.json` (line 34)  
**현상:**
```js
// main.js.ok 에는 있음
if (require("electron-squirrel-startup")) { app.quit(); }

// 현재 main.js 에는 없음 ← 문제
```
`electron-squirrel-startup`는 Squirrel 설치 이벤트(설치/업데이트/삭제) 처리용.  
없으면 Windows 설치 완료 후 앱이 정상 종료되지 않고 계속 실행되거나 충돌 발생  
**원인:** `main.js.ok` → `main.js` 리팩토링 시 누락  
**수정:** `main.js` 최상단에 추가:
```js
if (require('electron-squirrel-startup')) { app.quit(); }
```

---

### P-05. `preload.js`의 `onServerStatus` — `main.js`에서 `server-status` 이벤트 미발송

**파일:** `electron/preload.js` (line 30-34), `electron/main.js`  
**현상:**
```js
// preload.js — 이벤트 리스너 등록
onServerStatus: (callback) => {
  ipcRenderer.on('server-status', callback);  // ← 수신 준비
  return () => ipcRenderer.removeListener('server-status', callback);
}
// main.js — 'server-status' 를 send 하는 코드가 없음
```
웹앱(Next.js)에서 `window.electronAPI.onServerStatus(cb)` 등록 시 콜백이 영원히 호출되지 않음  
**원인:** preload API 설계 후 main.js에서 실제 발송 코드 미구현  
**수정:** `main.js`에서 서버 상태 변화 시 `mainWindow.webContents.send('server-status', {...})` 발송 추가

---

## 🟠 HIGH (기능 오동작 / 빌드 실패 유발)

---

### P-06. Windows에서 `SIGTERM`으로 Next.js 프로세스 종료 불가

**파일:** `electron/main.js` (line 280, 325)  
**현상:**
```js
nextProcess.kill("SIGTERM");  // Windows에서 SIGTERM은 지원 안 됨
```
Windows에서 `process.kill(pid, 'SIGTERM')`은 실제로 `SIGKILL`처럼 동작하거나 아예 무시될 수 있음.  
Node.js 자식 프로세스에 `SIGTERM`을 보내면 Windows에서는 즉시 `SIGKILL`로 처리되어  
Next.js 서버가 graceful shutdown 없이 강제 종료됨 (DB 연결 정리 불가)  
`main.js.ok`는 `taskkill /pid /T /F`를 사용하여 자식 프로세스 트리까지 안전하게 종료  
**원인:** `main.js` 리팩토링 시 Windows 전용 종료 로직 제거  
**수정:**
```js
if (process.platform === 'win32') {
  execSync(`taskkill /pid ${nextProcess.pid} /T /F`, { stdio: 'ignore' });
} else {
  nextProcess.kill('SIGTERM');
}
```

---

### P-07. `quitApp()`와 `will-quit` 이벤트에서 `nextProcess.kill()` 중복 호출

**파일:** `electron/main.js` (line 277-284, 323-327)  
**현상:**
```js
function quitApp() {
    nextProcess.kill("SIGTERM");  // ← 1차 kill
    nextProcess = null;           // ← null로 초기화
    app.quit();                   // → will-quit 이벤트 발생
}
app.on("will-quit", () => {
    if (nextProcess) {            // ← quitApp()에서 null로 됐으므로 조건 통과 안 됨
        nextProcess.kill("SIGTERM");  // 중복 kill 시도
    }
});
```
`quitApp()` 경로로 종료 시 `nextProcess = null` 후 `will-quit`에서 `if(nextProcess)` 조건이 false가 되어 중복 kill은 발생 안 함. 그러나 `app.quit()` 직접 호출 경로(트레이 메뉴 외부 등)에서는 `will-quit`만 실행되어 종료.  
결론적으로 로직 중복으로 코드가 혼란스럽고, `before-quit`에서도 `appQuitting = true`만 설정하고 프로세스 종료를 하지 않아 타이밍 이슈 존재  
**수정:** 프로세스 종료 로직을 `before-quit` 한 곳으로 통합

---

### P-08. `forge.config.js`에서 없는 `node-bin` 폴더를 `extraResource`에 포함

**파일:** `forge.config.js` (line 32), `node-bin/` (미존재)  
**현상:**
```
$ ls node-bin → "No such file or directory"
```
`extraResource: ['./standalone', './node-bin']`에서 `node-bin`이 없으면  
`electron-forge make` 실행 시 빌드 오류 발생  
**원인:** `bundle-node.js` 실행 전 빌드 시도 또는 CI/CD 환경에서 미실행  
**수정 옵션 1:** `forge.config.js`에서 조건부 처리 (존재할 때만 포함)  
**수정 옵션 2:** `prebuild` 스크립트에 `bundle-node.js` 자동 실행 추가  
**수정 옵션 3:** `node-bin`이 없으면 빌드 전 경고만 출력하도록 별도 스크립트 작성

---

### P-09. `standalone/server.js`에 Windows 절대 경로 하드코딩

**파일:** `standalone/server.js`  
**현상:**
```js
"outputFileTracingRoot":"E:\\Web\\devroot\\PTZ_www\\integrated\\20260302-1403-Base\\ptzcontroller_admin"
```
`nextConfig` 객체 내 `outputFileTracingRoot`가 빌드 머신의 Windows 절대 경로로 하드코딩됨.  
Linux/macOS 빌드 환경에서 경로 탐색 실패로 이어질 수 있음.  
`server.js`는 `next build` 시 자동 생성되는 파일이므로 재빌드 시 매번 해당 머신 경로가 박힘  
**원인:** Windows 빌드 머신에서 생성된 `server.js`가 그대로 커밋됨  
**수정:** `standalone/server.js`를 `.gitignore`에 추가하고 `copy:standalone` 실행 후 생성된 파일 사용 (또는 Next.js config에서 `outputFileTracingRoot` 제거)

---

### P-10. `main.js`에 `app.on('activate')` macOS 핸들러 누락

**파일:** `electron/main.js`  
**현상:** macOS에서 Dock 아이콘 클릭 시 창이 다시 열리지 않음  
```js
// main.js.ok 에는 있음
app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
// 현재 main.js 에는 없음
```
macOS 관례상 `activate` 이벤트 처리는 필수  
**원인:** `main.js` 단순화 과정에서 누락  
**수정:** `app.whenReady()` 블록 내에 추가

---

### P-11. `waitForServer()` 타임아웃 20초 — 저사양/부팅 직후 환경에서 부족

**파일:** `electron/main.js` (line 153)  
**현상:**
```js
function waitForServer(retries = 40, interval = 500)  // 최대 40 × 0.5s = 20초
```
Next.js standalone + Prisma + NeonDB 초기 연결은 저사양 PC나 부팅 직후 디스크 캐시가 없는 상황에서 20초를 초과할 수 있음  
`main.js.ok`는 `maxAttempts = 120` → 60초로 더 넉넉하게 설정  
**수정:** `retries = 120` (60초) 또는 환경변수로 설정 가능하게 변경

---

### P-12. Next.js 서버 비정상 종료 시 사용자 알림 없음

**파일:** `electron/main.js` (line 144-149)  
**현상:**
```js
nextProcess.on("exit", (code, signal) => {
    if (!appQuitting && code !== 0)
        console.error(`[Desktop] server exited...`);
    // ← dialog 알림 없음, 자동 재시작 없음
});
```
서버가 충돌하면 사용자는 빈 흰 화면만 보게 되고 원인을 알 수 없음  
`main.js.ok`는 `dialog.showErrorBox()`로 사용자에게 알림  
**수정:** `dialog.showErrorBox()` 추가 및 재시작 옵션 제공

---

### P-13. `main.js`에 `process.on('uncaughtException')` 핸들러 누락

**파일:** `electron/main.js`  
**현상:** 메인 프로세스에서 처리되지 않은 예외 발생 시 앱이 아무 알림 없이 크래시  
`main.js.ok`에는 존재:
```js
process.on("uncaughtException", (err) => {
    dialog.showErrorBox?.("오류", err.message);
});
```
**수정:** 동일한 핸들러 추가

---

## 🟡 MEDIUM (품질/안정성 이슈)

---

### P-14. `INLINE_COMMENT` 파싱 버그 — `parseEnv()` 인라인 주석 미처리

**파일:** `electron/main.js` (line 57-67)  
**현상:**
```js
const m = line.match(/^([^#=\s][^=]*)=(.*)/);
// 값에 인라인 주석이 있을 때:
// KEY=value # this is a comment  →  vars.KEY = "value # this is a comment"
```
표준 dotenv는 인라인 주석을 제거하지만 현재 구현은 `#` 이후 텍스트를 값에 포함  
특히 `STORAGE_MODE=db` 같은 값은 괜찮지만 `PORT=3000 # default port` 같은 경우 `"3000 # default port"`가 됨  
**수정:**
```js
m[2].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "")
```

---

### P-15. `main.js`에서 `PTZ_FORCE_SHARED` 환경변수 미전달

**파일:** `electron/main.js`, `electron/main.js.ok`  
**현상:**
```js
// main.js.ok
PTZ_FORCE_SHARED: 'true',  // Desktop은 1인용 — userId 무시하고 공유 경로 사용

// 현재 main.js — 없음
```
`PTZ_FORCE_SHARED`가 없으면 Next.js 서버가 사용자별 데이터 경로를 사용, 데스크톱 1인용 앱에서 라이선스/설정 경로가 올바르게 잡히지 않을 수 있음  
**수정:** `serverEnv` 객체에 `PTZ_FORCE_SHARED: 'true'` 추가

---

### P-16. `main.js`에서 공유 라이선스 디렉토리(`PTZ_DATA_DIR`) 경로 단순화

**파일:** `electron/main.js` (line 121), `electron/main.js.ok` (line 386-395)  
**현상:**
```js
// 현재 main.js
PTZ_DATA_DIR: path.join(app.getPath("userData"), "data"),

// main.js.ok — OS별 공용 경로 사용
win32:  path.join(PROGRAMDATA, "PTZController")           // C:\ProgramData\PTZController
darwin: "/Library/Application Support/PTZController"
linux:  path.join(HOME, ".config", "PTZController")
```
현재 `app.getPath("userData")`는 사용자별 경로 (`AppData\Roaming\...`)를 가리켜,  
동일 PC에서 다른 Windows 계정으로 실행 시 데이터가 분리됨  
데스크톱 1인용 앱의 의도(공유 경로)와 불일치  
**수정:** `main.js.ok`의 `getSharedLicenseDir()` 로직 이식

---

### P-17. `copy-standalone.js`의 `NEXTAUTH_URL` 포트가 `process.env.PORT`에서 읽힘

**파일:** `scripts/copy-standalone.js` (line 121)  
**현상:**
```js
const port = process.env.PORT || 3000;  // copy:standalone 실행 시점의 PORT 환경변수
```
`npm run copy:standalone` 실행 시 `PORT` 환경변수를 설정하지 않으면 항상 `3000`으로 고정됨.  
만약 프로덕션 포트를 변경했다면 `.env`의 `NEXTAUTH_URL`이 잘못 설정됨  
**수정:** `.env` 원본에서 `NEXTAUTH_URL`의 포트를 파싱하거나, 복사 후 `main.js`에서 런타임에 덮어쓰는 현재 방식(line 119)으로 일관되게 처리

---

### P-18. `copy-standalone.js`에서 `standalone/` 전체 삭제 후 복사 — `data/` 보호 로직 취약

**파일:** `scripts/copy-standalone.js` (line 69-71)  
**현상:**
```js
if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true });  // 전체 삭제
}
copyDir(sourceDir, destDir);  // 재생성
// 이후 data/ 보호 로직 실행 (line 90~)
```
`fs.rmSync`로 전체 삭제 후 `data/` 보호 로직을 적용하므로 **삭제와 재생성 사이에 프로세스가 중단되면** 사용자 데이터 영구 손실.  
더 안전한 방법은 `standalone/`을 통째로 삭제하지 않고 `data/`를 먼저 임시 백업 후 복원하는 방식  
**수정:** `data/` 디렉토리를 임시 경로에 먼저 백업 → 전체 삭제 → 재생성 → 백업 복원 순서로 처리

---

### P-19. `preload.js`의 `closeWindow()`가 `main.js`에서 `hide()`로 동작 (불일치)

**파일:** `electron/main.js` (line 301), `electron/preload.js` (line 22), `electron/main.js.ok` (line 566)  
**현상:**
```js
// main.js
ipcMain.on("close-window", () => mainWindow?.hide());  // 창 숨기기

// main.js.ok
ipcMain.on("close-window", () => mainWindow?.close());  // 창 닫기
```
`preload.js`에서 `closeWindow()`를 호출하면 실제로 창이 닫히는 것이 아니라 숨겨짐.  
웹앱 컴포넌트에서 `window.electronAPI.closeWindow()`를 "닫기"로 사용한다면 혼란 야기  
`main.js`의 `close` 이벤트 핸들러(`mainWindow.on("close")`)에서 `hide()`를 이미 하므로 `close-window` IPC에서도 `hide()`가 맞긴 하나 명세 불일치  
**수정:** 함수명을 `hideWindow()`로 변경하거나 동작을 명확히 문서화

---

### P-20. `HOSTNAME: "localhost"` 설정으로 외부 접근 차단 — 네트워크 제어 시 문제

**파일:** `electron/main.js` (line 117)  
**현상:**
```js
HOSTNAME: "localhost",  // 127.0.0.1 바인딩
// standalone/server.js 기본값: HOSTNAME || '0.0.0.0'
```
현재 설정은 `127.0.0.1`에만 바인딩되어 동일 PC의 다른 앱이나 네트워크 내 다른 기기에서 접근 불가.  
사용자가 PC를 PTZ 제어 서버로 사용하는 시나리오에서는 `0.0.0.0` 바인딩이 필요할 수 있음  
**수정:** `HOSTNAME`을 설정 파일(`settings.json`)에서 읽어 유연하게 처리하거나 옵션 제공

---

### P-21. `standalone/data/settings.json`의 `proxyPort: 9902`가 실제로 사용되지 않음

**파일:** `standalone/data/settings.json`, `electron/main.js`  
**현상:**
```json
{ "proxyPort": 9902, "defaultProtocol": "pelcod", ... }
```
현재 `main.js`에 PTZ Proxy 서버 기능이 없으므로 `proxyPort` 설정값이 참조되지 않음  
`main.js.ok`에서는 `PROXY_PORT = 9902`로 하드코딩되어 `settings.json`조차 읽지 않음  
**원인:** 설정 파일 구조와 실제 코드 연동 미완성  
**수정:** Proxy 기능 구현 시 `settings.json`에서 포트를 읽도록 연동

---

## 🔵 LOW (코드 품질 / 유지보수성)

---

### P-22. `electron/main.js.ok` 파일이 Git에 추적되고 있음

**파일:** `electron/main.js.ok`  
**현상:** 백업/참조 목적의 파일이 프로덕션 저장소에 포함됨  
정식 배포 패키지에 포함될 경우 혼란 야기 (Electron이 `main.js.ok`를 직접 실행하진 않지만)  
**수정:** `electron/main.js.ok`를 `.gitignore`에 추가하거나 별도 브랜치/문서로 관리

---

### P-23. `index.html`의 버전 표시(`v1.0.1`)가 `package.json` 버전(`1.0.0`)과 불일치

**파일:** `index.html` (line 555), `package.json`  
**현상:**
```html
<span class="footer-version">v1.0.1</span>  <!-- index.html -->
```
```json
"version": "1.0.0"  // package.json
```
버전 관리가 수동이며 파일 간 동기화가 되지 않음  
**수정:** 버전을 하드코딩 대신 `window.electronAPI.getAppVersion()`으로 동적 표시

---

### P-24. `ws` 패키지가 `dependencies`에 선언됐지만 현재 `main.js`에서 미사용

**파일:** `package.json` (line 35), `electron/main.js`  
**현상:**
```json
"dependencies": { "ws": "^8.19.0" }  // 현재 main.js에서 require('ws') 없음
```
`main.js.ok`에서는 사용하지만 현재 `main.js`에는 없음.  
불필요한 의존성이 패키지 크기를 늘리며, `forge.config.js`의 `asar.unpackDir`에도 `ws`가 포함되어 빌드 복잡도 증가  
**수정:** Proxy 기능 미포함 구조라면 `ws`를 `devDependencies`로 이동하거나 제거, `unpackDir`에서도 제거

---

### P-25. `main.js` `startNextServer()`가 async가 아닌 동기 함수지만 내부에서 에러를 비동기로 처리

**파일:** `electron/main.js` (line 98-150)  
**현상:**
```js
function startNextServer() {          // ← async 아님
    // ...
    nextProcess = cp.spawn(...);       // 비동기 spawn
    nextProcess.on("error", (err) => { // ← 에러는 이벤트로만 처리
        showFatalError(...);
    });
}
// 호출부
startNextServer();                     // await 없이 호출
await waitForServer();                 // 즉시 폴링 시작
```
`startNextServer()`가 반환된 직후 즉시 `waitForServer()` 폴링을 시작하나,  
`spawn` 자체가 실패(`ENOENT`)하면 `error` 이벤트가 비동기로 발생하므로  
폴링 실패 에러와 spawn 에러가 동시에 발생해 `showFatalError`가 중복 호출될 수 있음  
**수정:** `startNextServer()`를 `async`로 전환하고 spawn 성공 여부를 Promise로 반환

---

### P-26. `forge.config.js`에서 macOS용 `maker-zip`만 있고 `maker-dmg`가 없음

**파일:** `forge.config.js`  
**현상:** macOS 빌드 시 ZIP만 생성되며 표준 `.dmg` 설치 패키지가 없음  
macOS 사용자 경험상 DMG가 표준 배포 방식  
**수정:** `@electron-forge/maker-dmg` 추가 고려

---

### P-27. `bundle-node.js`의 크로스 컴파일 미지원 — CI/CD에서 문제

**파일:** `scripts/bundle-node.js` (line 16)  
**현상:**
```
⚠️ 현재 실행 환경의 Node.js 버전 및 아키텍처와 동일한 바이너리를 다운로드
   크로스 컴파일(예: macOS에서 Windows용 빌드)은 지원하지 않음
```
CI 파이프라인에서 Linux 환경으로 Windows용 `node.exe`를 번들하는 것이 불가능  
**수정:** 플랫폼 타겟을 인자로 받아 크로스 컴파일을 지원하도록 개선

---

### P-28. `LICENSE_SERVER_URL`이 `localhost:4000`으로 설정되어 배포 환경에서 동작 불가

**파일:** `standalone/.env`, `.env-in-standalone`  
**현상:**
```
LICENSE_SERVER_URL="http://127.0.0.1:4000"
```
배포된 사용자 PC에는 라이선스 서버가 없으므로 온라인 라이선스 발급 기능이 항상 실패  
**수정:** 실제 라이선스 서버 URL로 변경하거나, 없을 경우 오프라인 전용 모드로 graceful 처리

---

## 📋 요약 테이블

| ID | 심각도 | 파일 | 문제 요약 |
|---|---|---|---|
| P-01 | 🔴 CRITICAL | `.gitignore` | DB 비밀번호 등 민감정보 Git 노출 |
| P-02 | 🔴 CRITICAL | `index.html` | `require('electron')` 동작 불가 |
| P-03 | 🔴 CRITICAL | `index.html` / `main.js` | IPC 채널 핸들러 6개 누락 |
| P-04 | 🔴 CRITICAL | `main.js` | `electron-squirrel-startup` 미처리 |
| P-05 | 🔴 CRITICAL | `preload.js` / `main.js` | `server-status` 이벤트 미발송 |
| P-06 | 🟠 HIGH | `main.js` | Windows SIGTERM 프로세스 종료 불가 |
| P-07 | 🟠 HIGH | `main.js` | 종료 로직 중복 및 타이밍 이슈 |
| P-08 | 🟠 HIGH | `forge.config.js` | `node-bin` 없으면 빌드 실패 |
| P-09 | 🟠 HIGH | `standalone/server.js` | Windows 절대경로 하드코딩 |
| P-10 | 🟠 HIGH | `main.js` | macOS `activate` 핸들러 누락 |
| P-11 | 🟠 HIGH | `main.js` | 서버 대기 타임아웃 20초 부족 |
| P-12 | 🟠 HIGH | `main.js` | 서버 비정상 종료 시 사용자 알림 없음 |
| P-13 | 🟠 HIGH | `main.js` | `uncaughtException` 핸들러 누락 |
| P-14 | 🟡 MEDIUM | `main.js` | `parseEnv()` 인라인 주석 파싱 버그 |
| P-15 | 🟡 MEDIUM | `main.js` | `PTZ_FORCE_SHARED` 환경변수 미전달 |
| P-16 | 🟡 MEDIUM | `main.js` | `PTZ_DATA_DIR` 사용자별 경로 (공유 경로 아님) |
| P-17 | 🟡 MEDIUM | `copy-standalone.js` | `NEXTAUTH_URL` 포트 하드코딩 |
| P-18 | 🟡 MEDIUM | `copy-standalone.js` | `data/` 삭제-복사 중 중단 시 데이터 손실 위험 |
| P-19 | 🟡 MEDIUM | `main.js` / `preload.js` | `closeWindow()` 동작이 hide(숨기기)로 불일치 |
| P-20 | 🟡 MEDIUM | `main.js` | `HOSTNAME=localhost`로 네트워크 접근 제한 |
| P-21 | 🟡 MEDIUM | `settings.json` / `main.js` | `proxyPort` 설정값 미참조 |
| P-22 | 🔵 LOW | `main.js.ok` | 백업 파일이 Git에 추적됨 |
| P-23 | 🔵 LOW | `index.html` | 버전 하드코딩 및 `package.json`과 불일치 |
| P-24 | 🔵 LOW | `package.json` | `ws` 패키지 미사용 의존성 |
| P-25 | 🔵 LOW | `main.js` | `startNextServer()` 에러 처리 구조 불완전 |
| P-26 | 🔵 LOW | `forge.config.js` | macOS DMG 패키저 없음 |
| P-27 | 🔵 LOW | `bundle-node.js` | 크로스 컴파일 미지원 |
| P-28 | 🔵 LOW | `standalone/.env` | `LICENSE_SERVER_URL` localhost — 배포 환경 불가 |

---

*총 28개 문제점 | CRITICAL 5개 | HIGH 8개 | MEDIUM 8개 | LOW 7개*
