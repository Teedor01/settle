export interface Chunk {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 800;
  const overlap = Math.min(opts.overlap ?? 120, Math.floor(maxChars / 2));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
      if (cut > maxChars * 0.5) end = start + cut + 1;
    }
    chunks.push({ id: chunks.length, start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'what', 'which', 'who', 'when', 'how', 'do', 'does', 'can', 'it', 'their', 'they', 'if', 'at',
  'must', 'should', 'there', 'this', 'that', 'with', 'by', 'as', 'any', 'all',
]);

export function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t)).map(stem);
}

export interface RetrieveOptions {
  k?: number;
  budgetChars?: number;
}

export interface Scored extends Chunk {
  score: number;
}

export function retrieve(chunks: Chunk[], query: string, opts: RetrieveOptions = {}): Scored[] {
  const k = opts.k ?? 3;
  const budget = opts.budgetChars ?? 3500;
  const docs = chunks.map((c) => tokenize(c.text));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const q = [...new Set(tokenize(query))];
  const k1 = 1.5;
  const b = 0.75;

  const scored: Scored[] = chunks.map((c, i) => {
    const d = docs[i] as string[];
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / (avgLen || 1))));
    }
    return { ...c, score };
  });

  const out: Scored[] = [];
  let used = 0;
  for (const s of scored.filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score)) {
    if (out.length >= k) break;
    if (used + s.text.length > budget && out.length > 0) continue;
    out.push(s);
    used += s.text.length;
  }
  return out;
}

export interface ContextSelection {
  mode: 'full' | 'retrieved';
  passages: string[];
  chunkIds: number[];
}

export function selectContext(
  source: string,
  question: string,
  opts: ChunkOptions & RetrieveOptions = {},
): ContextSelection {
  const budget = opts.budgetChars ?? 3500;
  if (source.length <= budget) return { mode: 'full', passages: [source], chunkIds: [] };
  const chunks = chunkText(source, opts);
  const top = retrieve(chunks, question, opts);
  return { mode: 'retrieved', passages: top.map((c) => c.text), chunkIds: top.map((c) => c.id) };
}
