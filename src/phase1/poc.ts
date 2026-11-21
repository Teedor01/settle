// MUST stay the first import: sets FIREBASE_APPCHECK_DEBUG_TOKEN before any Firebase module is evaluated.
import './debug-flag';
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, getToken as getAppCheckToken, CustomProvider, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type HybridParams } from 'firebase/ai';
import { selectContext } from '../core/chunk';
import { checkClaim } from '../core/check';
import { analyzeHar } from '../core/har';
import { redactUrl } from '../core/netclass';
import {
  INSTRUMENTATION_LIMITS, controlStatus, evaluatePreferTest, harStatus, mechanicalPass, observeInferenceSource, summarizeNetwork, summarizeRun,
  type Faithful, type HarEvidence, type PositiveControl, type PreferTestRow, type QuestionReport, type Useful,
} from '../core/report';
import { SCHOLARSHIP_TEXT, ALL_QUESTIONS, type DemoQuestion } from '../fixtures/scholarship';
import { installNetLog } from './netlog';
import { CLAIM_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseClaim } from './prompt';

const env = import.meta.env;
const CLOUD_MODEL = 'gemini-3.5-flash-lite'; // default cloud model per current Firebase web docs; override if retired
const RUN_NONCE = `cn-${crypto.randomUUID().slice(0, 8)}`; // canary: must never appear in on-device-phase traffic
const NEEDLES = [RUN_NONCE, 'Adeyemi', 'Bursary Award', 'older than 30', ...ALL_QUESTIONS.map((q) => q.question)];
const PREFER_IDS = ['q1', 'q4', 'a1']; // small on purpose: this test is about the SDK property, not model quality

// ---- Network logger: installed after the Firebase modules are evaluated, BEFORE any Firebase call --
const net = installNetLog(window, { origin: location.origin });
net.setNeedles(NEEDLES);

// ---- Firebase + App Check (documented debug-provider procedure; the flag was already set by ./debug-flag) ----
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});
// initializeAppCheck REQUIRES a provider object (AppCheckOptions.provider is not optional) and Firebase's debug snippet elides the options.
// Firebase states that no app registration or production provider is needed to enforce App Check with the debug provider only, and in debug
// mode the SDK exchanges the registered debug token instead of asking the provider for an attestation. So by default this uses a documented
// CustomProvider that can never attest: if the SDK ever calls it, the self-check fails loudly. App Check stays ENFORCED server-side; nothing is bypassed.
// If you have registered a reCAPTCHA Enterprise key and prefer that provider, set VITE_RECAPTCHA_SITE_KEY.
const appCheckProviderKind = env.VITE_RECAPTCHA_SITE_KEY ? 'ReCaptchaEnterpriseProvider (your key)' : 'CustomProvider (debug-only; cannot attest)';
const appCheck = initializeAppCheck(app, {
  provider: env.VITE_RECAPTCHA_SITE_KEY
    ? new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_SITE_KEY)
    : new CustomProvider({ getToken: () => Promise.reject(new Error('App Check debug mode is not active: the SDK asked the attestation provider for a token instead of exchanging the registered debug token.')) }),
  isTokenAutoRefreshEnabled: true,
});
const ai = getAI(app, { backend: new GoogleAIBackend() });

// Plain JSON schema, in the shape Firebase's hybrid structured-output page uses for BOTH responseConstraint and responseSchema.
// No `any` cast: if the installed SDK's types reject this shape, `npm run typecheck` shows the exact error (it was never run against the real SDK).
const schema = CLAIM_SCHEMA;
type OnDeviceParams = NonNullable<HybridParams['onDeviceParams']>;
type InCloudParams = NonNullable<HybridParams['inCloudParams']>;
const onDeviceParams = {
  createOptions: {
    expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
    expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
    initialPrompts: [{ role: 'system' as const, content: [{ type: 'text' as const, value: SYSTEM_PROMPT }] }],
  },
  promptOptions: { responseConstraint: schema },
} satisfies OnDeviceParams;
const inCloudParams = {
  model: CLOUD_MODEL,
  generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
} satisfies InCloudParams;

