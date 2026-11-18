import type { InferenceSourceObservation } from '../../core/report';
import { cueMismatches } from './cues';
import { foreignFacts } from './facts';
import {
  REVIEW_ISSUE_TYPES, REVIEW_VERDICTS, type ClaimStatus, type DeterministicChecks, type ReviewIssue, type ReviewRecord, type ReviewVerdict,
} from './types';

/** Plain JSON schema in the documented shape (same conventions as the Phase 1 schema). Output is ALSO validated in code: the schema is not trusted. */
export const REVIEW_SCHEMA = {
  type: 'object' as const,
  properties: {
    verdict: { type: 'string' as const, enum: [...REVIEW_VERDICTS], nullable: false },
    explanation: { type: 'string' as const, nullable: false },
    issues: {
      type: 'array' as const,
      nullable: false,
      items: {
        type: 'object' as const,
        nullable: false,
        properties: { type: { type: 'string' as const, enum: [...REVIEW_ISSUE_TYPES], nullable: false }, detail: { type: 'string' as const, nullable: false } },
        required: ['type', 'detail'],
      },
    },
    revisedClaim: { type: 'string' as const, nullable: false },
  },
  nullable: false,
  required: ['verdict', 'explanation', 'issues', 'revisedClaim'],
};

export interface Disclosure {
  /** The exact string handed to the SDK. What you see here is what is sent (plus SDK metadata, below). */
  prompt: string;
  sends: string[];
  doesNotSend: string[];
  sdkMetadataNote: string;
  characters: number;
}

const INSTRUCTIONS = [
  'You review whether a QUOTED PASSAGE supports a CLAIM. Use ONLY the quoted passage. Do not use outside knowledge.',
  'Check for: negation, exceptions or conditions the claim omits, contradiction, insufficient evidence, conclusions that go beyond the passage, and scope mismatch. Respond as JSON.',
  'verdict: "supports" only if the passage fully supports the claim as written, including every condition and exception; "partially_supports" if the passage supports a narrower or differently worded claim (put it in revisedClaim, using only facts in the passage); "contradicts"; or "insufficient".',
  'explanation: one to three sentences. issues: every problem you found (empty list if none), each with a type and detail. revisedClaim: only for partially_supports, otherwise an empty string.',
].join('\n');

/** The ONLY function that builds what leaves the device for a review: claim text + quoted passage + fixed instructions. */
export function buildReviewRequest(claimText: string, quote: string): { prompt: string; disclosure: Disclosure } {
  const prompt = `${INSTRUCTIONS}\n\nCLAIM:\n${claimText}\n\nQUOTED PASSAGE:\n${quote}`;
  return {
    prompt,
    disclosure: {
      prompt,
      sends: ['the claim text', 'the quoted passage', 'fixed review instructions'],
      doesNotSend: ['the document', 'the question you asked', 'the document title', 'the source position', 'other claims, tasks or history'],
      sdkMetadataNote: 'The Firebase SDK also sends request metadata that is not part of this text (project id, model name, your App Check token, API key headers).',
      characters: prompt.length,
    },
  };
}

export interface ParsedReview { verdict: ReviewVerdict; explanation: string; issues: ReviewIssue[]; revisedClaim: string }

export function parseReview(raw: string): { ok: true; value: ParsedReview } | { ok: false; error: string } {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { ok: false, error: 'invalid_json' }; }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, error: 'not_an_object' };
  const r = o as Record<string, unknown>;
  if (!REVIEW_VERDICTS.includes(r.verdict as ReviewVerdict)) return { ok: false, error: 'bad_verdict' };
  if (typeof r.explanation !== 'string' || r.explanation.trim() === '') return { ok: false, error: 'missing_explanation' };
  if (typeof r.revisedClaim !== 'string') return { ok: false, error: 'bad_revisedClaim' };
  if (!Array.isArray(r.issues)) return { ok: false, error: 'bad_issues' };
  const issues: ReviewIssue[] = [];
  for (const i of r.issues) {
    if (typeof i !== 'object' || i === null) return { ok: false, error: 'bad_issue' };
    const t = (i as Record<string, unknown>).type;
    const d = (i as Record<string, unknown>).detail;
    if (!REVIEW_ISSUE_TYPES.includes(t as never) || typeof d !== 'string') return { ok: false, error: 'bad_issue' };
    issues.push({ type: t as ReviewIssue['type'], detail: d });
  }
  return { ok: true, value: { verdict: r.verdict as ReviewVerdict, explanation: r.explanation, issues, revisedClaim: r.revisedClaim } };
}

