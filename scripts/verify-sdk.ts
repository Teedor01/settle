import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export interface ImportRecord { module: string; name: string; typeOnly: boolean; file: string; line: number }
export interface SymbolResult {
  module: string; name: string; status: 'FOUND' | 'MISSING' | 'MODULE_UNRESOLVED';
  kind?: string; declaredIn?: string; signatures?: string[]; members?: string[]; usedBy: string[];
}
export interface ExpectationResult { id: string; status: 'PASS' | 'FAIL' | 'UNRESOLVED'; detail: string }
export interface Report {
  generatedAt: string; typescriptVersion: string; sdkVersions: Record<string, string | null>;
  imports: ImportRecord[]; symbols: SymbolResult[]; expectations: ExpectationResult[];
  summary: { symbolsFound: number; symbolsMissing: number; symbolsUnresolved: number; expectationsPassed: number; expectationsFailed: number; expectationsUnresolved: number };
  exitCode: 0 | 1 | 2;
}

const isFirebaseModule = (m: string) => m === 'firebase' || m.startsWith('firebase/');

export function loadProject(tsconfigPath: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath));
  return { fileNames: parsed.fileNames, options: parsed.options };
}

/** Every `import ... from 'firebase/...'` in the given files, symbol by symbol. Pure syntax: works without the SDK. */
export function collectImports(fileNames: string[], rootDir: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  for (const file of fileNames) {
    if (file.endsWith('.d.ts') || file.includes('node_modules')) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const module = node.moduleSpecifier.text;
      if (!isFirebaseModule(module)) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const rel = path.relative(rootDir, file).split(path.sep).join('/');
      const clause = node.importClause;
      if (!clause) { out.push({ module, name: '(side-effect import)', typeOnly: false, file: rel, line }); return; }
      if (clause.name) out.push({ module, name: 'default', typeOnly: clause.isTypeOnly, file: rel, line });
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) out.push({ module, name: (el.propertyName ?? el.name).text, typeOnly: clause.isTypeOnly || el.isTypeOnly, file: rel, line });
      } else if (nb && ts.isNamespaceImport(nb)) out.push({ module, name: '* as ' + nb.name.text, typeOnly: false, file: rel, line });
    });
  }
  return out.sort((a, b) => (a.module + a.name + a.file).localeCompare(b.module + b.name + b.file));
}

