import { harVerdict, type HarCounts } from './har';
import type { NetClass } from './netclass';

export interface NetEventRecord {
  seq: number;
  tag: string;
  api: 'fetch' | 'xhr' | 'beacon';
  method: string;
  urlRedacted: string;
  urlClass: NetClass;
  bodyBytes: number | null;
  bodyInspected: boolean;
  leaks: string[];
  outcome: 'pending' | 'ok' | 'failed';
  status?: number;
  error?: string;
  durationMs?: number;
}

export interface NetworkSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  byClass: Record<string, number>;
  cloudInferenceAttempts: number;
  leaks: string[];
  unclassified: string[];
  bodiesNotInspectable: number;
  status: 'CLEAN' | 'REVIEW' | 'VIOLATION';
}

export function summarizeNetwork(events: NetEventRecord[]): NetworkSummary {
  const byClass: Record<string, number> = {};
  const leaks = new Set<string>();
  const unclassified: string[] = [];
  let succeeded = 0;
  let failed = 0;
  let notInspectable = 0;
  let inference = 0;
  for (const e of events) {
    byClass[e.urlClass] = (byClass[e.urlClass] ?? 0) + 1;
    if (e.outcome === 'ok') succeeded++;
    if (e.outcome === 'failed') failed++;
    if (e.urlClass === 'cloud_inference') inference++;
    if (e.urlClass.startsWith('unclassified')) unclassified.push(e.urlRedacted);
    if (!e.bodyInspected) notInspectable++;
    for (const l of e.leaks) leaks.add(l);
  }
  const status: NetworkSummary['status'] =
    inference > 0 || leaks.size > 0 ? 'VIOLATION' : unclassified.length > 0 || notInspectable > 0 ? 'REVIEW' : 'CLEAN';
  return {
    attempted: events.length, succeeded, failed, byClass, cloudInferenceAttempts: inference,
    leaks: [...leaks], unclassified, bodiesNotInspectable: notInspectable, status,
  };
}

export type InferenceSourceStatus = 'reported_on_device' | 'reported_in_cloud' | 'reported_other' | 'not_reported';
export interface InferenceSourceObservation {
  reported: boolean;
  raw: string | null;
  status: InferenceSourceStatus;
}

export function observeInferenceSource(raw: unknown): InferenceSourceObservation {
  if (raw === undefined || raw === null) return { reported: false, raw: null, status: 'not_reported' };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const norm = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '_') : '';
  const status: InferenceSourceStatus = norm === 'ON_DEVICE' ? 'reported_on_device' : norm === 'IN_CLOUD' ? 'reported_in_cloud' : 'reported_other';
  return { reported: true, raw: text, status };
}

export type PreferOutcome =
  | 'SOURCE_REPORTED_ON_DEVICE_AND_NO_INFERENCE_TRAFFIC'
  | 'SOURCE_REPORTED_ON_DEVICE_BUT_INFERENCE_TRAFFIC_SEEN'
  | 'SOURCE_REPORTED_IN_CLOUD'
  | 'SOURCE_REPORTED_OTHER'
  | 'SOURCE_NOT_REPORTED'
  | 'ERROR';

export function evaluatePreferTest(i: { observation: InferenceSourceObservation; succeeded: boolean; inferenceAttempts: number }): PreferOutcome {
  if (!i.succeeded) return 'ERROR';
  switch (i.observation.status) {
    case 'not_reported': return 'SOURCE_NOT_REPORTED';
    case 'reported_in_cloud': return 'SOURCE_REPORTED_IN_CLOUD';
    case 'reported_other': return 'SOURCE_REPORTED_OTHER';
    case 'reported_on_device':
      return i.inferenceAttempts > 0 ? 'SOURCE_REPORTED_ON_DEVICE_BUT_INFERENCE_TRAFFIC_SEEN' : 'SOURCE_REPORTED_ON_DEVICE_AND_NO_INFERENCE_TRAFFIC';
  }
}

export interface PreferTestRow {
  id: string;
  question: string;
  mode: 'PREFER_ON_DEVICE';
  navigatorOnLine: boolean;
  latencyMs: number;
  inferenceSucceeded: boolean;
  inferenceSource: InferenceSourceObservation;
  inferenceRequestAttempts: number;
  outcome: PreferOutcome;
  error?: string;
}

