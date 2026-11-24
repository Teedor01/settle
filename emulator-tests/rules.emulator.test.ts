import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { collection, deleteDoc, doc, getDoc, getDocs, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { canonicalJson } from '../src/app/domain/canonical';
import type { EventKind } from '../src/app/domain/types';
import { EVENT_CASES, PAYLOAD_CASES, baseEvent, type PayloadCase } from '../src/app/selftest/schema-cases';
import { clearAll, expectDenied, newClient, signUp, type Client } from './support';

const open: Client[] = [];
const client = (l?: string) => { const c = newClient(l); open.push(c); return c; };
beforeEach(clearAll);
afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });

const pad = (n: number) => String(n).padStart(10, '0');
const evRef = (c: Client, uid: string, dev: string, seq: number) => doc(c.db, 'users', uid, 'devices', dev, 'events', pad(seq));
const devRef = (c: Client, uid: string, dev: string) => doc(c.db, 'users', uid, 'devices', dev);
const VALID_TASK_PAYLOAD = PAYLOAD_CASES.find((c) => c.name === 'valid task_archived')!.payload;

/** A full event document as a real client would write it (server timestamp, author = the signed-in user). */
const eventData = (uid: string, dev: string, seq: number, kind: EventKind, payload: unknown, over: Record<string, unknown> = {}) =>
  ({ ...baseEvent({ uid, otherUid: 'someone-else', deviceId: dev, seq, now: serverTimestamp(), notNow: new Date(), payload }), kind, ...over });

async function owner(email = 'owner@example.test') {
  const c = client('owner');
  const uid = await signUp(c, email);
  await setDoc(devRef(c, uid, 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() });
  return { c, uid };
}
const countEvents = async (c: Client, uid: string, dev = 'dev-a') => (await getDocs(collection(c.db, 'users', uid, 'devices', dev, 'events'))).size;

async function expectCases(cases: PayloadCase[], label: string, start = 1) {
  const { c, uid } = await owner();
  let seq = start;
  let accepted = 0;
  for (const k of cases) {
    const ref = evRef(c, uid, 'dev-a', seq);
    if (k.valid) { await setDoc(ref, eventData(uid, 'dev-a', seq, k.kind, k.payload)); accepted++; assert.equal((await getDoc(ref)).exists(), true, `${label}: ${k.name} was not stored`); }
    else { await expectDenied(setDoc(ref, eventData(uid, 'dev-a', seq, k.kind, k.payload)), `${label}: ${k.name}`); assert.equal((await getDoc(ref)).exists(), false, `${label}: ${k.name} left a document behind`); }
    seq++;
  }
  assert.equal(await countEvents(c, uid), accepted, `${label}: only the accepted events may exist`);
}

test('AUTH: the emulator issues real users and the rules see their uid', async () => {
  const { c, uid } = await owner();
  assert.ok(uid.length > 5);
  assert.equal((await getDoc(devRef(c, uid, 'dev-a'))).exists(), true);
});

test('UNAUTHENTICATED clients can neither read nor write anything', async () => {
  const { c, uid } = await owner();
  await setDoc(evRef(c, uid, 'dev-a', 1), eventData(uid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD));
  const anon = client('anon');
  await expectDenied(getDoc(evRef(anon, uid, 'dev-a', 1)), 'anonymous read of an event');
  await expectDenied(getDocs(collection(anon.db, 'users', uid, 'devices')), 'anonymous list of devices');
  await expectDenied(setDoc(evRef(anon, uid, 'dev-a', 2), eventData(uid, 'dev-a', 2, 'task_archived', VALID_TASK_PAYLOAD)), 'anonymous create of an event');
});

test('UNAUTHORISED USERS cannot write events: another user, a spoofed author, and an owner naming someone else as author', async () => {
  const { c, uid } = await owner();
  const intruder = client('intruder');
  const intruderUid = await signUp(intruder, 'intruder@example.test');
  await expectDenied(setDoc(evRef(intruder, uid, 'dev-a', 1), eventData(uid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD)), 'another user writing under the owner path, authorUid = owner');
  await expectDenied(setDoc(evRef(intruder, uid, 'dev-a', 1), eventData(intruderUid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD)), 'another user writing under the owner path, authorUid = self');
  await expectDenied(setDoc(evRef(c, uid, 'dev-a', 1), eventData(intruderUid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD)), 'the owner naming another user as the author');
  await expectDenied(setDoc(devRef(intruder, uid, 'dev-x'), { deviceId: 'dev-x', lastSeen: serverTimestamp() }), "registering a device on someone else's path");
  await expectDenied(getDocs(collection(intruder.db, 'users', uid, 'devices', 'dev-a', 'events')), 'cross-user list of events');
  assert.equal(await countEvents(c, uid), 0);
  // a user writing under their OWN path is fine
  await setDoc(devRef(intruder, intruderUid, 'dev-i'), { deviceId: 'dev-i', lastSeen: serverTimestamp() });
  await setDoc(evRef(intruder, intruderUid, 'dev-i', 1), eventData(intruderUid, 'dev-i', 1, 'task_archived', VALID_TASK_PAYLOAD));
});

