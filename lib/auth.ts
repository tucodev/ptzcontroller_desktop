// auth.ts 내 authorize() 함수 수정 부분

async authorize(credentials) {
  if (!credentials?.email || !credentials?.password) {
    return null;
  }

  const DB_AUTH_TIMEOUT_MS = 3_000;
  
  try {
    // 온라인 DB 시도
    const user = await Promise.race([
      prisma.user.findUnique({ 
        where: { email: credentials.email } 
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), DB_AUTH_TIMEOUT_MS)
      ),
    ]);

    if (user && user.password) {
      const isValid = await bcrypt.compare(credentials.password, user.password);
      if (isValid) {
        // ✅ 온라인 로그인 성공 → 오프라인 DB에 저장 (추가 필드 포함)
        try {
          await saveOfflineUser({
            email: user.email,
            name: user.name || 'User',
            organization: user.organization || undefined,
            passwordHash: user.password,
            role: (user.role as 'user' | 'admin') || 'user',
            lastOnlineLoginAt: new Date().toISOString(),
            lastSyncAt: new Date().toISOString(),
            platform: process.platform,
            appVersion: process.env.npm_package_version,
          });
          console.log('[Auth] Offline user saved with extended fields:', user.email);
        } catch (err) {
          console.warn('[Auth] Failed to save offline user:', err);
        }
        
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      }
    }
  } catch (error) {
    console.error('[Auth] Online DB error:', (error as Error).message);
  }

  // DB 오프라인 또는 온라인 로그인 실패 → 오프라인 저장소 확인
  console.log('[Auth] Attempting offline authentication...');
  try {
    const offlineUser = await verifyOfflinePassword(
      credentials.email,
      credentials.password,
      bcrypt  // bcryptjs 모듈 전달
    );
    
    if (offlineUser) {
      console.log('[Auth] Offline login successful:', credentials.email);
      
      // 오프라인 모드 상태 업데이트
      updateOfflineModeStatus(offlineUser.email, true);
      
      return {
        id: offlineUser.id,
        email: offlineUser.email,
        name: offlineUser.name,
        role: offlineUser.role,
      };
    }
  } catch (err) {
    console.error('[Auth] Offline authentication error:', err);
  }

  return null;
}
