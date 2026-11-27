import { SCHOLARSHIP_TEXT } from '../../fixtures/scholarship';
import type { EventKind } from '../domain/types';

export interface PayloadCase { name: string; kind: EventKind; payload: unknown; valid: boolean }

const SHA = 'a'.repeat(64);
const x = (n: number) => 'x'.repeat(n);
const QUOTE = 'Applications must be received by 17:00 WAT on 15 December 2026';
type Obj = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const observation = { raw: null, reported: false, status: 'not_reported' };
const deterministic = { cueWarnings: [] as string[], quoteFound: true, unsupportedFacts: [] as string[] };
const source = { docId: SHA, docSha256: SHA, start: 10, end: 70, method: 'exact', occurrences: 1 };
export const localVersion = (): Obj => ({
  versionId: 'v-1', parents: [], status: 'PROVISIONAL', text: 'The deadline is 15 December 2026.', quote: QUOTE, source, origin: 'local_model',
  reason: 'Answered on-device.', deterministic, generation: { inferenceSource: observation, mode: 'ONLY_ON_DEVICE' },
});
export const reviewedVersion = (): Obj => ({
  versionId: 'v-2', parents: ['v-1'], status: 'UNSUPPORTED', text: 'The deadline is 15 December 2026.', quote: QUOTE, source, origin: 'cloud_review', reason: 'Not supported.', deterministic,
  review: { cloudInferenceSource: observation, explanation: 'The passage does not say that.', issues: [{ detail: 'Omits the extension rule.', type: 'exception' }], model: 'gemini-test',
    outcome: 'UNSUPPORTED', outcomeReasons: ['Reviewer: no.'], payloadSent: `CLAIM:\nx\n\nQUOTED PASSAGE:\n${QUOTE}`, revisedClaim: '', verdict: 'contradicts' },
});
const overrideVersion = (): Obj => {
  const v: Obj = { ...localVersion(), versionId: 'v-3', parents: ['v-2'], origin: 'user_override', override: { note: 'I checked it myself.', overridesVersionId: 'v-2', previousStatus: 'UNSUPPORTED' } };
  delete v.generation; // real payloads never carry an undefined key
  return v;
};

const valid: Record<EventKind, unknown> = {
  doc_registered: { docId: SHA, length: 1623, sha256: SHA, title: 'Guidelines' },
  claim_created: { claimId: 'c-1', docId: SHA, question: 'What is the deadline?', version: localVersion() },
  claim_version_added: { claimId: 'c-1', version: reviewedVersion() },
  task_created: { dependsOn: [{ claimId: 'c-1', versionId: 'v-1' }, { claimId: 'c-2', versionId: 'v-9' }], statusVersionId: 's-1', taskId: 't-1', title: 'Submit', titleVersionId: 'tv-1' },
  task_title_set: { parents: ['tv-1'], taskId: 't-1', title: 'Renamed', versionId: 'tv-2' },
  task_status_set: { note: 'done', parents: ['s-1'], status: 'COMPLETED', taskId: 't-1', versionId: 's-2' },
  task_flag_ack: { claimId: 'c-1', claimVersionId: 'v-2', note: 'still valid', taskId: 't-1' },
  task_archived: { archived: true, note: 'obsolete', taskId: 't-1' },
};

/** payload with one field replaced/removed/added at a path */
function mut(kind: EventKind, edit: (p: Obj) => void): unknown { const p = clone(valid[kind]) as Obj; edit(p); return p; }
const ver = (p: Obj): Obj => p.version as Obj;
const review = (p: Obj): Obj => ver(p).review as Obj;

