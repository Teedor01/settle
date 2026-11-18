import { canonicalJson } from '../domain/canonical';
import { maxHlc, nextHlc } from '../domain/clock';
import { eventId } from '../domain/events';
import type { LocalStore } from '../domain/ports';
import type { EventKind, StoredDocument, SyncEvent } from '../domain/types';

interface EventRecord { id: string; event: SyncEvent; origin: 'local' | 'remote'; pushed: boolean }

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finished = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
});


export class IdbStore implements LocalStore {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(private dbName = 'settle-phase2', private newId: () => string = () => crypto.randomUUID()) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((res, rej) => {
        const r = indexedDB.open(this.dbName, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('events', { keyPath: 'id' });
          db.createObjectStore('documents', { keyPath: 'docId' });
          db.createObjectStore('quarantine', { autoIncrement: true });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('IndexedDB open blocked by another tab'));
      });
    }
    return this.dbp;
  }

  async init(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    const meta = tx.objectStore('meta');
    if (!(await req(meta.get('deviceId')))) meta.put({ key: 'deviceId', value: this.newId() });
    await finished(tx);
  }

  async close(): Promise<void> { (await this.open()).close(); }

  private async metaGet<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    const r = (await req(db.transaction('meta').objectStore('meta').get(key))) as { value: T } | undefined;
    return r?.value;
  }

  async deviceId(): Promise<string> {
    const id = await this.metaGet<string>('deviceId');
    if (!id) throw new Error('IdbStore.init() must be called first.');
    return id;
  }

  async putDocument(d: StoredDocument): Promise<void> {
    const tx = (await this.open()).transaction('documents', 'readwrite');
    tx.objectStore('documents').put(d);
    await finished(tx);
  }
  async getDocument(docId: string): Promise<StoredDocument | undefined> {
    return (await req((await this.open()).transaction('documents').objectStore('documents').get(docId))) as StoredDocument | undefined;
  }
  async listDocuments(): Promise<StoredDocument[]> {
    return (await req((await this.open()).transaction('documents').objectStore('documents').getAll())) as StoredDocument[];
  }

  async appendLocal(kind: EventKind, payload: unknown, nowMs: number): Promise<SyncEvent> {
    const db = await this.open();
    const tx = db.transaction(['meta', 'events'], 'readwrite');
    const meta = tx.objectStore('meta');
    const deviceId = ((await req(meta.get('deviceId'))) as { value: string } | undefined)?.value;
    if (!deviceId) throw new Error('IdbStore.init() must be called first.');
    const seq = (((await req(meta.get('seq'))) as { value: number } | undefined)?.value ?? 0) + 1;
    const lastHlc = ((await req(meta.get('lastHlc'))) as { value: string } | undefined)?.value ?? null;
    const hlc = nextHlc(lastHlc, nowMs, deviceId);
    const event: SyncEvent = { id: eventId(deviceId, seq), deviceId, seq, hlc, kind, payload: JSON.parse(JSON.stringify(payload)) };
    tx.objectStore('events').put({ id: event.id, event, origin: 'local', pushed: false } satisfies EventRecord);
    meta.put({ key: 'seq', value: seq });
    meta.put({ key: 'lastHlc', value: hlc });
    await finished(tx);
    return event;
  }

  async ingestRemote(events: SyncEvent[]) {
    const db = await this.open();
    const tx = db.transaction(['meta', 'events'], 'readwrite');
    const meta = tx.objectStore('meta');
    const store = tx.objectStore('events');
    let lastHlc = ((await req(meta.get('lastHlc'))) as { value: string } | undefined)?.value ?? null;
    let added = 0;
    let duplicates = 0;
    const conflicting: SyncEvent[] = [];
    for (const e of events) {
      const have = (await req(store.get(e.id))) as EventRecord | undefined;
      if (!have) { store.put({ id: e.id, event: JSON.parse(JSON.stringify(e)), origin: 'remote', pushed: true } satisfies EventRecord); added++; }
      else if (canonicalJson(have.event) === canonicalJson(e)) duplicates++;
      else conflicting.push(e);
      lastHlc = maxHlc(lastHlc, e.hlc);
    }
    if (lastHlc) meta.put({ key: 'lastHlc', value: lastHlc });
    await finished(tx);
    return { added, duplicates, conflicting };
  }

  private async records(): Promise<EventRecord[]> {
    return (await req((await this.open()).transaction('events').objectStore('events').getAll())) as EventRecord[];
  }
  async allEvents(): Promise<SyncEvent[]> { return (await this.records()).map((r) => r.event); }
  async pendingEvents(limit: number): Promise<SyncEvent[]> {
    return (await this.records()).filter((r) => r.origin === 'local' && !r.pushed).map((r) => r.event).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  async markPushed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = (await this.open()).transaction('events', 'readwrite');
    const store = tx.objectStore('events');
    for (const id of ids) {
      const r = (await req(store.get(id))) as EventRecord | undefined;
      if (r) store.put({ ...r, pushed: true });
    }
    await finished(tx);
  }

  async getCursor(deviceId: string): Promise<number> { return (await this.metaGet<number>(`cursor:${deviceId}`)) ?? 0; }
  async setCursor(deviceId: string, seq: number): Promise<void> {
    const tx = (await this.open()).transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: `cursor:${deviceId}`, value: seq });
    await finished(tx);
  }

  async quarantine(item: { source: 'remote' | 'local'; reason: string; event?: unknown }): Promise<void> {
    const tx = (await this.open()).transaction('quarantine', 'readwrite');
    tx.objectStore('quarantine').add({ ...item, at: Date.now() });
    await finished(tx);
  }
  async listQuarantine() {
    return (await req((await this.open()).transaction('quarantine').objectStore('quarantine').getAll())) as { source: string; reason: string; event?: unknown; at: number }[];
  }
}

export async function runIdbSelfTest(runContract: (make: () => Promise<LocalStore>) => Promise<{ name: string; ok: boolean; error?: string }[]>) {
  const created: IdbStore[] = [];
  const names: string[] = [];
  const results = await runContract(async () => {
    const name = `settle-selftest-${crypto.randomUUID()}`;
    const s = new IdbStore(name);
    await s.init();
    created.push(s);
    names.push(name);
    return s;
  });
  for (const s of created) await s.close();
  for (const n of names) indexedDB.deleteDatabase(n);
  return results;
}
