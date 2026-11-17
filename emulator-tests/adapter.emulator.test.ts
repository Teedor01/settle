import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/app/domain/canonical';
import { eventId, padSeq } from '../src/app/domain/events';
import { nextHlc } from '../src/app/domain/clock';
import type { SyncEvent } from '../src/app/domain/types';
import { FirestoreRemote } from '../src/app/adapters/firestore-remote';
import { adminGet, adminList, adminPut, clearAll, expectDenied, newClient, signIn, signUp, type Client } from './support';

const open: Client[] = [];
const client = (l?: string) => { const c = newClient(l); open.push(c); return c; };
beforeEach(clearAll);
afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });

const SHA = 'a'.repeat(64);
const mkEvent = (deviceId: string, seq: number, payload: Record<string, unknown> = { docId: SHA, title: `doc ${seq}`, sha256: SHA, length: seq }): SyncEvent =>
  ({ id: eventId(deviceId, seq), deviceId, seq, hlc: nextHlc(null, 1_000_000 + seq, deviceId), kind: 'doc_registered', payload });

async function owner() {
  const c = client('owner');
  const uid = await signUp(c, 'owner@example.test');
  return { c, uid, remote: new FirestoreRemote(c.db, uid) };
}

test('registerDevice and listDevices round-trip against real Firestore', async () => {
  const { remote } = await owner();
  await remote.registerDevice('dev-a');
  await remote.registerDevice('dev-b');
  await remote.registerDevice('dev-a'); // idempotent
  assert.deepEqual((await remote.listDevices()).sort(), ['dev-a', 'dev-b']);
});

test('pushEvent: created, then exists_identical on a repeat; the stored record is the canonical event', async () => {
  const { remote, uid } = await owner();
  await remote.registerDevice('dev-a');
  const ev = mkEvent('dev-a', 1);
  assert.equal(await remote.pushEvent(ev), 'created');
  assert.equal(await remote.pushEvent(ev), 'exists_identical');
  assert.equal(await remote.pushEvent({ ...ev, payload: { length: ev.seq, sha256: SHA, title: 'doc 1', docId: SHA } }), 'exists_identical', 'key order is irrelevant');
  const stored = await adminGet(`users/${uid}/devices/dev-a/events/${padSeq(1)}`);
  if (!stored) { assert.fail('the pushed event is not on the server'); return; }
  assert.equal(stored.payloadJson, canonicalJson(ev.payload));
  assert.equal(stored.id, ev.id);
  assert.equal(typeof stored.createdAt, 'undefined', 'serverTimestamp is stored as a timestamp, not a string/integer');
});

test('TAMPERED EVENTS: a different event under an existing id is reported exists_different and the server copy is NOT overwritten', async () => {
  const { remote, uid } = await owner();
  await remote.registerDevice('dev-a');
  await remote.pushEvent(mkEvent('dev-a', 1));
  const forged = mkEvent('dev-a', 1, { docId: SHA, title: 'FORGED', sha256: SHA, length: 1 });
  assert.equal(await remote.pushEvent(forged), 'exists_different');
  assert.match((await adminGet(`users/${uid}/devices/dev-a/events/${padSeq(1)}`))?.payloadJson as string, /doc 1/);
  // and a server-side tamper (rules bypassed, simulating a compromised backend) is detected by the next push of the original
  await adminPut(`users/${uid}/devices/dev-a/events/${padSeq(1)}`, { payloadJson: '{"tampered":true}' });
  assert.equal(await remote.pushEvent(mkEvent('dev-a', 1)), 'exists_different');
});