export const PAYLOAD_CASES: PayloadCase[] = [
  // ---- accepted
  ...(Object.keys(valid) as EventKind[]).map((k): PayloadCase => ({ name: `valid ${k}`, kind: k, payload: valid[k], valid: true })),
  { name: 'valid: claim version with a user override', kind: 'claim_version_added', payload: { claimId: 'c-1', version: overrideVersion() }, valid: true },
  { name: 'valid: quote exactly at its 4000-character limit', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).quote = x(4000); }), valid: true },
  { name: 'valid: 8 parents and 5 issues (the list limits)', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => {
    ver(p).parents = Array.from({ length: 8 }, (_, i) => `v-${i}`); review(p).issues = Array.from({ length: 5 }, () => ({ detail: 'd', type: 'negation' })); }), valid: true },
  { name: 'valid: issue detail at its limit in the LAST allowed position', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => {
    review(p).issues = Array.from({ length: 5 }, (_, i) => ({ detail: i === 4 ? x(2000) : 'd', type: 'scope_mismatch' })); }), valid: true },
  // ---- rejected: document text and unknown fields
  { name: 'REJECT: full document text in a doc_registered "text" field', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.text = SCHOLARSHIP_TEXT; }), valid: false },
  { name: 'REJECT: even a tiny "content" field on doc_registered', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.content = 'x'; }), valid: false },
  { name: 'REJECT: document text longer than any field limit, as a quote', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).quote = SCHOLARSHIP_TEXT.repeat(4); }), valid: false },
  { name: 'REJECT: document text longer than any field limit, as a title', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.title = SCHOLARSHIP_TEXT; }), valid: false },
  { name: 'REJECT: document text longer than any field limit, in a task note', kind: 'task_flag_ack', payload: mut('task_flag_ack', (p) => { p.note = SCHOLARSHIP_TEXT.repeat(2); }), valid: false },
  { name: 'REJECT: unexpected top-level payload field', kind: 'task_archived', payload: mut('task_archived', (p) => { p.documentText = 'x'; }), valid: false },
  { name: 'REJECT: unexpected field inside the nested version', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).fullDocument = 'x'; }), valid: false },
  { name: 'REJECT: unexpected field inside the deeply nested review', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { review(p).rawDocument = 'x'; }), valid: false },
  { name: 'REJECT: unexpected field inside a list element (issue)', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { ((review(p).issues as Obj[])[0] as Obj).extra = 'x'; }), valid: false },
  { name: 'REJECT: unexpected field inside a task dependency', kind: 'task_created', payload: mut('task_created', (p) => { ((p.dependsOn as Obj[])[1] as Obj).note = 'x'; }), valid: false },
  // ---- rejected: oversized fields and lists
  { name: 'REJECT: quote one character over its 4000 limit', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).quote = x(4001); }), valid: false },
  { name: 'REJECT: claim text over 4000', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).text = x(4001); }), valid: false },
  { name: 'REJECT: reason over 6000', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).reason = x(6001); }), valid: false },
  { name: 'REJECT: question over 2000', kind: 'claim_created', payload: mut('claim_created', (p) => { p.question = x(2001); }), valid: false },
  { name: 'REJECT: payloadSent over 12000', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { review(p).payloadSent = x(12001); }), valid: false },
  { name: 'REJECT: explanation over 4000', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { review(p).explanation = x(4001); }), valid: false },
  { name: 'REJECT: title over 500', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.title = x(501); }), valid: false },
  { name: 'REJECT: empty title', kind: 'task_created', payload: mut('task_created', (p) => { p.title = ''; }), valid: false },
  { name: 'REJECT: note over 2000', kind: 'task_status_set', payload: mut('task_status_set', (p) => { p.note = x(2001); }), valid: false },
  { name: 'REJECT: identifier over 100 characters', kind: 'task_archived', payload: mut('task_archived', (p) => { p.taskId = x(101); }), valid: false },
  { name: 'REJECT: identifier with illegal characters', kind: 'task_archived', payload: mut('task_archived', (p) => { p.taskId = 'a b/c'; }), valid: false },
  { name: 'REJECT: 9 parents (one over the list limit)', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).parents = Array.from({ length: 9 }, (_, i) => `v-${i}`); }), valid: false },
  { name: 'REJECT: 6 issues (one over the list limit)', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { review(p).issues = Array.from({ length: 6 }, () => ({ detail: 'd', type: 'negation' })); }), valid: false },
  { name: 'REJECT: oversized issue detail in the LAST position (the unrolled check must cover every index)', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => {
    review(p).issues = Array.from({ length: 5 }, (_, i) => ({ detail: i === 4 ? x(2001) : 'd', type: 'negation' })); }), valid: false },
  { name: 'REJECT: oversized parent identifier hidden at the LAST position', kind: 'task_title_set', payload: mut('task_title_set', (p) => { p.parents = ['a', 'b', 'c', 'd', 'e', 'f', 'g', x(101)]; }), valid: false },
  { name: 'REJECT: 17 task dependencies', kind: 'task_created', payload: mut('task_created', (p) => { p.dependsOn = Array.from({ length: 17 }, (_, i) => ({ claimId: `c-${i}`, versionId: 'v' })); }), valid: false },
  // ---- rejected: types, enums, formats, missing fields
  { name: 'REJECT: sha256 not a 64-character hex digest', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.sha256 = 'abc'; }), valid: false },
  { name: 'REJECT: length is a string', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.length = '1623'; }), valid: false },
  { name: 'REJECT: length negative', kind: 'doc_registered', payload: mut('doc_registered', (p) => { p.length = -1; }), valid: false },
  { name: 'REJECT: derived status REQUIRES_REVIEW can never be written', kind: 'task_status_set', payload: mut('task_status_set', (p) => { p.status = 'REQUIRES_REVIEW'; }), valid: false },
  { name: 'REJECT: unknown claim status', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).status = 'VERIFIED'; }), valid: false },
  { name: 'REJECT: unknown verdict', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { review(p).verdict = 'agree'; }), valid: false },
  { name: 'REJECT: archived is not a boolean', kind: 'task_archived', payload: mut('task_archived', (p) => { p.archived = 'yes'; }), valid: false },
  { name: 'REJECT: required field missing (review.explanation)', kind: 'claim_version_added', payload: mut('claim_version_added', (p) => { delete review(p).explanation; }), valid: false },
  { name: 'REJECT: required field missing (version.quote)', kind: 'claim_created', payload: mut('claim_created', (p) => { delete ver(p).quote; }), valid: false },
  { name: 'REJECT: source is neither null nor a source map', kind: 'claim_created', payload: mut('claim_created', (p) => { ver(p).source = 'chars 10-70'; }), valid: false },
  { name: 'REJECT: payload is a string, not a map', kind: 'task_archived', payload: 'the whole document', valid: false },
];

