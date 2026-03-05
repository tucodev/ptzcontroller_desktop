/**
 * scripts/make-portable.js
 *
 * Electron Forge make 후 생성된 ZIP을 Portable 배포용으로 정리.
 *
 * 동작:
 *   1. out/make/zip/win32/x64/*.zip 를 찾음
 *   2. PTZController-Portable-{version}-win32-x64.zip 으로 복사
 *   3. out/portable/ 에 저장
 *
 * 실행:
 *   node scripts/make-portable.js
 *   또는 npm run make:portable 로 호출 (make:win 이후 자동 실행)
 *
 * 사용법:
 *   npm run make:win:portable   ← 인스톨러 + Portable 동시 생성
 *   npm run make:portable       ← ZIP이 이미 있을 때 Portable만 생성
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const pkg      = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version  = pkg.version ?? '1.0.0';
const OUT_DIR  = path.join(ROOT, 'out');
const ZIP_DIR  = path.join(OUT_DIR, 'make', 'zip', 'win32', 'x64');
const PORT_DIR = path.join(OUT_DIR, 'portable');

console.log('\n=== make-portable ===');
console.log(`Version : ${version}`);
console.log(`ZIP dir : ${ZIP_DIR}`);
console.log(`Out dir : ${PORT_DIR}\n`);

// ── ZIP 파일 찾기 ────────────────────────────────────────────
if (!fs.existsSync(ZIP_DIR)) {
  console.error('[ERROR] ZIP 폴더가 없습니다:', ZIP_DIR);
  console.error('먼저 빌드를 실행하세요: npm run make:win\n');
  process.exit(1);
}

const zips = fs.readdirSync(ZIP_DIR).filter(f => f.endsWith('.zip'));
if (zips.length === 0) {
  console.error('[ERROR] ZIP 파일이 없습니다:', ZIP_DIR);
  console.error('먼저 빌드를 실행하세요: npm run make:win\n');
  process.exit(1);
}

const srcZip  = path.join(ZIP_DIR, zips[0]);
const destName = `PTZController-Portable-${version}-win32-x64.zip`;
const destZip  = path.join(PORT_DIR, destName);

// ── Portable 폴더 생성 및 복사 ───────────────────────────────
fs.mkdirSync(PORT_DIR, { recursive: true });
fs.copyFileSync(srcZip, destZip);

console.log(`✅ Portable 생성 완료:`);
console.log(`   ${destZip}\n`);
console.log('사용법:');
console.log('  1. ZIP 압축 해제');
console.log('  2. ptz-controller.exe 실행 (설치 불필요)\n');
