import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaim } from '../src/core/check';
import { SCHOLARSHIP_TEXT } from '../src/fixtures/scholarship';


const SRC = 'Applicants must not be older than 25 on 1 January 2027. Other rules apply.';

const REVERSALS: { name: string; source: string; quote: string; claim: string }[] = [
  { name: 'user example: "must NOT be older than 25" -> "may be older than 25"',
    source: SRC, quote: 'Applicants must not be older than 25 on 1 January 2027.',
    claim: 'Applicants may be older than 25 on 1 January 2027.' },
  { name: 'negation dropped (not required -> required)', source: SCHOLARSHIP_TEXT,
    quote: "A recommendation letter is not required for applicants who have received the Foundation's earlier Bursary Award.",
    claim: 'A recommendation letter is required for applicants who have received the earlier Bursary Award.' },
  { name: 'numeric limit direction flipped (at most 800 -> at least 800)', source: SCHOLARSHIP_TEXT,
    quote: 'a personal statement of at most 800 words', claim: 'The personal statement must be at least 800 words.' },
  { name: 'exception silently dropped ("except where ... written extension")', source: SCHOLARSHIP_TEXT,
    quote: 'Late applications will not be considered under any circumstances, except where the Foundation has granted a written extension.',
    claim: 'Late applications are never considered.' },
  { name: 'exception invented as the rule', source: SCHOLARSHIP_TEXT,
    quote: 'Late applications will not be considered under any circumstances, except where the Foundation has granted a written extension.',
    claim: 'Late applications are considered if the Foundation has granted a written extension, and otherwise too.' },
  { name: 'eligibility flipped', source: SCHOLARSHIP_TEXT,
    quote: 'Final-year students who have already completed all coursework are not eligible.',
    claim: 'Final-year students who have already completed all coursework are eligible.' },
];

for (const c of REVERSALS) {
  test(`ADVERSARIAL reversal passes mechanical checks but is never judged semantically: ${c.name}`, () => {
    const r = checkClaim(c.source, c.claim, c.quote);
    assert.equal(r.quote.found, true, 'the quotation really exists');
    assert.deepEqual(r.unsupportedFacts, [], 'no foreign numbers or months');
    assert.equal(r.mechanicalChecksPassed, true, 'mechanically fine: that is the point of the test');
    assert.equal(r.semanticSupport, 'NOT_ASSESSED');
  });
}

test('the deterministic result exposes no field that could be read as "correct/supported/faithful"', () => {
  const r = checkClaim(SRC, 'Applicants may be older than 25.', 'Applicants must not be older than 25 on 1 January 2027.');
  assert.deepEqual(Object.keys(r).sort(), ['mechanicalChecksPassed', 'quote', 'semanticSupport', 'unsupportedFacts']);
  assert.equal(JSON.stringify(r).toLowerCase().includes('"faithful"'), false);
});

test('control: a fabricated number in the claim IS caught mechanically', () => {
  const r = checkClaim(SRC, 'Applicants must not be older than 35.', 'Applicants must not be older than 25 on 1 January 2027.');
  assert.equal(r.mechanicalChecksPassed, false);
  assert.deepEqual(r.unsupportedFacts, ['35']);
});

test('control: a fabricated quotation IS caught mechanically', () => {
  const r = checkClaim(SRC, 'No age limit applies.', 'There is no upper age limit for applicants.');
  assert.equal(r.mechanicalChecksPassed, false);
  assert.equal(r.quote.found, false);
});