export interface Outcome { status: ClaimStatus; text: string; reasons: string[] }

const sameText = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * OUR policy turns a review into a status. The model never chooses the status, and "the model agrees" is never enough:
 * SOURCE-CHECKED needs (1) quotation exists, (2) no foreign numbers/dates, (3) verdict "supports", (4) no issues listed,
 * (5) no negation/exception/limit cue mismatch. Anything less is UNSUPPORTED (a user can override with a recorded reason).
 */
export function decideOutcome(a: { parsed: ParsedReview; claimText: string; quote: string; deterministic: DeterministicChecks }): Outcome {
  const { parsed, claimText, quote, deterministic } = a;
  const base = `Reviewer: ${parsed.explanation.trim()}`;
  if (!deterministic.quoteFound) return { status: 'UNSUPPORTED', text: claimText, reasons: ['The quotation is not found in the document.', base] };
  if (deterministic.unsupportedFacts.length) {
    return { status: 'UNSUPPORTED', text: claimText, reasons: [`The claim states ${deterministic.unsupportedFacts.join(', ')}, which is not in its quotation.`, base] };
  }
  switch (parsed.verdict) {
    case 'supports': {
      if (parsed.issues.length) {
        return { status: 'UNSUPPORTED', text: claimText, reasons: [`The reviewer said "supports" but listed issues: ${parsed.issues.map((i) => `${i.type}: ${i.detail}`).join('; ')}.`, base] };
      }
      if (deterministic.cueWarnings.length) {
        return { status: 'UNSUPPORTED', text: claimText, reasons: [...deterministic.cueWarnings, 'Automatic confirmation was withheld; check the wording yourself and override if the claim is right.', base] };
      }
      return { status: 'SOURCE-CHECKED', text: claimText, reasons: ['A cloud model judged the quoted passage to support the claim and the deterministic checks passed. This is not verified truth, and it only covers the quoted passage, not the rest of the document.', base] };
    }
    case 'partially_supports': {
      const rev = parsed.revisedClaim.trim();
      const problems: string[] = [];
      if (rev === '') problems.push('no revised claim was given');
      else if (sameText(rev, claimText)) problems.push('the "revised" claim is identical to the original');
      else {
        const foreign = foreignFacts(rev, quote);
        if (foreign.length) problems.push(`the revised claim states ${foreign.join(', ')}, which is not in the quotation`);
        const cues = cueMismatches(rev, quote);
        if (cues.length) problems.push(cues.join(' '));
      }
      return problems.length
        ? { status: 'UNSUPPORTED', text: claimText, reasons: [`The reviewer proposed a revision but it was rejected: ${problems.join('; ')}.`, base] }
        : { status: 'REVISED', text: rev, reasons: ['The quoted passage supports a differently worded claim. The original answer is preserved. The revised wording has not been confirmed: review it again or confirm it yourself.', base] };
    }
    case 'contradicts': return { status: 'UNSUPPORTED', text: claimText, reasons: ['The reviewer found the quoted passage contradicts the claim.', base] };
    case 'insufficient': return { status: 'UNSUPPORTED', text: claimText, reasons: ['The reviewer found the quoted passage insufficient to establish the claim.', base] };
  }
}

export function makeReviewRecord(a: {
  parsed: ParsedReview; outcome: Outcome; payloadSent: string; model: string; cloudInferenceSource: InferenceSourceObservation;
}): ReviewRecord {
  return {
    verdict: a.parsed.verdict, explanation: a.parsed.explanation, issues: a.parsed.issues, revisedClaim: a.parsed.revisedClaim,
    outcome: a.outcome.status, outcomeReasons: a.outcome.reasons, payloadSent: a.payloadSent, model: a.model, cloudInferenceSource: a.cloudInferenceSource,
  };
}
