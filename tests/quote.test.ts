import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote, unsupportedFacts, extractFacts, normalizeWithMap } from '../src/core/quote';
import { SCHOLARSHIP_TEXT } from '../src/fixtures/scholarship';

const SRC = SCHOLARSHIP_TEXT;

test('1. a valid quotation exists in the document (exact, correct offsets)', () => {
  const q = 'Applications must be received by 17:00 WAT on 15 December 2026.';
  const m = verifyQuote(SRC, q);
  assert.equal(m.found, true);
  assert.equal(m.method, 'exact');
  assert.equal(SRC.slice(m.start, m.end), q);
});

test('2. a fabricated quotation is rejected', () => {
  const m = verifyQuote(SRC, 'Applications close on 31 January 2027 at midnight.');
  assert.equal(m.found, false);
  assert.equal(m.reason, 'not_found');
});

test('quote with different whitespace and smart quotes still matches, offsets point at ORIGINAL text', () => {
  const q = "A recommendation letter is not required for applicants who have received the Foundation\u2019s earlier   Bursary\nAward.";
  const m = verifyQuote(SRC, q);
  assert.equal(m.found, true);
  assert.equal(m.method, 'normalized');
  assert.equal(
    SRC.slice(m.start, m.end),
    "A recommendation letter is not required for applicants who have received the Foundation's earlier Bursary Award.",
  );
});

test('case differences are tolerated by the normalized path', () => {
  const m = verifyQuote(SRC, 'SUCCESSFUL APPLICANTS RECEIVE N1,200,000 PER ACADEMIC YEAR');
  assert.equal(m.found, true);
});

test('ellipsis quotes are rejected (not contiguous)', () => {
  const m = verifyQuote(SRC, 'Applications must be received ... 15 December 2026.');
  assert.equal(m.found, false);
  assert.equal(m.reason, 'ellipsis');
});

test('very short quotes are rejected', () => {
  const m = verifyQuote(SRC, 'must');
  assert.equal(m.found, false);
  assert.equal(m.reason, 'too_short');
});

test('empty quote is rejected', () => {
  assert.equal(verifyQuote(SRC, '   ').reason, 'empty');
});

test('3. a claim containing a number absent from its quotation is flagged', () => {
  const claim = 'The deadline is 20 December 2026.';
  const quote = 'Applications must be received by 17:00 WAT on 15 December 2026.';
  assert.deepEqual(unsupportedFacts(claim, quote), ['20']);
});

test('numbers with commas and decimals compare equal', () => {
  assert.deepEqual(unsupportedFacts('Award is 1,200,000 a year', 'receive N1,200,000 per academic year'), []);
  assert.deepEqual(extractFacts('GPA 3.50 on a 5.00 scale').sort(), ['3.50', '5.00']);
});

test('month names are treated as facts', () => {
  assert.deepEqual(unsupportedFacts('The deadline is in January.', 'received by 15 December 2026'), ['january']);
});

test('4. same numbers but contradicting claim is NOT caught deterministically (needs semantic review)', () => {
  const quote = 'Late applications will not be considered under any circumstances, except where the Foundation has granted a written extension.';
  const claim = 'Late applications are considered under any circumstances.';
  const m = verifyQuote(SRC, quote);
  assert.equal(m.found, true);
  assert.deepEqual(unsupportedFacts(claim, quote), []); 
});

test('offset map survives dropped zero-width characters', () => {
  const src = 'Alpha\u200B beta  gamma delta epsilon';
  const m = verifyQuote(src, 'alpha beta gamma delta', { minLength: 5 });
  assert.equal(m.found, true);
  assert.ok(src.slice(m.start, m.end).startsWith('Alpha'));
});

test('normalizeWithMap map length equals normalized length', () => {
  const n = normalizeWithMap('  A\u00A0 b\t\nC  ');
  assert.equal(n.text, 'a b c');
  assert.equal(n.map.length, n.text.length);
});

test('ambiguous quotes report multiple occurrences', () => {
  const src = 'Submit the form. Submit the form. Done.';
  const m = verifyQuote(src, 'Submit the form.', { minLength: 5 });
  assert.equal(m.found, true);
  assert.equal(m.occurrences, 2);
});

test('REGRESSION: the modal verb "may" is not the month May (it falsely flagged "applicants may be older...")', () => {
  assert.deepEqual(extractFacts('Applicants may be older than 25.'), ['25']);
  assert.deepEqual(unsupportedFacts('Applicants may apply.', 'Applicants must apply.'), []);
});

test('"May" and "March"/"August" ARE facts when attached to a day or year', () => {
  assert.deepEqual(extractFacts('Deadline: 15 May 2026').sort(), ['15', '2026', 'may']);
  assert.deepEqual(extractFacts('Closes March 3').sort(), ['3', 'march']);
  assert.deepEqual(unsupportedFacts('Due 15 May 2026', 'Due 15 June 2026').sort(), ['may']);
  assert.deepEqual(extractFacts('We march on and an august body'), []);
});
