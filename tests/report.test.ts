import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mechanicalPass, summarizeRun, controlStatus, summarizeNetwork, observeInferenceSource, evaluatePreferTest, harStatus, INSTRUMENTATION_LIMITS, type QuestionReport, type PreferTestRow } from '../src/core/report';

const cleanNet = summarizeNetwork([]);
const base = (over: Partial<QuestionReport> = {}): QuestionReport => ({
  id: 'q1', kind: 'main', question: '?', contextMode: 'full', mode: 'ONLY_ON_DEVICE', inferenceSucceeded: true, inferenceSource: observeInferenceSource('ON_DEVICE'),
  navigatorOnLine: false, latencyMs: 1200, json: { valid: true }, answerable: true, claim: 'c', quote: 'q',
  quoteCheck: { found: true, method: 'exact', occurrences: 1, start: 0, end: 5 }, numberDateCheck: { unsupportedFacts: [] },
  semantic: 'NOT_ASSESSED_BY_VALIDATOR', network: cleanNet, mechanicalPass: true,
  human: { faithful: 'unreviewed', useful: 'unreviewed', notes: '' }, ...over,
});
const goodControl = { run: true, cloudInferenceObserved: 1, leakDetectorSawCanary: true };
const cleanHar = { provided: true, fileName: 'run1.har', entries: 12, entriesInWindow: 12, cloudInferenceRequests: 0, needleHits: 0, failedOrBlocked: 3, unclassified: 0, bodiesNotInspectable: 0, outsideWindowFindings: 0 };

test('mechanical pass requires a resolved ONLY_ON_DEVICE call, valid JSON, found quote, no foreign facts, no network violation', () => {
  assert.equal(mechanicalPass(base()), true);
  assert.equal(mechanicalPass(base({ inferenceSucceeded: false })), false);
  assert.equal(mechanicalPass(base({ json: { valid: false, error: 'invalid_json' } })), false);
  assert.equal(mechanicalPass(base({ quoteCheck: { found: false, method: 'none', occurrences: 0, start: -1, end: -1 } })), false);
  assert.equal(mechanicalPass(base({ numberDateCheck: { unsupportedFacts: ['20'] } })), false);
  assert.equal(mechanicalPass(base({ error: 'boom' })), false);
  const bad = summarizeNetwork([{ seq: 1, tag: 'q1', api: 'fetch', method: 'POST', urlRedacted: 'x', urlClass: 'cloud_inference', bodyBytes: 1, bodyInspected: true, leaks: [], outcome: 'failed' }]);
  assert.equal(mechanicalPass(base({ network: bad })), false);
});

test('a declined answer is mechanically fine (usefulness is a human call)', () => {
  assert.equal(mechanicalPass(base({ answerable: false, quoteCheck: undefined, numberDateCheck: undefined })), true);
});

test('the run summary NEVER declares success on its own: no status contains PASS', () => {
  const reviewed = [base({ human: { faithful: 'yes', useful: 'yes', notes: '' } })];
  const noControl = { run: false, cloudInferenceObserved: 0, leakDetectorSawCanary: false };
  const states = [
    summarizeRun([], goodControl).status,
    summarizeRun(reviewed, noControl).status,
    summarizeRun(reviewed, goodControl).status, // no HAR yet
    summarizeRun(reviewed, goodControl, { ...cleanHar, cloudInferenceRequests: 1 }).status,
    summarizeRun([base()], goodControl, cleanHar).status, // not yet human-reviewed
    summarizeRun(reviewed, goodControl, cleanHar).status,
  ];
  assert.deepEqual(states, [
    'NO_RESULTS', 'PENDING_POSITIVE_CONTROL', 'PENDING_HAR_EVIDENCE',
    'CLOUD_TRAFFIC_EVIDENCE_FOUND', 'PENDING_HUMAN_REVIEW', 'READY_FOR_HUMAN_DECISION',
  ]);
  for (const s of states) assert.equal(/pass/i.test(s), false);
});

test('an invalid positive control blocks the verdict (a zero count would prove nothing)', () => {
  assert.equal(controlStatus({ run: true, cloudInferenceObserved: 0, leakDetectorSawCanary: true }), 'INVALID');
  assert.equal(controlStatus({ run: true, cloudInferenceObserved: 2, leakDetectorSawCanary: false }), 'INVALID');
  assert.equal(controlStatus({ run: false, cloudInferenceObserved: 0, leakDetectorSawCanary: false }), 'NOT_RUN');
  assert.equal(summarizeRun([base()], { run: true, cloudInferenceObserved: 0, leakDetectorSawCanary: true }, cleanHar).status, 'PENDING_POSITIVE_CONTROL');
});

