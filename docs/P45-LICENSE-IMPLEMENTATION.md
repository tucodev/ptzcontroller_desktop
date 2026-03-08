## File 3: 라이선스 저장 경로 (모든 플랫폼)

OS 경로

Windows C:\ProgramData\PTZController\
macOS /Library/Application Support/PTZController/
Linux ~/.config/PTZController/

라이선스 파일명

online.ptzlic – 온라인 라이선스 (자동 저장)
offline.ptzlic – 오프라인 라이선스 (수동 업로드)
offline.ptzreq – 오프라인 요청 (수동 생성, P-47에서)

사용 예시 (렌더러)

```Copy
// 온라인 라이선스 검증 및 저장
window.electronAPI.validateLicenseOnline(
'https://license.example.com/api/license/validate',
'jwt_token_here'
);

// 오프라인 라이선스 상태 확인
window.electronAPI.checkOfflineLicense();

// 전체 라이선스 상태 조회
window.electronAPI.getLicenseStatus();

// 라이선스 상태 변경 이벤트 수신
const cleanup = window.electronAPI.onLicenseStatus((event, status) => {
console.log('라이선스 상태:', status);
});

// 정리
cleanup();
```

## 다음 단계 (P-47)

HWID 생성 함수 추가
오프라인 요청 파일 생성
오프라인 라이선스 파일 업로드/검증 UI

이제 이 코드를 GitHub의 `docs/P46-LICENSE-IMPLEMENTATION.md` 파일에 저장하겠습니다.

실제 코드 적용을 원하시면, 위 내용을 아래와 같이 적용하면 됩니다:

1. **electron/main.js** – `getSharedDataDir()` 함수 다음에 라이선스 경로 함수 추가
2. **electron/main.js** – `parseEnv()` 함수 다음에 라이선스 검증 함수 추가
3. **electron/main.js** – `request-status` IPC 핸들러 이후에 라이선스 IPC 추가
4. **electron/preload.js** – `saveSettings` 메소드 다음에 라이선스 API 추가

**확인 사항:**

- LICENSE_SERVER_URL 환경변수가 `.env` 파일에 설정되어 있나요?
- 라이선스 서버의 API 엔드포인트 형식이 위와 동일한가요?
- 온라인 인증 후 authToken을 어떻게 주입할 예정인가요? (NextAuth 토큰인가?)

# P-46: Online License Verification & Auto-Save Implementation

**Document Version**: 1.0  
**Date**: 2026-03-07  
**File Path**: `docs/P46-LICENSE-IMPLEMENTATION.md`

---

## 📊 Overview

This document provides a complete analysis of the PTZ Controller licensing system (based on `ptzcontroller_admin`) and its integration with `ptzcontroller_desktop`.

### Key Points

- License storage is **unified across all platforms**
- Online login triggers **automatic license verification & storage**
- Offline mode remains functional even without internet
- HWID-based licensing ensures PC-specific bindings

---

## 1️⃣ License Storage Paths (Unified)

| OS      | Path                                                       |
| ------- | ---------------------------------------------------------- |
| Windows | `C:\ProgramData\PTZController\online.ptzlic`               |
| macOS   | `/Library/Application Support/PTZController/online.ptzlic` |
| Linux   | `~/.config/PTZController/online.ptzlic`                    |

**Offline License**: Same location, filename `offline.ptzlic`

**Important**: Both `ptzcontroller_admin` and `ptzcontroller_desktop` use identical paths via platform-specific `getLicensePath()` functions.

---

## 2️⃣ License Server API Endpoints (ptzcontroller_admin)

### POST `/api/license/request-online`

**Purpose**: Request license issuance after user logs in (online mode)

**Requirements**:

- NextAuth session required (user must be logged in)
- Automatically collects: userId, userEmail, machineId, machineIds[], userName, userOrg

**Request Body** (auto-generated):

