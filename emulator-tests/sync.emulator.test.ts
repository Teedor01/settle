import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreRemote } from '../src/app/adapters/firestore-remote';
import { eventId } from '../src/app/domain/events';
import { fingerprint, reduceEvents } from '../src/app/domain/reduce';
import { AppService } from '../src/app/service';
import { findDocumentLeaks } from '../src/app/selftest/leak-scan';
import { SyncEngine } from '../src/app/sync/engine';
import { SCHOLARSHIP_TEXT, SCHOLARSHIP_TITLE } from '../src/fixtures/scholarship';
import { MemoryStore } from '../tests/support/memory-store';
import { ScriptedCloudPort, ScriptedLocalPort, cloudReview, localAnswer } from '../tests/support/scripted-ports';
import { clock, idGen } from '../tests/support/builders';
import { adminList, adminPut, clearAll, newClient, signIn, signUp, type Client } from './support';

const QUOTE = 'Applications must be received by 17:00 WAT on 15 December 2026';
const CLAIM = 'The deadline is 17:00 WAT on 15 December 2026.';
const open: Client[] = [];
beforeEach(clearAll);
afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });

let userUid = '';
async function account() {
  const c = newClient('account');
  open.push(c);
  userUid = await signUp(c, 'owner@example.test');
  return userUid;
}
async function device(name: string, opts: { local?: string[]; cloud?: string[]; t0?: number } = {}) {
  const c = newClient(name);
  open.push(c);
  await signIn(c, 'owner@example.test');
  const store = new MemoryStore(`dev-${name}`);
  const svc = new AppService({ store, local: new ScriptedLocalPort(opts.local ?? []), cloud: new ScriptedCloudPort(opts.cloud ?? []), now: clock(opts.t0 ?? 1_000_000), newId: idGen(name) });
  const sync = new SyncEngine(store, new FirestoreRemote(c.db, userUid));
  return { name, store, svc, sync };
}
type Dev = Awaited<ReturnType<typeof device>>;
const st = async (d: Dev) => reduceEvents(await d.store.allEvents());
const fp = async (d: Dev) => fingerprint(await st(d));
const syncAll = async (...ds: Dev[]) => { for (let i = 0; i < 2; i++) for (const d of ds) { const r = await d.sync.sync(); assert.deepEqual(r.errors, [], `${d.name} sync errors`); } };

async function twoDevices(cloudA: string[] = [], cloudB: string[] = []) {
  await account();
  const a = await device('a', { local: [localAnswer(CLAIM, QUOTE)], cloud: cloudA, t0: 1_000_000 });
  const b = await device('b', { cloud: cloudB, t0: 2_000_000 });
  const doc = await a.svc.importDocument(SCHOLARSHIP_TITLE, SCHOLARSHIP_TEXT);
  const claim = (await a.svc.askQuestion(doc.docId, 'What is the application deadline?')) as { claimId: string };
  const task = (await a.svc.createTask('Submit before the deadline', [claim.claimId])).taskId;
  await syncAll(a, b);
  await b.svc.importDocument(SCHOLARSHIP_TITLE, SCHOLARSHIP_TEXT);
  await syncAll(a, b);
  return { a, b, claimId: claim.claimId, taskId: task, uid: userUid };
}

test('MULTI-DEVICE SYNC through real Firestore: claims, versions, tasks and history converge', async () => {
  const { a, b, claimId, taskId } = await twoDevices([cloudReview({ verdict: 'contradicts', explanation: 'No.' })]);
  assert.equal(await fp(a), await fp(b));
  await a.svc.runReviews(await a.svc.prepareReviews([claimId]), { userConfirmedDisclosure: true });
  await syncAll(a, b);
  for (const d of [a, b]) {
    const s = await st(d);
    assert.equal(s.claims[0]!.versions.length, 2);
    assert.equal(s.tasks.find((t) => t.taskId === taskId)!.effectiveStatus, 'REQUIRES_REVIEW');
  }
  assert.equal(await fp(a), await fp(b));
});

test('DOCUMENT TEXT NEVER REACHES FIRESTORE: every stored record is scanned for document text (quotations excepted)', async () => {
  const { a, b, claimId, uid } = await twoDevices([cloudReview({ verdict: 'supports' })]);
  await a.svc.runReviews(await a.svc.prepareReviews([claimId]), { userConfirmedDisclosure: true });
  await syncAll(a, b);
  const devices = await adminList(`users/${uid}/devices`);
  assert.ok(devices.length >= 2);
  const events: { payload: unknown }[] = [];
  let storedChars = 0;
  for (const d of devices) {
    for (const e of await adminList(`users/${uid}/devices/${d.id}/events`)) {
      storedChars += JSON.stringify(e.fields).length;
      events.push({ payload: JSON.parse(String(e.fields.payloadJson)) });
    }
  }
  assert.ok(events.length >= 5);
  assert.deepEqual(findDocumentLeaks(events, SCHOLARSHIP_TEXT), []);
  assert.ok(findDocumentLeaks(events, SCHOLARSHIP_TEXT, { allowQuotes: false }).length > 0, 'the scan is not vacuous: the legitimate quote is visible without the allowance');
  assert.ok(storedChars < SCHOLARSHIP_TEXT.length * 12, 'the stored data is a small event log, not a copy of the document');
});

