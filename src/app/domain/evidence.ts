import { checkClaim } from '../../core/check';
import { normalizeWithMap, verifyQuote } from '../../core/quote';
import type { ModelClaim } from '../../phase1/prompt';
import type { InferenceSourceObservation } from '../../core/report';
import { cueMismatches } from './cues';
import { foreignFacts } from './facts';
import type { ClaimVersionBody, DeterministicChecks, SourceRef } from './types';

export interface EvidenceValidation {
  docHashMatches: boolean;
  /** The text at [start,end) of the current document equals the quotation (after whitespace/quote normalisation). */
  sliceMatchesQuote: boolean;
  /** The quotation can still be found somewhere in the current document. */
  quoteFindable: boolean;
  relocated?: { start: number; end: number };
  problems: string[];
}

export function validateEvidence(docText: string, docSha256: string, ref: SourceRef | null, quote: string): EvidenceValidation {
  const problems: string[] = [];
  const found = verifyQuote(docText, quote);
  const docHashMatches = ref !== null && ref.docSha256 === docSha256;
  if (ref === null) problems.push('The claim has no stored source position.');
  else if (!docHashMatches) problems.push('The document on this device differs from the one the claim was made against (hash mismatch).');
  let sliceMatchesQuote = false;
  if (ref !== null && ref.start >= 0 && ref.end <= docText.length && ref.start < ref.end) {
    sliceMatchesQuote = normalizeWithMap(docText.slice(ref.start, ref.end)).text === normalizeWithMap(quote).text;
  }
  if (ref !== null && !sliceMatchesQuote) problems.push('The text at the stored position does not match the quotation.');
  if (!found.found) problems.push(`The quotation can no longer be found in the document (${found.reason ?? 'not found'}).`);
  return {
    docHashMatches, sliceMatchesQuote, quoteFindable: found.found,
    ...(found.found && !sliceMatchesQuote ? { relocated: { start: found.start, end: found.end } } : {}),
    problems,
  };
}

export function deterministicChecks(docText: string, claim: string, quote: string): { checks: DeterministicChecks; quoteMatch: ReturnType<typeof verifyQuote> } {
  const c = checkClaim(docText, claim, quote);
  return {
    quoteMatch: c.quote,
    checks: { quoteFound: c.quote.found, unsupportedFacts: foreignFacts(claim, quote), cueWarnings: c.quote.found ? cueMismatches(claim, quote) : [] },
  };
}

/**
 * First version of a claim from a validated local-model answer. Returns null when the model declined to answer.
 * The status is decided here, deterministically: PROVISIONAL only if the quotation exists and the claim adds no foreign number/date.
 * Nothing here marks a claim SOURCE-CHECKED.
 */
export function buildInitialVersion(a: {
  versionId: string; docId: string; docText: string; docSha256: string; parsed: ModelClaim; inferenceSource: InferenceSourceObservation;
}): ClaimVersionBody | null {
  if (!a.parsed.answerable) return null;
  const { checks, quoteMatch } = deterministicChecks(a.docText, a.parsed.claim, a.parsed.quote);
  const source: SourceRef | null = quoteMatch.found && quoteMatch.method !== 'none'
    ? { docId: a.docId, docSha256: a.docSha256, start: quoteMatch.start, end: quoteMatch.end, method: quoteMatch.method, occurrences: quoteMatch.occurrences }
    : null;
  const problems: string[] = [];
  if (!checks.quoteFound) problems.push('The quotation was not found in the document, so the answer has no verifiable evidence.');
  if (checks.unsupportedFacts.length) problems.push(`The claim states ${checks.unsupportedFacts.join(', ')}, which does not appear in its quotation.`);
  const ok = problems.length === 0;
  return {
    versionId: a.versionId, parents: [], status: ok ? 'PROVISIONAL' : 'UNSUPPORTED', text: a.parsed.claim, quote: a.parsed.quote, source,
    origin: ok ? 'local_model' : 'deterministic_check',
    reason: ok
      ? 'Answered on-device. The quotation exists in the document; the claim has not been semantically reviewed.'
      : problems.join(' '),
    deterministic: checks,
    generation: { mode: 'ONLY_ON_DEVICE', inferenceSource: a.inferenceSource },
  };
}
