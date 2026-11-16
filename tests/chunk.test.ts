import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, retrieve, selectContext } from '../src/core/chunk';
import { SCHOLARSHIP_TEXT, QUESTIONS, ALL_QUESTIONS } from '../src/fixtures/scholarship';

test('chunks reconstruct the source: every character is covered and spans match', () => {
  const chunks = chunkText(SCHOLARSHIP_TEXT, { maxChars: 400, overlap: 60 });
  assert.ok(chunks.length > 1);
  const covered = new Array<boolean>(SCHOLARSHIP_TEXT.length).fill(false);
  for (const c of chunks) {
    assert.equal(SCHOLARSHIP_TEXT.slice(c.start, c.end), c.text);
    for (let i = c.start; i < c.end; i++) covered[i] = true;
  }
  assert.ok(covered.every(Boolean));
});

test('chunking always terminates, even with tiny sizes', () => {
  const chunks = chunkText('x'.repeat(500), { maxChars: 50, overlap: 49 });
  assert.ok(chunks.length > 0 && chunks.length < 600);
});

test('short document: whole text is sent, so every demo question has its evidence', () => {
  for (const q of ALL_QUESTIONS) {
    const ctx = selectContext(SCHOLARSHIP_TEXT, q.question, { budgetChars: 3500 });
    assert.equal(ctx.mode, 'full');
    assert.ok(ctx.passages.join('\n').includes(q.evidenceHint), `${q.id}: evidence missing`);
  }
});

const FILLER = 'The university library opens at eight each weekday and closes at ten. Parking permits are sold at the front office. '.repeat(60);
const LONG_DOC = FILLER + '\n\n' + SCHOLARSHIP_TEXT + '\n\n' + FILLER;

for (const q of ALL_QUESTIONS.filter((x) => x.id !== 'q2')) {
  test(`long document: retrieval surfaces evidence for ${q.id}`, () => {
    const ctx = selectContext(LONG_DOC, q.question, { budgetChars: 3500, maxChars: 450, overlap: 80, k: 3 });
    assert.equal(ctx.mode, 'retrieved');
    assert.ok(ctx.passages.join('\n').includes(q.evidenceHint), `${q.id}: evidence "${q.evidenceHint}" not retrieved`);
  });
}

test('long document: vocabulary-mismatch question (q2) is retrieved', { todo: 'lexical retrieval cannot bridge "qualifications" -> "GPA"' }, () => {
  const q = QUESTIONS.find((x) => x.id === 'q2')!;
  const ctx = selectContext(LONG_DOC, q.question, { budgetChars: 3500, maxChars: 450, overlap: 80, k: 3 });
  assert.ok(ctx.passages.join('\n').includes(q.evidenceHint));
});

test('retrieval respects the character budget (after the first chunk)', () => {
  const chunks = chunkText(SCHOLARSHIP_TEXT, { maxChars: 450, overlap: 80 });
  const top = retrieve(chunks, 'recommendation letter required applicants', { k: 5, budgetChars: 600 });
  const total = top.reduce((a, c) => a + c.text.length, 0);
  assert.ok(top.length >= 1);
  assert.ok(top.length === 1 || total <= 600);
});

test('irrelevant query retrieves nothing rather than noise', () => {
  const chunks = chunkText(SCHOLARSHIP_TEXT, { maxChars: 450, overlap: 80 });
  assert.equal(retrieve(chunks, 'zebra quantum helicopter').length, 0);
});

test('stemming bridges plural and verb-form variants', async () => {
  const { tokenize } = await import('../src/core/chunk');
  assert.deepEqual(tokenize('Applications applied'), ['application', 'appli']);
  assert.deepEqual(tokenize('application'), ['application']);
});
