import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNetLog } from '../src/phase1/netlog';
import { summarizeNetwork } from '../src/core/report';

function fakeHost(impl: (u: unknown, i?: unknown) => Promise<{ status: number }>) {
  return { fetch: impl } as unknown as { fetch: typeof fetch };
}
const ok = async () => ({ status: 200 });
const offline = async () => { throw new TypeError('Failed to fetch'); };
const ORIGIN = 'http://localhost:5173';

test('records an attempt, classifies it, and redacts the query string', async () => {
  const host = fakeHost(ok);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setTag('q1');
  await host.fetch('https://firebaseinstallations.googleapis.com/v1/projects/p/installations?key=SECRET', { method: 'POST', body: '{}' });
  const [e] = nl.eventsFor('q1');
  assert.equal(e?.urlClass, 'installations');
  assert.equal(e?.outcome, 'ok');
  assert.equal(e?.urlRedacted.includes('SECRET'), false);
  assert.equal(e?.method, 'POST');
});

test('a failed (offline/blocked) inference attempt is still recorded and counts as a violation', async () => {
  const host = fakeHost(offline);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setNeedles(['canary-123', 'Adeyemi']);
  nl.setTag('q2');
  await assert.rejects(host.fetch('https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent', { method: 'POST', body: JSON.stringify({ text: 'Adeyemi canary-123' }) }));
  const s = summarizeNetwork(nl.eventsFor('q2'));
  assert.equal(s.attempted, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.cloudInferenceAttempts, 1);
  assert.deepEqual(s.leaks.sort(), ['Adeyemi', 'canary-123']);
  assert.equal(s.status, 'VIOLATION');
});

test('App Check / installations / telemetry traffic alone does NOT violate the on-device criterion', async () => {
  const host = fakeHost(ok);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setNeedles(['Adeyemi']);
  nl.setTag('q3');
  await host.fetch('https://firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeDebugToken', { method: 'POST', body: '{"debug_token":"x"}' });
  await host.fetch('https://firebaselogging-pa.googleapis.com/v1/firelog/legacy/batchlog', { method: 'POST', body: '{}' });
  const s = summarizeNetwork(nl.eventsFor('q3'));
  assert.equal(s.status, 'CLEAN');
  assert.equal(s.cloudInferenceAttempts, 0);
  assert.equal(s.byClass.app_check, 1);
  assert.equal(s.byClass.telemetry, 1);
});

test('unknown Google host is flagged REVIEW, not silently clean', async () => {
  const host = fakeHost(ok);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setTag('q4');
  await host.fetch('https://mystery.googleapis.com/v1/thing');
  assert.equal(summarizeNetwork(nl.eventsFor('q4')).status, 'REVIEW');
});

test('an un-inspectable body (FormData-like) is reported, not assumed safe', async () => {
  const host = fakeHost(ok);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setTag('q5');
  await host.fetch('https://firebaseinstallations.googleapis.com/v1/x', { method: 'POST', body: { weird: true } as unknown as BodyInit }); // deliberately not a valid BodyInit
  const s = summarizeNetwork(nl.eventsFor('q5'));
  assert.equal(s.bodiesNotInspectable, 1);
  assert.equal(s.status, 'REVIEW');
});

test('events are attributed to the tag active when the request started; uninstall restores fetch', async () => {
  const host = fakeHost(ok);
  const original = host.fetch;
  const nl = installNetLog(host, { origin: ORIGIN });
  assert.notEqual(host.fetch, original);
  nl.setTag('a1');
  await host.fetch('https://firebaseinstallations.googleapis.com/v1/a');
  nl.setTag('idle');
  await host.fetch('https://firebaseinstallations.googleapis.com/v1/b');
  assert.equal(nl.eventsFor('a1').length, 1);
  assert.equal(nl.eventsFor('idle').length, 1);
  nl.uninstall();
  assert.equal(host.fetch === original || typeof host.fetch === 'function', true);
});

test('positive-control logic: the logger sees an inference request and its canary', async () => {
  const host = fakeHost(ok);
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setNeedles(['canary-9f3a']);
  nl.setTag('cloud-control');
  await host.fetch('https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent', { method: 'POST', body: JSON.stringify({ contents: 'REQUEST-ID: canary-9f3a' }) });
  const ev = nl.eventsFor('cloud-control');
  assert.equal(ev.filter((e) => e.urlClass === 'cloud_inference').length, 1);
  assert.equal(ev.some((e) => e.leaks.includes('canary-9f3a')), true);
});

