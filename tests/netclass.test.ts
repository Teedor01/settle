import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, findLeaks, redactUrl } from '../src/core/netclass';

const ORIGIN = 'http://localhost:5173';

test('cloud inference endpoints are recognised by host and by method suffix', () => {
  const urls = [
    'https://firebasevertexai.googleapis.com/v1beta/projects/p/models/gemini-3.5-flash-lite:generateContent',
    'https://firebasevertexai.googleapis.com/v1beta/projects/p/models/x:streamGenerateContent?alt=sse',
    'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:generateContent',
    'https://some-new-proxy.example.com/v1/models/m:generateContent', 
  ];
  for (const u of urls) assert.equal(classifyUrl(u, ORIGIN), 'cloud_inference', u);
});

test('App Check, installations, recaptcha, telemetry are NOT inference', () => {
  assert.equal(classifyUrl('https://firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeDebugToken', ORIGIN), 'app_check');
  assert.equal(classifyUrl('https://content-firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeRecaptchaEnterpriseToken', ORIGIN), 'app_check');
  assert.equal(classifyUrl('https://firebaseinstallations.googleapis.com/v1/projects/p/installations', ORIGIN), 'installations');
  assert.equal(classifyUrl('https://www.google.com/recaptcha/enterprise.js?render=k', ORIGIN), 'recaptcha');
  assert.equal(classifyUrl('https://firebaselogging-pa.googleapis.com/v1/firelog/legacy/batchlog', ORIGIN), 'telemetry');
  assert.equal(classifyUrl('https://firebase.googleapis.com/v1alpha/projects/-/apps/a/webConfig', ORIGIN), 'telemetry');
});

test('same-origin dev-server assets are local; unknown Google hosts need human review, never auto-clean', () => {
  assert.equal(classifyUrl('http://localhost:5173/src/main.ts', ORIGIN), 'local_asset');
  assert.equal(classifyUrl('/node_modules/.vite/deps/firebase_ai.js', ORIGIN), 'local_asset');
  assert.equal(classifyUrl('https://mystery.googleapis.com/v1/thing', ORIGIN), 'unclassified_google');
  assert.equal(classifyUrl('https://example.com/x', ORIGIN), 'unclassified');
  assert.equal(classifyUrl('/relative/path', undefined), 'unclassified');
});

test('leak scanner is case-insensitive, URL-decoding, and ignores tiny needles', () => {
  assert.deepEqual(findLeaks('{"contents":[{"text":"... ADEYEMI Merit ..."}]}', ['Adeyemi', 'zz']), ['Adeyemi']);
  assert.deepEqual(findLeaks('q=Can%20a+late%20application', ['late application']), ['late application']);
  assert.deepEqual(findLeaks('nothing relevant', ['Adeyemi']), []);
  assert.deepEqual(findLeaks('', ['Adeyemi']), []);
});

test('redactUrl strips query strings (they can carry API keys) and fragments', () => {
  assert.equal(redactUrl('https://x.googleapis.com/v1/a:b?key=SECRET#frag'), 'https://x.googleapis.com/v1/a:b');
});

test('the dev-server websocket on the page host is local; other websockets and odd protocols are never auto-clean', () => {
  assert.equal(classifyUrl('ws://localhost:5173/?token=abc', ORIGIN), 'local_asset');
  assert.equal(classifyUrl('wss://evil.example.com/socket', ORIGIN), 'unclassified');
  assert.equal(classifyUrl('chrome-extension://abcdef/page.js', ORIGIN), 'unclassified');
  assert.equal(classifyUrl('ftp://example.com/x', ORIGIN), 'unclassified');
  assert.equal(classifyUrl('data:text/plain,hi', ORIGIN), 'local_asset');
});

test('inference path rule fires even on same-origin proxies', () => {
  assert.equal(classifyUrl('http://localhost:5173/proxy/models/m:generateContent', ORIGIN), 'cloud_inference');
});
