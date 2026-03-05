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
 *
 * 실행:
 *   node scripts/copy-standalone.js
 *   또는: NEXT_APP_DIR=/경로/to/ptzcontroller_admin node scripts/copy-standalone.js
 *
 * 선행 조건:
 *   cd ptzcontroller_admin && yarn build  (Next.js standalone 빌드)
 */

const fs   = require('fs');
const path = require('path');

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
// 버그 수정: 재빌드 시 standalone/ 전체를 rmSync 후 재생성하면
//   data/cameras.json 등 사용자 설정 파일도 초기화됨.
//   → 이미 standalone/data 가 존재하면 소스의 파일만 병합(덮어쓰지 않음)
console.log('[4/6] data        ->', dataDest);
if (fs.existsSync(dataDest)) {
  // 재빌드: 기존 data 폴더 유지, 소스에만 있는 파일만 복사 (사용자 설정 보호)
  console.log('  [INFO] 기존 standalone/data 폴더 유지 (사용자 설정 보호)');
  if (fs.existsSync(dataSrc)) {
    for (const entry of fs.readdirSync(dataSrc, { withFileTypes: true })) {
      const s = path.join(dataSrc, entry.name);
      const d = path.join(dataDest, entry.name);
      if (!fs.existsSync(d)) {
        // 대상에 없는 파일만 복사 (기존 파일 덮어쓰기 금지)
        entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
        console.log(`  [NEW] ${entry.name}`);
      }
    }
  }
} else {
  // 최초 복사
  copyDir(dataSrc, dataDest);
}

// ── [5/6] .env 복사 + NEXTAUTH_URL 강제 http 설정 ──────────
console.log('[5/6] .env        ->', envDest);
if (!fs.existsSync(envSrc)) {
  console.warn('  [WARN] .env 파일 없음:', envSrc);
  console.warn('         DATABASE_URL / NEXTAUTH_SECRET 없으면 로그인 실패합니다.');
} else {
  let envContent = fs.readFileSync(envSrc, 'utf8');

  // ⚠️ NEXTAUTH_URL 강제 http 처리:
  //   Electron 내장 서버는 TLS 없이 localhost 로 동작하므로
  //   https 로 설정되면 NextAuth 리다이렉트가 실패함.
  //   기존 NEXTAUTH_URL 값(https 포함)을 제거하고 항상 http 로 덮어씀.
  const port = process.env.PORT || 3000;
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
  if (!envContent.includes('DATABASE_URL'))       missing.push('DATABASE_URL');
  if (!envContent.includes('NEXTAUTH_SECRET'))    missing.push('NEXTAUTH_SECRET');
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

// 버그 수정: 원본은 @prisma/client 를 복사하지 않아
//           일부 환경에서 Prisma 초기화 실패
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

console.log('\n✅ Done!\n');
