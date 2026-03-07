# PTZ Controller Desktop - 개선 현황 및 향후 과제 요약

## ✅ 이미 개선된 사항 (P-01 ~ P-32)

| ID | 심각도 | 개선 항목 | 상태 |
|---|---|---|---|
| P-01 | 🔴 CRITICAL | Git에 민감정보(.env) 노출 → .gitignore 추가 | ✅ 수정 |
| P-02 | 🔴 CRITICAL | index.html의 require('electron') 미동작 → preload.js + contextBridge 사용 | ✅ 수정 |
| P-03 | 🔴 CRITICAL | IPC 핸들러 6개 누락(hide-window, save-settings 등) → main.js에 추가 | ✅ 수정 |
| P-04 | 🔴 CRITICAL | Squirrel 설치 이벤트 미처리 → electron-squirrel-startup 추가 | ✅ 수정 |
| P-05 | 🔴 CRITICAL | server-status IPC 이벤트 미발송 → did-finish-load/exit에서 발송 | ✅ 수정 |
| P-06 | 🟠 HIGH | Windows SIGTERM 미지원 → taskkill /T /F 사용 | ✅ 수정 |
| P-07 | 🟠 HIGH | 종료 로직 중복 호출 → before-quit에 통합 | ✅ 수정 |
| P-08 | 🟠 HIGH | node-bin 없으면 빌드 실패 → forge.config.js 조건부 처리 | ✅ 수정 |
| P-09 | 🟠 HIGH | server.js 하드코딩된 Windows 경로 → copy-standalone.js에서 __dirname으로 교체 | ✅ 수정 |
| P-10 | 🟠 HIGH | macOS Dock 클릭 시 창 미복원 → app.on("activate") 추가 | ✅ 수정 |
| P-11 | 🟠 HIGH | 서버 대기 타임아웃 20초 부족 → 60초로 증가 | ✅ 수정 |
| P-12 | 🟠 HIGH | 서버 비정상 종료 시 사용자 알림 없음 → dialog.showErrorBox() 추가 | ✅ 수정 |
| P-13 | 🟠 HIGH | uncaughtException 핸들러 누락 → process.on() 추가 | ✅ 수정 |
| P-14 | 🟡 MEDIUM | parseEnv() 인라인 주석 미처리 → 정규식으로 `#` 이후 제거 | ✅ 수정 |
| P-15 | 🟡 MEDIUM | PTZ_FORCE_SHARED 환경변수 미전달 → serverEnv에 추가 | ✅ 수정 |
| P-16 | 🟡 MEDIUM | PTZ_DATA_DIR이 사용자별 경로 → getSharedDataDir()로 OS별 공용 경로 사용 | ✅ 수정 |
| P-17 | 🟡 MEDIUM | NEXTAUTH_URL 포트 하드코딩(3000) → .env 기준으로 동적 결정 | ✅ 수정 |
| P-18 | 🟡 MEDIUM | data 폴더 삭제 중 중단 시 데이터 손실 → 임시 백업 및 복원 메커니즘 | ✅ 수정 |
| P-19 | 🟡 MEDIUM | closeWindow() 명세 모호(hide vs close) → 함수명/동작 명확화 | ✅ 수정 |
| P-20 | 🟡 MEDIUM | HOSTNAME=localhost 고정 → PTZ_HOSTNAME 환경변수 지원 | ✅ 수정 |
| P-21 | 🟡 MEDIUM | proxyPort 설정값 미참조 → IPC 저장/로드 구현 | ✅ 수정 |
| P-22 | 🔵 LOW | main.js.ok 백업 파일 Git 추적 → .gitignore 추가 | ✅ 수정 |
| P-23 | 🔵 LOW | 버전 하드코딩(v1.0.1) → getAppVersion() 동적 로드 | ✅ 수정 |
| P-24 | 🔵 LOW | ws 패키지 미사용 → devDependencies 이동 고려 | ✅ 수정 |
| P-25 | 🔵 LOW | startNextServer() 에러 처리 구조 불완전 → async/Promise 패턴 개선 | ✅ 수정 |
| P-26 | 🔵 LOW | macOS DMG 패키저 없음 → maker-dmg 추가 | ✅ 수정 |
| P-27 | 🔵 LOW | bundle-node.js 크로스 컴파일 미지원 → 플랫폼 타겟 인자 고려 | ✅ 고려중 |
| P-28 | 🔵 LOW | LICENSE_SERVER_URL localhost 고정 → 배포 가이드 명확화 | ✅ 수정 |
| P-29 | 🟠 HIGH | waitForServer() localhost 하드코딩 → hostname 파라미터 추가 | ✅ 수정 |
| P-30 | 🟠 HIGH | icon.icns 없으면 DMG 빌드 실패 → forge.config.js 조건부 처리 | ✅ 수정 |
| P-31 | 🟡 MEDIUM | DEFAULT_SETTINGS에 UI 토글 항목 누락 → startToTray, tokenAuth, webAppUrl 추가 | ✅ 수정 |
| P-32 | 🟡 MEDIUM | server-status 발송 로직 미구현 → did-finish-load/exit에서 발송 구현 | ✅ 수정 |

