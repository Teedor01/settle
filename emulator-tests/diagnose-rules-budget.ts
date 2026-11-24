import { readFileSync } from 'node:fs';
import { doc, serverTimestamp, setDoc, setLogLevel } from 'firebase/firestore';
import { EVENT_CASES, PAYLOAD_CASES, baseEvent } from '../src/app/selftest/schema-cases';
import type { EventKind } from '../src/app/domain/types';
import { FS, PROJECT_ID, clearAll, newClient, signUp, type Client } from './support';

type Outcome = 'ACCEPTED' | 'DENIED' | 'MAX1000' | 'OTHER';
const pad = (n: number) => String(n).padStart(10, '0');
let seqCounter = 0;

async function putRules(content: string): Promise<void> {
  const res = await fetch(`http://${FS.host}:${FS.port}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  if (!res.ok) throw new Error(`could not load rules into the emulator: ${res.status} ${await res.text()}`);
}

async function classify(write: () => Promise<void>): Promise<Outcome> {
  try { await write(); return 'ACCEPTED'; } catch (e) {
    const message = String((e as { message?: unknown }).message ?? e);
    if (/maximum of 1000 expressions/.test(message)) return 'MAX1000';
    return (e as { code?: string }).code === 'permission-denied' ? 'DENIED' : 'OTHER';
  }
}

async function main(): Promise<void> {
  setLogLevel('silent'); // the SDK logs every denied write; the outcome is classified below
  await clearAll();
  const realRules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  await putRules(realRules);
  const c: Client = newClient('diagnose');
  const uid = await signUp(c, 'diagnose@example.test');
  await setDoc(doc(c.db, 'users', uid, 'devices', 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() });
  const validTask = PAYLOAD_CASES.find((k) => k.name === 'valid task_archived')?.payload;
  const evRef = (seq: number) => doc(c.db, 'users', uid, 'devices', 'dev-a', 'events', pad(seq));
  const event = (seq: number, kind: EventKind, payload: unknown) => ({ ...baseEvent({ uid, otherUid: 'someone-else', deviceId: 'dev-a', seq, now: serverTimestamp(), notNow: new Date(), payload }), kind });

  console.log('\n=== 1. every payload case against the REAL rules ===');
  for (const k of PAYLOAD_CASES) {
    const seq = ++seqCounter;
    const outcome = await classify(() => setDoc(evRef(seq), event(seq, k.kind, k.payload)));
    const verdict = outcome === 'ACCEPTED' ? 'accepted' : 'refused';
    const flag = (k.valid && outcome !== 'ACCEPTED') || (!k.valid && outcome === 'ACCEPTED') ? '  <-- WRONG' : '';
    console.log(`${outcome.padEnd(9)} expected ${k.valid ? 'valid  ' : 'invalid'} (${verdict})${flag}  ${k.name}`);
  }

  console.log('\n=== 2. every event-document case (a small valid task_archived payload) against the REAL rules ===');
  for (const k of EVENT_CASES) {
    const seq = ++seqCounter;
    const data = k.build({ uid, otherUid: 'another-user', deviceId: 'dev-a', seq, now: serverTimestamp(), notNow: new Date(), payload: validTask });
    const outcome = await classify(() => setDoc(evRef(seq), data));
    console.log(`${outcome.padEnd(9)} expected ${k.valid ? 'valid  ' : 'invalid'}  ${k.name}`);
  }

  console.log('\n=== 3. SWEEPS: how large can each list be before the REAL rules give up? (each line: size -> outcome) ===');
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  const validPayload = (name: string): Record<string, unknown> => clone(obj(PAYLOAD_CASES.find((k) => k.name === name)?.payload));
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `v-${i}`);
  const sweep = async (label: string, kind: EventKind, from: string, sizes: number[], edit: (p: Record<string, unknown>, n: number) => void) => {
    const row: string[] = [];
    for (const n of sizes) {
      const p = validPayload(from);
      edit(p, n);
      const seq = ++seqCounter;
      row.push(`${n}:${await classify(() => setDoc(evRef(seq), event(seq, kind, p)))}`);
    }
    console.log(`${label.padEnd(46)} ${row.join('  ')}`);
  };
  const version = (p: Record<string, unknown>) => obj(p.version);
  const review = (p: Record<string, unknown>) => obj(version(p).review);
  const det = (p: Record<string, unknown>) => obj(version(p).deterministic);
  const cv = 'valid claim_version_added';
  const to = (max: number) => Array.from({ length: max }, (_, i) => i + 1);
  await sweep('claim_version_added: issues (1 parent)', 'claim_version_added', cv, to(12), (p, n) => { review(p).issues = Array.from({ length: n }, () => ({ detail: 'd', type: 'negation' })); });
  await sweep('claim_version_added: parents (1 issue)', 'claim_version_added', cv, to(8), (p, n) => { version(p).parents = ids(n); });
  await sweep('claim_version_added: outcomeReasons', 'claim_version_added', cv, to(6), (p, n) => { review(p).outcomeReasons = Array.from({ length: n }, () => 'r'); });
  await sweep('claim_version_added: unsupportedFacts', 'claim_version_added', cv, to(12), (p, n) => { det(p).unsupportedFacts = Array.from({ length: n }, () => 'f'); });
  await sweep('claim_version_added: cueWarnings', 'claim_version_added', cv, to(6), (p, n) => { det(p).cueWarnings = Array.from({ length: n }, () => 'w'); });
  await sweep('claim_version_added: issues with 8 parents', 'claim_version_added', cv, to(12), (p, n) => { version(p).parents = ids(8); review(p).issues = Array.from({ length: n }, () => ({ detail: 'd', type: 'negation' })); });
  await sweep('claim_created: parents', 'claim_created', 'valid claim_created', to(8), (p, n) => { version(p).parents = ids(n); });
  await sweep('claim_created: unsupportedFacts', 'claim_created', 'valid claim_created', to(12), (p, n) => { det(p).unsupportedFacts = Array.from({ length: n }, () => 'f'); });
  await sweep('task_created: dependsOn', 'task_created', 'valid task_created', to(16), (p, n) => { p.dependsOn = Array.from({ length: n }, (_, i) => ({ claimId: `c-${i}`, versionId: 'v' })); });
  await sweep('task_title_set: parents', 'task_title_set', 'valid task_title_set', to(8), (p, n) => { p.parents = ids(n); });
  await sweep('task_status_set: parents', 'task_status_set', 'valid task_status_set', to(8), (p, n) => { p.parents = ids(n); });
  await c.close();
  console.log('\nDONE (this diagnostic asserts nothing)');
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
