// Import order is deliberate and load-bearing: (1) the App Check debug flag, (2) the request logger, (3) Firebase.
import '../../phase1/debug-flag';
import { diagnostics, net } from './netlog-boot';
import { ai, appCheckProviderKind, auth, db, usingEmulators } from '../adapters/firebase-app';
import { createAuthPort, type AuthUser } from '../adapters/auth';
import { createCloudReviewPort } from '../adapters/cloud-review';
import { FirestoreRemote } from '../adapters/firestore-remote';
import { IdbStore, runIdbSelfTest } from '../adapters/idb-store';
import { createNanoLocalPort } from '../adapters/nano-local';
import { runStoreContract } from '../selftest/store-contract';
import { AppService, type PreparedBatch } from '../service';
import { SyncEngine, type SyncReport } from '../sync/engine';
import type { ClaimStatus, TaskUserStatus } from '../domain/types';
import { summarizeEgress } from './egress';
import { buildDiagnosticsReport } from './diagnostics';
import { SCHOLARSHIP_TEXT, SCHOLARSHIP_TITLE, QUESTIONS } from '../../fixtures/scholarship';

const store = new IdbStore();
const local = createNanoLocalPort(ai);
const cloud = createCloudReviewPort(ai);
const svc = new AppService({ store, local, cloud });
const authPort = createAuthPort(auth);

let user: AuthUser | null = null;
let sync: SyncEngine | null = null;
let lastSync: SyncReport | null = null;
let selectedDoc = '';
let batch: PreparedBatch | null = null;
let askNote = '';
let modelNote = 'On-device model: not initialised.';
let selfTest: { name: string; ok: boolean; error?: string }[] | null = null;

const $app = document.getElementById('app') as HTMLElement;
const $banner = document.getElementById('banner') as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (text: string, kind: 'ok' | 'bad' = 'ok') => { $banner.hidden = false; $banner.className = kind; $banner.textContent = text; };

/** Tags every network request made during an action, so the egress panel can attribute traffic (nano:* must never reach the cloud). */
async function withTag<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  net.setTag(tag);
  try { return await fn(); } finally { await tick(300); net.setTag('idle'); }
}

authPort.onChange((u) => {
  user = u;
  sync = u ? new SyncEngine(store, new FirestoreRemote(db, u.uid)) : null;
  void render();
});

const badge = (s: string) => `<span class="badge ${s}">${esc(s)}</span>`;

