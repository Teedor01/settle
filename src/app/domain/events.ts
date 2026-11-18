import { CLAIM_STATUSES, EVENT_KINDS, TASK_USER_STATUSES, VERSION_ORIGINS, type ClaimVersionBody, type EventKind, type TypedEvent } from './types';

const STRING_CAPS: Record<string, number> = {
  quote: 4000, text: 4000, revisedClaim: 4000, explanation: 4000, detail: 2000, question: 2000, title: 500, note: 2000, reason: 6000, payloadSent: 12000,
};
const DEFAULT_STRING_CAP = 2000;
const MAX_PAYLOAD_CHARS = 60000;
const DOC_META_KEYS = ['docId', 'length', 'sha256', 'title'];

/** Returns a human-readable problem, or null when the payload is within limits. */
export function checkPayloadLimits(kind: EventKind, payload: unknown): string | null {
  if (kind === 'doc_registered') {
    if (!isObj(payload)) return 'doc_registered payload must be an object';
    const keys = Object.keys(payload).sort();
    if (keys.join() !== DOC_META_KEYS.join()) return `doc_registered may only contain ${DOC_META_KEYS.join(', ')} (got ${keys.join(', ')}): document text is never synchronised`;
    if (!/^[0-9a-f]{64}$/.test(String(payload.sha256))) return 'doc_registered sha256 must be a 64-character hex digest';
  }
  let total = 0;
  const walk = (v: unknown, key: string, depth: number): string | null => {
    if (depth > 8) return 'payload nested too deeply';
    if (typeof v === 'string') {
      total += v.length;
      const cap = STRING_CAPS[key] ?? DEFAULT_STRING_CAP;
      return v.length > cap ? `field "${key}" is ${v.length} characters (limit ${cap}): large text cannot be recorded in the synchronised log` : null;
    }
    if (Array.isArray(v)) { for (const x of v) { const r = walk(x, key, depth + 1); if (r) return r; } return null; }
    if (isObj(v)) { for (const [k, x] of Object.entries(v)) { const r = walk(x, k, depth + 1); if (r) return r; } }
    return null;
  };
  const problem = walk(payload, '', 0);
  if (problem) return problem;
  return total > MAX_PAYLOAD_CHARS ? `payload is ${total} characters (limit ${MAX_PAYLOAD_CHARS})` : null;
}

export const padSeq = (n: number): string => String(n).padStart(10, '0');
export const eventId = (deviceId: string, seq: number): string => `${deviceId}-${padSeq(seq)}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function validVersion(v: unknown): v is ClaimVersionBody {
  if (!isObj(v)) return false;
  const d = v.deterministic;
  return isStr(v.versionId) && v.versionId !== '' && isStrArr(v.parents) &&
    CLAIM_STATUSES.includes(v.status as never) && isStr(v.text) && isStr(v.quote) && isStr(v.reason) &&
    VERSION_ORIGINS.includes(v.origin as never) && (v.source === null || isObj(v.source)) &&
    isObj(d) && typeof d.quoteFound === 'boolean' && isStrArr(d.unsupportedFacts) && isStrArr(d.cueWarnings);
}

const payloadValidators: Record<EventKind, (p: Record<string, unknown>) => boolean> = {
  doc_registered: (p) => isStr(p.docId) && isStr(p.title) && isStr(p.sha256) && typeof p.length === 'number',
  claim_created: (p) => isStr(p.claimId) && isStr(p.docId) && isStr(p.question) && validVersion(p.version),
  claim_version_added: (p) => isStr(p.claimId) && validVersion(p.version),
  task_created: (p) => isStr(p.taskId) && isStr(p.title) && isStr(p.titleVersionId) && isStr(p.statusVersionId) &&
    Array.isArray(p.dependsOn) && p.dependsOn.every((d) => isObj(d) && isStr(d.claimId) && isStr(d.versionId)),
  task_title_set: (p) => isStr(p.taskId) && isStr(p.versionId) && isStrArr(p.parents) && isStr(p.title),
  task_status_set: (p) => isStr(p.taskId) && isStr(p.versionId) && isStrArr(p.parents) && TASK_USER_STATUSES.includes(p.status as never) && isStr(p.note),
  task_flag_ack: (p) => isStr(p.taskId) && isStr(p.claimId) && isStr(p.claimVersionId) && isStr(p.note),
  task_archived: (p) => isStr(p.taskId) && typeof p.archived === 'boolean' && isStr(p.note),
};

/** Every event from outside this process (Firestore, IndexedDB) is validated before it can reach the reducer. */
export function validateEvent(raw: unknown): { ok: true; event: TypedEvent } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'not an object' };
  const { id, deviceId, seq, hlc, kind, payload } = raw;
  if (!isStr(deviceId) || deviceId === '') return { ok: false, reason: 'bad deviceId' };
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { ok: false, reason: 'bad seq' };
  if (!isStr(id) || id !== eventId(deviceId, seq)) return { ok: false, reason: 'id does not match deviceId+seq' };
  if (!isStr(hlc) || !/^\d{15}-\d{5}-.+/.test(hlc)) return { ok: false, reason: 'bad hlc' };
  if (!isStr(kind) || !EVENT_KINDS.includes(kind as EventKind)) return { ok: false, reason: `unknown kind ${String(kind)}` };
  if (!isObj(payload) || !payloadValidators[kind as EventKind](payload)) return { ok: false, reason: `invalid payload for ${kind}` };
  const limit = checkPayloadLimits(kind as EventKind, payload);
  if (limit) return { ok: false, reason: `payload over limits for ${kind}: ${limit}` };
  return { ok: true, event: raw as unknown as TypedEvent };
}
