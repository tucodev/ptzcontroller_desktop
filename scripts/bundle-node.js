/**
 * bundle-node.js
 *
 * EXE 빌드 시 필요한 portable Node.js 를 공식 배포판에서 다운받아
 * node-bin/ 폴더에 번들합니다.
 *
 * 실행 (기본: 현재 환경과 동일한 플랫폼):
 *   node scripts/bundle-node.js
 *
 * P-27 수정: 명령행 인수로 타겟 플랫폼/아키텍처 지정 가능 (크로스 컴파일 지원):
 *   node scripts/bundle-node.js --platform=win32 --arch=x64
 *   node scripts/bundle-node.js --platform=darwin --arch=arm64
 *   node scripts/bundle-node.js --platform=linux --arch=x64
 *
 * 완료 후 forge.config.js 의 extraResource 에 './node-bin' 이 있는지 확인.
 * (forge.config.js 에서 node-bin 폴더 존재 여부를 자동 감지하여 포함)
 *
 * ⚠️ 주의:
 *   - Windows 타겟(win32)은 모든 플랫폼에서 다운로드 가능
 *   - Linux/macOS 타겟: tar 추출 필요 (Windows 호스트 미지원)
 *   - 크로스 빌드 시 추출 방식이 호스트 플랫폼에 의존하므로 주의
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ── P-27 수정: CLI 인수 파싱으로 타겟 플랫폼/아키텍처 지정 지원 ──
function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach((arg) => {
        const m = arg.match(/^--(\w+)=(.+)$/);
        if (m) args[m[1]] = m[2];
    });
    return args;
}

const cliArgs = parseArgs();

// 타겟 플랫폼/아키텍처 결정 (CLI 인수 > 현재 환경)
const NODE_VERSION = process.versions.node;
const platform = cliArgs.platform || process.platform; // win32 | darwin | linux
const arch     = cliArgs.arch     || process.arch;      // x64 | arm64

const isCross = (platform !== process.platform) || (arch !== process.arch);
if (isCross) {
    console.log(`[bundle-node] 크로스 빌드 모드: ${process.platform}/${process.arch} → ${platform}/${arch}`);
} else {
    console.log(`[bundle-node] 네이티브 빌드 모드: ${platform}/${arch}`);
}

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
// 크로스 빌드 지원:
//   win32: ZIP 형식 (PowerShell 압축 해제 필요 → Windows 호스트만 가능,
//                    비 Windows 에서는 unzip 사용)
//   darwin/linux: tar.gz 형식 (tar 명령 필요 → Unix 계열 필수)
let fileName;
if (platform === "win32") {
    // Windows: arm64 빌드 없음 → x64 고정
    fileName = `node-v${NODE_VERSION}-win-x64.zip`;
} else if (platform === "darwin") {
    fileName = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
} else {
    // Linux
    fileName = `node-v${NODE_VERSION}-linux-${arch}.tar.gz`;
}

const downloadUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${fileName}`;
const tmpFile = path.join(__dirname, "..", fileName);

console.log(`Node.js version : ${NODE_VERSION}`);
console.log(`Target platform : ${platform}/${arch}`);
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
            // ── Windows 타겟: ZIP 압축 해제 ───────────────────────
            if (process.platform === "win32") {
                // 호스트가 Windows: PowerShell 사용
                // 버그 수정: fs.rmSync 로 임시 폴더 삭제 시 Windows가 파일 핸들을
                //   아직 잡고 있어 EPERM 발생 → PowerShell Remove-Item 으로 교체
                const extractTmp = path.join(destDir, "_extract_tmp");
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
                const entries = fs.readdirSync(extractTmp);
                if (entries.length === 0) throw new Error("Extraction produced no files");
                const innerDir = path.join(extractTmp, entries[0]);
                fs.copyFileSync(path.join(innerDir, "node.exe"), path.join(destDir, "node.exe"));
                console.log("  ✔ node.exe copied");
                for (const f of ["npm", "npm.cmd", "npx", "npx.cmd"]) {
                    const src = path.join(innerDir, f);
                    if (fs.existsSync(src)) {
                        fs.copyFileSync(src, path.join(destDir, f));
                        console.log(`  ✔ ${f} copied`);
                    }
                }
                execSync(
                    `powershell -NoProfile -Command "Remove-Item -LiteralPath '${extractTmp}' -Recurse -Force"`,
                    { stdio: "inherit" },
                );
            } else {
                // 호스트가 Linux/macOS: unzip 사용 (크로스 빌드)
                const extractTmp = path.join(destDir, "_extract_tmp");
                fs.mkdirSync(extractTmp, { recursive: true });
                execSync(`unzip -q "${tmpFile}" -d "${extractTmp}"`, { stdio: "inherit" });
                const entries = fs.readdirSync(extractTmp);
                if (entries.length === 0) throw new Error("Extraction produced no files");
                const innerDir = path.join(extractTmp, entries[0]);
                fs.copyFileSync(path.join(innerDir, "node.exe"), path.join(destDir, "node.exe"));
                console.log("  ✔ node.exe copied (cross-build)");
                for (const f of ["npm", "npm.cmd", "npx", "npx.cmd"]) {
                    const src = path.join(innerDir, f);
                    if (fs.existsSync(src)) {
                        fs.copyFileSync(src, path.join(destDir, f));
                        console.log(`  ✔ ${f} copied`);
                    }
                }
                fs.rmSync(extractTmp, { recursive: true });
            }
        } else {
            // ── macOS / Linux 타겟: tar 로 압축 해제 ──────────────
            // --strip-components=1 : 최상위 디렉토리(node-vX.Y.Z-...) 를 벗겨냄
            // 크로스 빌드 가능 (tar 는 플랫폼 무관)
            execSync(
                `tar -xzf "${tmpFile}" -C "${destDir}" --strip-components=1`,
                { stdio: "inherit" },
            );
            console.log("  ✔ extracted");
        }

        // 임시 다운로드 파일 삭제
        fs.unlinkSync(tmpFile);

        console.log(`\n✅ Node.js ${NODE_VERSION} (${platform}/${arch}) bundled to: ${destDir}`);
        console.log(`\nforge.config.js 는 node-bin 폴더를 자동 감지하여 extraResource 에 포함합니다.`);

        if (isCross) {
            console.log(`\n⚠️  크로스 빌드: 번들된 Node.js 는 ${platform}/${arch} 에서만 실행됩니다.`);
            console.log(`   빌드 대상 플랫폼에서만 사용하세요.`);
        }
    } catch (extractErr) {
        console.error("❌ Extraction failed:", extractErr.message);
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        process.exit(1);
    }
});
