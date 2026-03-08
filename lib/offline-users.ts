// lib/offline-users.ts
// 로컬 JSON 기반 사용자 저장소
interface OfflineUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'user' | 'admin';
  createdAt: string;
  offline: true;
}

function getOfflineUser(email: string): OfflineUser | null { ... }
function saveOfflineUser(user: OfflineUser): void { ... }
function verifyOfflinePassword(email: string, password: string): OfflineUser | null { ... }