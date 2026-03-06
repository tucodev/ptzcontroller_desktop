/**
 * forge.config.js
 *
 * Electron Forge 빌드 설정.
 *
 * P-08 수정:
 *   extraResource 에 './node-bin' 을 조건부로 포함.
 *   node-bin 폴더가 없으면 경고를 출력하고 목록에서 제외하여
 *   빌드 실패 없이 진행 (시스템 Node.js 를 사용하는 환경에서 유효).
 *   번들 Node.js 를 포함하려면 빌드 전에 실행:
 *     node scripts/bundle-node.js
 *
 * P-24 수정:
 *   ws 는 현재 main.js 에서 직접 사용하지 않으므로 asar.unpackDir 에서 제거.
 *   (main.js.ok 의 PTZ Proxy 기능 재활성화 시 다시 추가 필요)
 *
 * P-30 수정:
 *   assets/icon.icns 누락 시 macOS DMG 빌드 실패 방지.
 *   icon.icns 가 없으면 maker-dmg 의 icon 설정을 undefined 로 처리하고 경고 출력.
 *   (macOS 공식 배포 시에는 iconutil 로 icon.icns 를 생성해야 함)
 */

const fs   = require('fs');
const path = require('path');

// ── node-bin 조건부 포함 (P-08) ──────────────────────────────
const nodeBinPath = path.resolve(__dirname, 'node-bin');
const hasNodeBin  = fs.existsSync(nodeBinPath);

if (hasNodeBin) {
  console.log('[forge] node-bin 폴더 감지 → extraResource 에 포함');
} else {
  console.warn(
    '[forge] ⚠️  node-bin 폴더 없음 — 번들 없이 빌드합니다.\n' +
    '         배포 대상 PC 에 Node.js 가 설치돼 있어야 합니다.\n' +
    '         번들 Node.js 포함 시: node scripts/bundle-node.js',
  );
}

const extraResources = ['./standalone'];
if (hasNodeBin) extraResources.push('./node-bin');

// ── macOS icon.icns 조건부 처리 (P-30 수정) ─────────────────
// icon.icns 는 macOS 전용 다중해상도 아이콘 포맷.
// 파일이 없으면 maker-dmg 의 icon 필드를 제거하여 빌드 실패 방지.
// 공식 macOS 배포 시에는 반드시 icon.icns 를 준비해야 함:
//   mkdir icon.iconset
//   sips -z 16 16 assets/icon.png -o icon.iconset/icon_16x16.png
//   sips -z 32 32 assets/icon.png -o icon.iconset/icon_16x16@2x.png
//   sips -z 128 128 assets/icon.png -o icon.iconset/icon_128x128.png
//   sips -z 256 256 assets/icon.png -o icon.iconset/icon_128x128@2x.png
//   sips -z 512 512 assets/icon.png -o icon.iconset/icon_512x512.png
//   iconutil -c icns icon.iconset -o assets/icon.icns
const icnsPath = path.resolve(__dirname, 'assets', 'icon.icns');
const hasIcns  = fs.existsSync(icnsPath);

if (!hasIcns) {
  console.warn(
    '[forge] ⚠️  assets/icon.icns 없음 — macOS DMG 아이콘이 기본값으로 설정됩니다.\n' +
    '         공식 macOS 배포 시 iconutil 로 icon.icns 를 생성하세요.',
  );
}

// ─────────────────────────────────────────────────────────────
module.exports = {
  packagerConfig: {
    // ── asar 설정 ────────────────────────────────────────────
    // asar: true 이면 standalone/server.js 를 spawn 으로 실행할 수 없음.
    // unpackDir 로 실행이 필요한 파일들을 asar 밖(app.asar.unpacked/)으로 꺼냄.
    // 단, standalone 은 extraResource 로 따로 복사하므로 unpackDir 에서 제외.
    //
    // P-24 수정: ws 는 현재 main.js 에서 미사용이므로 제거.
    //           (PTZ Proxy 재활성화 시 다시 추가)
    asar: {
      unpackDir: '{node_modules/.prisma,node_modules/@prisma,node_modules/bufferutil,node_modules/utf-8-validate}',
    },

    name:           'PTZ Controller',
    executableName: 'ptz-controller',
    icon:           './assets/icon',
    appBundleId:    'com.ptzcontroller.app',
    appCopyright:   'Copyright © 2024 TYCHE. All rights reserved.',

    win32metadata: {
      CompanyName:     'TYCHE',
      ProductName:     'PTZ Controller',
      FileDescription: 'PTZ Camera Controller Application',
    },

    // ── extraResource ─────────────────────────────────────────
    // standalone : Next.js 서버 번들 (node 로 직접 실행)
    // node-bin   : 번들된 Node.js 바이너리 (있을 때만 포함, P-08 수정)
    extraResource: extraResources,

    ignore: [
      /^\/\.git/,
      /node_modules\/\.cache/,
      // standalone, node-bin 은 extraResource 로 처리하므로 asar 패키지에서 제외
      /^\/standalone/,
      /^\/node-bin/,
    ],
  },

  rebuildConfig: {},

  makers: [
    // Windows: Squirrel 설치 패키지 (.exe 인스톨러)
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name:      'PTZController',
        setupIcon: './assets/icon.ico',
        // iconUrl: Squirrel 업데이트 서버가 있을 때만 사용
        // 없으면 제거해야 빌드 오류 방지
      },
    },
    // 모든 플랫폼: ZIP 아카이브
    // Windows: make:portable 스크립트로 Portable 배포판 생성에 사용
    // → out/make/zip/win32/x64/*.zip → out/portable/PTZController-Portable-{version}-win32-x64.zip
    {
      name:      '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    // macOS: DMG 설치 패키지 (P-26 수정: macOS 표준 배포 포맷 추가)
    // ⚠️ maker-dmg 는 macOS 환경에서만 빌드 가능 (hdiutil 의존)
    // P-30 수정: icon.icns 없을 때 icon 필드 제거하여 빌드 실패 방지
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name:   'PTZ Controller',
        ...(hasIcns ? { icon: './assets/icon.icns' } : {}),
        format: 'ULFO',
      },
      platforms: ['darwin'],
    },
    // Linux: Debian 패키지
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          maintainer: 'Tyche PTZ Controller Team',
          homepage:   'https://www.tyche.pro/',
        },
      },
    },
    // Linux: RPM 패키지
    {
      name:   '@electron-forge/maker-rpm',
      config: {},
    },
  ],

  plugins: [
    // native .node 모듈을 asar 밖으로 자동으로 unpack
    {
      name:   '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