test('pullEvents: ordered by seq across the 9 -> 10 boundary, honours afterSeq and limit, and returns exactly what was pushed', async () => {
  const { remote } = await owner();
  await remote.registerDevice('dev-a');
  const evs = Array.from({ length: 12 }, (_, i) => mkEvent('dev-a', i + 1));
  for (const e of evs) assert.equal(await remote.pushEvent(e), 'created');
  const seqs = async (after: number, limit: number) => ((await remote.pullEvents('dev-a', after, limit)) as SyncEvent[]).map((e) => e.seq);
  assert.deepEqual(await seqs(0, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(await seqs(5, 5), [6, 7, 8, 9, 10]);
  assert.deepEqual(await seqs(8, 100), [9, 10, 11, 12], 'seq 10 sorts after seq 9 (zero-padded ids)');
  assert.deepEqual(await seqs(12, 10), []);
  const pulled = (await remote.pullEvents('dev-a', 0, 100)) as SyncEvent[];
  assert.equal(canonicalJson(pulled[0]), canonicalJson(evs[0]));
  assert.equal(canonicalJson(pulled[11]), canonicalJson(evs[11]));
});

test('a corrupted payloadJson on the server is delivered as an undefined payload for the sync engine to quarantine, not thrown', async () => {
  const { remote, uid } = await owner();
  await remote.registerDevice('dev-a');
  await remote.pushEvent(mkEvent('dev-a', 1));
  await adminPut(`users/${uid}/devices/dev-a/events/${padSeq(1)}`, { payloadJson: 'not json {' });
  const [raw] = (await remote.pullEvents('dev-a', 0, 10)) as { payload: unknown }[];
  assert.equal(raw?.payload, undefined);
});

test('CONCURRENT PUSHES of the same event from two real clients: exactly one creates it, the other sees exists_identical', async () => {
  const a = await owner();
  const c2 = client('second-device');
  await signIn(c2, 'owner@example.test');
  const remote2 = new FirestoreRemote(c2.db, a.uid);
  await a.remote.registerDevice('dev-a');
  const ev = mkEvent('dev-a', 1);
  const results = await Promise.all([a.remote.pushEvent(ev), remote2.pushEvent(ev)]);
  assert.deepEqual([...results].sort(), ['created', 'exists_identical']);
  assert.equal((await adminList(`users/${a.uid}/devices/dev-a/events`)).length, 1);
});

test('CONCURRENT PUSHES with DIFFERENT content under one id: one wins, the other is told exists_different, the winner is intact', async () => {
  const a = await owner();
  const c2 = client('second-device');
  await signIn(c2, 'owner@example.test');
  const remote2 = new FirestoreRemote(c2.db, a.uid);
  await a.remote.registerDevice('dev-a');
  const x = mkEvent('dev-a', 1, { docId: SHA, title: 'X', sha256: SHA, length: 1 });
  const y = mkEvent('dev-a', 1, { docId: SHA, title: 'Y', sha256: SHA, length: 1 });
  const results = await Promise.all([a.remote.pushEvent(x), remote2.pushEvent(y)]);
  assert.deepEqual([...results].sort(), ['created', 'exists_different']);
  const stored = await adminGet(`users/${a.uid}/devices/dev-a/events/${padSeq(1)}`);
  assert.ok(stored?.payloadJson === canonicalJson(x.payload) || stored?.payloadJson === canonicalJson(y.payload));
  assert.equal((await adminList(`users/${a.uid}/devices/dev-a/events`)).length, 1);
});

test('AUTHORISATION through the adapter: another user\'s client cannot use the owner\'s path', async () => {
  const a = await owner();
  await a.remote.registerDevice('dev-a');
  await a.remote.pushEvent(mkEvent('dev-a', 1));
  const intruder = client('intruder');
  await signUp(intruder, 'intruder@example.test');
  const evil = new FirestoreRemote(intruder.db, a.uid);
  await expectDenied(evil.registerDevice('dev-evil'), 'registerDevice on another user\'s path');
  await expectDenied(evil.listDevices(), 'listDevices on another user\'s path');
  await expectDenied(evil.pushEvent(mkEvent('dev-a', 2)), 'pushEvent on another user\'s path');
  await expectDenied(evil.pullEvents('dev-a', 0, 10), 'pullEvents on another user\'s path');
});

test('an unauthenticated adapter is denied everywhere', async () => {
  const a = await owner();
  const anon = client('anon');
  const remote = new FirestoreRemote(anon.db, a.uid);
  await expectDenied(remote.listDevices(), 'anonymous listDevices');
  await expectDenied(remote.pushEvent(mkEvent('dev-a', 1)), 'anonymous pushEvent');
});
