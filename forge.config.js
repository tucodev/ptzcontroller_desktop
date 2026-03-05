module.exports = {
  packagerConfig: {
    // ── asar 설정 ────────────────────────────────────────────
    // asar: true 이면 standalone/server.js 를 spawn 으로 실행할 수 없음.
    // unpackDir 로 실행이 필요한 파일들을 asar 밖(app.asar.unpacked/)으로 꺼냄.
    // 단, standalone 은 extraResource 로 따로 복사하므로 unpackDir 에서 제외.
    asar: {
      // ws 는 asar 안에 묶이면 require('ws') 가 실패하므로 반드시 unpack
      unpackDir: '{node_modules/.prisma,node_modules/@prisma,node_modules/ws,node_modules/bufferutil,node_modules/utf-8-validate}',
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
    // node-bin   : 번들된 Node.js 바이너리 (scripts/bundle-node.js 로 생성)
    //
    // ⚠️ node-bin 폴더가 없으면 빌드 전에 아래 명령 실행:
    //     node scripts/bundle-node.js
    extraResource: [
      './standalone',
      './node-bin',  // bundle-node.js 로 생성된 portable Node.js
    ],

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