```json
{
  "userId": "user-uuid",
  "userEmail": "user@example.com",
  "userName": "John Doe",
  "userOrg": "Company Inc",
  "machineId": "HWID-A1B2C3D4E5F6G7H8",
  "machineIds": ["HWID-A1B...", "HWID-I9J...", ...]
}
Copy
Response:

Copy{
  "status": "pending|approved|rejected",
  "requestId": "req-xxxxx",
  "license": "base64-encoded-license-file",
  "machineId": "HWID-A1B2C3D4E5F6G7H8",
  "message": "..."
}
Flow:

User logs in to ptzcontroller_desktop (Next.js app in Electron)
App calls /api/license/request-online (with NextAuth session)
Backend proxies request to LICENSE_SERVER_URL/api/license/request
Response returned to browser (no server-side storage)
GET /api/license/verify
Purpose: Check if saved license file is valid

Response:

Copy{
  "valid": true|false,
  "expiresAt": "2027-03-07T23:59:59Z",
  "machineId": "HWID-A1B2C3D4E5F6G7H8",
  "reason": "License expired" (if invalid)
}
POST /api/license/verify (multipart/form-data)
Purpose: User uploads a license file (.ptzlic) for verification & storage

Request:

Field name: license
File type: .ptzlic only
Content: base64-encoded JSON license object
Response:

Copy{
  "success": true,
  "expiresAt": "2027-03-07T23:59:59Z",
  "machineId": "HWID-A1B2C3D4E5F6G7H8"
}
Storage: File saved to LICENSE_FILE_PATH (see paths above)

GET /api/license/poll?requestId=...
Purpose: Poll license server to check if manual request has been approved

Response:

Copy{
  "status": "pending|approved|rejected",
  "license": "base64-..." (if approved),
  "expiresAt": "2027-03-07T23:59:59Z",
  "note": "..."
}
Polling Interval: 30 seconds (from UI)

3️⃣ HWID Generation (lib/license.ts Analysis)
MachineID Composition
MachineID = SHA256(osId || hardwareKey)[:16] (uppercase)

Hardware Sources
Physical NIC MAC Addresses (both active & inactive):

Windows:  Get-NetAdapter | MacAddress (PowerShell)
macOS:    networksetup -listallhardwareports
Linux:    /sys/class/net/*/address
Internal Hard Drive Serial (USB/removable excluded):

Windows:  Get-PhysicalDisk | SerialNumber
macOS:    system_profiler SPStorageDataType
Linux:    /sys/block/*/device/serial
OS Identity (salt):

Windows:  HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
macOS:    IOPlatformUUID
Linux:    /etc/machine-id
Calculation Example
osId = "windows-x64-16gb"
mac1 = "A0:B1:C2:D3:E4:F5"
mac2 = "A0:B1:C2:D3:E4:F6"
hdd1 = "WDC-12345678"

machineIds = [
  SHA256(osId || mac1)[:16].toUpperCase(),  // "HWID-A1B2C3D4E5F6G7H8"
  SHA256(osId || mac2)[:16].toUpperCase(),  // "HWID-I9J0K1L2M3N4O5P6"
  SHA256(osId || hdd1)[:16].toUpperCase(),  // "HWID-Q7R8S9T0U1V2W3X4"
]
Verification Logic
Issue time: Store all machineIds in license
Verify time: Check if ANY current machineId matches stored machineIds
Effect: Tolerant to hardware changes (NIC replaced → HDD still works, etc.)
4️⃣ License File Format
Content (base64-decoded)
Copy{
  "machineId": "HWID-A1B2C3D4E5F6G7H8",
  "machineIds": [
    "HWID-A1B2C3D4E5F6G7H8",
    "HWID-I9J0K1L2M3N4O5P6",
    "HWID-Q7R8S9T0U1V2W3X4"
  ],
  "issuedAt": "2026-03-07T12:00:00Z",
  "expiresAt": "2027-03-07T23:59:59Z",
  "product": "PTZ-OFFLINE",
  "sig": "sha256_hmac_full_64_char_hex_string"
}
Storage Format
Base64(JSON) written to file as UTF-8 text

Signature Verification
sig = HMAC-SHA256(JSON.stringify(payload_without_sig), MASTER_SECRET)
MASTER_SECRET = process.env.LICENSE_SECRET (from .env)
5️⃣ NextAuth Session & Token
Session Object
Copysession.user = {
  id: "user-uuid",
  email: "user@example.com",
  name: "John Doe",
  role: "user|admin",
  // ... additional fields
}
Token Transmission
Automatic: NextAuth session cookie (next-auth.session-token)
Manual: Authorization: Bearer <jwt> header (if custom)
Validation: Checked by getServerSession(authOptions) in API routes
License Server Access
ptzcontroller_admin: Uses LICENSE_SERVER_URL (server env var, not exposed to browser)
ptzcontroller_desktop: Calls /api/license/request-online which proxies the request
Security: Only authenticated users can request licenses
6️⃣ Environment Variables (.env)
Required
LICENSE_SERVER_URL=https://license.example.com
LICENSE_SECRET=long-random-secret-for-hmac-signing
In ptzcontroller_desktop
Copied from ptzcontroller_admin's .env via scripts/copy-standalone.js

In Electron
LICENSE_SERVER_URL is available to Electron main process
Used by P-46 functions to validate online licenses
7️⃣ Implementation Steps (ptzcontroller_desktop)
Step 1: electron/main.js Functions
1a. License Paths
Copyfunction getLicensePath() {
  if (process.platform === 'win32') {
    const pd = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(pd, 'PTZController');
  } else if (process.platform === 'darwin') {
    return '/Library/Application Support/PTZController';
  } else {
    return path.join(process.env.HOME || '/etc', '.config', 'PTZController');
  }
}

function getLicenseFilePath(filename) {
  return path.join(getLicensePath(), filename);
}

const ONLINE_LICENSE_FILE = 'online.ptzlic';
const OFFLINE_LICENSE_FILE = 'offline.ptzlic';
1b. License Validation
Copyfunction isLicenseValid(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lic = JSON.parse(Buffer.from(content, 'base64').toString());

    // Required fields
    if (!lic.machineId || !lic.expiresAt) return false;

    // Expiry check
    if (new Date(lic.expiresAt) < new Date()) {
      console.warn('[Desktop] License expired:', lic.expiresAt);
      return false;
    }

    // Status check (if present)
    if (lic.status && lic.status !== 'valid') return false;

    return true;
  } catch (e) {
    console.error('[Desktop] License validation error:', e.message);
    return false;
  }
}
1c. License File I/O
Copyfunction saveLicenseFile(filename, content) {
  try {
    const filePath = getLicenseFilePath(filename);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[Desktop] License saved: ${filePath}`);
    return true;
  } catch (e) {
    console.error(`[Desktop] License save failed: ${e.message}`);
    return false;
  }
}

