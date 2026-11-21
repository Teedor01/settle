import { classifyUrl, findLeaks, redactUrl } from '../core/netclass';
import type { NetEventRecord } from '../core/report';

export interface NetLogger {
  setTag(tag: string): void;
  setNeedles(needles: string[]): void;
  events(): NetEventRecord[];
  eventsFor(tag: string): NetEventRecord[];
  uninstall(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Host = any;

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const maybe = input as { url?: unknown } | null;
  return maybe && typeof maybe.url === 'string' ? maybe.url : String(input);
}

async function readBody(input: unknown, init: { body?: unknown } | undefined): Promise<{ text: string | null; bytes: number | null; inspected: boolean }> {
  const b = init?.body;
  try {
    if (b !== undefined && b !== null) {
      if (typeof b === 'string') return { text: b, bytes: new TextEncoder().encode(b).length, inspected: true };
      if (b instanceof URLSearchParams) { const s = b.toString(); return { text: s, bytes: s.length, inspected: true }; }
      if (typeof Blob !== 'undefined' && b instanceof Blob) return { text: await b.text(), bytes: b.size, inspected: true };
      if (b instanceof ArrayBuffer) return { text: new TextDecoder().decode(b), bytes: b.byteLength, inspected: true };
      if (ArrayBuffer.isView(b)) return { text: new TextDecoder().decode(b as ArrayBufferView), bytes: (b as ArrayBufferView).byteLength, inspected: true };
      return { text: null, bytes: null, inspected: false }; // FormData / ReadableStream
    }
    if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
      const t = await input.clone().text();
      return { text: t, bytes: new TextEncoder().encode(t).length, inspected: true };
    }
  } catch {
    return { text: null, bytes: null, inspected: false };
  }
  return { text: '', bytes: 0, inspected: true }; // no body (e.g. GET)
}

export function installNetLog(host: Host, opts: { origin?: string } = {}): NetLogger {
  const log: NetEventRecord[] = [];
  let tag = 'idle';
  let needles: string[] = [];
  let seq = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const begin = (api: NetEventRecord['api'], method: string, fullUrl: string): NetEventRecord => {
    const ev: NetEventRecord = {
      seq: ++seq, tag, api, method, urlRedacted: redactUrl(fullUrl), urlClass: classifyUrl(fullUrl, opts.origin),
      bodyBytes: null, bodyInspected: false, leaks: findLeaks(fullUrl, needles), outcome: 'pending',
    };
    log.push(ev);
    return ev;
  };

  const origFetch: typeof fetch | undefined = host.fetch?.bind(host);
  if (origFetch) {
    host.fetch = async (input: unknown, init?: { body?: unknown; method?: string }) => {
      const full = urlOf(input);
      const method = (init?.method ?? (input as { method?: string } | null)?.method ?? 'GET').toUpperCase();
      const ev = begin('fetch', method, full);
      const t0 = now();
      const body = await readBody(input, init);
      ev.bodyBytes = body.bytes;
      ev.bodyInspected = body.inspected;
      ev.leaks = [...new Set([...ev.leaks, ...findLeaks(body.text ?? '', needles)])];
      try {
        const res = await origFetch(input as RequestInfo, init as RequestInit);
        ev.outcome = 'ok';
        ev.status = res.status;
        return res;
      } catch (e) {
        ev.outcome = 'failed';
        ev.error = String((e as Error)?.message ?? e);
        throw e;
      } finally {
        ev.durationMs = Math.round(now() - t0);
      }
    };
  }

  // XMLHttpRequest and sendBeacon: browser-only, NOT covered by the Node unit tests.
  const XHR = host.XMLHttpRequest;
  const xhrOpen = XHR?.prototype?.open;
  const xhrSend = XHR?.prototype?.send;
  if (XHR && xhrOpen && xhrSend) {
    XHR.prototype.open = function (this: Host, method: string, url: string | URL, ...rest: unknown[]) {
      this.__netlog = { method: String(method).toUpperCase(), url: String(url) };
      return xhrOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: Host, body?: unknown) {
      const meta = this.__netlog ?? { method: 'GET', url: '' };
      const ev = begin('xhr', meta.method, meta.url);
      const t0 = now();
      ev.bodyInspected = body === undefined || body === null || typeof body === 'string';
      ev.bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body).length : body == null ? 0 : null;
      if (typeof body === 'string') ev.leaks = [...new Set([...ev.leaks, ...findLeaks(body, needles)])];
      this.addEventListener('loadend', () => {
        ev.status = this.status;
        ev.outcome = this.status === 0 ? 'failed' : 'ok';
        ev.durationMs = Math.round(now() - t0);
      });
      return xhrSend.call(this, body);
    };
  }

  const nav = host.navigator;
  const beaconProp = nav?.sendBeacon; // the original property, restored by uninstall()
  const origBeacon = beaconProp?.bind(nav);
  if (origBeacon) {
    nav.sendBeacon = (url: string, data?: unknown) => {
      const ev = begin('beacon', 'POST', String(url));
      ev.bodyInspected = typeof data === 'string';
      ev.bodyBytes = typeof data === 'string' ? new TextEncoder().encode(data).length : null;
      if (typeof data === 'string') ev.leaks = [...new Set([...ev.leaks, ...findLeaks(data, needles)])];
      const ok = origBeacon(url, data);
      ev.outcome = ok ? 'ok' : 'failed';
      return ok;
    };
  }

  return {
    setTag: (t) => { tag = t; },
    setNeedles: (n) => { needles = n; },
    events: () => log.slice(),
    eventsFor: (t) => log.filter((e) => e.tag === t),
    uninstall: () => {
      if (origFetch) host.fetch = origFetch;
      if (XHR && xhrOpen) XHR.prototype.open = xhrOpen;
      if (XHR && xhrSend) XHR.prototype.send = xhrSend;
      if (nav && beaconProp) nav.sendBeacon = beaconProp;
    },
  };
}
