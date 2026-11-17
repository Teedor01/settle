import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { clearAll, expectDenied, newClient, signUp, type Client } from './support';

const open: Client[] = [];
const client = (l?: string) => { const c = newClient(l); open.push(c); return c; };
beforeEach(clearAll);
afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });

const event = (deviceId: string, seq: number, over: Record<string, unknown> = {}) => ({
  id: `${deviceId}-${String(seq).padStart(10, '0')}`, deviceId, seq, hlc: `000000000000001-00000-${deviceId}`, kind: 'doc_registered', payloadJson: '{}', createdAt: serverTimestamp(), ...over,
});
const evPath = (c: Client, uid: string, dev: string, seq: string) => doc(c.db, 'users', uid, 'devices', dev, 'events', seq);

test('AUTH: the emulator issues real users and the rules see their uid', async () => {
  const c = client();
  const uid = await signUp(c, 'owner@example.test');
  assert.ok(uid.length > 5);
  await setDoc(doc(c.db, 'users', uid, 'devices', 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() });
  assert.equal((await getDoc(doc(c.db, 'users', uid, 'devices', 'dev-a'))).exists(), true);
});

test('UNAUTHENTICATED clients can neither read nor write anything', async () => {
  const owner = client('owner');
  const uid = await signUp(owner, 'owner@example.test');
  await setDoc(evPath(owner, uid, 'dev-a', '0000000001'), event('dev-a', 1));
  const anon = client('anon');
  await expectDenied(getDoc(evPath(anon, uid, 'dev-a', '0000000001')), 'anonymous read of an event');
  await expectDenied(getDocs(collection(anon.db, 'users', uid, 'devices')), 'anonymous list of devices');
  await expectDenied(setDoc(evPath(anon, uid, 'dev-a', '0000000002'), event('dev-a', 2)), 'anonymous create');
});

test('ANOTHER signed-in user cannot read, list or write under someone else\'s uid', async () => {
  const owner = client('owner');
  const uid = await signUp(owner, 'owner@example.test');
  await setDoc(evPath(owner, uid, 'dev-a', '0000000001'), event('dev-a', 1));
  const intruder = client('intruder');
  await signUp(intruder, 'intruder@example.test');
  await expectDenied(getDoc(evPath(intruder, uid, 'dev-a', '0000000001')), 'cross-user read');
  await expectDenied(getDocs(collection(intruder.db, 'users', uid, 'devices', 'dev-a', 'events')), 'cross-user list');
  await expectDenied(setDoc(evPath(intruder, uid, 'dev-a', '0000000002'), event('dev-a', 2)), 'cross-user create');
  await expectDenied(setDoc(doc(intruder.db, 'users', uid, 'devices', 'dev-x'), { deviceId: 'dev-x' }), 'cross-user device registration');
});

test('the OWNER can register a device, create events and read them back', async () => {
  const c = client();
  const uid = await signUp(c, 'owner@example.test');
  await setDoc(doc(c.db, 'users', uid, 'devices', 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() });
  await setDoc(evPath(c, uid, 'dev-a', '0000000001'), event('dev-a', 1));
  const snap = await getDocs(collection(c.db, 'users', uid, 'devices', 'dev-a', 'events'));
  assert.equal(snap.size, 1);
  await setDoc(doc(c.db, 'users', uid, 'devices', 'dev-a'), { deviceId: 'dev-a', lastSeen: serverTimestamp() }, { merge: true }); // device metadata may be refreshed
});

test('MALFORMED creates are rejected: wrong id, wrong deviceId, bad seq format', async () => {
  const c = client();
  const uid = await signUp(c, 'owner@example.test');
  await expectDenied(setDoc(evPath(c, uid, 'dev-a', '0000000001'), event('dev-a', 1, { id: 'dev-a-0000000002' })), 'id does not match deviceId+seq');
  await expectDenied(setDoc(evPath(c, uid, 'dev-a', '0000000001'), event('dev-a', 1, { deviceId: 'dev-other' })), 'deviceId field differs from the path');
  await expectDenied(setDoc(evPath(c, uid, 'dev-a', '1'), event('dev-a', 1, { id: 'dev-a-1' })), 'seq not 10 digits');
  await expectDenied(setDoc(evPath(c, uid, 'dev-a', 'abcdefghij'), event('dev-a', 1, { id: 'dev-a-abcdefghij' })), 'seq not numeric');
});

test('IMMUTABLE EVENTS: even the owner cannot update, overwrite or delete an event', async () => {
  const c = client();
  const uid = await signUp(c, 'owner@example.test');
  const ref = evPath(c, uid, 'dev-a', '0000000001');
  await setDoc(ref, event('dev-a', 1, { payloadJson: '{"original":true}' }));
  await expectDenied(updateDoc(ref, { payloadJson: '{"tampered":true}' }), 'update of an event');
  await expectDenied(setDoc(ref, event('dev-a', 1, { payloadJson: '{"tampered":true}' })), 'overwrite of an event');
  await expectDenied(setDoc(ref, { payloadJson: '{"tampered":true}' }, { merge: true }), 'merge-overwrite of an event');
  await expectDenied(deleteDoc(ref), 'delete of an event');
  assert.equal((await getDoc(ref)).data()?.payloadJson, '{"original":true}');
});

test('a device record cannot be deleted; unknown collections are denied by default', async () => {
  const c = client();
  const uid = await signUp(c, 'owner@example.test');
  const dev = doc(c.db, 'users', uid, 'devices', 'dev-a');
  await setDoc(dev, { deviceId: 'dev-a' });
  await expectDenied(deleteDoc(dev), 'delete of a device');
  await expectDenied(setDoc(doc(c.db, 'somewhere-else', 'x'), { a: 1 }), 'write to an unlisted collection');
  await expectDenied(setDoc(doc(c.db, 'users', uid), { a: 1 }), 'write to the user root document');
  await expectDenied(getDoc(doc(c.db, 'somewhere-else', 'x')), 'read of an unlisted collection');
});
