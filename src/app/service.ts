import { selectContext } from '../core/chunk';
import { buildPrompt, parseClaim } from '../phase1/prompt';
import { deterministicChecks, buildInitialVersion, validateEvidence } from './domain/evidence';
import type { CloudReviewPort, LocalAnswerPort, LocalStore } from './domain/ports';
import { checkPayloadLimits } from './domain/events';
import { reduceEvents, type AppState, type ClaimView } from './domain/reduce';
import { buildReviewRequest, decideOutcome, makeReviewRecord, parseReview, type Disclosure } from './domain/review';
import { sha256Hex } from './domain/canonical';
import { CLAIM_STATUSES, TASK_USER_STATUSES, type EventKind, type ClaimStatus, type ClaimVersionBody, type DeterministicChecks, type DocMeta, type TaskUserStatus } from './domain/types';

export interface ServiceDeps {
  store: LocalStore;
  local: LocalAnswerPort;
  cloud: CloudReviewPort;
  now?: () => number;
  newId?: () => string;
}

export type AskResult =
  | { kind: 'claim'; claimId: string; version: ClaimVersionBody }
  | { kind: 'declined' }
  | { kind: 'invalid_output'; error: string; raw: string };

export interface PreparedReview {
  claimId: string; versionId: string; claimText: string; quote: string; deterministic: DeterministicChecks;
  request: { prompt: string; disclosure: Disclosure };
}
export interface PreparedFailure { claimId: string; versionId: string; reasons: string[]; checks: DeterministicChecks }
export interface SkippedReview { claimId: string; reason: 'not_found' | 'incomplete' | 'conflict' | 'already_reviewed' | 'document_missing'; detail: string }
export interface PreparedBatch { toSend: PreparedReview[]; deterministicFailures: PreparedFailure[]; skipped: SkippedReview[] }

export type ReviewResult =
  | { claimId: string; kind: 'applied'; status: ClaimStatus; versionId: string }
  | { claimId: string; kind: 'duplicate' }
  | { claimId: string; kind: 'error'; error: string };

export class AppService {
  constructor(private d: ServiceDeps) {}
  private now = () => (this.d.now ? this.d.now() : Date.now());
  private id = () => (this.d.newId ? this.d.newId() : crypto.randomUUID());

  private async append(kind: EventKind, payload: unknown) {
    const normalised: unknown = JSON.parse(JSON.stringify(payload)); // drops undefined keys: exactly what is stored and synchronised
    const problem = checkPayloadLimits(kind, normalised);
    if (problem) throw new Error(`Refusing to record this: ${problem}`);
    return this.d.store.appendLocal(kind, normalised, this.now());
  }

  async state(): Promise<AppState> {
    return reduceEvents(await this.d.store.allEvents());
  }

  async importDocument(title: string, text: string): Promise<DocMeta> {
    if (!title.trim()) throw new Error('A document needs a title.');
    if (!text.trim()) throw new Error('The document is empty.');
    const sha256 = await sha256Hex(text);
    const docId = sha256;
    await this.d.store.putDocument({ docId, title, text, sha256, importedAt: this.now() });
    const meta: DocMeta = { docId, title, sha256, length: text.length };
    await this.append('doc_registered', meta);
    return meta;
  }

  /** On-device answer -> provisional claim. Uses ONLY the local port; the cloud port is never touched here. */
  async askQuestion(docId: string, question: string): Promise<AskResult> {
    const doc = await this.d.store.getDocument(docId);
    if (!doc) throw new Error('That document is not on this device.');
    if (!question.trim()) throw new Error('Ask a question.');
    const ctx = selectContext(doc.text, question, { budgetChars: 3500, maxChars: 450, overlap: 80, k: 3 });
    const out = await this.d.local.answer(buildPrompt(question, ctx.passages));
    const parsed = parseClaim(out.rawText);
    if (!parsed.ok) return { kind: 'invalid_output', error: parsed.error, raw: out.rawText };
    const version = buildInitialVersion({ versionId: this.id(), docId, docText: doc.text, docSha256: doc.sha256, parsed: parsed.value, inferenceSource: out.inferenceSource });
    if (!version) return { kind: 'declined' };
    const claimId = this.id();
    await this.append('claim_created', { claimId, docId, question, version });
    return { kind: 'claim', claimId, version };
  }

  private claimOf(state: AppState, claimId: string): ClaimView {
    const c = state.claims.find((x) => x.claimId === claimId);
    if (!c) throw new Error('Unknown claim.');
    return c;
  }

