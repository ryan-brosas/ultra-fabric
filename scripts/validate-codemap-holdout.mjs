// Held-out validation for the cascade objective. The cascade historyWeight is
// selected on a TRAIN split and reported on a disjoint TEST split. Reference
// points: full ast-grep outline and naive truncation. No grep comparator.
import { execFileSync } from 'node:child_process';
import { extractQueryIdentifiers } from '../dist/codemap/eval.js';
import { runOutline } from '../dist/codemap/outline.js';
import { buildSymbolIndex, buildAllEdges, buildNodeKeys } from '../dist/codemap/symbols.js';
import { anchoredPageRank } from '../dist/codemap/build.js';
import { buildBothAdjacency } from '../dist/codemap/search.js';
import { renderFileSkeleton } from '../dist/codemap/skeleton.js';
import { predictFileCascade } from '../dist/codemap/cascade.js';

const ROOT = process.cwd();
const WINDOW = Number(process.argv.find((a) => a.startsWith('--window='))?.slice(9) ?? 200);
const MAX_FILES = 20;
const BUDGETS = [4000, 8000];

const find = execFileSync('find', ['src', '-name', '*.ts'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).trim().split('\n').filter(Boolean).sort();
const outlineFiles = runOutline(find, { cwd: ROOT });
const outlineByPath = new Map(outlineFiles.map((f) => [f.path, f]));
const index = buildSymbolIndex(outlineFiles);
const edges = buildAllEdges(index, ROOT);
const nodeKeys = buildNodeKeys(index);
const prebuilt = buildBothAdjacency(nodeKeys, edges);
const nameToKeys = new Map();
for (const key of nodeKeys) { const name = key.split(':')[0]; if (!nameToKeys.has(name)) nameToKeys.set(name, []); nameToKeys.get(name).push(key); }
const fileTokens = new Map();
for (const f of find) { const o = outlineByPath.get(f); fileTokens.set(f, o ? Math.ceil(renderFileSkeleton(o).length / 4) : Math.ceil(f.length / 4)); }

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
const train = queries.filter((_, i) => i % 2 === 0);
const test = queries.filter((_, i) => i % 2 === 1);
const trainMsgs = new Set(train.map((q) => q.msg));
let overlap = 0; for (const q of test) if (trainMsgs.has(q.msg)) overlap++;

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
  const order = dedupe(ranked); for (const f of find) if (!order.includes(f)) order.push(f); return order;
};
const cascadeCache = new Map();
const cascadeOrder = (q, hw) => {
  if (q.idents.length === 0) return [...find];
  const anchors = q.idents.flatMap((id) => nameToKeys.get(id) ?? []);
  if (anchors.length === 0) return [...find];
  const seedFile = anchors[0].split(':').slice(1).join(':');
  const ck = seedFile + '@' + hw;
  if (!cascadeCache.has(ck)) {
    const preds = predictFileCascade(seedFile, { cwd: ROOT, historyWeight: hw, maxCommits: 10 });
    const order = [seedFile, ...preds.map((p) => p.file)]; for (const f of find) if (!order.includes(f)) order.push(f);
    cascadeCache.set(ck, order);
  }
  return cascadeCache.get(ck);
};
const scoreOrder = (order, truth) => {
  const orderSet = new Set(order); const truthSet = new Set(truth);
  const reachable = truth.filter((f) => orderSet.has(f)); const reachableSet = new Set(reachable);
  let cum = 0, covered = 0;
  const recallAt = (B) => { if (!truth.length) return 0; let c = 0, t = 0; for (const f of order) { t += fileTokens.get(f) ?? 0; if (t > B) break; if (truthSet.has(f)) c++; } return c / truth.length; };
  let ttc = reachable.length === 0 ? 0 : Infinity;
  for (const f of order) { cum += fileTokens.get(f) ?? 0; if (reachableSet.has(f)) covered++; if (reachable.length > 0 && covered === reachable.length) { ttc = cum; break; } }
  return { r4: recallAt(BUDGETS[0]), r8: recallAt(BUDGETS[1]), ttc };
};
const scoreArm = (qs, orderFn) => {
  let r4 = 0, r8 = 0, ttc = 0, n = 0;
  for (const q of qs) { const s = scoreOrder(orderFn(q), q.files); r4 += s.r4; r8 += s.r8; ttc += Number.isFinite(s.ttc) ? s.ttc : 0; n++; }
  return { r4: r4 / (n || 1), r8: r8 / (n || 1), ttc: ttc / (n || 1) };
};

// Sweep historyWeight on TRAIN only (test is never read here).
let best = null;
for (const hw of [0, 0.25, 0.5, 0.75, 1]) {
  const s = scoreArm(train, (q) => cascadeOrder(q, hw));
  const obj = s.r4 + s.r8;
  if (!best || obj > best.obj) best = { hw, s, obj };
}
// Freeze and report on TEST.
const testCascade = scoreArm(test, (q) => cascadeOrder(q, best.hw));
const testGraph = scoreArm(test, graphOrder);
const testNaive = scoreArm(test, () => [...find]);

console.log('Queries: ' + queries.length + ' total, ' + train.length + ' train, ' + test.length + ' test, overlap ' + overlap);
console.log('TRAIN-selected historyWeight=' + best.hw + ' (train cascade R@4K=' + best.s.r4.toFixed(3) + ' R@8K=' + best.s.r8.toFixed(3) + ')');
console.log('');
console.log('=== HELD-OUT TEST SPLIT ===');
console.log('| Arm      | Recall@4K | Recall@8K | Tokens-to-cover |');
console.log('|----------|-----------|-----------|-----------------|');
for (const [name, a] of [['naive', testNaive], ['graph', testGraph], ['cascade', testCascade]]) console.log('| ' + name.padEnd(8) + ' | ' + a.r4.toFixed(3) + '     | ' + a.r8.toFixed(3) + '     | ' + Math.round(a.ttc).toString().padStart(15) + ' |');