function readLicenseFile(filename) {
  try {
    const filePath = getLicenseFilePath(filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (e) {
    console.error('[Desktop] License read error:', e.message);
    return null;
  }
}
1d. Online License Validation (HTTP POST)
Copyasync function validateLicenseFromServer(serverUrl, apiPath, sessionToken) {
  if (!serverUrl || !sessionToken) {
    console.warn('[Desktop] Missing serverUrl or sessionToken');
    return null;
  }

  try {
    const fullUrl = `${serverUrl}${apiPath}`;
    const isSecure = fullUrl.startsWith('https');
    const client = isSecure ? require('https') : require('http');

    return new Promise((resolve) => {
      const options = new URL(fullUrl);
      options.method = 'POST';
      options.headers = {
        'Content-Type': 'application/json',
        'Cookie': `next-auth.session-token=${sessionToken}`
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200 && json.status === 'approved' && json.license) {
              console.log('[Desktop] License validated successfully');
              resolve(json.license); // base64-encoded
            } else {
              console.warn('[Desktop] License validation failed:', json.error || json.status);
              resolve(null);
            }
          } catch (parseErr) {
            console.error('[Desktop] Response parse error:', parseErr.message);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Desktop] Request error:', err.message);
        resolve(null);
      });

      req.setTimeout(10000, () => {
        console.warn('[Desktop] License validation timeout');
        req.destroy();
        resolve(null);
      });

      req.write('{}');
      req.end();
    });
  } catch (e) {
    console.error('[Desktop] License validation exception:', e.message);
    return null;
  }
}
Copy
1e. IPC Handlers
CopyipcMain.on('validate-license-online', async (event, { serverUrl, apiPath, sessionToken }) => {
  console.log('[IPC] validate-license-online');
  const license = await validateLicenseFromServer(serverUrl, apiPath, sessionToken);
  if (license) {
    const saved = saveLicenseFile(ONLINE_LICENSE_FILE, license);
    event.sender.send('license-validated', { success: saved, license: saved ? license : null });
  } else {
    event.sender.send('license-validated', { success: false, message: 'Validation failed' });
  }
});

ipcMain.on('check-offline-license', (event) => {
  console.log('[IPC] check-offline-license');
  const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);
  const isValid = isLicenseValid(offlinePath);
  const content = readLicenseFile(OFFLINE_LICENSE_FILE);
  event.sender.send('offline-license-checked', { valid: isValid, content });
});