// The offline proof: throws rather than ever using the cloud.
const onlyOnDevice = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams });
// Separate check of the inferenceSource property. May legitimately fall back to the cloud, so it runs online and is judged on
// REPORTED source vs OBSERVED traffic only.
const preferOnDevice = getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams, inCloudParams });
// Positive control for the network logger.
const onlyCloud = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams });

// ---- UI helpers -------------------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const log = (m: string) => { $('log').textContent += `[${new Date().toISOString()}] ${m}\n`; };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rows: QuestionReport[] = [];
const preferRows: PreferTestRow[] = [];
let control: PositiveControl = { run: false, cloudInferenceObserved: 0, leakDetectorSawCanary: false };
let har: HarEvidence = { provided: false };
let envSnapshot: Record<string, unknown> = {};
let appCheckSelfCheck: { run: boolean; ok: boolean; provider: string; tokenLength?: number; error?: string } = { run: false, ok: false, provider: appCheckProviderKind };
let runWindow: { startedAtMs: number; endedAtMs: number } | null = null;
let runSeq: { first: number; last: number } | null = null; // request-log sequence range covering the whole ONLY_ON_DEVICE run
const lastSeq = () => net.events().at(-1)?.seq ?? 0;
const runWideSummary = () => (runSeq ? summarizeNetwork(net.events().filter((e) => e.seq > runSeq!.first && e.seq <= runSeq!.last)) : summarizeNetwork([]));

// Cross-check: resource-timing entries the wrappers never saw (scripts, iframes, workers...).
const perfSeen: { name: string; initiatorType: string }[] = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) perfSeen.push({ name: redactUrl(e.name), initiatorType: (e as PerformanceResourceTiming).initiatorType }); })
  .observe({ type: 'resource', buffered: true });

const srcCell = (o: { reported: boolean; raw: string | null; status: string }) =>
  o.reported ? `<span class="${o.status === 'reported_on_device' ? 'pass' : o.status === 'reported_in_cloud' ? 'fail' : 'warn'}">${esc(o.raw ?? '')}</span>`
             : '<span class="warn">not reported by the SDK</span>';

async function showEnv() {
  const lm = (self as unknown as { LanguageModel?: { availability: (o?: unknown) => Promise<string> } }).LanguageModel;
  let availability = 'LanguageModel API not present in this browser';
  if (lm) {
    try { availability = await lm.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }); }
    catch (e) { availability = `error: ${(e as Error).message}`; }
  }
  const major = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0);
  const nav = navigator as Navigator & { deviceMemory?: number };
  envSnapshot = {
    userAgent: navigator.userAgent, chromeMajor: major, languageModelAvailability: availability,
    cpuThreads: navigator.hardwareConcurrency, deviceMemoryGB_cappedAt8: nav.deviceMemory ?? null,
    navigatorOnLine: navigator.onLine, cloudModel: CLOUD_MODEL, appCheckProvider: appCheckProviderKind, canary: RUN_NONCE,
  };
  $('env').innerHTML = Object.entries(envSnapshot).map(([k, v]) => `<div>${esc(k)}</div><div>${esc(String(v))}</div>`).join('');
  $('env-warn').innerHTML = major && major < 148
    ? `<div class="box warn">Chrome ${major}: Chrome's docs list the web Prompt API as shipped in Chrome 148, while Firebase's page says 139+ with a flag. Below 148 results may still work, but your setup differs from the documented release: report it.</div>`
    : '';
}