test('mechanical pass is independent of human faithfulness (reversed claim: mechanical yes, human no)', () => {
  const r = base({ human: { faithful: 'no', useful: 'no', notes: 'reversed the negation' } });
  const s = summarizeRun([r], goodControl);
  assert.equal(s.mechanicalPassed, 1);
  assert.equal(s.faithful.no, 1);
});

test('allRanOffline is true only when every question ran with navigator.onLine=false', () => {
  assert.equal(summarizeRun([base(), base({ navigatorOnLine: true })], goodControl).allRanOffline, false);
  assert.equal(summarizeRun([base(), base()], goodControl).allRanOffline, true);
});

// ---- inferenceSource handling (ONLY_ON_DEVICE must not depend on it; nothing may be manufactured) ----
test('ONLY_ON_DEVICE row with inferenceSource ABSENT still passes mechanically (property not documented for this mode)', () => {
  const r = base({ inferenceSource: observeInferenceSource(undefined) });
  assert.equal(r.inferenceSource.reported, false);
  assert.equal(mechanicalPass(r), true);
});

test('ONLY_ON_DEVICE row where the SDK reports ON_DEVICE passes; reporting IN_CLOUD contradicts the mode and fails', () => {
  assert.equal(mechanicalPass(base({ inferenceSource: observeInferenceSource('ON_DEVICE') })), true);
  assert.equal(mechanicalPass(base({ inferenceSource: observeInferenceSource('IN_CLOUD') })), false);
});

test('an unexpected reported value is recorded verbatim and flagged "other", not reinterpreted', () => {
  const o = observeInferenceSource('hybrid-2');
  assert.deepEqual(o, { reported: true, raw: 'hybrid-2', status: 'reported_other' });
  const obj = observeInferenceSource({ weird: 1 });
  assert.equal(obj.status, 'reported_other');
  assert.equal(obj.raw, '{"weird":1}');
});

test('NEVER MANUFACTURED: absent source stays null; no placeholder string, no ON_DEVICE, anywhere in the serialized row', () => {
  for (const absent of [undefined, null]) {
    const o = observeInferenceSource(absent);
    assert.deepEqual(o, { reported: false, raw: null, status: 'not_reported' });
  }
  const json = JSON.stringify(base({ inferenceSource: observeInferenceSource(undefined) }));
  assert.equal(json.includes('"inferenceSource":{"reported":false,"raw":null,"status":"not_reported"}'), true);
  assert.equal(/undefined|n\/a|ON_DEVICE/i.test(JSON.stringify(observeInferenceSource(undefined))), false);
});

test('summary counts what was reported, and "not reported" is not an error', () => {
  const rows = [base(), base({ inferenceSource: observeInferenceSource(undefined) }), base({ inferenceSource: observeInferenceSource('IN_CLOUD'), mechanicalPass: false })];
  const s = summarizeRun(rows, goodControl, cleanHar);
  assert.deepEqual(s.inferenceSourceReport, { onDevice: 1, inCloud: 1, other: 0, notReported: 1 });
  assert.equal(s.onlyOnDeviceSucceeded, 3);
});

// ---- PREFER_ON_DEVICE source check: compares REPORTED source against OBSERVED traffic; never infers ----
test('PREFER_ON_DEVICE outcomes', () => {
  const ev = (raw: unknown, succeeded = true, attempts = 0) => evaluatePreferTest({ observation: observeInferenceSource(raw), succeeded, inferenceAttempts: attempts });
  assert.equal(ev('ON_DEVICE'), 'SOURCE_REPORTED_ON_DEVICE_AND_NO_INFERENCE_TRAFFIC');
  assert.equal(ev('ON_DEVICE', true, 1), 'SOURCE_REPORTED_ON_DEVICE_BUT_INFERENCE_TRAFFIC_SEEN');
  assert.equal(ev('IN_CLOUD', true, 1), 'SOURCE_REPORTED_IN_CLOUD');
  assert.equal(ev(undefined), 'SOURCE_NOT_REPORTED'); // absent is reported as absent, even if no traffic was seen
  assert.equal(ev(undefined, true, 0), 'SOURCE_NOT_REPORTED');
  assert.equal(ev('weird'), 'SOURCE_REPORTED_OTHER');
  assert.equal(ev('ON_DEVICE', false), 'ERROR');
});

test('prefer-test summary is counted separately and does not affect the ONLY_ON_DEVICE verdict', () => {
  const p: PreferTestRow = { id: 'q1', question: '?', mode: 'PREFER_ON_DEVICE', navigatorOnLine: true, latencyMs: 900, inferenceSucceeded: true,
    inferenceSource: observeInferenceSource('ON_DEVICE'), inferenceRequestAttempts: 0, outcome: 'SOURCE_REPORTED_ON_DEVICE_AND_NO_INFERENCE_TRAFFIC' };
  const s = summarizeRun([base({ human: { faithful: 'yes', useful: 'yes', notes: '' } })], goodControl, cleanHar, [p]);
  assert.deepEqual(s.preferTest, { run: true, total: 1, outcomes: { SOURCE_REPORTED_ON_DEVICE_AND_NO_INFERENCE_TRAFFIC: 1 } });
  assert.equal(s.status, 'READY_FOR_HUMAN_DECISION');
  assert.equal(summarizeRun([], goodControl).preferTest.run, false);
});