ipcMain.on('get-license-status', (event) => {
  console.log('[IPC] get-license-status');
  const onlinePath = getLicenseFilePath(ONLINE_LICENSE_FILE);
  const offlinePath = getLicenseFilePath(OFFLINE_LICENSE_FILE);
  event.sender.send('license-status', {
    online: {
      valid: isLicenseValid(onlinePath),
      path: onlinePath,
      hasFile: fs.existsSync(onlinePath)
    },
    offline: {
      valid: isLicenseValid(offlinePath),
      path: offlinePath,
      hasFile: fs.existsSync(offlinePath)
    }
  });
});

ipcMain.on('upload-license-file', async (event, { filename, content }) => {
  console.log('[IPC] upload-license-file:', filename);
  const saved = saveLicenseFile(OFFLINE_LICENSE_FILE, content);
  event.sender.send('license-uploaded', { success: saved });
});
Copy
Step 2: electron/preload.js Methods
Copy// ── License API (P-46) ───────────────────────────────
validateLicenseOnline: (serverUrl, apiPath, sessionToken) =>
  ipcRenderer.send('validate-license-online', { serverUrl, apiPath, sessionToken }),

checkOfflineLicense: () =>
  ipcRenderer.send('check-offline-license'),

getLicenseStatus: () =>
  ipcRenderer.send('get-license-status'),

uploadLicenseFile: (filename, content) =>
  ipcRenderer.send('upload-license-file', { filename, content }),

// ── License Events (P-46) ────────────────────────────
onLicenseValidated: (callback) => {
  ipcRenderer.on('license-validated', callback);
  return () => ipcRenderer.removeListener('license-validated', callback);
},

onOfflineLicenseChecked: (callback) => {
  ipcRenderer.on('offline-license-checked', callback);
  return () => ipcRenderer.removeListener('offline-license-checked', callback);
},

onLicenseStatus: (callback) => {
  ipcRenderer.on('license-status', callback);
  return () => ipcRenderer.removeListener('license-status', callback);
},

onLicenseUploaded: (callback) => {
  ipcRenderer.on('license-uploaded', callback);
  return () => ipcRenderer.removeListener('license-uploaded', callback);
},
Copy
Step 3: Renderer Integration (Next.js App)
After successful login, call:

Copyasync function validateLicenseAfterLogin() {
  // Get NextAuth session
  const session = await getSession();
  if (!session?.user) return;

  // Extract session token from cookie
  const cookies = document.cookie.split('; ');
  const sessionToken = cookies
    .find(c => c.startsWith('next-auth.session-token='))
    ?.split('=')[1];

  if (!sessionToken) {
    console.warn('[License] No session token found');
    return;
  }

  // Electron Desktop: Request online license validation
  if (window.electronAPI?.validateLicenseOnline) {
    const serverUrl = window.location.origin; // http://localhost:3000
    const apiPath = '/api/license/request-online';

    console.log('[License] Validating online license...');
    window.electronAPI.validateLicenseOnline(serverUrl, apiPath, sessionToken);

    // Wait for response
    const unsubscribe = window.electronAPI.onLicenseValidated((event, result) => {
      if (result.success) {
        console.log('[License] Online license saved successfully');
        showNotification('라이선스가 자동 저장되었습니다');
      } else {
        console.warn('[License] Online license validation failed');
        showNotification('라이선스 자동 저장 실패: ' + result.message, 'warning');
      }
      unsubscribe();
    });
  }
}

// Call after login form submission:
// In login component's onSuccess callback:
// await validateLicenseAfterLogin();
Copy
8️⃣ Testing Checklist
 Electron can access getLicensePath() on all platforms (Win/Mac/Linux)
 License file saved to correct location: C:\ProgramData\PTZController\online.ptzlic
 isLicenseValid() correctly validates base64-encoded JSON
 Expiry date check works (rejects expired licenses)
 Online login triggers /api/license/request-online call
 License server returns {status: "approved", license: "base64..."}
 License auto-saved to disk after online login
 check-offline-license detects saved offline license
 Offline mode enabled when valid license file exists
 Invalid/expired license prevents offline mode
9️⃣ Error Handling
Scenario	Behavior
No .env LICENSE_SERVER_URL	License validation skipped, warning logged
Network timeout (10s)	Resolve as null, show retry option
Invalid base64 in file	Reject, log parse error
Expired license	Invalid, user prompted to re-login
NIC changed after issue	Still valid (machineIds fallback to HDD)
Both NIC & HDD changed	Invalid, generate offline.ptzreq (P-47)
🔟 Next Steps (P-47)
After P-46 is complete:

Generate HWID for offline request (offline.ptzreq)
Provide UI for user to submit HWID to vendor
Receive offline.ptzlic from vendor
Upload offline.ptzlic via form
Verify and save to same location

```
