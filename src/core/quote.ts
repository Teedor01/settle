export type QuoteMethod = 'exact' | 'normalized' | 'none';

export interface QuoteMatch {
  found: boolean;
  method: QuoteMethod;
  start: number;
  end: number;
  occurrences: number;
  reason?: 'too_short' | 'ellipsis' | 'not_found' | 'empty';
}

export interface VerifyOptions {
  minLength?: number;
}

const CHAR_MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2013': '-', '\u2014': '-', '\u00A0': ' ',
};
const DROP = new Set(['\u00AD', '\u200B', '\uFEFF']);

export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let prevSpace = true; 
  for (let i = 0; i < text.length; i++) {
    let ch = text[i] as string;
    if (DROP.has(ch)) continue;
    ch = CHAR_MAP[ch] ?? ch;
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      prevSpace = true;
      out += ' ';
      map.push(i);
      continue;
    }
    prevSpace = false;
    const lower = ch.toLowerCase();
    for (const c of lower) {
      out += c;
      map.push(i);
    }
  }
  while (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { text: out, map };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

export function verifyQuote(source: string, quote: string, opts: VerifyOptions = {}): QuoteMatch {
  const minLength = opts.minLength ?? 15;
  const none = (reason: QuoteMatch['reason']): QuoteMatch =>
    ({ found: false, method: 'none', start: -1, end: -1, occurrences: 0, reason });

  const trimmed = quote.trim();
  if (!trimmed) return none('empty');
  if (trimmed.includes('...') || trimmed.includes('\u2026')) return none('ellipsis');
  if (trimmed.length < minLength) return none('too_short');

  const exactIdx = source.indexOf(trimmed);
  if (exactIdx !== -1) {
    return {
      found: true,
      method: 'exact',
      start: exactIdx,
      end: exactIdx + trimmed.length,
      occurrences: countOccurrences(source, trimmed),
    };
  }

  const n = normalizeWithMap(source);
  const q = normalizeWithMap(trimmed).text;
  const idx = n.text.indexOf(q);
  if (idx === -1 || q.length === 0) return none('not_found');
  const start = n.map[idx] as number;
  const end = (n.map[idx + q.length - 1] as number) + 1;
  return {
    found: true,
    method: 'normalized',
    start,
    end,
    occurrences: countOccurrences(n.text, q),
  };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];
const AMBIGUOUS_MONTHS = new Set(['may', 'march', 'august']);

export function extractFacts(text: string): string[] {
  const facts = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    facts.add(m[0].replace(/,/g, '').replace(/\.$/, ''));
  }
  const lower = text.toLowerCase();
  for (const month of MONTHS) {
    if (AMBIGUOUS_MONTHS.has(month)) {
      const cap = month[0]!.toUpperCase() + month.slice(1);
      const adjacent = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${cap}\\b|\\b${cap}\\s+\\d{1,4}\\b`);
      if (adjacent.test(text)) facts.add(month);
    } else if (new RegExp(`\\b${month}\\b`).test(lower)) {
      facts.add(month);
    }
  }
  return [...facts];
}

export function unsupportedFacts(claim: string, quote: string): string[] {
  const inQuote = new Set(extractFacts(quote));
  return extractFacts(claim).filter((f) => !inQuote.has(f));
}
