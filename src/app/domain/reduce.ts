import { canonicalJson } from './canonical';
import { resolveRegister, type RegVersion } from './register';
import type {
  ClaimStatus, ClaimVersionBody, DocMeta, Dependency, SyncEvent, TaskEffectiveStatus, TaskUserStatus, TypedEvent,
} from './types';
import { validateEvent } from './events';

export interface ClaimView {
  claimId: string;
  docId: string;
  question: string;
  createdHlc: string;
  versions: { body: ClaimVersionBody; hlc: string }[];
  heads: ClaimVersionBody[];
  /** Two heads that differ in status or text: a fork that a user must resolve explicitly. */
  conflict: boolean;
  current: ClaimVersionBody;
  status: ClaimStatus;
  missingParents: string[];
  /** The claim_created event has not arrived (events from another device are still missing). */
  incomplete: boolean;
}

export interface FlagView {
  claimId: string;
  claimVersionId: string;
  claimStatus: ClaimStatus;
  raisedHlc: string;
  reason: string;
  acknowledged: boolean;
  ackNote?: string;
}

export interface TaskHistoryEntry { hlc: string; kind: 'created' | 'title' | 'status' | 'flag_raised' | 'flag_acknowledged' | 'archived'; detail: string }

export interface TaskView {
  taskId: string;
  createdHlc: string;
  title: string;
  titleConflict: boolean;
  /** Ids of the current register heads: a new write names them as its parents (resolving any fork). */
  titleHeads: string[];
  statusHeads: string[];
  userStatus: TaskUserStatus;
  statusConflict: boolean;
  /** Derived. COMPLETED always wins; otherwise any unacknowledged flag makes it REQUIRES_REVIEW. */
  effectiveStatus: TaskEffectiveStatus;
  dependsOn: Dependency[];
  /** Flags on tasks that are not completed (acknowledged ones are kept for history). */
  flags: FlagView[];
  /** Claim changes that happened to a COMPLETED task: informational only, the task itself is never changed. */
  notices: FlagView[];
  archived: boolean;
  history: TaskHistoryEntry[];
  missingDependencies: string[];
}

export interface AppState {
  documents: DocMeta[];
  claims: ClaimView[];
  tasks: TaskView[];
  skipped: { id: string; reason: string }[];
  eventCount: number;
}

const byHlcThenId = (a: SyncEvent, b: SyncEvent) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameClaimContent = (a: ClaimVersionBody, b: ClaimVersionBody) => a.status === b.status && a.text === b.text;

interface ClaimAcc { claimId: string; docId: string; question: string; createdHlc: string; created: boolean; versions: RegVersion<ClaimVersionBody>[] }
interface TaskAcc {
  taskId: string; createdHlc: string; created: boolean; dependsOn: Dependency[];
  titles: RegVersion<string>[]; statuses: RegVersion<TaskUserStatus>[];
  archive: { hlc: string; archived: boolean; note: string }[]; acks: Map<string, { note: string; hlc: string }>;
}

type Reach = 'yes' | 'no' | 'unknown';
/** Does `from` descend from `ancestor`? "unknown" (a missing parent) is treated as "yes" by callers: fail toward flagging. */
function reaches(versions: Map<string, RegVersion<ClaimVersionBody>>, from: string, ancestor: string): Reach {
  const seen = new Set<string>();
  const stack = [from];
  let hitMissing = false;
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === ancestor) return 'yes';
    if (seen.has(id)) continue;
    seen.add(id);
    const v = versions.get(id);
    if (!v) { hitMissing = true; continue; }
    for (const p of v.parents) stack.push(p);
  }
  return hitMissing ? 'unknown' : 'no';
}

