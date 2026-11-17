import { readFileSync } from 'node:fs';
import { analyzeHar, exitCodeFor } from '../src/core/har';

const args = process.argv.slice(2);
const flagsWithValue = new Set(['--origin', '--needle', '--since', '--until']);
const file = args.find((a: string, i: number) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1] ?? ''));
const get = (flag: string) => args.flatMap((a: string, i: number) => (a === flag ? [args[i + 1] ?? ''] : []));
if (!file) {
  console.error('usage: check-har <file.har> [--origin URL] [--needle TEXT]... [--since ISO --until ISO]');
  process.exit(2);
}
const since = get('--since')[0];
const until = get('--until')[0];
const window = since && until ? { startMs: Date.parse(since), endMs: Date.parse(until) } : undefined;
const res = analyzeHar(JSON.parse(readFileSync(file, 'utf8')), { origin: get('--origin')[0], needles: get('--needle'), ...(window ? { window } : {}) });
console.log(`entries: ${res.entries} (in window: ${res.entriesInWindow})`);
console.log('by class (in window):', res.byClass);
console.log(`cloud inference requests (in window): ${res.cloudInferenceRequests}`);
for (const r of res.cloudInference) console.log('  ', r.status, r.startedAt ?? '', r.url, r.error ?? '');
console.log(`failed/blocked (status 0 or _error): ${res.failedOrBlocked}`);
for (const r of res.failedOrBlockedList) console.log('  ', r.cls, r.url, r.error ?? '');
console.log(`unclassified (identify by hand): ${res.unclassified}`);
for (const u of res.unclassifiedList) console.log('  ', u);
console.log(`bodies not inspectable: ${res.bodiesNotInspectable}`);
console.log(`needle hits: ${res.needleHits}`);
for (const l of res.leaks) console.log('  ', l.url, l.needles);
console.log(`findings outside the window: ${res.outsideWindowFindings}`);
for (const r of res.outsideWindow) console.log('  ', r.startedAt ?? '', r.cls, r.url);
for (const r of res.reasons) console.log('REASON:', r);
console.log(`VERDICT: ${res.verdict}  (absence of findings is not proof of zero data leakage: see README "What the instruments cannot see")`);
process.exit(exitCodeFor(res.verdict));
