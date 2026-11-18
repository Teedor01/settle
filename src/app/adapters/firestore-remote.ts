import { collection, doc, documentId, getDocs, limit, orderBy, query, runTransaction, serverTimestamp, setDoc, startAfter, type Firestore } from 'firebase/firestore';
import { canonicalJson } from '../domain/canonical';
import { padSeq } from '../domain/events';
import type { PushResult, RemoteStore } from '../domain/ports';
import type { SyncEvent } from '../domain/types';

export class FirestoreRemote implements RemoteStore {
  constructor(private db: Firestore, private uid: string) {}
  private devicesCol() { return collection(this.db, 'users', this.uid, 'devices'); }
  private eventsCol(deviceId: string) { return collection(this.db, 'users', this.uid, 'devices', deviceId, 'events'); }

  async registerDevice(deviceId: string): Promise<void> {
    await setDoc(doc(this.devicesCol(), deviceId), { deviceId, lastSeen: serverTimestamp() }, { merge: true });
  }

  async listDevices(): Promise<string[]> {
    return (await getDocs(this.devicesCol())).docs.map((d: { id: string }) => d.id);
  }

  async pushEvent(e: SyncEvent): Promise<PushResult> {
    const ref = doc(this.eventsCol(e.deviceId), padSeq(e.seq));
    const data = { id: e.id, deviceId: e.deviceId, seq: e.seq, hlc: e.hlc, kind: e.kind, payloadJson: canonicalJson(e.payload) };
    return runTransaction(this.db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const x = snap.data();
        const same = x.id === data.id && x.deviceId === data.deviceId && x.seq === data.seq && x.hlc === data.hlc && x.kind === data.kind && x.payloadJson === data.payloadJson;
        return (same ? 'exists_identical' : 'exists_different') as PushResult;
      }
      tx.set(ref, { ...data, createdAt: serverTimestamp() });
      return 'created' as PushResult;
    });
  }

  async pullEvents(deviceId: string, afterSeq: number, lim: number): Promise<unknown[]> {
    const col = this.eventsCol(deviceId);
    const q = afterSeq > 0 ? query(col, orderBy(documentId()), startAfter(padSeq(afterSeq)), limit(lim)) : query(col, orderBy(documentId()), limit(lim));
    return (await getDocs(q)).docs.map((d: { data(): Record<string, unknown> }) => {
      const x = d.data();
      let payload: unknown;
      try { payload = JSON.parse(String(x.payloadJson)); } catch { payload = undefined; } // the sync engine validates and quarantines
      return { id: x.id, deviceId: x.deviceId, seq: x.seq, hlc: x.hlc, kind: x.kind, payload };
    });
  }
}
