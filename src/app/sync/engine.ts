import { validateEvent } from '../domain/events';
import type { LocalStore, PushResult, RemoteStore } from '../domain/ports';
import type { SyncEvent } from '../domain/types';

export interface SyncReport {
  pushed: number;
  alreadyOnServer: number;
  pulled: number;
  duplicates: number;
  quarantined: number;
  gaps: { deviceId: string; expectedSeq: number; gotSeq: number }[];
  errors: string[];
}

const empty = (): SyncReport => ({ pushed: 0, alreadyOnServer: 0, pulled: 0, duplicates: 0, quarantined: 0, gaps: [], errors: [] });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));


export class SyncEngine {
  private inflight: Promise<SyncReport> | null = null;
  constructor(private store: LocalStore, private remote: RemoteStore, private opts: { pushBatch?: number; pullBatch?: number } = {}) {}

  sync(): Promise<SyncReport> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async pendingCount(): Promise<number> {
    return (await this.store.pendingEvents(Number.MAX_SAFE_INTEGER)).length;
  }

  private async runOnce(): Promise<SyncReport> {
    const r = empty();
    const pushBatch = this.opts.pushBatch ?? 50;
    const pullBatch = this.opts.pullBatch ?? 100;
    try {
      const self = await this.store.deviceId();
      await this.remote.registerDevice(self);

      // ---- push (in order, stop at the first failure)
      push: for (;;) {
        const batch = await this.store.pendingEvents(pushBatch);
        if (batch.length === 0) break;
        const done: string[] = [];
        for (const ev of batch) {
          let res: PushResult;
          try { res = await this.remote.pushEvent(ev); }
          catch (e) { r.errors.push(`push ${ev.id}: ${msg(e)}`); await this.store.markPushed(done); break push; }
          if (res === 'exists_different') {
            r.quarantined++;
            r.errors.push(`push ${ev.id}: the server already has a different event with this id; not overwritten`);
            await this.store.quarantine({ source: 'local', reason: 'server has a different event with the same id', event: ev });
            await this.store.markPushed(done);
            break push;
          }
          done.push(ev.id);
          if (res === 'created') r.pushed++; else r.alreadyOnServer++;
        }
        await this.store.markPushed(done);
      }

      // ---- pull (per-device cursors)
      for (const d of await this.remote.listDevices()) {
        if (d === self) continue;
        let cursor = await this.store.getCursor(d);
        for (;;) {
          const raw = await this.remote.pullEvents(d, cursor, pullBatch);
          if (raw.length === 0) break;
          const good: SyncEvent[] = [];
          let expected = cursor + 1;
          let stop = false;
          for (const item of raw) {
            const v = validateEvent(item);
            if (!v.ok || v.event.deviceId !== d) {
              r.quarantined++;
              const reason = v.ok ? `event claims device ${v.event.deviceId} but was stored under ${d}` : v.reason;
              r.errors.push(`pull ${d}: invalid event quarantined (${reason}); this device's stream is paused at seq ${expected}`);
              await this.store.quarantine({ source: 'remote', reason, event: item });
              stop = true;
              break;
            }
            if (v.event.seq !== expected) {
              r.gaps.push({ deviceId: d, expectedSeq: expected, gotSeq: v.event.seq });
              stop = true;
              break;
            }
            good.push(v.event as unknown as SyncEvent);
            expected++;
          }
          if (good.length) {
            const res = await this.store.ingestRemote(good);
            r.pulled += res.added;
            r.duplicates += res.duplicates;
            for (const c of res.conflicting) {
              r.quarantined++;
              r.errors.push(`pull ${d}: event ${c.id} differs from the local copy with the same id; kept the local copy`);
              await this.store.quarantine({ source: 'remote', reason: 'differs from local event with the same id', event: c });
            }
            cursor = (good[good.length - 1] as SyncEvent).seq;
            await this.store.setCursor(d, cursor); // only after the events are persisted
          }
          if (stop || raw.length < pullBatch) break;
        }
      }
    } catch (e) {
      r.errors.push(msg(e));
    }
    return r;
  }
}
