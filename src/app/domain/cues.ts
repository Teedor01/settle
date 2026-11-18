const norm = (s: string) => s.replace(/[\u2018\u2019]/g, "'").toLowerCase();
const NEG = /\b(?:not|no|never|cannot|without|neither|nor)\b|n't\b/;
const EXC = /\b(?:except|unless|excluding|exempt|exception|other than|apart from|only if|provided that|save for)\b/;
const UPPER = /\b(?:at most|no more than|maximum|up to|fewer than|less than|not (?:older|more|greater|longer|later) than)\b/g;
const LOWER = /\b(?:at least|no fewer than|minimum|more than|greater than|older than|longer than|over|above)\b/;
const UPPER_TEST = /\b(?:at most|no more than|maximum|up to|fewer than|less than|not (?:older|more|greater|longer|later) than)\b/;

export function cueMismatches(claim: string, quote: string): string[] {
  const c = norm(claim);
  const q = norm(quote);
  const out: string[] = [];
  if (NEG.test(q) && !NEG.test(c)) out.push('The quotation contains negation wording (not/no/never/without...) that the claim does not reflect.');
  if (NEG.test(c) && !NEG.test(q)) out.push('The claim contains negation wording (not/no/never/without...) that the quotation does not contain.');
  if (EXC.test(q) && !EXC.test(c)) out.push('The quotation contains an exception or condition (except/unless/only if...) that the claim does not mention.');
  if (EXC.test(c) && !EXC.test(q)) out.push('The claim contains an exception or condition (except/unless/only if...) that the quotation does not contain.');
  const qUpper = UPPER_TEST.test(q);
  const qLower = LOWER.test(q.replace(UPPER, ' '));
  const cUpper = UPPER_TEST.test(c);
  const cLower = LOWER.test(c.replace(UPPER, ' '));
  if ((qUpper && !qLower && cLower && !cUpper) || (qLower && !qUpper && cUpper && !cLower)) {
    out.push('The claim states a limit in the opposite direction (upper vs lower bound) to the quotation.');
  }
  return out;
}
