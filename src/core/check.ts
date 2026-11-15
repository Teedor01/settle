import { verifyQuote, unsupportedFacts, type QuoteMatch, type VerifyOptions } from './quote';


export interface DeterministicCheck {
  quote: QuoteMatch;
  unsupportedFacts: string[];
  mechanicalChecksPassed: boolean;
  semanticSupport: 'NOT_ASSESSED';
}

export function checkClaim(source: string, claim: string, quote: string, opts: VerifyOptions = {}): DeterministicCheck {
  const q = verifyQuote(source, quote, opts);
  const facts = unsupportedFacts(claim, quote);
  return {
    quote: q,
    unsupportedFacts: facts,
    mechanicalChecksPassed: q.found && facts.length === 0,
    semanticSupport: 'NOT_ASSESSED',
  };
}