test('HAR evidence statuses: missing, clean, empty (captured nothing), unclassified, violation', () => {
  assert.equal(harStatus({ provided: false }), 'NOT_PROVIDED');
  assert.equal(harStatus(cleanHar), 'CLEAN');
  assert.equal(harStatus({ ...cleanHar, entriesInWindow: 0 }), 'REVIEW');
  assert.equal(harStatus({ ...cleanHar, bodiesNotInspectable: 1 }), 'REVIEW');
  assert.equal(harStatus({ ...cleanHar, outsideWindowFindings: 1 }), 'REVIEW');
  assert.equal(harStatus({ ...cleanHar, unclassified: 2 }), 'REVIEW');
  assert.equal(harStatus({ ...cleanHar, cloudInferenceRequests: 1 }), 'VIOLATION');
  assert.equal(harStatus({ ...cleanHar, needleHits: 1 }), 'VIOLATION');
});

test('status machine: new gates (no successful inference, not an offline run, network evidence needs review)', () => {
  const reviewed = { faithful: 'yes' as const, useful: 'yes' as const, notes: '' };
  const failedRow = base({ inferenceSucceeded: false, error: 'boom', human: reviewed });
  assert.equal(summarizeRun([failedRow], goodControl, cleanHar).status, 'NO_SUCCESSFUL_INFERENCE');
  const onlineRow = base({ navigatorOnLine: true, human: reviewed });
  assert.equal(summarizeRun([onlineRow], goodControl, cleanHar).status, 'NOT_AN_OFFLINE_RUN');
  assert.equal(summarizeRun([base({ human: reviewed })], goodControl, { ...cleanHar, unclassified: 2 }).status, 'NETWORK_EVIDENCE_NEEDS_REVIEW');
  const reviewNet = summarizeNetwork([{ seq: 1, tag: 'q1', api: 'fetch', method: 'GET', urlRedacted: 'https://x.googleapis.com/a', urlClass: 'unclassified_google', bodyBytes: 0, bodyInspected: true, leaks: [], outcome: 'failed' }]);
  assert.equal(summarizeRun([base({ human: reviewed, network: reviewNet })], goodControl, cleanHar).status, 'NETWORK_EVIDENCE_NEEDS_REVIEW');
  assert.equal(summarizeRun([base({ human: reviewed })], goodControl, cleanHar).status, 'READY_FOR_HUMAN_DECISION');
});

test('instrumentation limits are published with every report and never claim zero leakage', () => {
  assert.ok(INSTRUMENTATION_LIMITS.length >= 6);
  const text = INSTRUMENTATION_LIMITS.join(' ');
  assert.match(text, /not proof of zero data leakage/);
  assert.match(text, /service workers/);
});

test('GAP CLOSED: an inference attempt BETWEEN questions (tag "idle") still blocks the verdict even though every per-question summary is clean', () => {
  const reviewed = { faithful: 'yes' as const, useful: 'yes' as const, notes: '' };
  const rows = [base({ human: reviewed }), base({ id: 'q2', human: reviewed })];
  assert.equal(rows.every((r) => r.network.status === 'CLEAN'), true);
  const stray = summarizeNetwork([{ seq: 9, tag: 'idle', api: 'fetch', method: 'POST', urlRedacted: 'https://firebasevertexai.googleapis.com/v1beta/m:generateContent', urlClass: 'cloud_inference', bodyBytes: 10, bodyInspected: true, leaks: ['Adeyemi'], outcome: 'failed' }]);
  const s = summarizeRun(rows, goodControl, cleanHar, [], stray);
  assert.equal(s.status, 'CLOUD_TRAFFIC_EVIDENCE_FOUND');
  assert.equal(s.runWideNetwork, 'VIOLATION');
  const unknown = summarizeNetwork([{ seq: 9, tag: 'idle', api: 'fetch', method: 'GET', urlRedacted: 'https://x.googleapis.com/v1/y', urlClass: 'unclassified_google', bodyBytes: 0, bodyInspected: true, leaks: [], outcome: 'ok' }]);
  assert.equal(summarizeRun(rows, goodControl, cleanHar, [], unknown).status, 'NETWORK_EVIDENCE_NEEDS_REVIEW');
  assert.equal(summarizeRun(rows, goodControl, cleanHar).status, 'READY_FOR_HUMAN_DECISION');
});