// ---------------------------------------------------------------- event-document level cases (the Firestore document around a payload)
export interface EventCaseContext { uid: string; otherUid: string; deviceId: string; seq: number; now: unknown; notNow: unknown; payload: unknown }
export interface EventCase { name: string; valid: boolean; build: (c: EventCaseContext) => Record<string, unknown> }
const pad = (n: number) => String(n).padStart(10, '0');
export const baseEvent = (c: EventCaseContext): Record<string, unknown> => ({
  id: `${c.deviceId}-${pad(c.seq)}`, deviceId: c.deviceId, seq: c.seq, hlc: `000000000000001-00000-${c.deviceId}`, kind: 'task_archived',
  authorUid: c.uid, createdAt: c.now, payload: c.payload,
});

export const EVENT_CASES: EventCase[] = [
  { name: 'valid event document', valid: true, build: (c) => baseEvent(c) },
  { name: 'REJECT: unexpected top-level field', valid: false, build: (c) => ({ ...baseEvent(c), documentText: 'x' }) },
  { name: 'REJECT: top-level field named like document content', valid: false, build: (c) => ({ ...baseEvent(c), text: 'x' }) },
  { name: 'REJECT: missing createdAt', valid: false, build: (c) => { const e = baseEvent(c); delete e.createdAt; return e; } },
  { name: 'REJECT: client-chosen timestamp instead of the server time', valid: false, build: (c) => ({ ...baseEvent(c), createdAt: c.notNow }) },
  { name: 'REJECT: authorUid names another user (spoofed author)', valid: false, build: (c) => ({ ...baseEvent(c), authorUid: c.otherUid }) },
  { name: 'REJECT: missing authorUid', valid: false, build: (c) => { const e = baseEvent(c); delete e.authorUid; return e; } },
  { name: 'REJECT: id does not match deviceId and seq', valid: false, build: (c) => ({ ...baseEvent(c), id: `${c.deviceId}-${pad(c.seq + 1)}` }) },
  { name: 'REJECT: deviceId field differs from the path', valid: false, build: (c) => ({ ...baseEvent(c), deviceId: 'dev-other' }) },
  { name: 'REJECT: seq is a string', valid: false, build: (c) => ({ ...baseEvent(c), seq: String(c.seq) }) },
  { name: 'REJECT: seq is zero', valid: false, build: (c) => ({ ...baseEvent(c), seq: 0 }) },
  { name: 'REJECT: malformed hlc', valid: false, build: (c) => ({ ...baseEvent(c), hlc: 'yesterday' }) },
  { name: 'REJECT: oversized hlc', valid: false, build: (c) => ({ ...baseEvent(c), hlc: `000000000000001-00000-${'d'.repeat(300)}` }) },
  { name: 'REJECT: unknown event kind', valid: false, build: (c) => ({ ...baseEvent(c), kind: 'drop_all_data' }) },
  { name: 'REJECT: kind does not match the payload shape', valid: false, build: (c) => ({ ...baseEvent(c), kind: 'doc_registered' }) },
  { name: 'REJECT: payload missing', valid: false, build: (c) => { const e = baseEvent(c); delete e.payload; return e; } },
];