/** Pure, deterministic: the same SET of events (in any order, with duplicates) always yields the same state on every device. */
export function reduceEvents(events: SyncEvent[]): AppState {
  const skipped: AppState['skipped'] = [];
  const valid: TypedEvent[] = [];
  const seen = new Set<string>();
  for (const e of [...events].sort(byHlcThenId)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const v = validateEvent(e);
    if (v.ok) valid.push(v.event);
    else skipped.push({ id: e.id, reason: v.reason });
  }

  const docs = new Map<string, DocMeta>();
  const claims = new Map<string, ClaimAcc>();
  const tasks = new Map<string, TaskAcc>();
  const claimAcc = (claimId: string, hlc: string): ClaimAcc => {
    let c = claims.get(claimId);
    if (!c) { c = { claimId, docId: '', question: '', createdHlc: hlc, created: false, versions: [] }; claims.set(claimId, c); }
    return c;
  };
  const taskAcc = (taskId: string, hlc: string): TaskAcc => {
    let t = tasks.get(taskId);
    if (!t) { t = { taskId, createdHlc: hlc, created: false, dependsOn: [], titles: [], statuses: [], archive: [], acks: new Map() }; tasks.set(taskId, t); }
    return t;
  };

  for (const e of valid) {
    switch (e.kind) {
      case 'doc_registered': docs.set(e.payload.docId, { ...e.payload }); break;
      case 'claim_created': {
        const c = claimAcc(e.payload.claimId, e.hlc);
        Object.assign(c, { docId: e.payload.docId, question: e.payload.question, createdHlc: e.hlc, created: true });
        c.versions.push({ id: e.payload.version.versionId, parents: e.payload.version.parents, hlc: e.hlc, value: e.payload.version });
        break;
      }
      case 'claim_version_added': {
        const c = claimAcc(e.payload.claimId, e.hlc);
        c.versions.push({ id: e.payload.version.versionId, parents: e.payload.version.parents, hlc: e.hlc, value: e.payload.version });
        break;
      }
      case 'task_created': {
        const t = taskAcc(e.payload.taskId, e.hlc);
        Object.assign(t, { createdHlc: e.hlc, created: true, dependsOn: e.payload.dependsOn });
        t.titles.push({ id: e.payload.titleVersionId, parents: [], hlc: e.hlc, value: e.payload.title });
        t.statuses.push({ id: e.payload.statusVersionId, parents: [], hlc: e.hlc, value: 'PENDING' });
        break;
      }
      case 'task_title_set': taskAcc(e.payload.taskId, e.hlc).titles.push({ id: e.payload.versionId, parents: e.payload.parents, hlc: e.hlc, value: e.payload.title }); break;
      case 'task_status_set': taskAcc(e.payload.taskId, e.hlc).statuses.push({ id: e.payload.versionId, parents: e.payload.parents, hlc: e.hlc, value: e.payload.status }); break;
      case 'task_flag_ack': taskAcc(e.payload.taskId, e.hlc).acks.set(`${e.payload.claimId}|${e.payload.claimVersionId}`, { note: e.payload.note, hlc: e.hlc }); break;
      case 'task_archived': taskAcc(e.payload.taskId, e.hlc).archive.push({ hlc: e.hlc, archived: e.payload.archived, note: e.payload.note }); break;
    }
  }

  // ---- claims
  const claimViews = new Map<string, ClaimView>();
  const claimVersionMaps = new Map<string, Map<string, RegVersion<ClaimVersionBody>>>();
  for (const c of claims.values()) {
    const reg = resolveRegister(c.versions, sameClaimContent);
    const cur = reg.current;
    if (!cur) continue;
    claimVersionMaps.set(c.claimId, new Map(reg.versions.map((v) => [v.id, v])));
    claimViews.set(c.claimId, {
      claimId: c.claimId, docId: c.docId, question: c.question, createdHlc: c.createdHlc,
      versions: reg.versions.map((v) => ({ body: v.value, hlc: v.hlc })), heads: reg.heads.map((h) => h.value),
      conflict: reg.conflict, current: cur.value, status: cur.value.status, missingParents: reg.missingParents, incomplete: !c.created,
    });
  }

  // ---- tasks (flags are DERIVED from claim history, so every device computes the same flags without exchanging them)
  const taskViews: TaskView[] = [];
  for (const t of tasks.values()) {
    const title = resolveRegister(t.titles, (a, b) => a === b);
    const status = resolveRegister(t.statuses, (a, b) => a === b);
    const userStatus: TaskUserStatus = status.current?.value ?? 'PENDING';
    const archive = [...t.archive].sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
    const flags: FlagView[] = [];
    const missingDependencies: string[] = [];
    for (const dep of t.dependsOn) {
      const cv = claimViews.get(dep.claimId);
      const vmap = claimVersionMaps.get(dep.claimId);
      if (!cv || !vmap) { missingDependencies.push(dep.claimId); continue; }
      for (const w of cv.versions) {
        if (w.body.versionId === dep.versionId) continue;
        if (w.body.status !== 'UNSUPPORTED' && w.body.status !== 'REVISED') continue;
        if (reaches(vmap, w.body.versionId, dep.versionId) === 'no') continue;
        const ack = t.acks.get(`${dep.claimId}|${w.body.versionId}`);
        flags.push({
          claimId: dep.claimId, claimVersionId: w.body.versionId, claimStatus: w.body.status, raisedHlc: w.hlc,
          reason: w.body.reason, acknowledged: ack !== undefined, ...(ack ? { ackNote: ack.note } : {}),
        });
      }
    }
    flags.sort((a, b) => (a.raisedHlc < b.raisedHlc ? -1 : 1));
    const completed = userStatus === 'COMPLETED';
    const open = flags.filter((f) => !f.acknowledged);
    const effectiveStatus: TaskEffectiveStatus = completed ? 'COMPLETED' : open.length ? 'REQUIRES_REVIEW' : userStatus;

    const history: TaskHistoryEntry[] = [{ hlc: t.createdHlc, kind: 'created', detail: `Created: "${t.titles[0]?.value ?? ''}"` }];
    for (const v of title.versions.slice(1)) history.push({ hlc: v.hlc, kind: 'title', detail: `Title set to "${v.value}"` });
    for (const v of status.versions.slice(1)) history.push({ hlc: v.hlc, kind: 'status', detail: `Status set to ${v.value}` });
    for (const f of flags) {
      history.push({ hlc: f.raisedHlc, kind: 'flag_raised', detail: `Claim ${f.claimId.slice(0, 8)} became ${f.claimStatus}${completed ? ' (task already completed: preserved unchanged)' : ''}` });
      if (f.acknowledged) history.push({ hlc: t.acks.get(`${f.claimId}|${f.claimVersionId}`)?.hlc ?? f.raisedHlc, kind: 'flag_acknowledged', detail: `Acknowledged: ${f.ackNote ?? ''}` });
    }
    for (const a of archive) history.push({ hlc: a.hlc, kind: 'archived', detail: `${a.archived ? 'Archived' : 'Restored'}: ${a.note}` });
    history.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));

    taskViews.push({
      taskId: t.taskId, createdHlc: t.createdHlc, title: title.current?.value ?? '', titleConflict: title.conflict, titleHeads: title.heads.map((h) => h.id), statusHeads: status.heads.map((h) => h.id), userStatus,
      statusConflict: status.conflict, effectiveStatus, dependsOn: t.dependsOn,
      flags: completed ? [] : flags, notices: completed ? flags : [], archived: archive.length ? (archive[archive.length - 1] as { archived: boolean }).archived : false,
      history, missingDependencies,
    });
  }
  taskViews.sort((a, b) => (a.createdHlc < b.createdHlc ? -1 : a.createdHlc > b.createdHlc ? 1 : a.taskId < b.taskId ? -1 : 1));

  return {
    documents: [...docs.values()].sort((a, b) => (a.docId < b.docId ? -1 : 1)),
    claims: [...claimViews.values()].sort((a, b) => (a.createdHlc < b.createdHlc ? -1 : a.createdHlc > b.createdHlc ? 1 : a.claimId < b.claimId ? -1 : 1)),
    tasks: taskViews, skipped, eventCount: valid.length,
  };
}

/** Convergence helper used by tests: canonical fingerprint of a state. */
export const fingerprint = (s: AppState): string => canonicalJson({ documents: s.documents, claims: s.claims, tasks: s.tasks });
