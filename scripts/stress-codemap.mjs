import { codemapOperation, getCodeGraph } from '../dist/codemap/tool.js';

const ROOT = process.cwd();
let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const ok = (m) => console.log('  ok    ' + m);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

console.log('=== 1. GRAPH BUILD ===');
let t = Date.now();
const g1 = getCodeGraph(ROOT);
const cold = Date.now() - t;
t = Date.now();
const g2 = getCodeGraph(ROOT);
const warm = Date.now() - t;
console.log('cold ' + cold + 'ms | warm ' + warm + 'ms | identity ' + (g1 === g2));
console.log('nodes ' + g1.graph.nodeKeys.length + ' | edges ' + g1.graph.edges.length + ' | files ' + g1.graph.files.length);
if (g1 !== g2) fail('graph not memoized'); else ok('graph memoized');
if (warm > 50) fail('warm graph slow: ' + warm + 'ms'); else ok('warm rebuild under 50ms');

console.log('');
console.log('=== 2. GROUND-TRUTH SEARCH ===');
const GROUND = [
  ['restorePrewalkModel', 'src/prewalk/model.ts'],
  ['settleContinuation', 'src/prewalk/controller.ts'],
  ['reducePrewalkLifecycle', 'src/prewalk/lifecycle.ts'],
  ['buildCodeGraph', 'src/codemap/build.ts'],
  ['createCodemapTool', 'src/codemap/tool.ts'],
  ['buildSymbolIndex', 'src/codemap/symbols.ts'],
  ['runOutline', 'src/codemap/outline.ts'],
  ['predictFileCascade', 'src/codemap/cascade.ts'],
  ['buildLiteralIndex', 'src/codemap/literals.ts'],
  ['expandNeighborhood', 'src/codemap/search.ts'],
  ['DurableWorkflowStore', 'src/workflows/durable.ts'],
  ['normalizeFabricConfig', 'src/config.ts'],
];
const lat = [];
let hits = 0, rankSum = 0;
for (const [q, expected] of GROUND) {
  const t0 = Date.now();
  const r = codemapOperation('search', { query: q, maxTokens: 4000 }, ROOT);
  lat.push(Date.now() - t0);
  const splitChar = String.fromCharCode(10);
  const rows = r.text.split(splitChar);
  const rank = rows.findIndex((l) => l.includes(expected));
  if (rank >= 0) { hits++; rankSum += rank; ok(q + ' -> ' + expected + ' at row ' + rank); }
  else fail(q + ' -> MISS (expected ' + expected + '), got: ' + rows.slice(0, 3).join(' | ').slice(0, 160));
}
console.log('recall ' + hits + '/' + GROUND.length + ' | mean rank ' + (hits ? (rankSum / hits).toFixed(1) : 'n/a'));
console.log('search latency p50 ' + pct(lat, 0.5) + 'ms p95 ' + pct(lat, 0.95) + 'ms max ' + Math.max(...lat) + 'ms');

console.log('');
console.log('=== 3. TOKEN BUDGET ENFORCEMENT ===');
for (const budget of [100, 500, 1000, 4000, 20000]) {
  for (const op of ['skeleton', 'search', 'expand']) {
    const args = { maxTokens: budget };
    if (op === 'search') args.query = 'config';
    if (op === 'expand') args.entities = ['buildCodeGraph:src/codemap/build.ts'];
    const r = codemapOperation(op, args, ROOT);
    if (r.tokens > budget) fail(op + ' @' + budget + ' returned ' + r.tokens + ' tokens');
    else ok(op + ' @' + budget + ' -> ' + r.tokens + ' tokens' + (r.truncated ? ' (truncated)' : ''));
  }
}

console.log('');
console.log('=== 4. HOSTILE / EDGE INPUTS ===');
const nlc = String.fromCharCode(10);
const EDGE = [
  ['empty query', 'search', { query: '', maxTokens: 1000 }],
  ['whitespace query', 'search', { query: '   ', maxTokens: 1000 }],
  ['nonsense query', 'search', { query: 'zzzqqqxxnotarealsymbol', maxTokens: 1000 }],
  ['regex metachars', 'search', { query: '.*+?[](){}|^$', maxTokens: 1000 }],
  ['unicode query', 'search', { query: 'uniicode_symbol_名前', maxTokens: 1000 }],
  ['very long query', 'search', { query: 'a'.repeat(10000), maxTokens: 1000 }],
  ['newline query', 'search', { query: ['line1', 'line2', 'line3'].join(nlc), maxTokens: 1000 }],
  ['null-ish query', 'search', { maxTokens: 1000 }],
  ['expand no entities', 'expand', { entities: [], maxTokens: 1000 }],
  ['expand bogus entity', 'expand', { entities: ['NoSuchSymbol:no/such/file.ts'], maxTokens: 1000 }],
  ['expand malformed key', 'expand', { entities: ['::::'], maxTokens: 1000 }],
  ['expand 200 entities', 'expand', { entities: Array.from({ length: 200 }, (_, i) => 'S' + i + ':src/index.ts'), maxTokens: 2000 }],
  ['expand depth 5 both', 'expand', { entities: ['buildCodeGraph:src/codemap/build.ts'], depth: 5, direction: 'both', maxTokens: 4000 }],
  ['expand upstream', 'expand', { entities: ['runOutline:src/codemap/outline.ts'], direction: 'upstream', depth: 2, maxTokens: 2000 }],
  ['expand downstream', 'expand', { entities: ['runOutline:src/codemap/outline.ts'], direction: 'downstream', depth: 2, maxTokens: 2000 }],
  ['skeleton min budget', 'skeleton', { maxTokens: 100 }],
];
for (const [label, op, args] of EDGE) {
  try {
    const t0 = Date.now();
    const r = codemapOperation(op, args, ROOT);
    const ms = Date.now() - t0;
    if (typeof r.text !== 'string' || typeof r.tokens !== 'number' || !Array.isArray(r.entities)) {
      fail(label + ' -> malformed result shape');
    } else if (args.maxTokens && r.tokens > args.maxTokens) {
      fail(label + ' -> budget overrun ' + r.tokens + '/' + args.maxTokens);
    } else {
      ok(label + ' -> ' + r.tokens + ' tok, ' + r.entities.length + ' entities, ' + ms + 'ms');
    }
  } catch (e) {
    fail(label + ' -> THREW ' + (e && e.message ? e.message : String(e)));
  }
}

console.log('');
console.log('=== 5. DETERMINISM ===');
const first = codemapOperation('search', { query: 'buildCodeGraph', maxTokens: 2000 }, ROOT);
let stable = true;
for (let i = 0; i < 20; i++) {
  const r = codemapOperation('search', { query: 'buildCodeGraph', maxTokens: 2000 }, ROOT);
  if (r.text !== first.text) { stable = false; break; }
}
if (stable) ok('20 repeated searches are deterministic'); else fail('search output is nondeterministic');

console.log('');
console.log(failures === 0 ? 'RESULT: all checks passed' : 'RESULT: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);