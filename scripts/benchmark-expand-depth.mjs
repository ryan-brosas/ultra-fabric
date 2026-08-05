import { execFileSync } from 'node:child_process';
import { extractQueryIdentifiers } from '../dist/codemap/eval.js';
import { getCodeGraph, codemapOperation } from '../dist/codemap/tool.js';

const ROOT = process.cwd();
const WINDOW = 300;
const MAX_FILES = 20;
const DEPTHS = [1, 2, 3];

const find = execFileSync('find', ['src', '-name', '*.ts'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).trim().split('\n').filter(Boolean).sort();
const graph = getCodeGraph(ROOT);
const nodeKeys = graph.graph.nodeKeys;
const nameToKeys = new Map();
for (const key of nodeKeys) { const name = key.split(':')[0]; if (!nameToKeys.has(name)) nameToKeys.set(name, []); nameToKeys.get(name).push(key); }

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
console.error('Queries: ' + queries.length);

const results = { 1: { tokens: 0, covered: 0, total: 0 }, 2: { tokens: 0, covered: 0, total: 0 }, 3: { tokens: 0, covered: 0, total: 0 } };

for (const q of queries) {
  if (q.idents.length === 0) continue;
  const entities = q.idents.flatMap((id) => nameToKeys.get(id) ?? []);
  if (entities.length === 0) continue;
  for (const depth of [1, 2, 3]) {
    const r = codemapOperation('expand', { entities: entities.slice(0, 10), depth, direction: 'both', maxTokens: 8000 }, ROOT);
    results[depth].tokens += r.tokens;
    results[depth].total += q.files.length;
    for (const f of q.files) { if (r.text.includes(f)) results[depth].covered++; }
  }
}

const N = queries.filter(q => q.idents.length > 0).length;
console.log('\nExpand depth sweep: ' + N + ' commits with valid anchors');
console.log('| Depth | Mean coverage | Mean tokens | Cov per 1K tok |');
console.log('|-------|---------------|-------------|----------------|');
for (const depth of [1, 2, 3]) {
  const r = results[depth];
  const mc = r.total > 0 ? (r.covered / r.total).toFixed(3) : '0.000';
  const mt = (r.tokens / N).toFixed(0);
  const cpt = r.tokens > 0 ? ((r.covered / r.tokens) * 1000).toFixed(1) : '0.0';
  console.log('| ' + depth + '      | ' + mc.padStart(13) + ' | ' + mt.padStart(11) + ' | ' + cpt.padStart(14) + ' |');
}