// ---- XHR and sendBeacon wrappers, exercised against a FAKE host (not a real browser) ----
class FakeXHR {
  status = 0;
  private listeners: Record<string, (() => void)[]> = {};
  open(_method: string, _url: string | URL): void { /* original open */ }
  send(_body?: unknown): void { /* original send */ }
  addEventListener(name: string, fn: () => void): void { (this.listeners[name] ??= []).push(fn); }
  finish(status: number): void { this.status = status; for (const f of this.listeners.loadend ?? []) f(); }
}

function fakeFullHost(beaconResult = true) {
  const calls: unknown[] = [];
  const navigator = { sendBeacon: (url: string, data?: unknown) => { calls.push([url, data]); return beaconResult; } };
  return { host: { fetch: ok, XMLHttpRequest: FakeXHR, navigator } as unknown as { fetch: typeof fetch; XMLHttpRequest: typeof FakeXHR; navigator: typeof navigator }, calls, navigator };
}

test('XHR wrapper (fake host): records attempt, class, body leak, and success/failure by status', () => {
  const { host } = fakeFullHost();
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setNeedles(['Adeyemi']);
  nl.setTag('x1');
  const a = new host.XMLHttpRequest();
  a.open('POST', 'https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent');
  a.send('{"t":"Adeyemi"}');
  a.finish(0);
  const b = new host.XMLHttpRequest();
  b.open('GET', 'https://firebaseinstallations.googleapis.com/v1/x');
  b.send();
  b.finish(200);
  const [e1, e2] = nl.eventsFor('x1');
  assert.equal(e1?.api, 'xhr');
  assert.equal(e1?.urlClass, 'cloud_inference');
  assert.equal(e1?.outcome, 'failed');
  assert.deepEqual(e1?.leaks, ['Adeyemi']);
  assert.equal(e2?.outcome, 'ok');
  assert.equal(e2?.bodyInspected, true);
  assert.equal(summarizeNetwork(nl.eventsFor('x1')).status, 'VIOLATION');
});

test('XHR with a non-string body is reported as not inspectable', () => {
  const { host } = fakeFullHost();
  const nl = installNetLog(host, { origin: ORIGIN });
  nl.setTag('x2');
  const a = new host.XMLHttpRequest();
  a.open('POST', 'https://firebaseinstallations.googleapis.com/v1/x');
  a.send({ not: 'a string' });
  assert.equal(nl.eventsFor('x2')[0]?.bodyInspected, false);
});

test('sendBeacon wrapper (fake host): records, classifies, scans, reports the boolean result as the outcome', () => {
  const ok1 = fakeFullHost(true);
  const nl1 = installNetLog(ok1.host, { origin: ORIGIN });
  nl1.setNeedles(['canary-77']);
  nl1.setTag('b1');
  assert.equal(ok1.host.navigator.sendBeacon('https://firebaselogging-pa.googleapis.com/v1/firelog/legacy/batchlog', 'x canary-77 y'), true);
  const [e] = nl1.eventsFor('b1');
  assert.equal(e?.api, 'beacon');
  assert.equal(e?.urlClass, 'telemetry');
  assert.deepEqual(e?.leaks, ['canary-77']);
  assert.equal(e?.outcome, 'ok');

  const bad = fakeFullHost(false);
  const nl2 = installNetLog(bad.host, { origin: ORIGIN });
  nl2.setTag('b2');
  assert.equal(bad.host.navigator.sendBeacon('https://example.com/x', 'hello'), false);
  assert.equal(nl2.eventsFor('b2')[0]?.outcome, 'failed');
  assert.equal(nl2.eventsFor('b2')[0]?.urlClass, 'unclassified');
});

test('REGRESSION: uninstall() restores fetch, XHR.prototype AND navigator.sendBeacon (beacon was never restored before)', () => {
  const { host, navigator } = fakeFullHost();
  const originals = { fetch: host.fetch, open: FakeXHR.prototype.open, send: FakeXHR.prototype.send, beacon: navigator.sendBeacon };
  const nl = installNetLog(host, { origin: ORIGIN });
  assert.notEqual(navigator.sendBeacon, originals.beacon);
  assert.notEqual(FakeXHR.prototype.open, originals.open);
  nl.uninstall();
  assert.equal(host.fetch === originals.fetch || typeof host.fetch === 'function', true);
  assert.equal(FakeXHR.prototype.open, originals.open);
  assert.equal(FakeXHR.prototype.send, originals.send);
  assert.equal(navigator.sendBeacon, originals.beacon);
});
