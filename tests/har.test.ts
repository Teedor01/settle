import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHar, exitCodeFor, harVerdict } from '../src/core/har';

const entry = (url: string, status = 200, extra: { post?: string; params?: { name: string; value: string }[]; error?: string; method?: string; at?: string; bodySize?: number } = {}) => ({
  ...(extra.at ? { startedDateTime: extra.at } : {}),
  request: {
    url, method: extra.method ?? (extra.post || extra.params ? 'POST' : 'GET'),
    ...(extra.bodySize !== undefined ? { bodySize: extra.bodySize } : {}),
    ...(extra.post ? { postData: { text: extra.post } } : {}), ...(extra.params ? { postData: { params: extra.params } } : {}),
  },
  response: { status }, ...(extra.error ? { _error: extra.error } : {}),
});
const har = (...es: unknown[]) => ({ log: { entries: es } });
const ORIGIN = 'http://localhost:5173';
const INFER = 'https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent';

test('offline run: only local assets and failed App Check calls -> CLEAN, failures reported', () => {
  const a = analyzeHar(har(
    entry('http://localhost:5173/index.html'),
    entry('https://firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeDebugToken', 0, { error: 'net::ERR_INTERNET_DISCONNECTED', method: 'POST', bodySize: 0 }),
  ), { origin: ORIGIN, needles: ['Adeyemi'] });
  assert.equal(a.verdict, 'CLEAN');
  assert.equal(a.cloudInferenceRequests, 0);
  assert.equal(a.failedOrBlocked, 1);
  assert.equal(a.byClass.app_check, 1);
});

test('UNKNOWN TRAFFIC IS NEVER CLEAN: unclassified hosts force REVIEW', () => {
  const a = analyzeHar(har(entry('http://localhost:5173/index.html'), entry('https://mystery.example.net/collect'), entry('https://x.googleapis.com/v1/y')), { origin: ORIGIN });
  assert.equal(a.verdict, 'REVIEW');
  assert.equal(a.unclassified, 2);
  assert.equal(exitCodeFor(a.verdict), 3);
});

test('an empty or foreign HAR is REVIEW, not CLEAN (nothing was captured)', () => {
  assert.equal(analyzeHar({}).verdict, 'REVIEW');
  assert.equal(analyzeHar(null).verdict, 'REVIEW');
  assert.equal(analyzeHar(har(), { origin: ORIGIN }).verdict, 'REVIEW');
});

test('a BLOCKED inference attempt is still a violation (the attempt itself is the problem)', () => {
  const a = analyzeHar(har(entry(INFER, 0, { error: 'net::ERR_BLOCKED_BY_CLIENT', method: 'POST', bodySize: 0 })), { origin: ORIGIN });
  assert.equal(a.verdict, 'VIOLATION');
  assert.equal(a.cloudInferenceRequests, 1);
  assert.equal(exitCodeFor(a.verdict), 1);
});

test('document text in a request body is a violation, including form-encoded params', () => {
  const t = analyzeHar(har(entry('https://example.com/collect', 200, { post: '{"t":"Adeyemi Merit Scholarship"}' })), { origin: ORIGIN, needles: ['Adeyemi'] });
  assert.equal(t.verdict, 'VIOLATION');
  assert.equal(t.leaks.length, 1);
  const p = analyzeHar(har(entry('https://example.com/c', 200, { params: [{ name: 'q', value: 'Can a late application ever be considered?' }] })), { origin: ORIGIN, needles: ['late application'] });
  assert.equal(p.verdict, 'VIOLATION');
});

test('a request body missing from the HAR cannot be scanned: reported and forces REVIEW', () => {
  const a = analyzeHar(har(entry('https://firebaseinstallations.googleapis.com/v1/x', 200, { method: 'POST', bodySize: 120 })), { origin: ORIGIN, needles: ['Adeyemi'] });
  assert.equal(a.bodiesNotInspectable, 1);
  assert.equal(a.verdict, 'REVIEW');
  // a POST with a known empty body is fine
  assert.equal(analyzeHar(har(entry('https://firebaseinstallations.googleapis.com/v1/x', 200, { method: 'POST', bodySize: 0 })), { origin: ORIGIN }).bodiesNotInspectable, 0);
});

test('run window: earlier online steps are excluded from the violation count but force REVIEW, never CLEAN', () => {
  const run = { startMs: Date.parse('2026-11-14T10:00:00Z'), endMs: Date.parse('2026-11-14T10:05:00Z') };
  const a = analyzeHar(har(
    entry(INFER, 200, { method: 'POST', post: '{"canary":"cn-1"}', at: '2026-11-14T09:30:00Z' }), // the positive control, before the run
    entry('http://localhost:5173/index.html', 200, { at: '2026-11-14T10:01:00Z' }),
  ), { origin: ORIGIN, needles: ['cn-1x'], window: run });
  assert.equal(a.cloudInferenceRequests, 0);
  assert.equal(a.outsideWindowFindings, 1);
  assert.equal(a.verdict, 'REVIEW');
  assert.match(a.reasons.join(' '), /OUTSIDE the run window/);
});

test('run window: an inference request INSIDE the window is a violation', () => {
  const run = { startMs: Date.parse('2026-11-14T10:00:00Z'), endMs: Date.parse('2026-11-14T10:05:00Z') };
  const a = analyzeHar(har(entry(INFER, 0, { method: 'POST', bodySize: 0, at: '2026-11-14T10:02:00Z' })), { origin: ORIGIN, window: run });
  assert.equal(a.verdict, 'VIOLATION');
});

test('entries without a timestamp are treated as inside the window (conservative)', () => {
  const a = analyzeHar(har(entry(INFER, 0, { method: 'POST', bodySize: 0 })), { origin: ORIGIN, window: { startMs: 0, endMs: 1 } });
  assert.equal(a.verdict, 'VIOLATION');
});

test('query strings (possible keys) are not echoed in the analysis', () => {
  const a = analyzeHar(har(entry('https://firebaseinstallations.googleapis.com/v1/x?key=SECRET', 200, { at: '2026-11-14T10:01:00Z' })), { origin: ORIGIN });
  assert.equal(JSON.stringify(a).includes('SECRET'), false);
});

test('harVerdict is the single source of truth', () => {
  const base = { entriesInWindow: 5, cloudInferenceRequests: 0, needleHits: 0, unclassified: 0, bodiesNotInspectable: 0, outsideWindowFindings: 0 };
  assert.equal(harVerdict(base), 'CLEAN');
  assert.equal(harVerdict({ ...base, entriesInWindow: 0 }), 'REVIEW');
  assert.equal(harVerdict({ ...base, unclassified: 1 }), 'REVIEW');
  assert.equal(harVerdict({ ...base, needleHits: 1, unclassified: 1 }), 'VIOLATION');
});