export interface HarEvidence extends Partial<HarCounts> {
  provided: boolean;
  fileName?: string;
}
export type HarStatus = 'NOT_PROVIDED' | 'CLEAN' | 'REVIEW' | 'VIOLATION';
export function harStatus(h: HarEvidence): HarStatus {
  if (!h.provided) return 'NOT_PROVIDED';
  return harVerdict({
    entriesInWindow: h.entriesInWindow ?? 0, cloudInferenceRequests: h.cloudInferenceRequests ?? 0, needleHits: h.needleHits ?? 0,
    unclassified: h.unclassified ?? 0, bodiesNotInspectable: h.bodiesNotInspectable ?? 0, outsideWindowFindings: h.outsideWindowFindings ?? 0,
  });
}

export const INSTRUMENTATION_LIMITS: readonly string[] = [
  'The page logger wraps fetch, XMLHttpRequest and navigator.sendBeacon in the main page only.',
  'It cannot see service workers, web workers, cross-origin iframes (for example reCAPTCHA), WebSocket/EventSource/WebRTC traffic, script/image/CSS loads, browser-internal traffic (including Chrome\'s model download), other processes, or extensions.',
  'It cannot read bodies it cannot decode (FormData, streams) and cannot detect content that was transformed, compressed or encrypted before sending; the leak scan is a substring search for known strings.',
  'Its patches are installed after the Firebase modules are evaluated; a reference to the original fetch captured earlier would bypass it. The positive control only proves the cloud-inference path is visible.',
  'failed means offline, DevTools-blocked or any network error: JavaScript cannot tell them apart.',
  'The DevTools HAR is more complete for page traffic but is not an OS-level capture, may omit request bodies, and does not include browser-internal requests.',
  'Therefore these instruments can show EVIDENCE of cloud traffic or of a leak; their absence is not proof of zero data leakage. Turn the OS network off for the offline run to remove the network as a possibility.',
];

export type Faithful = 'unreviewed' | 'yes' | 'partly' | 'no';
export type Useful = 'unreviewed' | 'yes' | 'no';
export interface HumanReview { faithful: Faithful; useful: Useful; notes: string }

export interface QuestionReport {
  id: string;
  kind: 'main' | 'adversarial';
  question: string;
  contextMode: 'full' | 'retrieved';
  mode: 'ONLY_ON_DEVICE';
  inferenceSucceeded: boolean;
  inferenceSource: InferenceSourceObservation;
  navigatorOnLine: boolean;
  latencyMs: number;
  json: { valid: boolean; error?: string };
  answerable?: boolean;
  claim?: string;
  quote?: string;
  rawOutput?: string;
  quoteCheck?: { found: boolean; method: string; occurrences: number; start: number; end: number; reason?: string };
  numberDateCheck?: { unsupportedFacts: string[] };
  semantic: 'NOT_ASSESSED_BY_VALIDATOR';
  network: NetworkSummary;
  mechanicalPass: boolean;
  human: HumanReview;
  error?: string;
}

export function mechanicalPass(r: Pick<QuestionReport, 'inferenceSucceeded' | 'inferenceSource' | 'json' | 'answerable' | 'quoteCheck' | 'numberDateCheck' | 'network' | 'error'>): boolean {
  if (r.error || !r.inferenceSucceeded || !r.json.valid) return false;
  if (r.inferenceSource.status === 'reported_in_cloud') return false;
  if (r.network.status === 'VIOLATION') return false;
  if (r.answerable === false) return true; 
  return r.quoteCheck?.found === true && (r.numberDateCheck?.unsupportedFacts.length ?? 1) === 0;
}

export interface PositiveControl {
  run: boolean;
  cloudInferenceObserved: number;
  leakDetectorSawCanary: boolean;
  inferenceSource?: string;
}

export function controlStatus(c: PositiveControl): 'NOT_RUN' | 'VALID' | 'INVALID' {
  if (!c.run) return 'NOT_RUN';
  return c.cloudInferenceObserved >= 1 && c.leakDetectorSawCanary ? 'VALID' : 'INVALID';
}

