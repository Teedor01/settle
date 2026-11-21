

export const SYSTEM_PROMPT =
  'You answer questions using ONLY the passages provided. Respond as JSON. ' +
  'If the passages do not answer the question, set answerable to false and leave claim and quote empty. ' +
  'Otherwise: claim is one sentence that answers the question; quote is ONE contiguous span copied ' +
  'exactly, character for character, from the passages (no ellipses, no paraphrase). ' +
  'Do not state facts that are not in the quote.';


export const CLAIM_SCHEMA = {
  type: 'object' as const,
  properties: {
    answerable: { type: 'boolean' as const, nullable: false },
    claim: { type: 'string' as const, nullable: false },
    quote: { type: 'string' as const, nullable: false },
  },
  nullable: false,
  required: ['answerable', 'claim', 'quote'],
};

export interface ModelClaim {
  answerable: boolean;
  claim: string;
  quote: string;
}

/** `requestId` is a per-run canary: the network logger searches outbound traffic for it. */
export function buildPrompt(question: string, passages: string[], requestId?: string): string {
  const body = passages.map((p, i) => `[P${i + 1}]\n${p}`).join('\n\n');
  const id = requestId ? `\n\nREQUEST-ID: ${requestId}` : '';
  return `PASSAGES:\n${body}\n\nQUESTION: ${question}${id}`;
}

export function parseClaim(raw: string): { ok: true; value: ModelClaim } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not_an_object' };
  const o = obj as Record<string, unknown>;
  if (typeof o.answerable !== 'boolean' || typeof o.claim !== 'string' || typeof o.quote !== 'string') {
    return { ok: false, error: 'schema_mismatch' };
  }
  return { ok: true, value: { answerable: o.answerable, claim: o.claim, quote: o.quote } };
}