async function render() {
  const st = await svc.state();
  const docs = await store.listDocuments();
  const pending = sync ? await sync.pendingCount() : (await store.pendingEvents(Number.MAX_SAFE_INTEGER)).length;
  if (!selectedDoc && docs[0]) selectedDoc = docs[0].docId;
  const egress = summarizeEgress(net.events());
  const quarantined = (await store.listQuarantine()).length;
  const docTitle = (id: string) => st.documents.find((d) => d.docId === id)?.title ?? docs.find((d) => d.docId === id)?.title ?? id.slice(0, 8);

  const claimsHtml = st.claims.map((c) => {
    const cur = c.current;
    const hasDoc = docs.some((d) => d.docId === c.docId);
    return `<div class="card">
      <div>${badge(cur.status)} ${c.conflict ? '<span class="bad">CONFLICT between devices</span>' : ''} ${c.incomplete ? '<span class="warn">waiting for events from another device</span>' : ''}
        <b>${esc(cur.text)}</b></div>
      <blockquote>${esc(cur.quote)}<br><small>${cur.source ? `${esc(docTitle(c.docId))} · chars ${cur.source.start}–${cur.source.end} (${cur.source.method}${cur.source.occurrences > 1 ? `, appears ${cur.source.occurrences}×` : ''})` : 'no verified source position'}${hasDoc ? '' : ' · document not on this device'}</small></blockquote>
      <div><small>Question: ${esc(c.question)} · version origin: ${esc(cur.origin)}</small></div>
      <div>${esc(cur.reason)}</div>
      ${cur.deterministic.cueWarnings.length ? `<div class="warn">Wording check: ${cur.deterministic.cueWarnings.map(esc).join(' ')}</div>` : ''}
      ${cur.status === 'SOURCE-CHECKED' ? '<div class="muted">SOURCE-CHECKED means a cloud model judged the quoted passage to support the claim. It is not verified truth, and it only covers the quoted passage.</div>' : ''}
      <div>
        <button data-action="review" data-claim="${c.claimId}">Review in cloud…</button>
        <button data-action="review-force" data-claim="${c.claimId}">Review again…</button>
        <button data-action="override" data-claim="${c.claimId}">Override…</button>
        <button data-action="new-task" data-claim="${c.claimId}">Create task…</button>
        ${c.conflict ? `<button data-action="resolve" data-claim="${c.claimId}">Resolve conflict…</button>` : ''}
      </div>
      <details><summary>History (${c.versions.length} version${c.versions.length === 1 ? '' : 's'})</summary>
        ${c.versions.map((v) => `<div class="card">${badge(v.body.status)} <small>${esc(v.body.origin)} · ${esc(v.hlc.slice(0, 15))}</small><br>${esc(v.body.text)}<br><small>${esc(v.body.reason)}</small>
          ${v.body.review ? `<details><summary>Cloud review (${esc(v.body.review.verdict)})</summary><div>${esc(v.body.review.explanation)}</div>${v.body.review.issues.map((i) => `<div class="warn">${esc(i.type)}: ${esc(i.detail)}</div>`).join('')}<div class="muted">Model: ${esc(v.body.review.model)} · SDK inferenceSource: ${v.body.review.cloudInferenceSource.reported ? esc(v.body.review.cloudInferenceSource.raw ?? '') : 'not reported'}</div><div class="muted">What left this device:</div><pre>${esc(v.body.review.payloadSent)}</pre></details>` : ''}
          ${v.body.generation ? `<small>on-device generation · SDK inferenceSource: ${v.body.generation.inferenceSource.reported ? esc(v.body.generation.inferenceSource.raw ?? '') : 'not reported'}</small>` : ''}</div>`).join('')}
      </details></div>`;
  }).join('') || '<p class="muted">No claims yet. Ask a question about a document.</p>';

  const tasksHtml = st.tasks.map((t) => `<div class="card">
      <div>${badge(t.effectiveStatus)} ${t.archived ? '<span class="muted">(archived)</span>' : ''} ${t.titleConflict || t.statusConflict ? '<span class="bad">CONFLICT between devices</span>' : ''} <b>${esc(t.title)}</b>
        ${t.effectiveStatus === 'REQUIRES_REVIEW' ? `<small> · your own status underneath: ${t.userStatus}</small>` : ''}</div>
      ${t.flags.filter((f) => !f.acknowledged).map((f) => `<div class="warn">⚠ A claim this task depends on became ${f.claimStatus}: ${esc(f.reason)}
          <button data-action="ack" data-task="${t.taskId}" data-claim="${f.claimId}" data-version="${f.claimVersionId}">Acknowledge…</button></div>`).join('')}
      ${t.notices.map((f) => `<div class="muted">Note: this task is already completed (kept unchanged), but a claim it relied on later became ${f.claimStatus}.</div>`).join('')}
      <div>${(['PENDING', 'IN_PROGRESS', 'COMPLETED'] as TaskUserStatus[]).map((s) => `<button data-action="task-status" data-task="${t.taskId}" data-status="${s}">${s}</button>`).join('')}
        <button data-action="task-title" data-task="${t.taskId}">Rename…</button>
        <button data-action="task-archive" data-task="${t.taskId}" data-archived="${t.archived ? 'false' : 'true'}">${t.archived ? 'Restore' : 'Archive'}…</button></div>
      <details><summary>History (${t.history.length})</summary>${t.history.map((h) => `<div><small>${esc(h.hlc.slice(0, 15))} · ${esc(h.kind)}</small> ${esc(h.detail)}</div>`).join('')}</details></div>`).join('') || '<p class="muted">No tasks yet.</p>';

  const disclosureHtml = batch ? `<div class="card"><h3>What will leave this device</h3>
      ${batch.toSend.length === 0 ? '<p>Nothing needs to be sent.</p>' : `<p>For each claim below, <b>exactly this text</b> is sent to cloud Gemini through Firebase AI Logic:</p>
        ${batch.toSend.map((p) => `<pre>${esc(p.request.prompt)}</pre>`).join('')}
        <p><b>Not sent:</b> ${esc(batch.toSend[0]?.request.disclosure.doesNotSend.join(', ') ?? '')}.</p>
        <p class="muted">${esc(batch.toSend[0]?.request.disclosure.sdkMetadataNote ?? '')}</p>
        <label><input type="checkbox" id="consent"> I have read this and I am happy for it to be sent.</label><br>
        <button data-action="confirm-send">Send for review</button>`}
      ${batch.deterministicFailures.length ? `<p class="warn">${batch.deterministicFailures.length} claim(s) fail the local evidence checks and will be marked UNSUPPORTED without sending anything:</p>${batch.deterministicFailures.map((f) => `<div>${esc(f.reasons.join(' '))}</div>`).join('')}<button data-action="apply-local">Apply local results</button>` : ''}
      ${batch.skipped.map((s) => `<div class="muted">Skipped ${s.claimId.slice(0, 8)}: ${esc(s.reason)}: ${esc(s.detail)}</div>`).join('')}
      <button data-action="cancel-send">Cancel</button></div>` : '';

  $app.innerHTML = `
    <h2>1. Documents</h2>
    <div class="row"><input type="file" id="file" accept=".txt,.md,text/plain"> <button data-action="import-sample">Load sample (fictional) scholarship guidelines</button></div>
    <div>${docs.map((d) => `<div>${d.docId === selectedDoc ? '●' : '○'} <a href="#" data-action="select-doc" data-doc="${d.docId}">${esc(d.title)}</a> <small>${d.text.length} chars · sha256 ${d.sha256.slice(0, 10)}…</small></div>`).join('') || '<p class="muted">No documents on this device.</p>'}</div>
    <h2>2. Ask (on-device)</h2>
    <div class="row"><button data-action="init-model">Initialise on-device model</button><span class="muted">${esc(modelNote)}</span></div>
    <div class="row"><input type="text" id="q" size="60" placeholder="Ask about the selected document" list="samples"><datalist id="samples">${QUESTIONS.map((q) => `<option value="${esc(q.question)}">`).join('')}</datalist>
      <button data-action="ask">Ask</button></div>
    <div>${esc(askNote)}</div>
    <h2>3. Claims</h2>
    <button data-action="review-all">Review all unreviewed claims…</button>${disclosureHtml}${claimsHtml}
    <h2>4. Tasks</h2>${tasksHtml}
    <h2>5. Sync &amp; account</h2>
    <div class="card">${user ? `Signed in as <b>${esc(user.email ?? user.uid)}</b> <button data-action="sign-out">Sign out</button> <button data-action="sync">Sync now</button>`
      : `<div class="row"><input type="email" id="email" placeholder="email"><input type="password" id="pw" placeholder="password"><button data-action="sign-in">Sign in</button><button data-action="sign-up">Create account</button></div><div class="muted">Everything works offline without an account. Sign in only to sync across devices.</div>`}
      <div>Sync backend: <b class="${usingEmulators ? 'warn' : ''}">${usingEmulators ? 'LOCAL EMULATORS (Auth + Firestore)' : 'your real Firebase project'}</b></div>
      <div>Pending local changes: <b>${pending}</b> · quarantined problem events: <b class="${quarantined ? 'bad' : ''}">${quarantined}</b> · App Check provider object: ${esc(appCheckProviderKind)}</div>
      ${lastSync ? `<pre>${esc(JSON.stringify(lastSync, null, 2))}</pre>` : ''}</div>
    <h2>6. What left this device (this page load)</h2>
    <div class="card">${egress.onDeviceActionsWithCloudInference > 0 ? `<div class="bad">ALARM: ${egress.onDeviceActionsWithCloudInference} cloud-inference request(s) were made during on-device actions.</div>` : '<div class="ok">No cloud-inference request was made during on-device answering.</div>'}
      ${egress.unexpectedInference > 0 ? `<div class="bad">${egress.unexpectedInference} cloud-inference request(s) happened outside a confirmed review.</div>` : ''}
      <table><tr><th>action</th><th>requests</th><th>by class</th><th>cloud inference</th><th>failed/offline</th></tr>${egress.rows.map((r) => `<tr><td>${esc(r.tag)}</td><td>${r.total}</td><td>${esc(JSON.stringify(r.counts))}</td><td class="${r.inferenceRequests ? 'warn' : ''}">${r.inferenceRequests}</td><td>${r.failed}</td></tr>`).join('')}</table>
      <div class="muted">Limits: this only sees fetch/XHR/beacon from this page (not workers, iframes, Chrome's own traffic). Silence is evidence, not proof. Sync traffic to Firestore carries claim text, questions and history (never document text).</div></div>
    <h2>7. Self-test and evidence</h2>
    <button data-action="selftest">Run IndexedDB contract self-test</button>
    <button data-action="diagnostics">Download diagnostics (console errors + failed requests)</button>
    ${selfTest ? `<table>${selfTest.map((r) => `<tr><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'ok' : 'FAIL'}</td><td>${esc(r.name)}</td><td>${esc(r.error ?? '')}</td></tr>`).join('')}</table>` : ''}`;
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const ask = (label: string) => { const v = window.prompt(label); return v === null ? null : v.trim() || null; };
const allUnreviewed = async () => (await svc.state()).claims.filter((c) => !c.conflict && !c.incomplete && (c.status === 'PROVISIONAL' || c.status === 'REVISED')).map((c) => c.claimId);

async function importText(title: string, text: string) {
  const meta = await svc.importDocument(title, text);
  selectedDoc = meta.docId;
  say(`Imported "${title}" (${text.length} characters). It stays on this device.`);
}

document.body.addEventListener('change', async (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id !== 'file' || !t.files?.[0]) return;
  try { await importText(t.files[0].name, await t.files[0].text()); } catch (e) { say(e instanceof Error ? e.message : String(e), 'bad'); }
  await render();
});

