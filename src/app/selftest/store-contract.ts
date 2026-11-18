import { eventId } from '../domain/events';
import type { LocalStore } from '../domain/ports';
import type { SyncEvent } from '../domain/types';

export interface ContractResult { name: string; ok: boolean; error?: string }

const check = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

export async function runStoreContract(make: () => Promise<LocalStore>): Promise<ContractResult[]> {
  const cases: [string, (s: LocalStore) => Promise<void>][] = [
    ['deviceId is stable', async (s) => { const a = await s.deviceId(); check(a.length > 0, 'empty'); check(a === (await s.deviceId()), 'changed between calls'); }],
    ['appendLocal allocates contiguous seqs and well-formed ids', async (s) => {
      const d = await s.deviceId();
      const e1 = await s.appendLocal('doc_registered', { docId: 'a', title: 't', sha256: 'x', length: 1 }, 1000);
      const e2 = await s.appendLocal('doc_registered', { docId: 'b', title: 't', sha256: 'x', length: 1 }, 1000);
      check(e1.seq === 1 && e2.seq === 2, `seq ${e1.seq},${e2.seq}`);
      check(e1.id === eventId(d, 1) && e2.id === eventId(d, 2), 'bad id');
      check(e1.deviceId === d, 'bad deviceId');
    }],
    ['hlc strictly increases even if the wall clock goes backwards', async (s) => {
      const a = await s.appendLocal('doc_registered', { docId: 'a', title: 't', sha256: 'x', length: 1 }, 5000);
      const b = await s.appendLocal('doc_registered', { docId: 'b', title: 't', sha256: 'x', length: 1 }, 1);
      check(b.hlc > a.hlc, `${b.hlc} <= ${a.hlc}`);
    }],
    ['pendingEvents lists local unpushed events ascending; markPushed removes them', async (s) => {
      for (let i = 0; i < 3; i++) await s.appendLocal('doc_registered', { docId: `d${i}`, title: 't', sha256: 'x', length: 1 }, 10 + i);
      let p = await s.pendingEvents(100);
      check(p.length === 3 && p.map((e) => e.seq).join() === '1,2,3', 'pending order');
      check((await s.pendingEvents(2)).length === 2, 'limit not honoured');
      await s.markPushed([p[0]!.id, p[1]!.id]);
      p = await s.pendingEvents(100);
      check(p.length === 1 && p[0]!.seq === 3, 'markPushed');
      await s.markPushed([p[0]!.id]);
      check((await s.pendingEvents(100)).length === 0, 'still pending');
    }],
    ['ingestRemote: adds, ignores identical duplicates, reports conflicting ids, never overwrites', async (s) => {
      const other = 'other-device';
      const ev: SyncEvent = { id: eventId(other, 1), deviceId: other, seq: 1, hlc: `${String(9000).padStart(15, '0')}-00000-${other}`, kind: 'doc_registered', payload: { docId: 'r', title: 't', sha256: 'x', length: 1 } };
      let r = await s.ingestRemote([ev]);
      check(r.added === 1 && r.duplicates === 0 && r.conflicting.length === 0, 'first ingest');
      r = await s.ingestRemote([{ ...ev }]);
      check(r.added === 0 && r.duplicates === 1, 'duplicate not detected');
      r = await s.ingestRemote([{ ...ev, payload: { docId: 'DIFFERENT', title: 't', sha256: 'x', length: 1 } }]);
      check(r.conflicting.length === 1 && r.added === 0, 'conflict not reported');
      const all = await s.allEvents();
      const stored = all.find((e) => e.id === ev.id);
      check(stored && (stored.payload as { docId: string }).docId === 'r', 'original was overwritten');
      check((await s.pendingEvents(100)).every((e) => e.deviceId !== other), 'remote events must not be pending');
    }],
    ['after ingesting a remote event, the next local hlc sorts after it', async (s) => {
      const other = 'other-device';
      const remoteHlc = `${String(9_000_000_000_000).padStart(15, '0')}-00007-${other}`;
      await s.ingestRemote([{ id: eventId(other, 1), deviceId: other, seq: 1, hlc: remoteHlc, kind: 'doc_registered', payload: { docId: 'r', title: 't', sha256: 'x', length: 1 } }]);
      const e = await s.appendLocal('doc_registered', { docId: 'n', title: 't', sha256: 'x', length: 1 }, 1);
      check(e.hlc > remoteHlc, `${e.hlc} <= ${remoteHlc}`);
    }],
    ['cursors default to 0 and persist per device', async (s) => {
      check((await s.getCursor('x')) === 0, 'default');
      await s.setCursor('x', 5);
      await s.setCursor('y', 2);
      check((await s.getCursor('x')) === 5 && (await s.getCursor('y')) === 2, 'persisted');
    }],
    ['documents round-trip and list', async (s) => {
      await s.putDocument({ docId: 'd1', title: 'T1', text: 'hello', sha256: 'h', importedAt: 1 });
      await s.putDocument({ docId: 'd2', title: 'T2', text: 'world', sha256: 'w', importedAt: 2 });
      check((await s.getDocument('d1'))?.text === 'hello', 'get');
      check((await s.getDocument('missing')) === undefined, 'missing should be undefined');
      check((await s.listDocuments()).length === 2, 'list');
    }],
    ['quarantine is recorded', async (s) => {
      await s.quarantine({ source: 'remote', reason: 'bad', event: { a: 1 } });
      const q = await s.listQuarantine();
      check(q.length === 1 && q[0]!.reason === 'bad', 'quarantine');
    }],
    ['concurrent appendLocal calls never reuse or skip a seq', async (s) => {
      const evs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.appendLocal('doc_registered', { docId: `c${i}`, title: 't', sha256: 'x', length: 1 }, 100)));
      const seqs = evs.map((e) => e.seq).sort((a, b) => a - b);
      check(seqs.join() === Array.from({ length: 20 }, (_, i) => i + 1).join(), `seqs ${seqs.join()}`);
      check(new Set(evs.map((e) => e.hlc)).size === 20, 'duplicate hlc');
    }],
  ];
  const out: ContractResult[] = [];
  for (const [name, fn] of cases) {
    try { await fn(await make()); out.push({ name, ok: true }); }
    catch (e) { out.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
