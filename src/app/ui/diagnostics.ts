import type { NetEventRecord } from '../../core/report';
import { summarizeEgress } from './egress';

export interface DiagnosticEntry { at: string; type: 'console.error' | 'console.warn' | 'window.error' | 'unhandledrejection'; message: string }

const MAX_MESSAGE = 600;
/** Query strings can carry API keys or tokens: they are never recorded. */
export const redactMessage = (m: string): string => m.replace(/(https?:\/\/[^\s?'")]+)\?[^\s'")]*/g, '$1?[query removed]').slice(0, MAX_MESSAGE);

interface HostLike {
  console: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  addEventListener(type: string, listener: EventListener): void;
}

/** Collects browser console errors/warnings and uncaught errors so a browser test run leaves evidence, not memories. */
export class DiagnosticsCollector {
  readonly entries: DiagnosticEntry[] = [];
  constructor(private max = 300, private now: () => Date = () => new Date()) {}

  record(type: DiagnosticEntry['type'], message: string): void {
    if (this.entries.length >= this.max) return;
    this.entries.push({ at: this.now().toISOString(), type, message: redactMessage(message) });
  }

  attach(host: HostLike): void {
    const fmt = (args: unknown[]) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    for (const level of ['error', 'warn'] as const) {
      const original = host.console[level].bind(host.console);
      host.console[level] = (...args: unknown[]) => { this.record(level === 'error' ? 'console.error' : 'console.warn', fmt(args)); original(...args); };
    }
    host.addEventListener('error', (e) => this.record('window.error', (e as ErrorEvent).message ?? 'error'));
    host.addEventListener('unhandledrejection', (e) => {
      const reason = (e as PromiseRejectionEvent).reason as unknown;
      this.record('unhandledrejection', reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
    });
  }
}

/** What a browser test run should attach as evidence. No claim, document, task or question content is included. */
export function buildDiagnosticsReport(a: { entries: DiagnosticEntry[]; events: NetEventRecord[]; userAgent: string; appCheckProvider: string; online: boolean }) {
  const failed = a.events.filter((e) => e.outcome === 'failed' || (e.status !== undefined && e.status >= 400));
  return {
    generatedAt: new Date().toISOString(),
    userAgent: a.userAgent,
    navigatorOnLine: a.online,
    appCheckProviderObject: a.appCheckProvider,
    consoleAndErrors: { count: a.entries.length, errors: a.entries.filter((e) => e.type !== 'console.warn').length, entries: a.entries },
    network: {
      note: 'Attempts seen by the page logger (fetch/XHR/sendBeacon) only. failed = offline, blocked or network error; status >= 400 are server rejections. Query strings removed. Not an OS-level capture.',
      attempts: a.events.length,
      failedOrRejected: failed.map((e) => ({ tag: e.tag, method: e.method, url: e.urlRedacted, class: e.urlClass, outcome: e.outcome, status: e.status ?? null, error: e.error ?? null })),
      egress: summarizeEgress(a.events),
    },
  };
}