test('a VALID EVENT of every kind is accepted and stored exactly as written', async () => {
  const { c, uid } = await owner();
  let seq = 1;
  for (const k of PAYLOAD_CASES.filter((x) => x.valid)) {
    const ref = evRef(c, uid, 'dev-a', seq);
    await setDoc(ref, eventData(uid, 'dev-a', seq, k.kind, k.payload));
    const stored = (await getDoc(ref)).data();
    assert.equal(canonicalJson(stored?.payload), canonicalJson(k.payload), `${k.name}: payload stored differently from what was written`);
    assert.equal(stored?.authorUid, uid);
    seq++;
  }
  assert.equal(await countEvents(c, uid), PAYLOAD_CASES.filter((x) => x.valid).length);
});

test('AN EVENT CONTAINING FULL DOCUMENT TEXT is rejected, in every form the table covers', async () => {
  const cases = PAYLOAD_CASES.filter((k) => /document text|"content" field/.test(k.name));
  assert.ok(cases.length >= 5);
  await expectCases(cases, 'document text');
  const { c, uid } = await owner('other-owner@example.test');
  const text = PAYLOAD_CASES.find((k) => /"text" field/.test(k.name))!;
  await expectDenied(setDoc(evRef(c, uid, 'dev-a', 1), { ...eventData(uid, 'dev-a', 1, 'doc_registered', text.payload), documentText: 'the whole document' }), 'document text as an extra TOP-LEVEL field');
});

test('AN EVENT WITH AN UNEXPECTED FIELD is rejected at the top level, in the payload, and in nested maps and list elements', async () => {
  const cases = PAYLOAD_CASES.filter((k) => /unexpected (top-level payload )?field/.test(k.name));
  assert.ok(cases.length >= 5);
  await expectCases(cases, 'unexpected fields');
  const { c, uid } = await owner('other-owner@example.test');
  let seq = 1;
  for (const k of EVENT_CASES.filter((e) => /unexpected top-level|named like document content/.test(e.name))) {
    await expectDenied(setDoc(evRef(c, uid, 'dev-a', seq), k.build({ uid, otherUid: 'x', deviceId: 'dev-a', seq, now: serverTimestamp(), notNow: new Date(), payload: VALID_TASK_PAYLOAD })), k.name);
    seq++;
  }
});

test('OVERSIZED fields, identifiers, lists (including the LAST list element) and payloads are rejected; values exactly at the limit are accepted', async () => {
  const rejected = PAYLOAD_CASES.filter((k) => !k.valid && /over|LAST position|9 parents|6 issues|17 task|empty title/.test(k.name));
  const accepted = PAYLOAD_CASES.filter((k) => k.valid && /limit/.test(k.name));
  assert.ok(rejected.length >= 14 && accepted.length >= 3);
  await expectCases([...accepted, ...rejected], 'oversized');
});

test('EVERY payload case in the shared table gets the same verdict from the real rules, and rejected writes create nothing', async () => {
  await expectCases(PAYLOAD_CASES, 'full table');
});

test('EVENT DOCUMENT CASES: exact field set, authenticated author, server timestamp, id/path match, seq type, hlc, kind', async () => {
  const { c, uid } = await owner();
  let seq = 1;
  let accepted = 0;
  for (const k of EVENT_CASES) {
    const ref = evRef(c, uid, 'dev-a', seq);
    const data = k.build({ uid, otherUid: 'another-user', deviceId: 'dev-a', seq, now: serverTimestamp(), notNow: new Date(), payload: VALID_TASK_PAYLOAD });
    if (k.valid) { await setDoc(ref, data); accepted++; } else await expectDenied(setDoc(ref, data), k.name);
    seq++;
  }
  assert.equal(await countEvents(c, uid), accepted);
});

test('IMMUTABLE EVENTS: even the owner cannot update, overwrite, merge into or delete an event', async () => {
  const { c, uid } = await owner();
  const ref = evRef(c, uid, 'dev-a', 1);
  await setDoc(ref, eventData(uid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD));
  const before = canonicalJson((await getDoc(ref)).data()?.payload);
  const forged = { ...(VALID_TASK_PAYLOAD as Record<string, unknown>), note: 'tampered' };
  await expectDenied(updateDoc(ref, { payload: forged }), 'update of the payload');
  await expectDenied(updateDoc(ref, { 'payload.note': 'tampered' }), 'update of one payload field');
  await expectDenied(setDoc(ref, eventData(uid, 'dev-a', 1, 'task_archived', forged)), 'overwrite of an event');
  await expectDenied(setDoc(ref, { payload: forged }, { merge: true }), 'merge into an event');
  await expectDenied(deleteDoc(ref), 'delete of an event');
  assert.equal(canonicalJson((await getDoc(ref)).data()?.payload), before, 'the stored event is unchanged');
});