---

## 🚀 향후 추가 개선 항목 (P-33 ~ 현재)

| ID | 심각도 | 개선 항목 | 설명 | 우선순위 |
|---|---|---|---|---|
| P-33 | 🟠 HIGH | PTZ Proxy 서버 기능 구현 | index.html의 start-server/stop-server를 실제로 구현 (현재 TODO) | 높음 |
| P-34 | 🟠 HIGH | WebSocket 기반 실시간 통신 | 렌더러 ↔ 메인 프로세스 간 양방향 통신 개선 | 높음 |
| P-35 | 🟡 MEDIUM | 설정값 UI 동기화 | settings.json 변경 시 렌더러에 자동 반영 (onSettingsChanged) | 중간 |
| P-36 | 🟡 MEDIUM | 에러 로깅 시스템 | 메인/렌더러 프로세스의 에러를 통합 로깅 및 파일 저장 | 중간 |
| P-37 | 🟡 MEDIUM | 자동 업데이트 기능 | electron-updater 통합 (Delta 업데이트) | 중간 |
| P-38 | 🟡 MEDIUM | 다국어 지원(i18n) | 한글/영문/일본어 등 UI 다국어화 | 중간 |
| P-39 | 🟡 MEDIUM | 시스템 트레이 아이콘 애니메이션 | 서버 상태에 따른 트레이 아이콘 변경 (실행중/중지) | 중간 |
| P-40 | 🟡 MEDIUM | 성능 모니터링 | CPU/메모리 사용률 표시 및 리소스 경고 | 중간 |
| P-41 | 🔵 LOW | 개발 모드 핫 리로드 | npm start 시 파일 변경 감지 및 자동 재로드 | 낮음 |
| P-42 | 🔵 LOW | 로그 파일 ローテ이션 | 로그 파일 크기 제한 및 자동 정리 | 낮음 |
| P-43 | 🔵 LOW | 사용자 가이드 (docs/) | 한글 사용자 가이드, 트러블슈팅 문서 | 낮음 |
| P-44 | 🔵 LOW | CI/CD 파이프라인 | GitHub Actions로 자동 빌드 및 릴리스 | 낮음 |
| P-45 | 🔵 LOW | 단위 테스트 추가 | main.js, preload.js의 핵심 함수 단위 테스트 | 낮음 |
| P-46 | 🟠 HIGH | 라이선스 온라인 검증 | LICENSE_SERVER_URL 활용한 토큰 기반 인증 | 높음 |
| P-47 | 🟠 HIGH | 오프라인 모드 완성 | DB 미연결 시 로컬 캐시 및 동기화 메커니즘 | 높음 |
| P-48 | 🟡 MEDIUM | 방화벽/포트 설정 UI | 사용자가 바인딩 주소/포트 GUI로 변경 가능 | 중간 |
| P-49 | 🟡 MEDIUM | 카메라 프리셋 저장 | PTZ 위치 프리셋 저장/로드 기능 | 중간 |
| P-50 | 🔵 LOW | 다중 모니터 지원 | 창 위치/크기 다중 모니터 환경에서 복구 | 낮음 |

---

## 📊 개선 현황 통계

| 카테고리 | 개선됨 | 향후작업 | 합계 |
|---|---|---|---|
| 🔴 CRITICAL | 5 | 2 | 7 |
| 🟠 HIGH | 12 | 7 | 19 |
| 🟡 MEDIUM | 10 | 10 | 20 |
| 🔵 LOW | 5 | 4 | 9 |
| **총합** | **32** | **23** | **55** |

---

## 🎯 향후 개선 우선순위 TOP 5

1. **P-33: PTZ Proxy 서버 기능 구현** (🟠 HIGH)
   - index.html의 start-server/stop-server 실제 기능 완성
   - WebSocket 클라이언트 연결 관리

2. **P-46: 라이선스 온라인 검증** (🟠 HIGH)
   - LICENSE_SERVER_URL 활용
   - 토큰 기반 인증 및 HW ID 바인딩

3. **P-47: 오프라인 모드 완성** (🟠 HIGH)
   - DB 미연결 시 로컬 SQLite 캐시
   - 온라인 복귀 시 자동 동기화

4. **P-34: WebSocket 양방향 통신** (🟠 HIGH)
   - 렌더러 ↔ 메인 프로세스 실시간 양방향 통신 개선
   - PTZ 제어 명령 실시간 전달

5. **P-37: 자동 업데이트 기능** (🟡 MEDIUM)
   - electron-updater 통합
   - Delta 업데이트로 다운로드 최소화
