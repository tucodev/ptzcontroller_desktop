/**
 * copy-standalone.js
 *
 * Next.js standalone 빌드 결과물을 Electron 이 읽을 수 있는
 * desktop/standalone/ 폴더로 복사합니다.
 *
 * 복사 항목:
 *   [1/6] .next/standalone  → standalone/         (서버 번들)
 *   [2/6] .next/static      → standalone/.next/static (정적 파일)
 *   [3/6] public/           → standalone/public/  (공개 파일)
 *   [4/6] data/             → standalone/data/    (카메라 설정 등 데이터)
 *   [5/6] .env              → standalone/.env     (환경변수, NEXTAUTH_URL 강제 http 보정)
 *   [6/6] .prisma/client    → standalone/node_modules/.prisma/client (Prisma 엔진)
 *         @prisma/client    → standalone/node_modules/@prisma/client (Prisma 클라이언트)
 *   [7/7] server.js 패치    → outputFileTracingRoot 하드코딩 경로 제거 (P-09 수정)
 *
 * 실행:
 *   node scripts/copy-standalone.js
 *   또는: NEXT_APP_DIR=/경로/to/ptzcontroller_admin node scripts/copy-standalone.js
 *
 * 선행 조건:
 *   cd ptzcontroller_admin && yarn build  (Next.js standalone 빌드)
 *
 * 수정 이력:
 *   P-09 수정: server.js 의 outputFileTracingRoot Windows 하드코딩 경로 제거
 *   P-17 수정: NEXTAUTH_URL 포트를 .env 의 PORT 값 기준으로 동적 결정
 *   P-18 수정: data/ 폴더 원자적 교체 — 임시 디렉토리 사용으로 중단 시 손실 방지
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Next.js 앱 경로 (환경변수 또는 상대경로)
const NEXT_APP_DIR = process.env.NEXT_APP_DIR
  || path.join(__dirname, '..', '..', 'ptzcontroller_admin');

const destDir    = path.join(__dirname, '..', 'standalone');
const sourceDir  = path.join(NEXT_APP_DIR, '.next', 'standalone');
const staticSrc  = path.join(NEXT_APP_DIR, '.next', 'static');
const staticDest = path.join(destDir, '.next', 'static');
const publicSrc  = path.join(NEXT_APP_DIR, 'public');
const publicDest = path.join(destDir, 'public');
const dataSrc    = path.join(NEXT_APP_DIR, 'data');
const dataDest   = path.join(destDir, 'data');
const envSrc     = path.join(NEXT_APP_DIR, '.env');
const envDest    = path.join(destDir, '.env');

// ── 디렉토리 재귀 복사 ────────────────────────────────────────
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`  [SKIP] 없음: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n=== copy-standalone ===');
console.log('Source :', NEXT_APP_DIR);
console.log('Dest   :', destDir, '\n');

// standalone 폴더 존재 확인 (Next.js 빌드가 완료됐는지 체크)
if (!fs.existsSync(sourceDir)) {
  console.error('[ERROR] standalone 빌드 결과가 없습니다:', sourceDir);
  console.error(`먼저 Next.js 빌드를 실행하세요:\n  cd ${NEXT_APP_DIR}\n  yarn build\n`);
  process.exit(1);
}

// ── P-18 수정: data 폴더 보존을 위해 빌드 전 임시 백업 ──────
// 기존 standalone 전체 삭제 전에 data 폴더를 임시 경로로 이동.
// 복사 완료 후 임시 경로에서 복원 → 중단 시 데이터 손실 방지.
let dataTmpBackup = null;
const existingDataDir = path.join(destDir, 'data');

if (fs.existsSync(existingDataDir)) {
  // OS 임시 디렉토리에 고유한 백업 경로 생성
  dataTmpBackup = path.join(os.tmpdir(), `ptz-data-backup-${Date.now()}`);
  try {
    fs.renameSync(existingDataDir, dataTmpBackup);
    console.log(`[INFO] data 폴더 임시 백업: ${dataTmpBackup}`);
  } catch (e) {
    // rename 실패 시(cross-device 등) copyDir 로 복사 후 원본 유지
    console.warn('[WARN] data 폴더 rename 실패, 복사 방식으로 대체:', e.message);
    copyDir(existingDataDir, dataTmpBackup);
    dataTmpBackup = dataTmpBackup; // 복사 방식이므로 cleanup 필요
  }
}

// 기존 standalone 폴더 초기화 (구버전 파일 제거)
if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true });
}

// ── [1/6] standalone 서버 번들 복사 ─────────────────────────
console.log('[1/6] standalone  ->', destDir);
copyDir(sourceDir, destDir);

// ── [2/6] 정적 파일 복사 ─────────────────────────────────────
console.log('[2/6] .next/static->', staticDest);
copyDir(staticSrc, staticDest);

// ── [3/6] public 폴더 복사 ───────────────────────────────────
console.log('[3/6] public      ->', publicDest);
copyDir(publicSrc, publicDest);

// ── [4/6] data 폴더 복사 (카메라 설정 등) ───────────────────
// P-18 수정: 임시 백업에서 복원 후, 소스의 신규 파일만 병합
console.log('[4/6] data        ->', dataDest);

if (dataTmpBackup && fs.existsSync(dataTmpBackup)) {
  // 1) 백업에서 data 폴더 복원
  try {
    fs.renameSync(dataTmpBackup, dataDest);
    console.log('  [INFO] 기존 data 폴더 복원 완료 (사용자 설정 보호)');
    dataTmpBackup = null;
  } catch (e) {
    // cross-device 이슈 대응: 복사 후 삭제
    copyDir(dataTmpBackup, dataDest);
    fs.rmSync(dataTmpBackup, { recursive: true });
    dataTmpBackup = null;
    console.log('  [INFO] 기존 data 폴더 복원 완료 (복사 방식)');
  }

  // 2) 소스에만 있는 신규 파일 병합 (기존 파일 덮어쓰기 금지)
  if (fs.existsSync(dataSrc)) {
    for (const entry of fs.readdirSync(dataSrc, { withFileTypes: true })) {
      const s = path.join(dataSrc, entry.name);
      const d = path.join(dataDest, entry.name);
      if (!fs.existsSync(d)) {
        entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
        console.log(`  [NEW] ${entry.name}`);
      }
    }
  }
} else {
  // 최초 복사 (백업 없음 = data 폴더가 없던 상태)
  copyDir(dataSrc, dataDest);
}

// ── [5/6] .env 복사 + NEXTAUTH_URL 강제 http 설정 ──────────
console.log('[5/6] .env        ->', envDest);
if (!fs.existsSync(envSrc)) {
  console.warn('  [WARN] .env 파일 없음:', envSrc);
  console.warn('         DATABASE_URL / NEXTAUTH_SECRET 없으면 로그인 실패합니다.');
} else {
  let envContent = fs.readFileSync(envSrc, 'utf8');

  // P-17 수정: PORT 를 .env 에서 읽어 NEXTAUTH_URL 에 동적 반영
  // .env 의 PORT 값을 먼저 파싱하고, 없으면 환경변수, 없으면 3000 사용.
  let port = 3000;
  const portMatch = envContent.match(/^PORT\s*=\s*["']?(\d+)["']?/m);
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
    console.log(`  PORT → ${port} (.env 에서 읽음)`);
  } else if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
    console.log(`  PORT → ${port} (환경변수에서 읽음)`);
  } else {
    console.log(`  PORT → ${port} (기본값 사용)`);
  }

  // ⚠️ NEXTAUTH_URL 강제 http 처리:
  //   Electron 내장 서버는 TLS 없이 localhost 로 동작하므로
  //   https 로 설정되면 NextAuth 리다이렉트가 실패함.
  //   기존 NEXTAUTH_URL 값(https 포함)을 제거하고 항상 http 로 덮어씀.
  const correctNextAuthUrl = `http://localhost:${port}`;

  if (envContent.includes('NEXTAUTH_URL')) {
    // 기존 줄을 정규식으로 교체 (https 이든 http 이든 덮어씀)
    envContent = envContent.replace(
      /^NEXTAUTH_URL=.*$/m,
      `NEXTAUTH_URL="${correctNextAuthUrl}"`,
    );
    console.log(`  NEXTAUTH_URL → "${correctNextAuthUrl}" (강제 http 적용)`);
  } else {
    // 없으면 새로 추가
    envContent += `\n# Electron 데스크톱용 자동 추가\nNEXTAUTH_URL="${correctNextAuthUrl}"\n`;
    console.log(`  NEXTAUTH_URL="${correctNextAuthUrl}" 자동 추가됨`);
  }

  fs.writeFileSync(envDest, envContent, 'utf8');
  console.log('  .env 복사 완료');

  // ── 필수 환경변수 확인 ──────────────────────────────────────
  // DATABASE_URL, NEXTAUTH_SECRET : DB 연결 및 JWT 서명 (없으면 로그인 불가 - 필수)
  // LICENSE_SECRET                : 오프라인 라이선스 서명 (없으면 라이선스 기능 불가)
  // LICENSE_SERVER_URL            : 온라인 라이선스 발급 서버 (없으면 온라인 발급 불가)
  const missing = [];
  if (!envContent.includes('DATABASE_URL'))    missing.push('DATABASE_URL');
  if (!envContent.includes('NEXTAUTH_SECRET')) missing.push('NEXTAUTH_SECRET');
  if (missing.length > 0) {
    console.warn(`\n  [WARN] 필수 환경변수 누락: ${missing.join(', ')}`);
    console.warn('         .env 파일에 추가하지 않으면 앱이 정상 동작하지 않습니다.\n');
  }

  const warnMissing = [];
  if (!envContent.includes('LICENSE_SECRET'))     warnMissing.push('LICENSE_SECRET');
  if (!envContent.includes('LICENSE_SERVER_URL')) warnMissing.push('LICENSE_SERVER_URL');
  if (warnMissing.length > 0) {
    console.warn(`\n  [WARN] 권장 환경변수 누락: ${warnMissing.join(', ')}`);
    console.warn('         없으면 라이선스 기능(오프라인 모드/온라인 발급)이 동작하지 않습니다.\n');
  }
}

// ── [6/6] Prisma 엔진 파일 복사 ─────────────────────────────
//
// Next.js standalone 빌드는 node_modules 를 최소화해서 복사하는 과정에서
// .prisma/client 의 엔진 바이너리(.dll.node, .so.node)와 schema.prisma 를
// 누락하는 경우가 있음.
//
// Prisma index.js 는 __dirname/schema.prisma 존재 여부로 엔진 경로를 결정:
//   - schema.prisma 없으면 process.cwd() 기준으로 탐색 → 엔진 못 찾음
//   - 따라서 .prisma/client 전체를 강제 복사해야 함
//
// 추가: @prisma/client 도 복사 (일부 환경에서 require 시 필요)
//
console.log('[6/6] Prisma engine files...');

// (6a) .prisma/client
const prismaSrc  = path.join(NEXT_APP_DIR, 'node_modules', '.prisma',  'client');
const prismaDest = path.join(destDir,       'node_modules', '.prisma',  'client');

// (6b) @prisma/client
const prismaAtSrc  = path.join(NEXT_APP_DIR, 'node_modules', '@prisma', 'client');
const prismaAtDest = path.join(destDir,       'node_modules', '@prisma', 'client');

if (!fs.existsSync(prismaSrc)) {
  console.warn('  [WARN] .prisma/client 없음:', prismaSrc);
  console.warn('         npx prisma generate 를 먼저 실행하세요.');
} else {
  // 기존 폴더 제거 후 전체 재복사 (구버전 엔진 파일 혼재 방지)
  if (fs.existsSync(prismaDest)) fs.rmSync(prismaDest, { recursive: true });
  copyDir(prismaSrc, prismaDest);

  const engineFiles = fs.readdirSync(prismaDest)
    .filter(f => f.endsWith('.node') || f.endsWith('.dll'));
  console.log('  Copied .prisma/client engine files:');
  engineFiles.forEach(f => console.log(`    ✔ ${f}`));

  if (engineFiles.length === 0) {
    console.warn('  [WARN] 엔진 파일이 없습니다! npx prisma generate 를 실행하세요.');
  }

  // Windows 엔진 파일 경고
  if (!engineFiles.some(f => f.includes('windows'))) {
    console.warn('\n  [WARN] Windows용 엔진(query_engine-windows.dll.node)이 없습니다!');
    console.warn('         schema.prisma 의 binaryTargets 에 "windows" 를 추가하고');
    console.warn('         npx prisma generate 후 yarn build 를 다시 실행하세요.\n');
  }
}

if (!fs.existsSync(prismaAtSrc)) {
  console.warn('  [WARN] @prisma/client 없음:', prismaAtSrc);
} else {
  if (fs.existsSync(prismaAtDest)) fs.rmSync(prismaAtDest, { recursive: true });
  copyDir(prismaAtSrc, prismaAtDest);
  console.log('  ✔ @prisma/client 복사 완료');
}

// ── [7/7] server.js 패치: outputFileTracingRoot 하드코딩 제거 (P-09 수정) ──
//
// Next.js 빌드 시 nextConfig.experimental.outputFileTracingRoot 에
// 빌드 환경의 절대경로(예: E:\Web\devroot\...)가 하드코딩됨.
// 이 경로는 standalone 실행 환경과 다르므로 파일 추적 오류를 유발할 수 있음.
// 배포된 standalone 에서는 이미 모든 파일이 번들되어 있으므로
// outputFileTracingRoot 를 __dirname(server.js 위치)으로 교체하거나 제거.
//
console.log('[7/7] server.js 패치 (outputFileTracingRoot 수정)...');
const serverJsPath = path.join(destDir, 'server.js');

if (!fs.existsSync(serverJsPath)) {
  console.warn('  [SKIP] server.js 없음 — 패치 건너뜀');
} else {
  try {
    let serverContent = fs.readFileSync(serverJsPath, 'utf8');

    // nextConfig JSON 에서 outputFileTracingRoot 키를 현재 디렉토리 기준으로 교체.
    // JSON 문자열 내에서 "outputFileTracingRoot":"<hardcoded-path>" 패턴을 탐색하여
    // __dirname 을 사용하는 런타임 표현으로 교체할 수 없으므로 (JSON 은 코드가 아님),
    // 대신 해당 키의 값을 빈 문자열로 초기화한 뒤 server.js 상단에
    // 런타임에 __dirname 으로 덮어쓰는 코드를 삽입.
    //
    // 방법: JSON 에서 outputFileTracingRoot 값을 빈 문자열로 교체,
    //       그리고 nextConfig 파싱 후 __dirname 으로 덮어쓰기 코드 추가.

    // 1) JSON 내 outputFileTracingRoot 값 교체 (빈 문자열로 초기화)
    const before = serverContent;
    serverContent = serverContent.replace(
      /"outputFileTracingRoot"\s*:\s*"(?:[^"\\]|\\.)*"/g,
      '"outputFileTracingRoot":""',
    );

    if (serverContent === before) {
      console.log('  [INFO] outputFileTracingRoot 패턴 없음 — 패치 불필요');
    } else {
      // 2) __NEXT_PRIVATE_STANDALONE_CONFIG 설정 다음 줄에
      //    런타임 __dirname 으로 outputFileTracingRoot 덮어쓰기 삽입
      const insertAfter = 'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)';
      if (serverContent.includes(insertAfter)) {
        const patchCode = [
          '',
          '// P-09 패치: outputFileTracingRoot 를 런타임 __dirname 으로 덮어씀',
          '// (빌드 시 하드코딩된 개발 환경 절대경로를 배포 환경에서 유효한 경로로 교체)',
          'try {',
          '  const _cfg = JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG || "{}");',
          '  if (_cfg.experimental) _cfg.experimental.outputFileTracingRoot = __dirname;',
          '  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(_cfg);',
          '} catch(_e) {}',
          '',
        ].join('\n');
        serverContent = serverContent.replace(insertAfter, insertAfter + patchCode);
        console.log('  ✔ outputFileTracingRoot → __dirname 패치 적용');
      } else {
        console.log('  [INFO] 삽입 지점 없음 — JSON 값만 초기화 처리');
      }

      fs.writeFileSync(serverJsPath, serverContent, 'utf8');
      console.log('  ✔ server.js 패치 완료');
    }
  } catch (patchErr) {
    console.warn('  [WARN] server.js 패치 실패 (계속 진행):', patchErr.message);
  }
}

// ── 임시 백업 정리 (만약 오류로 남아있는 경우) ───────────────
if (dataTmpBackup && fs.existsSync(dataTmpBackup)) {
  try {
    // 복원이 안 된 경우 destDir/data 로 복원 시도
    if (!fs.existsSync(dataDest)) {
      fs.renameSync(dataTmpBackup, dataDest);
      console.warn('[WARN] 임시 백업에서 data 폴더 복원 (오류 복구)');
    } else {
      fs.rmSync(dataTmpBackup, { recursive: true });
    }
  } catch {}
}

console.log('\n✅ Done!\n');
