# PTZ Controller Desktop

Electron 기반 PTZ Controller 데스크톱 애플리케이션

## 폴더 구조 (전제 조건)

```
(상위 폴더)/
├── ptzcontroller_admin/     ← Next.js 소스 (원본 웹앱)
└── ptzcontroller_desktop/  ← 이 폴더 (Electron 래퍼)
```

## 설치

```bash
cd ptzcontroller_desktop
npm install
```

아이콘 파일 준비:

```
assets/ 폴더 아래에 아래 파일을 배치하세요:
  icon.ico   (Windows용)
  icon.png   (공통, 256×256 이상)
```

## 환경변수 설정 (.env)

> ⚠️ `.env` 파일은 **절대 Git에 커밋하지 마세요**. `.gitignore`에 등록되어 있습니다.

```bash
# .env.example 을 복사하여 실제 값을 채워 넣으세요
cp .env.example .env-in-standalone
# 실제 값 입력 후 copy:standalone 실행 시 자동으로 standalone/.env 로 복사됩니다
```

또는 `ptzcontroller_admin/.env` 에 값을 설정하면 `copy:standalone` 시 자동 복사됩니다.

## 개발 모드 실행

```bash
# 1. Next.js 빌드 (ptzcontroller_admin 에서)
cd ../ptzcontroller_admin
yarn install   # 첫 실행 시
yarn build

# 2. standalone 복사 (.env, Prisma 엔진 포함)
cd ../ptzcontroller_desktop
npm run copy:standalone

# 3. Electron 실행
npm start
```

## 빌드 (배포용)

자세한 빌드 가이드는 **BUILD.md** 를 참조하세요.

### Windows

```bash
npm run make:win
```

### macOS

```bash
npm run make:mac
```

### Linux

```bash
npm run make:linux
```

## 빌드 결과물

빌드 결과물은 `out/` 폴더에 생성됩니다:

- Windows: `out/make/squirrel.windows/x64/PTZControllerSetup.exe`
- macOS: `out/make/zip/darwin/`
- Linux: `out/make/deb/` 또는 `out/make/rpm/`

## 아이콘 설정

`assets/` 폴더에 아이콘 파일을 배치하세요:

- `icon.png` - 256×256 이상 (모든 플랫폼)
- `icon.ico` - Windows용
- `icon.icns` - macOS용 (선택)

## 구조

```
ptzcontroller_desktop/
├── electron/
│   ├── main.js          # Electron 메인 프로세스
│   └── preload.js       # 프리로드 스크립트
├── standalone/          # Next.js standalone 빌드 (copy:standalone 으로 생성)
│   ├── server.js
│   ├── .env
│   └── ...
├── scripts/
│   ├── copy-standalone.js  # standalone 복사 스크립트
│   └── bundle-node.js      # portable Node.js 번들 스크립트
├── assets/
│   ├── icon.png
│   └── icon.ico
├── package.json
├── forge.config.js
├── BUILD.md             # 상세 빌드 가이드
└── README.md
```
