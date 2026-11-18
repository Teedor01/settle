const ALLOWED_KEYS = new Set(['quote', 'payloadSent']);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (typeof v === 'object' && v !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = ALLOWED_KEYS.has(k) ? '' : strip(x);
    return o;
  }
  return v;
}

export interface LeakHit { index: number; excerpt: string }

export function findDocumentLeaks(events: { payload: unknown }[], docText: string, opts: { window?: number; step?: number; allowQuotes?: boolean } = {}): LeakHit[] {
  const window = opts.window ?? 48;
  const step = opts.step ?? 8;
  const hits: LeakHit[] = [];
  const collapsed = docText.replace(/\s+/g, ' ');
  events.forEach((e, index) => {
    const raw = opts.allowQuotes === false ? e.payload : strip(e.payload);
    const hay = JSON.stringify(raw).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
    for (let i = 0; i + window <= collapsed.length; i += step) {
      const w = collapsed.slice(i, i + window);
      if (w.trim().length < window / 2) continue;
      if (hay.includes(JSON.stringify(w).slice(1, -1))) { hits.push({ index, excerpt: w }); break; }
    }
  });
  return hits;
}