export interface RunSummary {
  total: number;
  onlyOnDeviceSucceeded: number;
  mechanicalPassed: number;
  inferenceSourceReport: { onDevice: number; inCloud: number; other: number; notReported: number };
  humanReviewed: number;
  faithful: { yes: number; partly: number; no: number };
  useful: { yes: number; no: number };
  networkViolations: number;
  networkNeedsReview: number;
  allRanOffline: boolean;
  positiveControl: 'NOT_RUN' | 'VALID' | 'INVALID';
  runWideNetwork: NetworkSummary['status'];
  harEvidence: HarStatus;
  preferTest: { run: boolean; total: number; outcomes: Record<string, number> };
  status:
    | 'NO_RESULTS'
    | 'NO_SUCCESSFUL_INFERENCE'
    | 'PENDING_POSITIVE_CONTROL'
    | 'CLOUD_TRAFFIC_EVIDENCE_FOUND'
    | 'NOT_AN_OFFLINE_RUN'
    | 'PENDING_HAR_EVIDENCE'
    | 'NETWORK_EVIDENCE_NEEDS_REVIEW'
    | 'PENDING_HUMAN_REVIEW'
    | 'READY_FOR_HUMAN_DECISION';
}

export function summarizeRun(rows: QuestionReport[], control: PositiveControl, har: HarEvidence = { provided: false }, prefer: PreferTestRow[] = [], runNetwork: NetworkSummary = summarizeNetwork([])): RunSummary {
  const reviewed = rows.filter((r) => r.human.faithful !== 'unreviewed' && r.human.useful !== 'unreviewed');
  const pc = controlStatus(control);
  const hs = harStatus(har);
  const networkViolations = rows.filter((r) => r.network.status === 'VIOLATION').length;
  const networkNeedsReview = rows.filter((r) => r.network.status === 'REVIEW').length;
  const succeeded = rows.filter((r) => r.inferenceSucceeded).length;
  const allRanOffline = rows.length > 0 && rows.every((r) => !r.navigatorOnLine);
  const status: RunSummary['status'] =
    rows.length === 0 ? 'NO_RESULTS'
    : succeeded === 0 ? 'NO_SUCCESSFUL_INFERENCE'
    : pc !== 'VALID' ? 'PENDING_POSITIVE_CONTROL'
    : networkViolations > 0 || runNetwork.status === 'VIOLATION' || hs === 'VIOLATION' ? 'CLOUD_TRAFFIC_EVIDENCE_FOUND'
    : !allRanOffline ? 'NOT_AN_OFFLINE_RUN'
    : hs === 'NOT_PROVIDED' ? 'PENDING_HAR_EVIDENCE'
    : hs === 'REVIEW' || networkNeedsReview > 0 || runNetwork.status === 'REVIEW' ? 'NETWORK_EVIDENCE_NEEDS_REVIEW'
    : reviewed.length < rows.length ? 'PENDING_HUMAN_REVIEW'
    : 'READY_FOR_HUMAN_DECISION';
  const count = (st: InferenceSourceStatus) => rows.filter((r) => r.inferenceSource.status === st).length;
  const outcomes: Record<string, number> = {};
  for (const p of prefer) outcomes[p.outcome] = (outcomes[p.outcome] ?? 0) + 1;
  return {
    total: rows.length,
    onlyOnDeviceSucceeded: succeeded,
    mechanicalPassed: rows.filter((r) => r.mechanicalPass).length,
    inferenceSourceReport: { onDevice: count('reported_on_device'), inCloud: count('reported_in_cloud'), other: count('reported_other'), notReported: count('not_reported') },
    humanReviewed: reviewed.length,
    faithful: {
      yes: rows.filter((r) => r.human.faithful === 'yes').length,
      partly: rows.filter((r) => r.human.faithful === 'partly').length,
      no: rows.filter((r) => r.human.faithful === 'no').length,
    },
    useful: { yes: rows.filter((r) => r.human.useful === 'yes').length, no: rows.filter((r) => r.human.useful === 'no').length },
    networkViolations,
    networkNeedsReview,
    allRanOffline,
    positiveControl: pc,
    runWideNetwork: runNetwork.status,
    harEvidence: hs,
    preferTest: { run: prefer.length > 0, total: prefer.length, outcomes },
    status,
  };
}