test('BATCH WRITES obey the same rules: a valid batch commits; one invalid event rejects the WHOLE batch; batch updates and deletes of events are denied', async () => {
  const { c, uid } = await owner();
  const good = PAYLOAD_CASES.filter((k) => k.valid).slice(0, 3);
  const ok = writeBatch(c.db);
  good.forEach((k, i) => ok.set(evRef(c, uid, 'dev-a', i + 1), eventData(uid, 'dev-a', i + 1, k.kind, k.payload)));
  await ok.commit();
  assert.equal(await countEvents(c, uid), 3);

  const textCase = PAYLOAD_CASES.find((k) => /"text" field/.test(k.name))!;
  const mixed = writeBatch(c.db);
  mixed.set(evRef(c, uid, 'dev-a', 4), eventData(uid, 'dev-a', 4, 'task_archived', VALID_TASK_PAYLOAD));
  mixed.set(evRef(c, uid, 'dev-a', 5), eventData(uid, 'dev-a', 5, 'doc_registered', textCase.payload));
  mixed.set(evRef(c, uid, 'dev-a', 6), eventData(uid, 'dev-a', 6, 'task_archived', VALID_TASK_PAYLOAD));
  await expectDenied(mixed.commit(), 'a batch containing one event with document text');
  assert.equal(await countEvents(c, uid), 3, 'the valid events in the rejected batch were NOT created (atomic)');

  const upd = writeBatch(c.db);
  upd.update(evRef(c, uid, 'dev-a', 1), { hlc: '000000000000009-00000-dev-a' });
  await expectDenied(upd.commit(), 'a batch UPDATE of an existing event');
  const del = writeBatch(c.db);
  del.delete(evRef(c, uid, 'dev-a', 2));
  await expectDenied(del.commit(), 'a batch DELETE of an existing event');
  assert.equal(await countEvents(c, uid), 3);

  const intruder = client('intruder');
  await signUp(intruder, 'intruder@example.test');
  const stolen = writeBatch(intruder.db);
  stolen.set(evRef(intruder, uid, 'dev-a', 7), eventData(uid, 'dev-a', 7, 'task_archived', VALID_TASK_PAYLOAD));
  await expectDenied(stolen.commit(), "an unauthorised user's batch into the owner's path");
});

test('TRANSACTION writes obey the same rules (the adapter writes events inside a transaction)', async () => {
  const { c, uid } = await owner();
  const textCase = PAYLOAD_CASES.find((k) => /"text" field/.test(k.name))!;
  await expectDenied(runTransaction(c.db, async (tx) => { tx.set(evRef(c, uid, 'dev-a', 1), eventData(uid, 'dev-a', 1, 'doc_registered', textCase.payload)); }), 'a transaction writing document text');
  await runTransaction(c.db, async (tx) => { tx.set(evRef(c, uid, 'dev-a', 1), eventData(uid, 'dev-a', 1, 'task_archived', VALID_TASK_PAYLOAD)); });
  assert.equal(await countEvents(c, uid), 1);
});

test('device records: exact fields and server time only; no deletes; unlisted collections denied by default', async () => {
  const { c, uid } = await owner();
  await expectDenied(setDoc(devRef(c, uid, 'dev-b'), { deviceId: 'dev-b', lastSeen: serverTimestamp(), note: 'x' }), 'extra field on a device record');
  await expectDenied(setDoc(devRef(c, uid, 'dev-b'), { deviceId: 'dev-b' }), 'device record without lastSeen');
  await expectDenied(setDoc(devRef(c, uid, 'dev-b'), { deviceId: 'dev-b', lastSeen: new Date() }), 'client-chosen lastSeen');
  await expectDenied(setDoc(devRef(c, uid, 'dev-b'), { deviceId: 'dev-other', lastSeen: serverTimestamp() }), 'deviceId differs from the path');
  await setDoc(devRef(c, uid, 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() }, { merge: true });
  await expectDenied(deleteDoc(devRef(c, uid, 'dev-a')), 'delete of a device record');
  await expectDenied(setDoc(doc(c.db, 'somewhere-else', 'x'), { a: 1 }), 'write to an unlisted collection');
  await expectDenied(setDoc(doc(c.db, 'users', uid), { a: 1 }), 'write to the user root document');
  await expectDenied(getDoc(doc(c.db, 'somewhere-else', 'x')), 'read of an unlisted collection');
});