  // ---------------------------------------------------------------- tasks
  async createTask(title: string, claimIds: string[]): Promise<{ taskId: string }> {
    if (!title.trim()) throw new Error('A task needs a title.');
    if (claimIds.length === 0) throw new Error('A task must depend on at least one claim.');
    const st = await this.state();
    const dependsOn = claimIds.map((claimId) => {
      const c = this.claimOf(st, claimId);
      if (c.conflict) throw new Error('Resolve the claim conflict before creating a task from it.');
      if (c.status === 'UNSUPPORTED') throw new Error('Cannot create a task from an UNSUPPORTED claim.');
      return { claimId, versionId: c.current.versionId };
    });
    const taskId = this.id();
    await this.append('task_created', { taskId, title, titleVersionId: this.id(), statusVersionId: this.id(), dependsOn });
    return { taskId };
  }

  private taskOf(st: AppState, taskId: string) {
    const t = st.tasks.find((x) => x.taskId === taskId);
    if (!t) throw new Error('Unknown task.');
    return t;
  }

  /** Writes a new status naming ALL current heads as parents, so it also resolves a status conflict explicitly. */
  async setTaskStatus(taskId: string, status: TaskUserStatus, note = ''): Promise<void> {
    if (!TASK_USER_STATUSES.includes(status)) throw new Error('REQUIRES_REVIEW cannot be set by hand: it is derived from claim changes.');
    const t = this.taskOf(await this.state(), taskId);
    await this.append('task_status_set', { taskId, versionId: this.id(), parents: t.statusHeads, status, note });
  }

  async setTaskTitle(taskId: string, title: string): Promise<void> {
    if (!title.trim()) throw new Error('A task needs a title.');
    const t = this.taskOf(await this.state(), taskId);
    await this.append('task_title_set', { taskId, versionId: this.id(), parents: t.titleHeads, title });
  }

  async archiveTask(taskId: string, archived: boolean, note: string): Promise<void> {
    this.taskOf(await this.state(), taskId);
    await this.append('task_archived', { taskId, archived, note });
  }

  async acknowledgeFlag(taskId: string, claimId: string, claimVersionId: string, note: string): Promise<void> {
    if (!note.trim()) throw new Error('Say what you decided (for example "still valid" or "rewrote the task").');
    const t = this.taskOf(await this.state(), taskId);
    if (!t.flags.some((f) => f.claimId === claimId && f.claimVersionId === claimVersionId && !f.acknowledged)) throw new Error('There is no open flag like that on this task.');
    await this.append('task_flag_ack', { taskId, claimId, claimVersionId, note });
  }