document.body.addEventListener('click', async (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  try {
    switch (d.action) {
      case 'select-doc': selectedDoc = d.doc ?? ''; break;
      case 'import-sample': await importText(SCHOLARSHIP_TITLE, SCHOLARSHIP_TEXT); break;
      case 'init-model':
        modelNote = 'Initialising… (first download can take minutes)'; await render();
        await local.init((p) => { modelNote = `Downloading… ${Math.round(p * 100)}%`; void render(); });
        modelNote = 'On-device model ready.'; break;
      case 'ask': {
        const q = $('q')?.value ?? '';
        const r = await withTag('nano:ask', () => svc.askQuestion(selectedDoc, q));
        askNote = r.kind === 'claim' ? `Provisional claim created (status ${r.version.status}).` : r.kind === 'declined' ? 'The on-device model declined: the document does not answer that.' : `The on-device model's output was unusable (${r.error}). No claim was created.`;
        break;
      }
      case 'review': case 'review-force': batch = await svc.prepareReviews([d.claim ?? ''], { force: d.action === 'review-force' }); break;
      case 'review-all': batch = await svc.prepareReviews(await allUnreviewed()); break;
      case 'cancel-send': batch = null; break;
      case 'apply-local': {
        if (!batch) break;
        const onlyLocal: PreparedBatch = { toSend: [], deterministicFailures: batch.deterministicFailures, skipped: [] };
        await svc.runReviews(onlyLocal, { userConfirmedDisclosure: true }); // nothing is sent: deterministic failures only
        batch = { ...batch, deterministicFailures: [] }; say('Local evidence results applied.'); break;
      }
      case 'confirm-send': {
        if (!batch) break;
        const consent = $('consent')?.checked === true;
        if (!consent) { say('Tick the box to confirm what will be sent.', 'bad'); break; }
        const results = await withTag('cloud:review', () => svc.runReviews(batch as PreparedBatch, { userConfirmedDisclosure: consent }));
        say(results.map((r) => (r.kind === 'applied' ? `${r.claimId.slice(0, 8)} → ${r.status}` : r.kind === 'duplicate' ? `${r.claimId.slice(0, 8)} already reviewed` : `${r.claimId.slice(0, 8)} error: ${r.error}`)).join(' · '));
        batch = null; break;
      }
      case 'override': {
        const status = ask('New status: PROVISIONAL, SOURCE-CHECKED, UNSUPPORTED or REVISED') as ClaimStatus | null;
        const note = status ? ask('Why? (required, recorded in the history)') : null;
        if (status && note) { await svc.overrideClaim(d.claim ?? '', status, note); say('Override recorded as a new version; the earlier versions are kept.'); }
        break;
      }
      case 'resolve': {
        const st = await svc.state();
        const c = st.claims.find((x) => x.claimId === d.claim);
        if (!c) break;
        const pick = ask(`Conflicting versions:\n${c.heads.map((h, i) => `${i + 1}. ${h.status}: ${h.text}`).join('\n')}\nChoose a number:`);
        const head = pick ? c.heads[Number(pick) - 1] : undefined;
        const note = head ? ask('Why this one? (required)') : null;
        if (head && note) { await svc.resolveClaimConflict(c.claimId, head.versionId, note); say('Conflict resolved; both originals remain in the history.'); }
        break;
      }
      case 'new-task': { const title = ask('Task title'); if (title) { await svc.createTask(title, [d.claim ?? '']); say('Task created and linked to this claim.'); } break; }
      case 'task-status': await svc.setTaskStatus(d.task ?? '', d.status as TaskUserStatus); break;
      case 'task-title': { const t = ask('New title'); if (t) await svc.setTaskTitle(d.task ?? '', t); break; }
      case 'task-archive': { const n = ask('Reason (recorded in the history)'); if (n) await svc.archiveTask(d.task ?? '', d.archived === 'true', n); break; }
      case 'ack': { const n = ask('What did you decide? (for example "still valid" or "rewrote the task")'); if (n) await svc.acknowledgeFlag(d.task ?? '', d.claim ?? '', d.version ?? '', n); break; }
      case 'sign-up': await authPort.signUp($('email')?.value ?? '', $('pw')?.value ?? ''); break;
      case 'sign-in': await authPort.signIn($('email')?.value ?? '', $('pw')?.value ?? ''); break;
      case 'sign-out': await authPort.signOut(); lastSync = null; break;
      case 'sync': if (sync) { lastSync = await withTag('sync', () => (sync as SyncEngine).sync()); say(lastSync.errors.length ? `Sync finished with ${lastSync.errors.length} problem(s): see the report.` : `Synced: pushed ${lastSync.pushed}, pulled ${lastSync.pulled}.`, lastSync.errors.length ? 'bad' : 'ok'); } break;
      case 'selftest': selfTest = await runIdbSelfTest(runStoreContract); break;
      case 'diagnostics': {
        const report = buildDiagnosticsReport({ entries: diagnostics.entries, events: net.events(), userAgent: navigator.userAgent, appCheckProvider: appCheckProviderKind, online: navigator.onLine });
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `settle-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        say('Diagnostics downloaded.');
        break;
      }
    }
  } catch (e) { say(e instanceof Error ? e.message : String(e), 'bad'); }
  await render();
});

async function boot() {
  try { await store.init(); await render(); } catch (e) { $app.textContent = `Could not start local storage: ${e instanceof Error ? e.message : String(e)}`; }
}
void boot();
