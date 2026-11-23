import type { NetEventRecord } from '../../core/report';

export type EgressClass = NetEventRecord['urlClass'] | 'sync_backend' | 'auth_backend';

/**
 * Phase 2 refinement of the Phase 1 classifier for DISPLAY only: Firestore and Auth hosts get their own labels.
 * The Phase 1 classifier is untouched, so the Phase 1 proof still treats such traffic as unknown (REVIEW).
 */
export function egressClass(e: Pick<NetEventRecord, 'urlRedacted' | 'urlClass'>): EgressClass {
  let host = '';
  try { host = new URL(e.urlRedacted).hostname; } catch { /* relative url */ }
  if (host === 'firestore.googleapis.com') return 'sync_backend';
  if (host === 'identitytoolkit.googleapis.com' || host === 'securetoken.googleapis.com') return 'auth_backend';
  return e.urlClass;
}

export interface EgressRow { tag: string; total: number; counts: Record<string, number>; inferenceRequests: number; failed: number }
export interface EgressSummary {
  rows: EgressRow[];
  /** Cloud-inference requests made while an ON-DEVICE action was running. Must be 0; anything else is shown as an alarm. */
  onDeviceActionsWithCloudInference: number;
  /** Cloud-inference requests made outside any cloud-review action (unexpected). */
  unexpectedInference: number;
}

export function summarizeEgress(events: NetEventRecord[]): EgressSummary {
  const by = new Map<string, EgressRow>();
  let onDevice = 0;
  let unexpected = 0;
  for (const e of events) {
    const row = by.get(e.tag) ?? { tag: e.tag, total: 0, counts: {}, inferenceRequests: 0, failed: 0 };
    const cls = egressClass(e);
    row.total++;
    row.counts[cls] = (row.counts[cls] ?? 0) + 1;
    if (e.outcome === 'failed') row.failed++;
    if (e.urlClass === 'cloud_inference') {
      row.inferenceRequests++;
      if (e.tag.startsWith('nano:')) onDevice++;
      else if (!e.tag.startsWith('cloud:')) unexpected++;
    }
    by.set(e.tag, row);
  }
  return { rows: [...by.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1)), onDeviceActionsWithCloudInference: onDevice, unexpectedInference: unexpected };
}