function readVersion(rootDir: string, pkg: string): string | null {
  try { return (JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', pkg, 'package.json'), 'utf8')) as { version?: string }).version ?? null; }
  catch { return null; }
}

interface Ctx {
  checker: ts.TypeChecker;
  exportOf(module: string, name: string): { symbol: ts.Symbol; anchor: ts.Node } | undefined;
  moduleResolved(module: string): boolean;
}

const members = (checker: ts.TypeChecker, t: ts.Type): string[] => checker.getPropertiesOfType(t).map((p) => p.name).sort();
const anchorOf = (s: ts.Symbol, fallback: ts.Node): ts.Node => s.valueDeclaration ?? s.declarations?.[0] ?? fallback;

function propType(ctx: Ctx, t: ts.Type, name: string, anchor: ts.Node): ts.Type | undefined {
  const p = ctx.checker.getPropertyOfType(t, name);
  return p ? ctx.checker.getNonNullableType(ctx.checker.getTypeOfSymbolAtLocation(p, anchorOf(p, anchor))) : undefined;
}
function declaredType(ctx: Ctx, module: string, name: string): { type: ts.Type; anchor: ts.Node } | undefined {
  const e = ctx.exportOf(module, name);
  return e ? { type: ctx.checker.getDeclaredTypeOfSymbol(e.symbol), anchor: e.anchor } : undefined;
}
function awaited(ctx: Ctx, t: ts.Type): ts.Type {
  // getAwaitedType is not guaranteed in every TypeScript release: fall back to the first type argument of a Promise-like reference
  const api = (ctx.checker as unknown as { getAwaitedType?: (t: ts.Type) => ts.Type | undefined }).getAwaitedType;
  const a = api?.call(ctx.checker, t);
  if (a && a !== t) return a;
  const isReference = (t.flags & ts.TypeFlags.Object) !== 0 && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  if (isReference && ctx.checker.getPropertyOfType(t, 'then')) {
    const first = ctx.checker.getTypeArguments(t as ts.TypeReference)[0];
    if (first) return first;
  }
  return t;
}
function hasAll(ctx: Ctx, t: ts.Type | undefined, wanted: string[]): { ok: boolean; detail: string } {
  if (!t) return { ok: false, detail: 'type could not be resolved' };
  const have = members(ctx.checker, t);
  const missing = wanted.filter((w) => !have.includes(w));
  return { ok: missing.length === 0, detail: missing.length ? `missing members: ${missing.join(', ')} (declared: ${have.join(', ') || 'none'})` : `has ${wanted.join(', ')}` };
}

/** The shapes our code relies on, taken from how src/ actually calls the SDK. Each is checked against the installed declarations. */
const EXPECTATIONS: { id: string; modules: string[]; run: (c: Ctx) => { ok: boolean; detail: string } }[] = [
  { id: 'firebase/ai HybridParams has mode, onDeviceParams, inCloudParams', modules: ['firebase/ai'],
    run: (c) => hasAll(c, declaredType(c, 'firebase/ai', 'HybridParams')?.type, ['mode', 'onDeviceParams', 'inCloudParams']) },
  { id: 'HybridParams.onDeviceParams has createOptions AND promptOptions (combined use)', modules: ['firebase/ai'],
    run: (c) => { const d = declaredType(c, 'firebase/ai', 'HybridParams'); return hasAll(c, d && propType(c, d.type, 'onDeviceParams', d.anchor), ['createOptions', 'promptOptions']); } },
  { id: 'onDeviceParams.createOptions has expectedInputs, expectedOutputs, initialPrompts', modules: ['firebase/ai'],
    run: (c) => { const d = declaredType(c, 'firebase/ai', 'HybridParams'); const o = d && propType(c, d.type, 'onDeviceParams', d.anchor); return hasAll(c, o && d && propType(c, o, 'createOptions', d.anchor), ['expectedInputs', 'expectedOutputs', 'initialPrompts']); } },
  { id: 'onDeviceParams.promptOptions has responseConstraint', modules: ['firebase/ai'],
    run: (c) => { const d = declaredType(c, 'firebase/ai', 'HybridParams'); const o = d && propType(c, d.type, 'onDeviceParams', d.anchor); return hasAll(c, o && d && propType(c, o, 'promptOptions', d.anchor), ['responseConstraint']); } },
  { id: 'HybridParams.inCloudParams has model and generationConfig', modules: ['firebase/ai'],
    run: (c) => { const d = declaredType(c, 'firebase/ai', 'HybridParams'); return hasAll(c, d && propType(c, d.type, 'inCloudParams', d.anchor), ['model', 'generationConfig']); } },
  { id: 'inCloudParams.generationConfig has responseMimeType and responseSchema', modules: ['firebase/ai'],
    run: (c) => { const d = declaredType(c, 'firebase/ai', 'HybridParams'); const i = d && propType(c, d.type, 'inCloudParams', d.anchor); return hasAll(c, i && d && propType(c, i, 'generationConfig', d.anchor), ['responseMimeType', 'responseSchema']); } },
  { id: 'getGenerativeModel(...) returns a model with generateContent and initializeDeviceModel', modules: ['firebase/ai'],
    run: (c) => {
      const e = c.exportOf('firebase/ai', 'getGenerativeModel');
      if (!e) return { ok: false, detail: 'getGenerativeModel not exported' };
      const sigs = c.checker.getTypeOfSymbolAtLocation(e.symbol, e.anchor).getCallSignatures();
      const results = sigs.map((s) => hasAll(c, s.getReturnType(), ['generateContent', 'initializeDeviceModel']));
      return results.find((r) => r.ok) ?? results[0] ?? { ok: false, detail: 'no call signature' };
    } },
  { id: 'generateContent(...) resolves to a result whose response has text and inferenceSource', modules: ['firebase/ai'],
    run: (c) => {
      const e = c.exportOf('firebase/ai', 'getGenerativeModel');
      if (!e) return { ok: false, detail: 'getGenerativeModel not exported' };
      for (const sig of c.checker.getTypeOfSymbolAtLocation(e.symbol, e.anchor).getCallSignatures()) {
        const model = sig.getReturnType();
        const gen = c.checker.getPropertyOfType(model, 'generateContent');
        if (!gen) continue;
        const r = awaited(c, c.checker.getTypeOfSymbolAtLocation(gen, anchorOf(gen, e.anchor)).getCallSignatures()[0]?.getReturnType() ?? model);
        const resp = propType(c, r, 'response', e.anchor);
        return hasAll(c, resp, ['text', 'inferenceSource']);
      }
      return { ok: false, detail: 'generateContent not found on the model type' };
    } },
  { id: 'AppCheckOptions.provider is declared (and whether it is optional is recorded)', modules: ['firebase/app-check'],
    run: (c) => {
      const d = declaredType(c, 'firebase/app-check', 'AppCheckOptions');
      const p = d && c.checker.getPropertyOfType(d.type, 'provider');
      if (!p) return { ok: false, detail: 'AppCheckOptions.provider not found' };
      return { ok: true, detail: `provider is ${p.flags & ts.SymbolFlags.Optional ? 'OPTIONAL' : 'REQUIRED'}` };
    } },
  { id: 'App Check getToken(appCheck, forceRefresh?) returns a result with token', modules: ['firebase/app-check'],
    run: (c) => {
      const e = c.exportOf('firebase/app-check', 'getToken');
      if (!e) return { ok: false, detail: 'getToken not exported' };
      const sig = c.checker.getTypeOfSymbolAtLocation(e.symbol, e.anchor).getCallSignatures()[0];
      if (!sig) return { ok: false, detail: 'no call signature' };
      const r = hasAll(c, awaited(c, sig.getReturnType()), ['token']);
      return { ok: r.ok && sig.parameters.length >= 1, detail: `${sig.parameters.length} parameter(s); ${r.detail}` };
    } },
  { id: 'firestore runTransaction(db, updateFunction) takes at least two parameters', modules: ['firebase/firestore'],
    run: (c) => {
      const e = c.exportOf('firebase/firestore', 'runTransaction');
      const sig = e && c.checker.getTypeOfSymbolAtLocation(e.symbol, e.anchor).getCallSignatures()[0];
      return sig ? { ok: sig.parameters.length >= 2, detail: `${sig.parameters.length} parameter(s)` } : { ok: false, detail: 'runTransaction has no call signature' };
    } },
];

export function verify(tsconfigPath: string): Report {
  const rootDir = path.dirname(tsconfigPath);
  const { fileNames, options } = loadProject(tsconfigPath);
  const imports = collectImports(fileNames, rootDir);
  const program = ts.createProgram({ rootNames: fileNames, options });
  const checker = program.getTypeChecker();
  const containing = fileNames.find((f) => imports.some((i) => path.resolve(rootDir, i.file) === f)) ?? fileNames[0] ?? tsconfigPath;

  const moduleExports = new Map<string, { sf: ts.SourceFile; exports: Map<string, ts.Symbol> } | null>();
  const resolveModule = (m: string) => {
    if (moduleExports.has(m)) return moduleExports.get(m) ?? null;
    const r = ts.resolveModuleName(m, containing, options, ts.sys).resolvedModule;
    const sf = r ? program.getSourceFile(r.resolvedFileName) : undefined;
    const ms = sf ? checker.getSymbolAtLocation(sf) : undefined;
    let entry: { sf: ts.SourceFile; exports: Map<string, ts.Symbol> } | null = null;
    if (sf && ms) {
      const map = new Map<string, ts.Symbol>();
      for (const s of checker.getExportsOfModule(ms)) map.set(s.name, s);
      entry = { sf, exports: map };
    }
    moduleExports.set(m, entry);
    return entry;
  };
  const ctx: Ctx = {
    checker,
    moduleResolved: (m) => resolveModule(m) !== null,
    exportOf(m, n) {
      const mod = resolveModule(m);
      let s = mod?.exports.get(n);
      if (!mod || !s) return undefined;
      if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      return { symbol: s, anchor: anchorOf(s, mod.sf) };
    },
  };

  const byKey = new Map<string, SymbolResult>();
  for (const i of imports) {
    if (i.name.startsWith('(') || i.name.startsWith('*') || i.name === 'default') continue;
    const key = `${i.module}::${i.name}`;
    const r = byKey.get(key) ?? { module: i.module, name: i.name, status: 'MISSING' as const, usedBy: [] };
    r.usedBy.push(`${i.file}:${i.line}`);
    byKey.set(key, r);
  }
  for (const r of byKey.values()) {
    if (!ctx.moduleResolved(r.module)) { r.status = 'MODULE_UNRESOLVED'; continue; }
    const e = ctx.exportOf(r.module, r.name);
    if (!e) { r.status = 'MISSING'; continue; }
    r.status = 'FOUND';
    const f = e.symbol.flags;
    r.kind = f & ts.SymbolFlags.Class ? 'class' : f & ts.SymbolFlags.Function ? 'function' : f & ts.SymbolFlags.Interface ? 'interface'
      : f & ts.SymbolFlags.TypeAlias ? 'type alias' : f & ts.SymbolFlags.Variable ? 'variable/const' : f & ts.SymbolFlags.Enum ? 'enum' : 'other';
    r.declaredIn = path.relative(rootDir, e.anchor.getSourceFile().fileName).split(path.sep).join('/');
    const t = checker.getTypeOfSymbolAtLocation(e.symbol, e.anchor);
    if (f & (ts.SymbolFlags.Function)) r.signatures = t.getCallSignatures().map((s) => checker.signatureToString(s));
    else if (f & ts.SymbolFlags.Class) r.signatures = t.getConstructSignatures().map((s) => `new ${checker.signatureToString(s)}`);
    else if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) r.members = members(checker, checker.getDeclaredTypeOfSymbol(e.symbol)).slice(0, 60);
    else if (f & ts.SymbolFlags.Variable) r.signatures = t.getCallSignatures().map((s) => checker.signatureToString(s));
  }
  const symbols = [...byKey.values()].sort((a, b) => (a.module + a.name).localeCompare(b.module + b.name));

  const expectations: ExpectationResult[] = EXPECTATIONS.map((x) => {
    if (!x.modules.every((m) => ctx.moduleResolved(m))) return { id: x.id, status: 'UNRESOLVED' as const, detail: 'SDK module not resolvable: not checked' };
    try { const r = x.run(ctx); return { id: x.id, status: r.ok ? ('PASS' as const) : ('FAIL' as const), detail: r.detail }; }
    catch (e) { return { id: x.id, status: 'FAIL' as const, detail: `check threw: ${e instanceof Error ? e.message : String(e)}` }; }
  });

  const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const summary = {
    symbolsFound: count(symbols, (s) => s.status === 'FOUND'), symbolsMissing: count(symbols, (s) => s.status === 'MISSING'),
    symbolsUnresolved: count(symbols, (s) => s.status === 'MODULE_UNRESOLVED'),
    expectationsPassed: count(expectations, (e) => e.status === 'PASS'), expectationsFailed: count(expectations, (e) => e.status === 'FAIL'),
    expectationsUnresolved: count(expectations, (e) => e.status === 'UNRESOLVED'),
  };
  const exitCode: 0 | 1 | 2 = summary.symbolsMissing || summary.expectationsFailed ? 1 : summary.symbolsUnresolved || summary.expectationsUnresolved ? 2 : 0;
  return {
    generatedAt: new Date().toISOString(), typescriptVersion: ts.version,
    sdkVersions: Object.fromEntries(['firebase', '@firebase/ai', '@firebase/app', '@firebase/app-check', '@firebase/auth', '@firebase/firestore'].map((p) => [p, readVersion(rootDir, p)])),
    imports, symbols, expectations, summary, exitCode,
  };
}

export function formatInventory(imports: ImportRecord[]): string {
  const by = new Map<string, Map<string, string[]>>();
  for (const i of imports) {
    const m = by.get(i.module) ?? new Map<string, string[]>();
    const u = m.get(i.name) ?? [];
    u.push(`${i.file}:${i.line}${i.typeOnly ? ' (type)' : ''}`);
    m.set(i.name, u);
    by.set(i.module, m);
  }
  const lines = [`Firebase imports: ${imports.length} import specifiers across ${new Set(imports.map((i) => i.file)).size} files`];
  for (const [mod, syms] of [...by.entries()].sort()) {
    lines.push('', `${mod}`);
    for (const [name, used] of [...syms.entries()].sort()) lines.push(`  ${name.padEnd(30)} ${used.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatReport(r: Report): string {
  const L: string[] = ['DECLARATION CHECK (declarations only; `npm run typecheck` checks the call sites)', `typescript ${r.typescriptVersion}`, 'installed versions: ' + JSON.stringify(r.sdkVersions)];
  L.push('', `symbols: ${r.summary.symbolsFound} found, ${r.summary.symbolsMissing} MISSING, ${r.summary.symbolsUnresolved} in unresolvable modules`);
  for (const s of r.symbols) {
    L.push(`  [${s.status}] ${s.module} :: ${s.name}${s.kind ? ` (${s.kind})` : ''}${s.declaredIn ? ` in ${s.declaredIn}` : ''}`);
    for (const g of s.signatures ?? []) L.push(`        ${g}`);
    if (s.members) L.push(`        members: ${s.members.join(', ')}`);
  }
  L.push('', `expectations: ${r.summary.expectationsPassed} pass, ${r.summary.expectationsFailed} FAIL, ${r.summary.expectationsUnresolved} unresolved`);
  for (const e of r.expectations) L.push(`  [${e.status}] ${e.id}: ${e.detail}`);
  L.push('', r.exitCode === 0 ? 'RESULT: every imported symbol was found and every expectation passed in the INSTALLED declarations.'
    : r.exitCode === 1 ? 'RESULT: FINDINGS. Missing symbols or failed expectations are real: fix the code against the installed declarations (do not suppress).'
    : 'RESULT: NOTHING WAS VERIFIED. The Firebase SDK could not be resolved (is it installed? run npm install).');
  return L.join('\n');
}

function main(argv: string[]) {
  const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const tsconfig = path.resolve(flag('--tsconfig') ?? 'tsconfig.json');
  if (argv.includes('--inventory')) {
    const { fileNames } = loadProject(tsconfig);
    console.log(formatInventory(collectImports(fileNames, path.dirname(tsconfig))));
    return 0;
  }
  const report = verify(tsconfig);
  console.log(formatReport(report));
  const out = flag('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
