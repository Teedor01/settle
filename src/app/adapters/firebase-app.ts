import '../../phase1/debug-flag';
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, CustomProvider, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const appCheckProviderKind = env.VITE_RECAPTCHA_SITE_KEY ? 'ReCaptchaEnterpriseProvider (your key)' : 'CustomProvider (debug-only; cannot attest)';
export const appCheck = initializeAppCheck(app, {
  provider: env.VITE_RECAPTCHA_SITE_KEY
    ? new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_SITE_KEY)
    : new CustomProvider({ getToken: () => Promise.reject(new Error('App Check debug mode is not active: the SDK asked the attestation provider for a token instead of exchanging the registered debug token.')) }),
  isTokenAutoRefreshEnabled: true,
});

export const ai = getAI(app, { backend: new GoogleAIBackend() });
export const auth = getAuth(app);
export const db = getFirestore(app);

export const usingEmulators = env.VITE_USE_EMULATORS === 'true' && ['localhost', '127.0.0.1'].includes(location.hostname);
if (usingEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
