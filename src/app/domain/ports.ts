import type { InferenceSourceObservation } from '../../core/report';
import type { EventKind, StoredDocument, SyncEvent } from './types';

/** Local persistence (IndexedDB in the browser). Everything the app needs offline lives behind this port. */
export interface LocalStore {
  init(): Promise<void>;
  deviceId(): Promise<string>;
  putDocument(d: StoredDocument): Promise<void>;
  getDocument(docId: string): Promise<StoredDocument | undefined>;
  listDocuments(): Promise<StoredDocument[]>;
  /** Atomically allocates the next per-device seq, computes the hlc (after everything seen so far) and stores the event as pending. */
  appendLocal(kind: EventKind, payload: unknown, nowMs: number): Promise<SyncEvent>;
  /** Stores events pulled from another device, marked as already synced. Same id + same content = duplicate (ignored); same id + different content = conflicting. */
  ingestRemote(events: SyncEvent[]): Promise<{ added: number; duplicates: number; conflicting: SyncEvent[] }>;
  allEvents(): Promise<SyncEvent[]>;
  /** Local-origin events not yet confirmed on the server, ascending by seq. */
  pendingEvents(limit: number): Promise<SyncEvent[]>;
  markPushed(ids: string[]): Promise<void>;
  getCursor(deviceId: string): Promise<number>;
  setCursor(deviceId: string, seq: number): Promise<void>;
  quarantine(item: { source: 'remote' | 'local'; reason: string; event?: unknown }): Promise<void>;
  listQuarantine(): Promise<{ source: string; reason: string; event?: unknown; at: number }[]>;
}

export type PushResult = 'created' | 'exists_identical' | 'exists_different';

/** Remote event store (Firestore in the browser). Events are immutable: create-only, never updated or deleted. */
export interface RemoteStore {
  registerDevice(deviceId: string): Promise<void>;
  listDevices(): Promise<string[]>;
  pushEvent(event: SyncEvent): Promise<PushResult>;
  /** Raw, UNVALIDATED documents with seq > afterSeq for one device, ascending by seq. The sync engine validates them. */
  pullEvents(deviceId: string, afterSeq: number, limit: number): Promise<unknown[]>;
}

/** Local (on-device) answering. Separate from cloud review on purpose: it must never be able to reach the cloud. */
export interface LocalAnswerPort {
  init(onProgress?: (fraction: number) => void): Promise<void>;
  answer(prompt: string): Promise<{ rawText: string; inferenceSource: InferenceSourceObservation }>;
}

/** Cloud semantic review. Receives only the string built by buildReviewRequest(). */
export interface CloudReviewPort {
  review(prompt: string): Promise<{ rawText: string; inferenceSource: InferenceSourceObservation; model: string }>;
}
