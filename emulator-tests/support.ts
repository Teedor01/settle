import assert from 'node:assert/strict';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, terminate, type Firestore } from 'firebase/firestore';

export const PROJECT_ID = 'demo-settle';
const hp = (v: string | undefined, dflt: string) => { const [h, p] = (v ?? dflt).split(':'); return { host: !h || h === '0.0.0.0' ? '127.0.0.1' : h, port: Number(p) }; };
export const FS = hp(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
export const AUTH = hp(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');

export interface Client { app: FirebaseApp; auth: Auth; db: Firestore; close(): Promise<void> }
let counter = 0;

export function newClient(label = 'client'): Client {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key', authDomain: 'localhost' }, `${label}-${++counter}-${Date.now()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH.host}:${AUTH.port}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, FS.host, FS.port);
  return { app, auth, db, close: async () => { await terminate(db); await deleteApp(app); } };
}

export async function signUp(c: Client, email: string, password = 'password-123'): Promise<string> {
  return (await createUserWithEmailAndPassword(c.auth, email, password)).user.uid;
}
export async function signIn(c: Client, email: string, password = 'password-123'): Promise<string> {
  return (await signInWithEmailAndPassword(c.auth, email, password)).user.uid;
}

export async function clearAll(): Promise<void> {
  const a = await fetch(`http://${FS.host}:${FS.port}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
  const b = await fetch(`http://${AUTH.host}:${AUTH.port}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' });
  assert.ok(a.ok && b.ok, `could not clear the emulators (firestore ${a.status}, auth ${b.status}): are they running?`);
}

/** Asserts the promise is rejected with Firestore's permission-denied (a rules decision), not any other failure. */
export async function expectDenied(p: Promise<unknown>, what: string): Promise<void> {
  try { await p; } catch (e) { assert.equal((e as { code?: string }).code, 'permission-denied', `${what}: rejected, but not by the rules (${String(e)})`); return; }
  assert.fail(`${what}: expected the rules to deny this, but it succeeded`);
}

// ---- admin (rules-bypass) REST helpers: ONLY to simulate server-side tampering and to inspect what is actually stored
const base = `http://${FS.host}:${FS.port}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const adminHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

/** Marker for a server-side timestamp value in admin writes. */
export const adminTimestamp = (iso = '2026-11-17T10:00:00Z') => ({ __timestamp: iso });

type RestValue = { nullValue?: null; stringValue?: string; booleanValue?: boolean; integerValue?: string; doubleValue?: number; timestampValue?: string; arrayValue?: { values?: RestValue[] }; mapValue?: { fields?: Record<string, RestValue> } };

function toValue(v: unknown): RestValue {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object' && v !== null && '__timestamp' in v) return { timestampValue: String((v as { __timestamp: string }).__timestamp) };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toValue(x)])) } };
}
function fromValue(v: RestValue): unknown {
  if ('nullValue' in v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(fromValue);
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  return undefined;
}
const decodeFields = (f: Record<string, RestValue> | undefined): Record<string, unknown> => Object.fromEntries(Object.entries(f ?? {}).map(([k, x]) => [k, fromValue(x)]));

export type StoredFields = Record<string, unknown>;

export async function adminPut(path: string, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/${path}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }) });
  assert.ok(res.ok, `admin write failed: ${res.status} ${await res.text()}`);
}

export async function adminGet(path: string): Promise<StoredFields | null> {
  const res = await fetch(`${base}/${path}`, { headers: adminHeaders });
  if (res.status === 404) return null;
  assert.ok(res.ok, `admin read failed: ${res.status}`);
  return decodeFields(((await res.json()) as { fields?: Record<string, RestValue> }).fields);
}

export async function adminList(path: string): Promise<{ id: string; fields: StoredFields }[]> {
  const res = await fetch(`${base}/${path}?pageSize=300`, { headers: adminHeaders });
  assert.ok(res.ok, `admin list failed: ${res.status}`);
  const j = (await res.json()) as { documents?: { name: string; fields?: Record<string, RestValue> }[] };
  return (j.documents ?? []).map((d) => ({ id: d.name.split('/').pop() as string, fields: decodeFields(d.fields) }));
}