  // ---------------------------------------------------------------- cloud evidence review
  async prepareReviews(claimIds: string[], opts: { force?: boolean } = {}): Promise<PreparedBatch> {
    const st = await this.state();
    const batch: PreparedBatch = { toSend: [], deterministicFailures: [], skipped: [] };
    for (const claimId of claimIds) {
      const c = st.claims.find((x) => x.claimId === claimId);
      if (!c) { batch.skipped.push({ claimId, reason: 'not_found', detail: 'Unknown claim.' }); continue; }
      if (c.incomplete) { batch.skipped.push({ claimId, reason: 'incomplete', detail: 'Events for this claim from another device have not all arrived yet. Sync first.' }); continue; }
      if (c.conflict) { batch.skipped.push({ claimId, reason: 'conflict', detail: 'Two devices changed this claim differently. Resolve the conflict first.' }); continue; }
      const cur = c.current;
      const reviewedAlready = (cur.origin === 'cloud_review' && cur.status !== 'REVISED') || cur.origin === 'user_override' || cur.origin === 'user_resolution';
      const rejectedMechanically = cur.status === 'UNSUPPORTED' && cur.origin === 'deterministic_check';
      if ((reviewedAlready || rejectedMechanically) && !opts.force) { batch.skipped.push({ claimId, reason: 'already_reviewed', detail: rejectedMechanically ? 'Already rejected by the deterministic checks (see its reason). Use "review again" to force it.' : 'This version was already reviewed or decided by you. Use "review again" to force it.' }); continue; }
      const doc = await this.d.store.getDocument(c.docId);
      if (!doc) { batch.skipped.push({ claimId, reason: 'document_missing', detail: 'The source document is not on this device, so the evidence cannot be re-validated. Import the same document here.' }); continue; }
      const ev = validateEvidence(doc.text, doc.sha256, cur.source, cur.quote);
      const { checks } = deterministicChecks(doc.text, cur.text, cur.quote);
      if (!ev.docHashMatches || !ev.sliceMatchesQuote || !ev.quoteFindable || !checks.quoteFound || checks.unsupportedFacts.length) {
        const reasons = [...ev.problems];
        if (checks.unsupportedFacts.length) reasons.push(`The claim states ${checks.unsupportedFacts.join(', ')}, which is not in its quotation.`);
        batch.deterministicFailures.push({ claimId, versionId: cur.versionId, reasons, checks });
        continue;
      }
      batch.toSend.push({ claimId, versionId: cur.versionId, claimText: cur.text, quote: cur.quote, deterministic: checks, request: buildReviewRequest(cur.text, cur.quote) });
    }
    return batch;
  }

 
  async runReviews(batch: PreparedBatch, confirmation: { userConfirmedDisclosure: boolean }): Promise<ReviewResult[]> {
    if (confirmation.userConfirmedDisclosure !== true) throw new Error('The user has not confirmed what will leave the device.');
    const results: ReviewResult[] = [];
    const hasChild = (c: ClaimView, parentId: string, origin: ClaimVersionBody['origin']) => c.versions.some((v) => v.body.parents.includes(parentId) && v.body.origin === origin);

    for (const f of batch.deterministicFailures) {
      const st = await this.state();
      const c = this.claimOf(st, f.claimId);
      if (hasChild(c, f.versionId, 'deterministic_check')) { results.push({ claimId: f.claimId, kind: 'duplicate' }); continue; }
      const cur = c.versions.find((v) => v.body.versionId === f.versionId)?.body;
      if (!cur) { results.push({ claimId: f.claimId, kind: 'error', error: 'The reviewed version no longer exists.' }); continue; }
      const version: ClaimVersionBody = {
        versionId: this.id(), parents: [f.versionId], status: 'UNSUPPORTED', text: cur.text, quote: cur.quote, source: cur.source,
        origin: 'deterministic_check', reason: f.reasons.join(' '), deterministic: f.checks,
      };
      await this.append('claim_version_added', { claimId: f.claimId, version });
      results.push({ claimId: f.claimId, kind: 'applied', status: 'UNSUPPORTED', versionId: version.versionId });
    }

    for (const p of batch.toSend) {
      try {
        const st = await this.state();
        const c = this.claimOf(st, p.claimId);
        if (hasChild(c, p.versionId, 'cloud_review')) { results.push({ claimId: p.claimId, kind: 'duplicate' }); continue; } // never review the same version twice
        const out = await this.d.cloud.review(p.request.prompt); // exactly the disclosed string
        const parsed = parseReview(out.rawText);
        if (!parsed.ok) { results.push({ claimId: p.claimId, kind: 'error', error: `Unusable review output (${parsed.error}). Nothing was changed.` }); continue; }
        const outcome = decideOutcome({ parsed: parsed.value, claimText: p.claimText, quote: p.quote, deterministic: p.deterministic });
        const base = c.versions.find((v) => v.body.versionId === p.versionId)?.body;
        if (!base) { results.push({ claimId: p.claimId, kind: 'error', error: 'The reviewed version no longer exists.' }); continue; }
        const version: ClaimVersionBody = {
          versionId: this.id(), parents: [p.versionId], status: outcome.status, text: outcome.text, quote: p.quote, source: base.source,
          origin: 'cloud_review', reason: outcome.reasons.join(' '), deterministic: p.deterministic,
          review: makeReviewRecord({ parsed: parsed.value, outcome, payloadSent: p.request.prompt, model: out.model, cloudInferenceSource: out.inferenceSource }),
        };
        await this.append('claim_version_added', { claimId: p.claimId, version });
        results.push({ claimId: p.claimId, kind: 'applied', status: outcome.status, versionId: version.versionId });
      } catch (e) {
        results.push({ claimId: p.claimId, kind: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- user decisions
  async overrideClaim(claimId: string, status: ClaimStatus, note: string, newText?: string): Promise<void> {
    if (!note.trim()) throw new Error('An override needs a reason.');
    if (!CLAIM_STATUSES.includes(status)) throw new Error('Unknown status.');
    const c = this.claimOf(await this.state(), claimId);
    const cur = c.current;
    const version: ClaimVersionBody = {
      versionId: this.id(), parents: c.heads.map((h) => h.versionId), status, text: newText?.trim() ? newText.trim() : cur.text, quote: cur.quote, source: cur.source,
      origin: 'user_override', reason: `User override: ${note.trim()}`, deterministic: cur.deterministic,
      override: { note: note.trim(), overridesVersionId: cur.versionId, previousStatus: cur.status },
    };
    await this.append('claim_version_added', { claimId, version });
  }

  /** Resolves a fork between devices by choosing one head; both originals stay in the history. */
  async resolveClaimConflict(claimId: string, chosenVersionId: string, note: string): Promise<void> {
    if (!note.trim()) throw new Error('A conflict resolution needs a reason.');
    const c = this.claimOf(await this.state(), claimId);
    if (!c.conflict) throw new Error('This claim has no conflict.');
    const chosen = c.heads.find((h) => h.versionId === chosenVersionId);
    if (!chosen) throw new Error('Choose one of the conflicting versions.');
    const version: ClaimVersionBody = { ...chosen, versionId: this.id(), parents: c.heads.map((h) => h.versionId), origin: 'user_resolution', reason: `Conflict resolved by user: ${note.trim()}` };
    delete version.review;
    delete version.override;
    await this.append('claim_version_added', { claimId, version });
  }
}
