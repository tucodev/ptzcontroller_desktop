# PTZ Controller - 전체 시스템 아키텍처 및 데이터 흐름

**문서 버전:** 1.0
**작성 일자:** 2026-03-07
**최종 수정:** 2026-03-07

---

## 목차

1. [시스템 개요](#시스템-개요)
2. [전체 아키텍처](#전체-아키텍처)
3. [프로젝트 구성](#프로젝트-구성)
4. [데이터 흐름](#데이터-흐름)
5. [라이선스 시스템](#라이선스-시스템)
6. [저장소 구조](#저장소-구조)
7. [배포 환경](#배포-환경)
8. [사용자 흐름](#사용자-흐름)
9. [보안 고려사항](#보안-고려사항)
10. [향후 개선 계획](#향후-개선-계획)

---

## 시스템 개요

PTZ(Pan-Tilt-Zoom) 카메라 제어 시스템으로, 온라인 웹 기반 UI와 오프라인 지원 데스크톱 UI를 제공합니다.

### 핵심 특징

- **다중 인터페이스**: 웹(온라인) + 데스크톱(온라인/오프라인)
- **라이선스 시스템**: 온라인 인증 + 오프라인 HWID 바인딩
- **프록시 구조**: 실제 하드웨어와의 통신을 독립적인 프록시 앱으로 분리
- **단일 사용자**: 데스크톱 버전은 1인용 (라이선스 및 설정 공유)

---

---

## 전체 아키텍처

---

## 전체 아키텍처

사용자 인터페이스 계층:

- [1] ptzcontroller_admin: 온라인 웹 기반 UI (Next.js + React, 다중 사용자)
- [2] ptzcontroller_desktop: Electron 데스크톱 UI (단일 사용자, Online/Offline 지원)

↓ WebSocket / HTTP API (명령 전송 및 상태 수신)

통신 및 제어 계층 (Proxy):

- [4] ptz-proxy-electron: WebSocket 클라이언트로 동작, 명령 처리, 응답 전송, 장치 상태 관리

↓ UART / TCP / Serial 통신

하드웨어 계층:

- 실제 PTZ 카메라 (H/W): 팬/틸트/줌 모터 제어, 센서 데이터 수집

↑ 응답

라이선스 및 인증 계층:

- [3] ptz_license_server: 사용자 계정 관리, 라이선스 발급/검증, HWID 바인딩, 히스토리 관리

---

## 프로젝트 구성

## 프로젝트 구성

### 1. ptzcontroller_admin (온라인 웹 기반 UI)

**역할**: 웹 브라우저에서 여러 사용자가 온라인으로 PTZ 카메라를 제어

**기술 스택**:

- Next.js 14+ (React 기반)
- TypeScript
- PostgreSQL/Neon/Supabase (DB)
- NextAuth (다중 사용자 인증)
- Prisma ORM

**특징**:

- 다중 사용자 지원 (계정별 설정 분리)
- 항상 Online 필요
- 웹 표준 브라우저 호환성
- 클라우드 배포 가능

**저장소**: ptzcontroller_admin/

---

### 2. ptzcontroller_desktop (데스크톱 기반 UI)

**역할**: Windows/macOS/Linux에서 단일 사용자가 온라인 또는 오프라인으로 PTZ 카메라를 제어

**기술 스택**:

- Electron (크로스 플랫폼 데스크톱)
- Next.js standalone (백엔드)
- contextIsolation + preload.js (보안)
- WebSocket (proxy 통신)

**특징**:

- 단일 사용자 (설정 및 라이선스 공유)
- Online/Offline 모드 지원
- 오프라인 라이선스 시스템 (HWID 바인딩)
- 자동 업데이트 (예정)
- 로컬 설정 저장 (SQLite, JSON 파일)

**저장소**: ptzcontroller_desktop/ (현재 분석 중)

**파일 경로** (Windows):

- 라이선스: C:\ProgramData\PTZController\
- 설정: C:\ProgramData\PTZController\data\

---

### 3. ptz_license_server (라이선스 서버)

**역할**: 라이선스 발급, 검증, 사용자 인증, 히스토리 관리

**기능**:

- 사용자 계정 등록/인증
- 라이선스 수동 발급 (관리자)
- 라이선스 자동 발급 (API)
- HWID 기반 라이선스 검증
- 라이선스 만료 관리
- 사용 히스토리 로깅

**API 엔드포인트** (예시):

- POST /api/auth/login - 사용자 로그인
- GET /api/license/validate - 라이선스 검증 (Online)
- POST /api/license/generate - 라이선스 발급 요청
- GET /api/user/allowed - 사용자 허가 여부 확인

**저장소**: ptz_license_server/

---

### 4. ptz-proxy-electron (PTZ 프록시)

**역할**: ptzcontroller_admin/desktop과 실제 PTZ 하드웨어 사이의 중개자

**기술 스택**:

- Electron 또는 Node.js
- WebSocket (클라이언트로 동작)
- UART/TCP/Serial (하드웨어 통신)

**기능**:

- WebSocket으로 ptzcontroller_admin/desktop에 클라이언트로 연결
- 명령 수신 (JSON 형식)
- 프로토콜 변환 (PelcoD, Ujin 등)
- 실제 하드웨어에 명령 전송
- 응답 수집 및 상태 업데이트
- 연결된 장치 관리

**저장소**: ptz-proxy-electron/

---

## 데이터 흐름

### 온라인 모드 (Online)

#### 1. ptzcontroller_admin (웹) 사용 시

```
사용자 로그인 (NextAuth)
↓
ptz_license_server 검증
├─ 사용자 인증 성공 → 허가 여부 확인
├─ 허가 ✓ → 정상 진행
└─ 허가 ✗ → 접근 제한 (403 Forbidden)
↓
[1] ptzcontroller_admin (웹) 로드
├─ DB (PostgreSQL)에서 사용자 설정 로드
├─ 등록된 카메라 목록 로드
└─ 웹 UI 렌더링
↓
사용자가 PTZ 제어 명령 입력
├─ 팬(Pan), 틸트(Tilt), 줌(Zoom) 제어
└─ 프리셋 선택, 속도 조정 등
↓
[1] → WebSocket → [4] ptz-proxy-electron (명령 전송)
↓
[4] 명령 수신 및 처리
├─ 프로토콜 변환 (PelcoD/Ujin 등)
├─ UART/TCP로 실제 PTZ 하드웨어에 전송
└─ 응답 수집
↓
[4] → WebSocket → [1] (응답 전송)
↓
[1] UI 업데이트
├─ 현재 위치 표시
├─ 상태 표시 (Connected, 온도 등)
└─ 로그 기록 (DB에 저장)
```

#### 2. ptzcontroller_desktop (데스크톱) 온라인 모드 사용 시

```
ptzcontroller_desktop 시작
↓
Next.js 서버 시작 (standalone/server.js)
↓
DB 연결 시도
├─ 성공 → Online 모드 진행
└─ 실패 → 사용자에게 Offline 진행 여부 묻기
↓
[Online 진행 선택]
↓
사용자 로그인 (NextAuth)
↓
ptz_license_server 검증
├─ 사용자 인증 성공 → 허가 여부 확인
├─ 허가 ✓ → 온라인 라이선스 발급
│ ├─ 자동 저장 또는 사용자 수동 저장
│ └─ C:\ProgramData\PTZController\online.ptzlic
└─ 허가 ✗ → 접근 제한
↓
[2] ptzcontroller_desktop Electron UI 렌더링
├─ DB (PostgreSQL)에서 사용자 설정 로드
├─ 등록된 카메라 목록 로드
└─ UI 표시
↓
사용자가 PTZ 제어 명령 입력
↓
[2] → WebSocket → [4] ptz-proxy-electron (명령 전송)
↓
[4] 명령 수신, 처리, 응답
↓
[4] → WebSocket → [2] (응답 전송)
↓
[2] Electron UI 업데이트
├─ 현재 위치 표시
├─ 상태 표시
└─ 설정 변경 시 DB에 저장 (또는 로컬 파일/SQLite)
```

### 오프라인 모드 (Offline)

#### ptzcontroller_desktop 오프라인 모드 사용 시

```
ptzcontroller_desktop 시작
↓
Next.js 서버 시작 (standalone/server.js)
↓
DB 연결 시도
├─ 실패
└─ 사용자에게 Offline 진행 여부 묻기
↓
[Offline 진행 선택]
↓
로컬 라이선스 파일 확인
├─ C:\ProgramData\PTZController\offline.ptzlic
└─ 파일 검증 (유효 여부, 만료 여부)
↓
라이선스 검증 결과
├─ 유효 ✓ → 오프라인 사용 가능
└─ 유효 ✗ (없거나 만료) → [라이선스 없음 처리]
├─ HWID 계산 (사용자 정보 + PC 고유 코드)
├─ offline.ptzreq 파일 생성
├─ C:\ProgramData\PTZController\offline.ptzreq
├─ 사용자에게 파일 제출 안내
├─ 공급자가 ptz_license_server에서 라이선스 발급
├─ 사용자가 라이선스 파일(offline.ptzlic) 다운로드
├─ ptzcontroller_desktop에서 라이선스 업로드
├─ offline.ptzlic를 C:\ProgramData\PTZController\에 저장
└─ 앱 재시작 또는 라이선스 재검증 → 오프라인 사용 가능
↓
[사용 가능]
↓
[2] ptzcontroller_desktop Electron UI 렌더링
├─ 로컬 설정 로드 (JSON 파일, SQLite 또는 DB 미사용)
├─ 최근 카메라 목록 표시 (캐시된 데이터)
└─ "Offline 모드" 표시
↓
사용자가 PTZ 제어 명령 입력
↓
[2] → WebSocket → [4] ptz-proxy-electron (명령 전송)
↓
[4] 명령 수신, 처리, 응답
↓
[4] → WebSocket → [2] (응답 전송)
↓
[2] Electron UI 업데이트
├─ 현재 위치 표시
├─ 상태 표시
└─ 설정 변경 시 로컬 파일에만 저장 (DB 동기화 불가)
↓
[Online 복귀]
↓
다음 재시작 또는 DB 재연결 시
├─ 로컬에서 저장된 변경사항
└─ DB에 자동 동기화 (예정)
```

---

## 라이선스 시스템

### 라이선스 파일 구조

#### offline.ptzreq (라이선스 요청 파일)

**위치**: C:\ProgramData\PTZController\offline.ptzreq

**내용 (JSON)**:

- requestId: 요청 고유 ID
- hwid: 하드웨어 ID (CPU 시리얼 + MAC 주소 + 호스트명 조합)
- userInfo: 사용자 정보 (이름, 이메일, 조직)
- pcInfo: PC 정보 (호스트명, MAC 주소, CPU 시리얼)
- requestDate: 요청 시간 (ISO 8601)
- appVersion: 앱 버전

**생성 과정**:

1. DB 연결 실패 → Offline 모드 진행
2. 로컬 라이선스 파일 없음 또는 만료
3. HWID 계산 (사용자 정보 + PC 고유 코드)
4. JSON 파일로 저장
5. 사용자가 공급자에게 제출

#### offline.ptzlic (라이선스 파일)

**위치**: C:\ProgramData\PTZController\offline.ptzlic

**내용 (JSON)**:

- licenseId: 라이선스 고유 ID
- hwid: 하드웨어 ID (요청 파일과 동일)
- licenseKey: 라이선스 키 (암호화된 토큰)
- userInfo: 사용자 정보
- issuedDate: 발급 날짜
- expiryDate: 만료 날짜
- status: 상태 (valid, expired 등)
- features: 지원 기능 목록 (pan, tilt, zoom, preset 등)

**발급 과정**:

1. 사용자가 offline.ptzreq를 공급자에게 제출
2. ptz_license_server에서 HWID 확인
3. 라이선스 생성 (해당 HWID에만 유효)
4. 라이선스 파일(offline.ptzlic) 제공
5. 사용자가 ptzcontroller_desktop에서 파일 업로드
6. C:\ProgramData\PTZController\에 저장

### Online 라이선스 자동 저장

**프로세스**:

```
Online 로그인 성공
↓
ptz_license_server에 라이선스 발급 요청
↓
라이선스 서버가 라이선스 생성
↓
ptzcontroller_desktop에 라이선스 파일 전송
↓
자동 저장 시도
├─ 브라우저 제약 없음 → 자동으로 C:\ProgramData\PTZController\에 저장
└─ 브라우저 제약 있음 → 사용자 다운로드 후 수동 저장
```

**파일명**: online.ptzlic (또는 offline.ptzlic와 동일)

---

## 설정 저장 구조

### Online + DB 연동 모드

**구조**:

```
사용자별로 다른 데이터 저장
↓
PostgreSQL / NeonDB / Supabase
├─ 사용자 A: 자신의 카메라 설정
├─ 사용자 B: 자신의 카메라 설정
└─ ... (각 계정별 분리)
```

**특징**:

- 각 사용자가 고유의 설정 유지
- Online 필수
- 다중 디바이스 동기화 가능

### Online + 로컬 저장소 모드 (SQLite / JSON 파일)

**구조**:

```
PC 사용자 단일
↓
C:\ProgramData\PTZController\data\
├─ settings.json
├─ sqlite.db
└─ ... (기타 설정 파일)

모든 Online 로그인 계정이 동일 설정 공유
├─ 사용자 A 로그인 → 설정 저장
└─ 사용자 B 로그인 (같은 PC) → 사용자 A의 설정 로드 (자신의 설정 무시)
```

**특징**:

- Desktop 앱의 기본 동작
- Online 모드에서도 로컬 저장소 사용 가능
- 한 PC = 한 설정

### Offline 모드

**구조**:

```
로컬 저장소만 사용
↓
C:\ProgramData\PTZController\data\
├─ settings.json
└─ sqlite.db

DB 동기화 불가
├─ 설정 변경사항 로컬에만 저장
└─ Online 복귀 시 동기화 (예정)
```

---

## 저장소 구조

### Windows 파일 경로

```
C:\ProgramData\PTZController\
├── offline.ptzreq # 라이선스 요청 파일
├── offline.ptzlic # 라이선스 파일 (오프라인)
├── online.ptzlic # 라이선스 파일 (온라인, 선택)
└── data\
 ├── settings.json # 애플리케이션 설정
├── sqlite.db # SQLite 데이터베이스 (선택)
├── cache\ # 캐시 파일
└── logs\ # 로그 파일
```

### macOS 파일 경로

```
/Library/Application Support/PTZController/
├── offline.ptzreq
├── offline.ptzlic
├── online.ptzlic
└── data/
├── settings.json
├── sqlite.db
├── cache/
└── logs/
```

### Linux 파일 경로

```
~/.config/PTZController/
├── offline.ptzreq
├── offline.ptzlic
├── online.ptzlic
└── data/
├── settings.json
├── sqlite.db
├── cache/
└── logs/
```

---

## 배포 환경

### 개발 환경 (Development)

```
Local Machine
├── ptzcontroller_admin (localhost:3000)
├── ptzcontroller_desktop (localhost:3000 + Electron)
├── ptz_license_server (localhost:4000)
└── ptz-proxy-electron (WebSocket 클라이언트)
```

### 프로덕션 환경 (Production)

```
Cloud / On-Premise Server
├── ptzcontroller_admin (web.example.com)
│ └─ Next.js 배포 (Vercel, AWS, GCP 등)
│
├── ptz_license_server (license.example.com)
│ └─ API 서버
│
└── 사용자 PC (On-Premise)
├── ptzcontroller_desktop (Electron)
│ └─ 자동 업데이트
│
└── ptz-proxy-electron
└─ 실제 PTZ 하드웨어 연결
```

### 네트워크 연결

```
**인터넷 연결 (Online)**:
├─ ptzcontroller_desktop ↔ ptzcontroller_admin (웹 서버)
├─ ptzcontroller_desktop ↔ ptz_license_server (라이선스 검증)
└─ ptz-proxy-electron ↔ ptzcontroller_desktop (WebSocket)

**인터넷 미연결 (Offline)**:
├─ ptzcontroller_desktop (로컬 라이선스 검증)
└─ ptz-proxy-electron ↔ ptzcontroller_desktop (WebSocket)
```

---

## 사용자 흐름 요약

### 시나리오 1: Online + DB 연동

```
사용자 1 로그인 (Online)
↓
DB에서 자신의 설정 로드
↓
PTZ 제어
↓
설정 변경 → DB에 저장
↓
다른 디바이스에서 접속 → 동일 설정 로드
```

### 시나리오 2: Online + 로컬 저장소 (SQLite/JSON)

```
사용자 1 로그인 (Online)
↓
로컬 저장소에서 설정 로드
↓
PTZ 제어
↓
설정 변경 → 로컬에만 저장
↓
사용자 2 로그인 (같은 PC) → 사용자 1의 설정 로드
```

### 시나리오 3: Offline

```
DB 연결 실패
↓
오프라인 진행 선택
↓
로컬 라이선스 검증 (offline.ptzlic)
├─ 유효 → 사용 가능
└─ 무효 → offline.ptzreq 생성
```

### 시나리오 4: Offline → Online (전환)

```
Offline 사용 중
↓
인터넷 복귀
↓
다음 재시작 또는 수동 재연결
↓
Online 라이선스 자동 발급 및 저장
↓
Online 모드 전환
↓
로컬 변경사항 DB와 동기화 (예정)
```

---

## 보안 고려사항

### 라이선스 검증

- HWID: CPU 시리얼, MAC 주소, 호스트명 조합으로 PC 고유성 보장
- 라이선스 파일: 서명(signature) 또는 암호화로 위조 방지
- Online 모드: License Server와 HTTPS 통신으로 중간자 공격 방지

### 인증

- Online: NextAuth + 세션 관리로 사용자 검증
- Offline: 라이선스 파일 기반 (온라인 인증 불가, 만료 검증만 가능)

### 데이터 저장

- 라이선스 파일: C:\ProgramData\ (관리자 권한 필요)로 일반 사용자 수정 방지
- 설정 파일: 권한 제한으로 무단 접근 차단
- 민감 정보: 암호화 저장 (향후 구현)

---

## 향후 개선 계획

### P-46: 라이선스 온라인 검증

- ptzcontroller_desktop ↔ ptz_license_server 연동 강화
- 사용자 허가 여부 실시간 확인
- online.ptzlic 자동 저장 및 갱신 기능

### P-47: 오프라인 모드 완성

- offline.ptzreq 자동 생성 및 공유 기능
- offline.ptzlic 검증 로직 고도화
- 파일 업로드 UI 개선 (드래그&드롭)

### P-34: ptz-proxy-electron 연동

- WebSocket 클라이언트 구현 완료
- 명령/응답 프로토콜 표준화
- 다중 하드웨어 동시 지원

### P-44: 자동 업데이트

- electron-updater 통합
- Delta 업데이트로 다운로드 최소화
- 자동 재시작 로직

### 오프라인 → Online 동기화

- 로컬 변경사항 자동 동기화
- 충돌 해결 메커니즘
- 오프라인 타임스탬프 추적

---

**최종 수정**: 2026-03-07
**문서 관리**: Git 저장소: /docs/flow-and-arch.md