// ---- Step 1: initialize on-device model (needs a user gesture) --------------------------------
$('btn-init').addEventListener('click', async () => {
  $('status').textContent = 'Initializing on-device model… (first download can take several minutes)';
  const t0 = performance.now();
  try {
    await onlyOnDevice.initializeDeviceModel((p: number) => { $('status').textContent = `Download progress: ${Math.round(p * 10000) / 100}%`; });
    $('status').textContent = `On-device model ready in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    $('status').innerHTML = `<span class="fail">initializeDeviceModel failed: ${esc((e as Error).message)}</span>`;
    log(`initializeDeviceModel FAILED: ${(e as Error).stack ?? e}`);
  }
  await showEnv();
});

// ---- Step 2: App Check self-check: proves the registered debug token is accepted (token itself is never shown or stored) ----
$('btn-appcheck').addEventListener('click', async () => {
  net.setTag('appcheck-selfcheck');
  try {
    const t = await getAppCheckToken(appCheck, false);
    appCheckSelfCheck = { run: true, ok: typeof t.token === 'string' && t.token.length > 0, provider: appCheckProviderKind, tokenLength: t.token.length };
  } catch (e) {
    appCheckSelfCheck = { run: true, ok: false, provider: appCheckProviderKind, error: (e as Error).message };
    log(`App Check self-check FAILED: ${(e as Error).stack ?? e}`);
  }
  await tick(300);
  net.setTag('idle');
  const a = appCheckSelfCheck;
  $('appcheck').innerHTML = `App Check self-check: <b class="${a.ok ? 'pass' : 'fail'}">${a.ok ? 'token obtained' : 'FAILED'}</b> · provider object: ${esc(a.provider)}
    ${a.ok ? `· token length ${a.tokenLength} (token not shown)` : `· <span class="fail">${esc(a.error ?? 'empty token')}</span><br><small>Most likely the debug token printed in the console is not registered yet (Console &gt; App Check &gt; Apps &gt; your web app &gt; Manage debug tokens), or the flag was not active. Fix this before the positive control.</small>`}`;
  render();
});

// ---- Step 3: positive control. Proves the logger + classifier CAN see an inference request -----
$('btn-control').addEventListener('click', async () => {
  const q = ALL_QUESTIONS[0]!;
  net.setTag('cloud-control');
  let err = '';
  let observation = observeInferenceSource(undefined);
  try {
    const ctx = selectContext(SCHOLARSHIP_TEXT, q.question, { budgetChars: 3500 });
    const res = await onlyCloud.generateContent(buildPrompt(q.question, ctx.passages, RUN_NONCE));
    observation = observeInferenceSource(res.response.inferenceSource);
  } catch (e) { err = (e as Error).message; log(`control call error: ${(e as Error).stack ?? e}`); }
  await tick(400);
  net.setTag('idle');
  const ev = net.eventsFor('cloud-control');
  control = {
    run: true,
    cloudInferenceObserved: ev.filter((e) => e.urlClass === 'cloud_inference').length,
    leakDetectorSawCanary: ev.some((e) => e.leaks.includes(RUN_NONCE)),
    ...(observation.reported ? { inferenceSource: observation.raw ?? '' } : {}),
  };
  $('control').innerHTML = `Positive control: <b class="${controlStatus(control) === 'VALID' ? 'pass' : 'fail'}">${controlStatus(control)}</b>
    · cloud_inference requests seen: ${control.cloudInferenceObserved} (need ≥ 1) · canary seen in request body: ${control.leakDetectorSawCanary} (need true)
    · SDK inferenceSource (ONLY_IN_CLOUD): ${srcCell(observation)} ${err ? `· <span class="fail">call error: ${esc(err)}</span>` : ''}<br>
    <small>VALID only means the logger can see the cloud-inference path. If INVALID, a zero count in the offline run proves nothing.
    Classes seen: ${esc(JSON.stringify(summarizeNetwork(ev).byClass))}</small>`;
  render();
});

// ---- Step 4: PREFER_ON_DEVICE: does the SDK report ON_DEVICE when local inference is selected? --
$('btn-prefer').addEventListener('click', async () => {
  preferRows.length = 0;
  render();
  try { await preferOnDevice.initializeDeviceModel(() => {}); } catch (e) { log(`prefer initializeDeviceModel: ${(e as Error).message}`); }
  for (const item of ALL_QUESTIONS.filter((q) => PREFER_IDS.includes(q.id))) {
    $('status').textContent = `PREFER_ON_DEVICE: ${item.id} (navigator.onLine=${navigator.onLine})…`;
    preferRows.push(await askPrefer(item));
    render();
  }
  $('status').textContent = 'PREFER_ON_DEVICE check done.';
});

async function askPrefer(item: DemoQuestion): Promise<PreferTestRow> {
  const tag = `p-${item.id}`;
  net.setTag(tag);
  const ctx = selectContext(SCHOLARSHIP_TEXT, item.question, { budgetChars: 3500, maxChars: 450, overlap: 80, k: 3 });
  const t0 = performance.now();
  let succeeded = false;
  let observation = observeInferenceSource(undefined);
  let error: string | undefined;
  try {
    const result = await preferOnDevice.generateContent(buildPrompt(item.question, ctx.passages, RUN_NONCE));
    succeeded = true;
    observation = observeInferenceSource(result.response.inferenceSource);
  } catch (e) { error = (e as Error).message; log(`${tag} ERROR: ${(e as Error).stack ?? e}`); }
  const latencyMs = Math.round(performance.now() - t0);
  await tick(400);
  net.setTag('idle');
  const attempts = net.eventsFor(tag).filter((e) => e.urlClass === 'cloud_inference').length;
  return {
    id: item.id, question: item.question, mode: 'PREFER_ON_DEVICE', navigatorOnLine: navigator.onLine, latencyMs,
    inferenceSucceeded: succeeded, inferenceSource: observation, inferenceRequestAttempts: attempts,
    outcome: evaluatePreferTest({ observation, succeeded, inferenceAttempts: attempts }), ...(error ? { error } : {}),
  };
}

// ---- Step 5: the offline proof, strictly ONLY_ON_DEVICE ----------------------------------------
async function ask(item: DemoQuestion): Promise<QuestionReport> {
  net.setTag(item.id);
  const ctx = selectContext(SCHOLARSHIP_TEXT, item.question, { budgetChars: 3500, maxChars: 450, overlap: 80, k: 3 });
  const prompt = buildPrompt(item.question, ctx.passages, RUN_NONCE);
  const r: QuestionReport = {
    id: item.id, kind: item.kind, question: item.question, contextMode: ctx.mode, mode: 'ONLY_ON_DEVICE',
    inferenceSucceeded: false, inferenceSource: observeInferenceSource(undefined), navigatorOnLine: navigator.onLine, latencyMs: 0,
    json: { valid: false }, semantic: 'NOT_ASSESSED_BY_VALIDATOR', network: summarizeNetwork([]), mechanicalPass: false,
    human: { faithful: 'unreviewed', useful: 'unreviewed', notes: '' },
  };
  const t0 = performance.now();
  try {
    const result = await onlyOnDevice.generateContent(prompt);
    r.latencyMs = Math.round(performance.now() - t0);
    r.inferenceSucceeded = true; // ONLY_ON_DEVICE throws if local inference is unavailable
    r.inferenceSource = observeInferenceSource(result.response.inferenceSource); // recorded as-is; absence is allowed
    const raw: string = result.response.text();
    r.rawOutput = raw;
    const parsed = parseClaim(raw);
    if (!parsed.ok) {
      r.json = { valid: false, error: parsed.error };
    } else {
      const c = parsed.value;
      r.json = { valid: true };
      Object.assign(r, { answerable: c.answerable, claim: c.claim, quote: c.quote });
      if (c.answerable) {
        const chk = checkClaim(SCHOLARSHIP_TEXT, c.claim, c.quote);
        r.quoteCheck = {
          found: chk.quote.found, method: chk.quote.method, occurrences: chk.quote.occurrences,
          start: chk.quote.start, end: chk.quote.end, ...(chk.quote.reason ? { reason: chk.quote.reason } : {}),
        };
        r.numberDateCheck = { unsupportedFacts: chk.unsupportedFacts };
      }
    }
  } catch (e) {
    r.latencyMs = Math.round(performance.now() - t0);
    r.error = (e as Error).message;
    log(`${item.id} ERROR: ${(e as Error).stack ?? e}`);
  }
  await tick(400); // let asynchronous token refresh / telemetry fire inside this question's window
  net.setTag('idle');
  r.network = summarizeNetwork(net.eventsFor(item.id));
  r.mechanicalPass = mechanicalPass(r);
  return r;
}

$('btn-run').addEventListener('click', async () => {
  rows.length = 0;
  har = { provided: false }; // a HAR loaded for an earlier run no longer applies
  $('har').textContent = 'HAR evidence: not provided.';
  runWindow = { startedAtMs: Date.now(), endedAtMs: 0 };
  runSeq = { first: lastSeq(), last: Number.MAX_SAFE_INTEGER };
  render();
  for (const q of ALL_QUESTIONS) {
    $('status').textContent = `Running ${q.id} ONLY_ON_DEVICE (navigator.onLine=${navigator.onLine})…`;
    rows.push(await ask(q));
    render();
  }
  await tick(500); // catch late asynchronous traffic before closing the run
  runWindow.endedAtMs = Date.now();
  runSeq.last = lastSeq();
  $('status').textContent = 'Done. Save the HAR now, load it in step 6, then review every row yourself (faithful? useful?).';
});

// ---- Step 6: independent evidence: analyse the exported HAR in the page (nothing is uploaded) ---
$('har-file').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!runWindow || runWindow.endedAtMs === 0 || rows.length === 0) {
    $('har').innerHTML = '<span class="fail">Run step 5 first: the HAR is analysed against the time window of that run.</span>';
    return;
  }
  try {
    const a = analyzeHar(JSON.parse(await file.text()), {
      origin: location.origin, needles: NEEDLES, window: { startMs: runWindow.startedAtMs - 2000, endMs: runWindow.endedAtMs + 2000 },
    });
    har = {
      provided: true, fileName: file.name, entries: a.entries, entriesInWindow: a.entriesInWindow, cloudInferenceRequests: a.cloudInferenceRequests,
      needleHits: a.needleHits, failedOrBlocked: a.failedOrBlocked, unclassified: a.unclassified,
      bodiesNotInspectable: a.bodiesNotInspectable, outsideWindowFindings: a.outsideWindowFindings,
    };
    const st = harStatus(har);
    $('har').innerHTML = `HAR evidence (${esc(file.name)}): <b class="${st === 'CLEAN' ? 'pass' : st === 'REVIEW' ? 'warn' : 'fail'}">${st}</b>
      · entries ${a.entries} (in the run window: ${a.entriesInWindow}) · cloud-inference requests ${a.cloudInferenceRequests} · needle hits ${a.needleHits}
      · failed/blocked ${a.failedOrBlocked} · unclassified ${a.unclassified} · bodies not inspectable ${a.bodiesNotInspectable} · outside-window findings ${a.outsideWindowFindings}<br>
      ${a.reasons.map((x) => `<span class="warn">• ${esc(x)}</span>`).join('<br>')}<br>
      <small>By class: ${esc(JSON.stringify(a.byClass))}. CLEAN means no finding by this analysis, not proof of zero data leakage.</small>`;
  } catch (e) {
    har = { provided: false };
    $('har').innerHTML = `<span class="fail">Could not read HAR: ${esc((e as Error).message)}</span>`;
  }
  render();
});

// ---- Rendering --------------------------------------------------------------------------------
const sel = (i: number, f: string, opts: string[], cur: string) =>
  `<select data-i="${i}" data-f="${f}">${opts.map((o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

function render() {
  ($('prefer').querySelector('tbody') as HTMLElement).innerHTML = preferRows.map((p) => `<tr>
    <td>${esc(p.id)}: ${esc(p.question)}</td><td>${p.navigatorOnLine}</td><td>${p.latencyMs} ms</td>
    <td class="${p.inferenceSucceeded ? 'pass' : 'fail'}">${p.inferenceSucceeded ? 'yes' : esc(p.error ?? 'no')}</td>
    <td>${srcCell(p.inferenceSource)}</td><td>${p.inferenceRequestAttempts}</td><td><b>${esc(p.outcome)}</b></td></tr>`).join('');

  ($('results').querySelector('tbody') as HTMLElement).innerHTML = rows.map((r, i) => {
    const ref = ALL_QUESTIONS.find((q) => q.id === r.id)?.reviewerReference ?? '';
    const n = r.network;
    return `<tr>
      <td><b>${esc(r.id)}</b> (${r.kind})<br>${esc(r.question)}<br><small>context: ${r.contextMode} · navigator.onLine: ${r.navigatorOnLine}</small></td>
      <td class="${r.inferenceSucceeded ? 'pass' : 'fail'}">${r.inferenceSucceeded ? 'yes' : 'NO'}</td>
      <td>${srcCell(r.inferenceSource)}</td>
      <td>${r.latencyMs} ms</td>
      <td class="${r.json.valid ? 'pass' : 'fail'}">${r.json.valid ? 'valid' : esc(r.json.error ?? r.error ?? 'failed')}</td>
      <td class="${r.answerable === false ? 'warn' : r.quoteCheck?.found ? 'pass' : 'fail'}">${r.answerable === false ? 'declined' : r.quoteCheck ? `${r.quoteCheck.found ? 'exists' : 'NOT found'} (${esc(r.quoteCheck.method)}${r.quoteCheck.reason ? ', ' + esc(r.quoteCheck.reason) : ''}${r.quoteCheck.found ? `, @${r.quoteCheck.start}-${r.quoteCheck.end}, x${r.quoteCheck.occurrences}` : ''})` : 'n/a'}</td>
      <td class="${(r.numberDateCheck?.unsupportedFacts.length ?? 0) ? 'fail' : 'pass'}">${esc((r.numberDateCheck?.unsupportedFacts ?? []).join(', ') || 'none')}</td>
      <td class="${n.status === 'CLEAN' ? 'pass' : n.status === 'REVIEW' ? 'warn' : 'fail'}"><b>${n.status}</b><br>attempted ${n.attempted} · ok ${n.succeeded} · failed/blocked ${n.failed}<br>inference attempts: ${n.cloudInferenceAttempts}<br>${esc(JSON.stringify(n.byClass))}${n.leaks.length ? `<br>LEAKED: ${esc(n.leaks.join(', '))}` : ''}${n.unclassified.length ? `<br>review: ${esc(n.unclassified.join(', '))}` : ''}${n.bodiesNotInspectable ? `<br>bodies not inspectable: ${n.bodiesNotInspectable}` : ''}</td>
      <td class="${r.mechanicalPass ? 'pass' : 'fail'}">${r.mechanicalPass ? 'mechanical checks OK' : 'mechanical FAIL'}<br><small>not a correctness verdict</small></td>
      <td><b>${esc(r.claim ?? '')}</b><br><small>${esc(r.quote ?? '')}</small>${r.error ? `<br><span class="fail">${esc(r.error)}</span>` : ''}</td>
      <td><small>${esc(ref)}</small></td>
      <td>faithful: ${sel(i, 'faithful', ['unreviewed', 'yes', 'partly', 'no'], r.human.faithful)}<br>useful: ${sel(i, 'useful', ['unreviewed', 'yes', 'no'], r.human.useful)}<br><input type="text" data-i="${i}" data-f="notes" placeholder="notes" value="${esc(r.human.notes)}"></td></tr>`;
  }).join('');

  const s = summarizeRun(rows, control, har, preferRows, runWideSummary());
  const sr = s.inferenceSourceReport;
  $('summary').innerHTML = `<b>status: ${s.status}</b><br>
    ONLY_ON_DEVICE calls that resolved: ${s.onlyOnDeviceSucceeded}/${s.total} · SDK-reported inferenceSource: ON_DEVICE ${sr.onDevice}, IN_CLOUD ${sr.inCloud}, other ${sr.other}, not reported ${sr.notReported} (not reported is allowed)<br>
    mechanical checks OK: ${s.mechanicalPassed}/${s.total} (this is NOT correctness)<br>
    your review completed: ${s.humanReviewed}/${s.total} · faithful yes/partly/no: ${s.faithful.yes}/${s.faithful.partly}/${s.faithful.no} · useful yes/no: ${s.useful.yes}/${s.useful.no}<br>
    network (page logger): per-question violations ${s.networkViolations} · need review ${s.networkNeedsReview} · run-wide ${s.runWideNetwork} · all rows offline: ${s.allRanOffline} · positive control: ${s.positiveControl} · HAR evidence: ${s.harEvidence}<br>
    App Check self-check: ${appCheckSelfCheck.run ? (appCheckSelfCheck.ok ? 'token obtained' : 'FAILED') : 'not run'} · PREFER_ON_DEVICE source check: ${s.preferTest.run ? esc(JSON.stringify(s.preferTest.outcomes)) : 'not run'}`;
}

$('results').addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const i = Number(t.dataset.i);
  const f = t.dataset.f;
  const row = rows[i];
  if (!row || !f) return;
  if (f === 'faithful') row.human.faithful = t.value as Faithful;
  else if (f === 'useful') row.human.useful = t.value as Useful;
  else if (f === 'notes') row.human.notes = t.value;
  render();
});

// ---- Report -----------------------------------------------------------------------------------
function buildReport() {
  const all = net.events();
  const byTag: Record<string, unknown[]> = {};
  for (const e of all) (byTag[e.tag] ??= []).push(e);
  const seen = new Set(all.map((e) => e.urlRedacted));
  const summary = summarizeRun(rows, control, har, preferRows, runWideSummary());
  return {
    generatedAt: new Date().toISOString(),
    phase: 'phase1-poc',
    summary,
    environment: envSnapshot,
    appCheck: appCheckSelfCheck,
    positiveControl: { ...control, status: controlStatus(control) },
    runWideNetwork: runWideSummary(),
    runWindow: runWindow ? { startedAt: new Date(runWindow.startedAtMs).toISOString(), endedAt: runWindow.endedAtMs ? new Date(runWindow.endedAtMs).toISOString() : null } : null,
    noCloudFallbackEvidence: {
      basis: 'ONLY_ON_DEVICE is documented to throw when on-device inference is unavailable, so a resolved call means local inference ran. ' +
        'This is corroborated, not proven, by (a) no cloud_inference attempt and no sensitive string seen by the page logger and (b) the independently exported HAR. ' +
        'inferenceSource is recorded only when the SDK reports it and is never inferred; its absence is not a failure. ' +
        'This is evidence about the observed traffic; it is NOT a guarantee of zero data leakage (see instrumentationLimits).',
      onlyOnDeviceCallsResolved: summary.onlyOnDeviceSucceeded,
      pageLoggerInferenceAttempts: rows.reduce((a, r) => a + r.network.cloudInferenceAttempts, 0),
      pageLoggerLeaks: rows.flatMap((r) => r.network.leaks),
      harEvidence: { ...har, status: harStatus(har) },
    },
    instrumentationLimits: INSTRUMENTATION_LIMITS,
    preferOnDeviceSourceCheck: preferRows,
    questions: rows,
    network: {
      note: 'Attempts recorded via fetch/XHR/sendBeacon wrappers. Query strings removed. failed = offline OR blocked OR network error (not distinguishable in JS).',
      eventsByTag: byTag,
      resourceTimingNotSeenByWrappers: perfSeen.filter((p) => !seen.has(p.name)),
    },
  };
}

$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(buildReport(), null, 2));
  $('status').textContent = 'Report JSON copied to clipboard.';
});

$('btn-download').addEventListener('click', () => {
  const label = rows.length > 0 && rows.every((r) => !r.navigatorOnLine) ? 'offline-run' : 'other-run';
  const name = `settle-phase1-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(buildReport(), null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  $('status').textContent = `Downloaded ${name}`;
});

void showEnv();
render();
