/**
 * bundle-node.js
 *
 * EXE 빌드 시 필요한 portable Node.js 를 공식 배포판에서 다운받아
 * node-bin/ 폴더에 번들합니다.
 *
 * 실행:
 *   node scripts/bundle-node.js
 *
 * 완료 후 forge.config.js 의 extraResource 에 './node-bin' 이 있는지 확인.
 * (forge.config.js 에는 이미 등록되어 있음)
 *
 * ⚠️ 주의:
 *   - 현재 실행 환경의 Node.js 버전 및 아키텍처와 동일한 바이너리를 다운로드
 *   - 크로스 컴파일(예: macOS에서 Windows용 빌드)은 지원하지 않음
 *   - Windows 빌드는 Windows 환경에서 실행할 것
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// 현재 실행 중인 Node.js 버전 및 아키텍처에 맞춰 다운로드
const NODE_VERSION = process.versions.node;
const platform = process.platform;
const arch = process.arch; // 'x64' | 'arm64'

const destDir = path.join(__dirname, "..", "node-bin");

// ── 이미 존재하면 스킵 ───────────────────────────────────────
const existingNode = path.join(
    destDir,
    platform === "win32" ? "node.exe" : "node",
);
if (fs.existsSync(existingNode)) {
    console.log(`✅ node-bin already exists (${destDir}), skipping download.`);
    console.log(`   To re-download, delete the node-bin folder and run again.`);
    process.exit(0);
}

// ── 플랫폼 + 아키텍처별 다운로드 URL 결정 ───────────────────
// 버그 수정: 원본은 darwin을 x64로 고정 → Apple Silicon(arm64) 미지원
//   → process.arch 로 현재 아키텍처 감지 후 URL 결정
let fileName;
if (platform === "win32") {
    // Windows: arm64 빌드 없음 → x64 고정
    fileName = `node-v${NODE_VERSION}-win-x64.zip`;
} else if (platform === "darwin") {
    // macOS: Intel(x64) vs Apple Silicon(arm64) 분기
    fileName = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
} else {
    // Linux: x64 / arm64 모두 지원
    fileName = `node-v${NODE_VERSION}-linux-${arch}.tar.gz`;
}

const downloadUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${fileName}`;
const tmpFile = path.join(__dirname, "..", fileName);

console.log(`Node.js version : ${NODE_VERSION} (${arch})`);
console.log(`Platform        : ${platform}`);
console.log(`Downloading     : ${downloadUrl}`);
console.log(`Saving to       : ${tmpFile}\n`);

// ── 리다이렉트를 따라가며 다운로드 ──────────────────────────
function download(url, dest, cb) {
    const file = fs.createWriteStream(dest);
    https
        .get(url, (res) => {
            // HTTP 리다이렉트 처리 (301 / 302)
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                fs.unlinkSync(dest);
                download(res.headers.location, dest, cb);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                cb(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            res.pipe(file);
            file.on("finish", () => file.close(cb));
        })
        .on("error", (err) => {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            cb(err);
        });
}

download(downloadUrl, tmpFile, (err) => {
    if (err) {
        console.error("❌ Download failed:", err.message);
        process.exit(1);
    }

    console.log("✔ Download complete. Extracting...");
    fs.mkdirSync(destDir, { recursive: true });

    try {
        if (platform === "win32") {
            // ── Windows: PowerShell 로 ZIP 압축 해제 ──────────────
            // 버그 수정: fs.rmSync 로 임시 폴더 삭제 시 Windows가 파일 핸들을
            //   아직 잡고 있어 EPERM 발생 → PowerShell Remove-Item 으로 교체
            const extractTmp = path.join(destDir, "_extract_tmp");

            // 혹시 이전 실행의 잔여 폴더가 있으면 먼저 제거
            if (fs.existsSync(extractTmp)) {
                execSync(
                    `powershell -NoProfile -Command "Remove-Item -LiteralPath '${extractTmp}' -Recurse -Force"`,
                    { stdio: "inherit" },
                );
            }

            execSync(
                `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tmpFile}' -DestinationPath '${extractTmp}' -Force"`,
                { stdio: "inherit" },
            );

            // 압축 해제된 내부 폴더 (node-vX.Y.Z-win-x64) 찾기
            const entries = fs.readdirSync(extractTmp);
            if (entries.length === 0)
                throw new Error("Extraction produced no files");
            const innerDir = path.join(extractTmp, entries[0]);

            // node.exe 복사 (필수)
            fs.copyFileSync(
                path.join(innerDir, "node.exe"),
                path.join(destDir, "node.exe"),
            );
            console.log("  ✔ node.exe copied");

            // npm / npx 복사 (선택 — 런타임 실행에는 불필요)
            for (const f of ["npm", "npm.cmd", "npx", "npx.cmd"]) {
                const src = path.join(innerDir, f);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, path.join(destDir, f));
                    console.log(`  ✔ ${f} copied`);
                }
            }

            // 임시 폴더 정리 — PowerShell Remove-Item 사용 (fs.rmSync 는 EPERM 발생)
            execSync(
                `powershell -NoProfile -Command "Remove-Item -LiteralPath '${extractTmp}' -Recurse -Force"`,
                { stdio: "inherit" },
            );
        } else {
            // ── macOS / Linux: tar 로 압축 해제 ──────────────────
            // --strip-components=1 : 최상위 디렉토리(node-vX.Y.Z-...) 를 벗겨냄
            execSync(
                `tar -xzf "${tmpFile}" -C "${destDir}" --strip-components=1`,
                { stdio: "inherit" },
            );
            console.log("  ✔ extracted");
        }

        // 임시 다운로드 파일 삭제
        fs.unlinkSync(tmpFile);

        console.log(
            `\n✅ Node.js ${NODE_VERSION} (${arch}) bundled to: ${destDir}`,
        );
        console.log(
            `\nforge.config.js 의 extraResource 에 './node-bin' 이 등록되어 있는지 확인하세요.`,
        );
    } catch (extractErr) {
        console.error("❌ Extraction failed:", extractErr.message);
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        process.exit(1);
    }
});
