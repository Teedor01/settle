import { extractFacts } from '../../core/quote';


const WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', ninety: '90', hundred: '100', thousand: '1000',
};

export function allFacts(text: string): string[] {
  const out = new Set(extractFacts(text));
  for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const d = WORDS[m[0]];
    if (d) out.add(d);
  }
  return [...out];
}

/** Facts the claim asserts that its quotation does not contain. */
export function foreignFacts(claim: string, quote: string): string[] {
  const inQuote = new Set(allFacts(quote));
  return allFacts(claim).filter((f) => !inQuote.has(f));
}
