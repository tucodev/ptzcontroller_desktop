# 빌드하기

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
