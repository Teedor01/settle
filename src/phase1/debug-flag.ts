const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
if (!import.meta.env.DEV || !isLocalhost) {
  throw new Error('Phase 1 uses the App Check debug provider and runs on localhost only.');
}
(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
export {};
