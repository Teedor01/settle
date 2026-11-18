import type { InferenceSourceObservation } from '../../core/report';

export type ClaimStatus = 'PROVISIONAL' | 'SOURCE-CHECKED' | 'UNSUPPORTED' | 'REVISED';
export const CLAIM_STATUSES: readonly ClaimStatus[] = ['PROVISIONAL', 'SOURCE-CHECKED', 'UNSUPPORTED', 'REVISED'];
export type TaskUserStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
export const TASK_USER_STATUSES: readonly TaskUserStatus[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];
/** REQUIRES_REVIEW is derived (never written by a user): it comes from unacknowledged claim changes. */
export type TaskEffectiveStatus = TaskUserStatus | 'REQUIRES_REVIEW';

export interface SourceRef {
  docId: string;
  /** SHA-256 of the extracted document text the offsets refer to. */
  docSha256: string;
  start: number;
  end: number;
  method: 'exact' | 'normalized';
  occurrences: number;
}

export interface DeterministicChecks {
  quoteFound: boolean;
  /** Numbers/months the claim asserts that are absent from its quotation. */
  unsupportedFacts: string[];
  /** Advisory heuristics: negation/exception/limit wording present in the quotation but not reflected in the claim. */
  cueWarnings: string[];
}

export type ReviewVerdict = 'supports' | 'contradicts' | 'insufficient' | 'partially_supports';
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['supports', 'contradicts', 'insufficient', 'partially_supports'];
export const REVIEW_ISSUE_TYPES = ['negation', 'exception', 'contradiction', 'insufficient_evidence', 'unsupported_conclusion', 'scope_mismatch'] as const;
export type ReviewIssueType = (typeof REVIEW_ISSUE_TYPES)[number];
export interface ReviewIssue { type: ReviewIssueType; detail: string }

export interface ReviewRecord {
  verdict: ReviewVerdict;
  explanation: string;
  issues: ReviewIssue[];
  revisedClaim: string;
  /** The status OUR policy derived from the verdict plus deterministic checks (the model never sets a status). */
  outcome: ClaimStatus;
  outcomeReasons: string[];
  /** The exact text that left the device for this review. */
  payloadSent: string;
  model: string;
  cloudInferenceSource: InferenceSourceObservation;
}

export type VersionOrigin = 'local_model' | 'deterministic_check' | 'cloud_review' | 'user_override' | 'user_resolution';
export const VERSION_ORIGINS: readonly VersionOrigin[] = ['local_model', 'deterministic_check', 'cloud_review', 'user_override', 'user_resolution'];

export interface ClaimVersionBody {
  versionId: string;
  /** Versions this one supersedes. Empty for the first version. Two versions sharing a parent are a fork (conflict). */
  parents: string[];
  status: ClaimStatus;
  text: string;
  quote: string;
  source: SourceRef | null;
  origin: VersionOrigin;
  reason: string;
  deterministic: DeterministicChecks;
  generation?: { mode: 'ONLY_ON_DEVICE'; inferenceSource: InferenceSourceObservation };
  review?: ReviewRecord;
  override?: { note: string; overridesVersionId: string; previousStatus: ClaimStatus };
}

export interface DocMeta { docId: string; title: string; sha256: string; length: number }
export interface Dependency { claimId: string; versionId: string }

export type EventKind =
  | 'doc_registered' | 'claim_created' | 'claim_version_added'
  | 'task_created' | 'task_title_set' | 'task_status_set' | 'task_flag_ack' | 'task_archived';
export const EVENT_KINDS: readonly EventKind[] = [
  'doc_registered', 'claim_created', 'claim_version_added', 'task_created', 'task_title_set', 'task_status_set', 'task_flag_ack', 'task_archived',
];

export interface PayloadMap {
  doc_registered: DocMeta;
  claim_created: { claimId: string; docId: string; question: string; version: ClaimVersionBody };
  claim_version_added: { claimId: string; version: ClaimVersionBody };
  task_created: { taskId: string; title: string; titleVersionId: string; statusVersionId: string; dependsOn: Dependency[] };
  task_title_set: { taskId: string; versionId: string; parents: string[]; title: string };
  task_status_set: { taskId: string; versionId: string; parents: string[]; status: TaskUserStatus; note: string };
  task_flag_ack: { taskId: string; claimId: string; claimVersionId: string; note: string };
  task_archived: { taskId: string; archived: boolean; note: string };
}

/** Immutable fact. State is always a pure function of the set of events (see reduce.ts). */
export interface SyncEvent {
  /** `${deviceId}-${seq padded to 10}`: also the Firestore document id, so a duplicate push is idempotent. */
  id: string;
  deviceId: string;
  /** Per-device monotonic counter starting at 1 with no gaps. Sync cursors are per device, so late events are never missed. */
  seq: number;
  hlc: string;
  kind: EventKind;
  payload: unknown;
}
export type TypedEvent<K extends EventKind = EventKind> = { [P in K]: Omit<SyncEvent, 'kind' | 'payload'> & { kind: P; payload: PayloadMap[P] } }[K];

export interface StoredDocument { docId: string; title: string; text: string; sha256: string; importedAt: number }
