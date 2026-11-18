import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';

export interface AuthUser { uid: string; email: string | null }

export function createAuthPort(auth: Auth) {
  return {
    signUp: async (email: string, password: string) => { await createUserWithEmailAndPassword(auth, email, password); },
    signIn: async (email: string, password: string) => { await signInWithEmailAndPassword(auth, email, password); },
    signOut: async () => { await signOut(auth); },
    onChange: (cb: (u: AuthUser | null) => void) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email } : null)),
  };
}
