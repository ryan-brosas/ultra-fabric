// AST-native benchmark. Objective: tokens-to-cover (tokens spent before a
// commit's changed files are all revealed) and cascade recall at fixed 4K/8K
// token budgets, for three file orderings. Reference point: the full ast-grep
// outline (~55K tokens). No grep comparator (see docs/code-map-research.md sec 9).
import { execFileSync } from 'node:child_process';
import { extractQueryIdentifiers } from '../dist/codemap/eval.js';
import { runOutline } from '../dist/codemap/outline.js';
import { buildSymbolIndex, buildAllEdges, buildNodeKeys } from '../dist/codemap/symbols.js';
import { anchoredPageRank } from '../dist/codemap/build.js';
import { buildBothAdjacency } from '../dist/codemap/search.js';
import { renderFileSkeleton } from '../dist/codemap/skeleton.js';
import { predictFileCascade } from '../dist/codemap/cascade.js';

const ROOT = process.cwd();
const WINDOW = Number(process.argv.find((a) => a.startsWith('--window='))?.slice(9) ?? 300);
const MAX_FILES = 20;
const BUDGETS = [4000, 8000];
const wantJson = process.argv.includes('--json');

const find = execFileSync('find', ['src', '-name', '*.ts'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).trim().split('\n').filter(Boolean).sort();
const outlineFiles = runOutline(find, { cwd: ROOT });
const outlineByPath = new Map(outlineFiles.map((f) => [f.path, f]));
const index = buildSymbolIndex(outlineFiles);
const edges = buildAllEdges(index, ROOT);
const nodeKeys = buildNodeKeys(index);
const prebuilt = buildBothAdjacency(nodeKeys, edges);
const nameToKeys = new Map();
for (const key of nodeKeys) { const name = key.split(':')[0]; if (!nameToKeys.has(name)) nameToKeys.set(name, []); nameToKeys.get(name).push(key); }

// Per-file skeleton token cost and the full-outline reference (raw ast-grep outline).
const fileTokens = new Map();
for (const f of find) { const o = outlineByPath.get(f); fileTokens.set(f, o ? Math.ceil(renderFileSkeleton(o).length / 4) : Math.ceil(f.length / 4)); }
const rawOutlineChars = execFileSync('ast-grep', ['outline', ...find], { encoding: 'utf8', cwd: ROOT, maxBuffer: 50 * 1024 * 1024 }).length;
const fullOutlineTokens = Math.ceil(rawOutlineChars / 4);

const hashes = execFileSync('git', ['log', '--format=%H', '-' + WINDOW], { encoding: 'utf8', cwd: ROOT }).trim().split('\n').filter(Boolean);
const queries = [];
for (const hash of hashes) {
  const parents = execFileSync('git', ['show', '--no-patch', '--format=%P', hash], { encoding: 'utf8', cwd: ROOT }).trim();
  if (parents.split('\n').length > 1) continue;
  const msg = execFileSync('git', ['show', '--no-patch', '--format=%s', hash], { encoding: 'utf8', cwd: ROOT }).trim();
  const files = execFileSync('git', ['show', '--name-only', '--format=', hash], { encoding: 'utf8', cwd: ROOT }).trim().split('\n').filter(Boolean).filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
  if (files.length === 0 || files.length > MAX_FILES) continue;
  queries.push({ msg, files, idents: extractQueryIdentifiers(msg) });
}
console.log('Queries: ' + queries.length + ' | full-outline reference: ' + fullOutlineTokens + ' tokens (' + Math.round(rawOutlineChars / 1024) + ' KB)');

const dedupe = (rankedKeys) => {
  const files = rankedKeys.map((k) => k.split(':').slice(1).join(':'));
  const seen = new Set();
  return files.filter((f) => { if (seen.has(f)) return false; seen.add(f); return true; });
};
const graphOrder = (q) => {
  if (q.idents.length === 0) return [...find];
  const anchors = q.idents.flatMap((id) => nameToKeys.get(id) ?? []);
  if (anchors.length === 0) return [...find];
  const ranked = [...anchoredPageRank(nodeKeys, edges, anchors, { depth: 1, prebuilt, personalize: anchors, maxIterations: 30, maxSubgraph: 200 }).entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const order = dedupe(ranked);
  for (const f of find) if (!order.includes(f)) order.push(f);
  return order;
};
const cascadeCache = new Map();
const cascadeOrder = (q) => {
  if (q.idents.length === 0) return [...find];
  const anchors = q.idents.flatMap((id) => nameToKeys.get(id) ?? []);
  if (anchors.length === 0) return [...find];
  const seedFile = anchors[0].split(':').slice(1).join(':');
  if (!cascadeCache.has(seedFile)) {
    const preds = predictFileCascade(seedFile, { cwd: ROOT, historyWeight: 0.5, maxCommits: 10 });
    const order = [seedFile, ...preds.map((p) => p.file)];
    for (const f of find) if (!order.includes(f)) order.push(f);
    cascadeCache.set(seedFile, order);
  }
  return cascadeCache.get(seedFile);
};

// For an ordered file list, compute recall@budget and tokens-to-cover.
const scoreOrder = (order, truth) => {
  const orderSet = new Set(order);
  const truthSet = new Set(truth);
  const reachable = truth.filter((f) => orderSet.has(f));
  const reachableSet = new Set(reachable);
  let cum = 0;
  let covered = 0;
  const recallAt = (B) => {
    if (truth.length === 0) return 0;
    let c = 0, t = 0;
    for (const f of order) { t += fileTokens.get(f) ?? 0; if (t > B) break; if (truthSet.has(f)) c++; }
    return c / truth.length;
  };
  let tokensToCover = reachable.length === 0 ? 0 : Infinity;
  for (const f of order) {
    cum += fileTokens.get(f) ?? 0;
    if (reachableSet.has(f)) covered++;
    if (reachable.length > 0 && covered === reachable.length) { tokensToCover = cum; break; }
  }
  return { r4: recallAt(BUDGETS[0]), r8: recallAt(BUDGETS[1]), ttc: tokensToCover };
};

const arms = {
  naive: (q) => [...find],
  graph: graphOrder,
  cascade: cascadeOrder,
};
const agg = { naive: { r4: 0, r8: 0, ttc: 0 }, graph: { r4: 0, r8: 0, ttc: 0 }, cascade: { r4: 0, r8: 0, ttc: 0 } };
const perQuery = [];
for (const q of queries) {
  const row = { msg: q.msg, truth: q.files };
  for (const [name, fn] of Object.entries(arms)) {
    const s = scoreOrder(fn(q), q.files);
    agg[name].r4 += s.r4; agg[name].r8 += s.r8; agg[name].ttc += s.ttc;
    row[name] = s;
  }
  perQuery.push(row);
}
const n = queries.length || 1;
for (const a of Object.values(agg)) { a.r4 /= n; a.r8 /= n; a.ttc /= n; }

if (wantJson) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/codemap-bench.json', JSON.stringify({ queries: queries.length, fullOutlineTokens, budgets: BUDGETS, agg, perQuery }, null, 1));
  console.log('Wrote /tmp/codemap-bench.json');
}

const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toString() : 'inf');
console.log('');
console.log('=== AST CODEMAP BENCHMARK (tokens-to-cover + cascade recall) ===');
console.log('| Arm      | Recall@4K | Recall@8K | Tokens-to-cover |');
console.log('|----------|-----------|-----------|-----------------|');
for (const [name, a] of Object.entries(agg)) console.log('| ' + name.padEnd(8) + ' | ' + a.r4.toFixed(3) + '     | ' + a.r8.toFixed(3) + '     | ' + fmt(a.ttc).padStart(15) + ' |');
console.log('');
console.log('Full-outline reference: ' + fullOutlineTokens + ' tokens (lower tokens-to-cover is better; Recall@B higher is better).');
