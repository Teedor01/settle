import { classifyUrl, findLeaks, type NetClass } from './netclass';

export type HarVerdict = 'CLEAN' | 'REVIEW' | 'VIOLATION';

export interface HarCounts {
  entries: number;
  entriesInWindow: number;
  cloudInferenceRequests: number;
  needleHits: number;
  failedOrBlocked: number;
  unclassified: number;
  bodiesNotInspectable: number;
  outsideWindowFindings: number;
}

export function harVerdict(c: Pick<HarCounts, 'entriesInWindow' | 'cloudInferenceRequests' | 'needleHits' | 'unclassified' | 'bodiesNotInspectable' | 'outsideWindowFindings'>): HarVerdict {
  if (c.cloudInferenceRequests > 0 || c.needleHits > 0) return 'VIOLATION';
  if (c.entriesInWindow === 0 || c.unclassified > 0 || c.bodiesNotInspectable > 0 || c.outsideWindowFindings > 0) return 'REVIEW';
  return 'CLEAN';
}

export function exitCodeFor(v: HarVerdict): number {
  return v === 'CLEAN' ? 0 : v === 'VIOLATION' ? 1 : 3;
}

export interface HarRequestInfo { url: string; status: number; error?: string; cls: NetClass; startedAt?: string }
export interface HarWindow { startMs: number; endMs: number }

export interface HarAnalysis extends HarCounts {
  verdict: HarVerdict;
  reasons: string[];
  byClass: Record<string, number>;
  cloudInference: HarRequestInfo[];
  failedOrBlockedList: HarRequestInfo[];
  unclassifiedList: string[];
  leaks: { url: string; needles: string[] }[];
  outsideWindow: HarRequestInfo[];
}

interface HarEntry {
  startedDateTime?: string;
  request?: { method?: string; url?: string; bodySize?: number; postData?: { text?: string; params?: { name?: string; value?: string }[] } };
  response?: { status?: number; _error?: string };
  _error?: string;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);


export function analyzeHar(har: unknown, opts: { origin?: string; needles?: string[]; window?: HarWindow } = {}): HarAnalysis {
  const entries: HarEntry[] = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries) ?? [];
  const out: HarAnalysis = {
    entries: entries.length, entriesInWindow: 0, cloudInferenceRequests: 0, needleHits: 0, failedOrBlocked: 0, unclassified: 0,
    bodiesNotInspectable: 0, outsideWindowFindings: 0, verdict: 'REVIEW', reasons: [], byClass: {}, cloudInference: [],
    failedOrBlockedList: [], unclassifiedList: [], leaks: [], outsideWindow: [],
  };
  for (const e of entries) {
    const url = e.request?.url ?? '';
    const cls = classifyUrl(url, opts.origin);
    const status = e.response?.status ?? 0;
    const error = e._error ?? e.response?._error;
    const info: HarRequestInfo = { url: url.split('?')[0] ?? url, status, cls, ...(e.startedDateTime ? { startedAt: e.startedDateTime } : {}), ...(error ? { error } : {}) };
    const post = e.request?.postData;
    const bodyText = `${post?.text ?? ''}\n${(post?.params ?? []).map((p) => `${p.name ?? ''}=${p.value ?? ''}`).join('&')}`;
    const leaked = findLeaks(`${url}\n${bodyText}`, opts.needles ?? []);

    const t = e.startedDateTime ? Date.parse(e.startedDateTime) : NaN;
    const inWindow = !opts.window || Number.isNaN(t) || (t >= opts.window.startMs && t <= opts.window.endMs);
    if (!inWindow) {
      if (cls === 'cloud_inference' || leaked.length) {
        out.outsideWindowFindings++;
        out.outsideWindow.push(info);
      }
      continue;
    }
    out.entriesInWindow++;
    out.byClass[cls] = (out.byClass[cls] ?? 0) + 1;
    if (cls === 'cloud_inference') { out.cloudInferenceRequests++; out.cloudInference.push(info); }
    if (status === 0 || error) { out.failedOrBlocked++; out.failedOrBlockedList.push(info); }
    if (cls.startsWith('unclassified')) { out.unclassified++; out.unclassifiedList.push(info.url); }
    if (leaked.length) { out.needleHits++; out.leaks.push({ url: info.url, needles: leaked }); }
    const method = (e.request?.method ?? 'GET').toUpperCase();
    const hasBody = BODY_METHODS.has(method) && (e.request?.bodySize ?? -1) !== 0;
    if (hasBody && post?.text === undefined && !(post?.params && post.params.length)) out.bodiesNotInspectable++;
  }
  out.verdict = harVerdict(out);
  if (out.cloudInferenceRequests) out.reasons.push(`${out.cloudInferenceRequests} cloud-inference request(s) inside the run window`);
  if (out.needleHits) out.reasons.push(`${out.needleHits} request(s) containing sensitive strings`);
  if (out.entriesInWindow === 0) out.reasons.push('no HAR entries inside the run window (wrong file, or the log was cleared too late)');
  if (out.unclassified) out.reasons.push(`${out.unclassified} unclassified request(s): identify them by hand`);
  if (out.bodiesNotInspectable) out.reasons.push(`${out.bodiesNotInspectable} request(s) carried a body that is not present in the HAR, so it could not be scanned`);
  if (out.outsideWindowFindings) out.reasons.push(`${out.outsideWindowFindings} inference request(s)/needle hit(s) OUTSIDE the run window (likely earlier online steps: clear the log before the offline run)`);
  return out;
}