test('CONCURRENT EDITS through real Firestore: offline status changes on two devices become an explicit conflict on BOTH, then resolve', async () => {
  const { a, b, taskId } = await twoDevices();
  await a.svc.setTaskStatus(taskId, 'COMPLETED', 'done on A');
  await b.svc.setTaskStatus(taskId, 'IN_PROGRESS', 'working on B');
  await syncAll(a, b);
  assert.equal(await fp(a), await fp(b));
  for (const d of [a, b]) assert.equal((await st(d)).tasks[0]!.statusConflict, true);
  await b.svc.setTaskStatus(taskId, 'IN_PROGRESS', 'resolved');
  await syncAll(a, b);
  for (const d of [a, b]) assert.equal((await st(d)).tasks[0]!.statusConflict, false);
  assert.equal(await fp(a), await fp(b));
});

test('CONCURRENT REVIEWS through real Firestore: different outcomes fork the claim; both versions survive; resolution converges', async () => {
  const { a, b, claimId } = await twoDevices([cloudReview({ verdict: 'supports' })], [cloudReview({ verdict: 'contradicts' })]);
  await a.svc.runReviews(await a.svc.prepareReviews([claimId]), { userConfirmedDisclosure: true });
  await b.svc.runReviews(await b.svc.prepareReviews([claimId]), { userConfirmedDisclosure: true });
  await syncAll(a, b);
  for (const d of [a, b]) { const c = (await st(d)).claims[0]!; assert.equal(c.conflict, true); assert.equal(c.versions.length, 3); }
  const head = (await st(a)).claims[0]!.heads.find((h) => h.status === 'SOURCE-CHECKED')!;
  await a.svc.resolveClaimConflict(claimId, head.versionId, 'A is right');
  await syncAll(a, b);
  for (const d of [a, b]) assert.equal((await st(d)).claims[0]!.conflict, false);
  assert.equal(await fp(a), await fp(b));
});

test('LATE OFFLINE EVENTS are never missed: a device with an old clock syncs after the others', async () => {
  await account();
  const a = await device('a', { t0: 5_000_000 });
  const b = await device('b', { t0: 5_100_000 });
  const c = await device('c', { t0: 1_000 });
  await a.svc.importDocument('A doc', 'alpha text');
  await syncAll(a, b);
  await c.svc.importDocument('C doc', 'gamma text written offline long ago');
  await syncAll(a, b);
  await c.sync.sync();
  await syncAll(a, b, c);
  for (const d of [a, b, c]) assert.equal((await st(d)).documents.length, 2, `${d.name} sees both documents`);
  assert.equal(await fp(a), await fp(c));
});

test('DUPLICATE SYNC ATTEMPTS against real Firestore: concurrent sync() calls push each event exactly once', async () => {
  await account();
  const a = await device('a');
  for (let i = 0; i < 6; i++) await a.svc.importDocument(`doc ${i}`, `text number ${i}`);
  const [r1, r2, r3] = await Promise.all([a.sync.sync(), a.sync.sync(), a.sync.sync()]);
  assert.ok(r1 === r2 && r2 === r3);
  assert.equal(r1.pushed, 6);
  assert.equal((await adminList(`users/${userUid}/devices/dev-a/events`)).length, 6);
});

test('TAMPERED/INVALID server events are quarantined by the real engine; healthy devices still sync', async () => {
  const uid = await account();
  const a = await device('a');
  const b = await device('b');
  await a.svc.importDocument('A doc', 'alpha');
  await a.sync.sync();
  await adminPut(`users/${uid}/devices/dev-z`, { deviceId: 'dev-z' });
  await adminPut(`users/${uid}/devices/dev-z/events/0000000001`, { id: eventId('dev-z', 1), deviceId: 'dev-z', seq: 1, hlc: 'not-an-hlc', kind: 'doc_registered', payloadJson: '{}' });
  const r = await b.sync.sync();
  assert.equal(r.quarantined, 1);
  assert.match(r.errors.join(' '), /paused/);
  assert.equal((await st(b)).documents.length, 1, "device a's event still arrived");
  assert.equal((await b.store.listQuarantine()).length, 1);
});

test('A DOCUMENT-TEXT payload injected on the server is rejected by the engine and never reaches the state', async () => {
  const uid = await account();
  const b = await device('b');
  await adminPut(`users/${uid}/devices/dev-evil`, { deviceId: 'dev-evil' });
  await adminPut(`users/${uid}/devices/dev-evil/events/0000000001`, {
    id: eventId('dev-evil', 1), deviceId: 'dev-evil', seq: 1, hlc: '000000000000001-00000-dev-evil', kind: 'doc_registered',
    payloadJson: JSON.stringify({ docId: 'a'.repeat(64), title: 'x', sha256: 'a'.repeat(64), length: 1, text: SCHOLARSHIP_TEXT }),
  });
  const r = await b.sync.sync();
  assert.equal(r.quarantined, 1);
  assert.equal((await st(b)).documents.length, 0);
});
