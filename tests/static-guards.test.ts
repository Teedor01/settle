import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const poc = readFileSync(new URL('../src/phase1/poc.ts', import.meta.url), 'utf8');
const flag = readFileSync(new URL('../src/phase1/debug-flag.ts', import.meta.url), 'utf8');
const prompt = readFileSync(new URL('../src/phase1/prompt.ts', import.meta.url), 'utf8');

test('App Check debug flag module is the FIRST import of poc.ts (set before any Firebase module is evaluated)', () => {
  const firstImport = poc.split('\n').find((l) => l.startsWith('import '));
  assert.equal(firstImport, "import './debug-flag';");
  assert.match(flag, /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*true/);
  assert.match(flag, /localhost/);
});

test('App Check: the provider is only a documented class; it is never the way tokens are minted in the default path, and a self-check exists', () => {
  assert.match(poc, /ReCaptchaEnterpriseProvider\(env\.VITE_RECAPTCHA_SITE_KEY\)/);
  assert.match(poc, /getAppCheckToken\(appCheck, false\)/);
  const custom = poc.match(/new CustomProvider\(\{ getToken: \(\) => ([^}]*)\}\)/);
  assert.ok(custom, 'CustomProvider fallback present');
  assert.match(custom![1]!, /^Promise\.reject\(/);
  assert.equal(/resolve\(\{\s*token/.test(poc), false);
});

test('no debug token or key material is hard-coded or logged', () => {
  assert.equal(/AppCheck debug token/i.test(poc.replace(/console and find[^`]*/g, '')), false);
  assert.equal(/console\.(log|info|debug)\(.*token/i.test(poc), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(poc + flag), false);
});

test('poc.ts never writes an inferenceSource value itself: no ON_DEVICE/IN_CLOUD literals, no placeholder assignment', () => {
  assert.equal(/['"`]ON_DEVICE['"`]|['"`]IN_CLOUD['"`]/.test(poc), false);
  assert.equal(/inferenceSource\s*:\s*['"`]/.test(poc), false);
  assert.equal(/inferenceSource\s*=\s*(?!observeInferenceSource)\S/.test(poc), false);
  assert.match(poc, /r\.inferenceSource = observeInferenceSource\(/);
});

test('the offline proof uses ONLY_ON_DEVICE and the source check uses PREFER_ON_DEVICE', () => {
  assert.match(poc, /mode:\s*InferenceMode\.ONLY_ON_DEVICE/);
  assert.match(poc, /mode:\s*InferenceMode\.PREFER_ON_DEVICE/);
  assert.match(poc, /const result = await onlyOnDevice\.generateContent/);
});

test('API shapes match the documented examples (verified against Firebase docs, not against the installed SDK)', () => {
  assert.match(poc, /onDeviceParams\s*=\s*\{\s*createOptions:/);
  assert.match(poc, /promptOptions:\s*\{\s*responseConstraint:\s*schema\s*\}/);
  assert.match(poc, /generationConfig:\s*\{\s*responseMimeType:\s*'application\/json',\s*responseSchema:\s*schema\s*\}/);
  assert.match(poc, /initializeDeviceModel\(\(p: number\) =>/); 
  assert.match(poc, /initializeDeviceModel\(\(\) => \{\}\)/); 
  assert.match(poc, /getAI\(app, \{ backend: new GoogleAIBackend\(\) \}\)/);
  assert.equal(/systemInstruction/.test(poc), false);
  assert.match(prompt, /nullable: false/);
  assert.match(prompt, /required: \['answerable', 'claim', 'quote'\]/);
});

test('the page never claims success', () => {
  assert.equal(/\bpassed\b/i.test(poc.replace(/mechanicalPassed|onlyOnDeviceSucceeded/g, '')), false);
  assert.equal(/zero data leakage/.test(poc), true); // appears only inside disclaimers
  assert.equal(/guarantee(s|d)? (of )?zero/i.test(poc.replace(/NOT a guarantee of zero/g, '')), false);
});

test('the run-wide network summary (all tags, whole run) is wired into the status machine', () => {
  assert.match(poc, /runSeq = \{ first: lastSeq\(\), last: Number\.MAX_SAFE_INTEGER \}/);
  assert.match(poc, /summarizeRun\(rows, control, har, preferRows, runWideSummary\(\)\)/);
});

test('the response schema is NOT cast to any, so the installed SDK types can judge it; params are checked with `satisfies`', () => {
  assert.equal(/\bas any\b/.test(poc), false);
  assert.equal(/\bas any\b/.test(prompt), false);
  assert.match(poc, /const schema = CLAIM_SCHEMA;/);
  assert.match(poc, /\} satisfies OnDeviceParams;/);
  assert.match(poc, /\} satisfies InCloudParams;/);
  assert.match(poc, /type HybridParams/);
});
