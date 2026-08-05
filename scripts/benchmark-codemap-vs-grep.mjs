import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { codemapOperation } from '../dist/codemap/tool.js';

const ROOT = process.cwd();
const RE = /^export (const|function|class|interface|type|enum) ([A-Za-z_$][A-Za-z0-9_$]*)/;

const map = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && p.endsWith('.ts')) {
      for (const l of readFileSync(p, 'utf8').split('\n')) {
        const m = l.match(RE);
        if (m) { const n = m[2]; if (!map.has(n)) map.set(n, []); map.get(n).push(p); }
      }
    }
  }
}
walk('src');
const unique = [...map.entries()].filter(([_, v]) => v.length === 1).map(([n, v]) => [n, v[0]]).sort((a, b) => a[0].localeCompare(b[0]));
const stride = Math.max(1, Math.floor(unique.length / 60));
const SAMPLE = unique.filter((_, i) => i % stride === 0).slice(0, 60);
console.error('Ground truth: ' + map.size + ' candidates, ' + unique.length + ' unique, ' + SAMPLE.length + ' sampled');

const results = { codemap: [], grepNaive: [], grepTuned: [] };

for (const [name, file] of SAMPLE) {
  let cmStart = Date.now();
  const r = codemapOperation('search', { query: name, maxTokens: 8000 }, ROOT);
  const cmMs = Date.now() - cmStart;
  const symRe = /([A-Za-z_$][A-Za-z0-9_$]*) \([^)]+\) ([^:]+):(\d+)/g;
  const cmFiles = []; const seen = new Set(); let m;
  while ((m = symRe.exec(r.text)) !== null) { const f = m[2]; if (!seen.has(f)) { seen.add(f); cmFiles.push(f); } }
  results.codemap.push({ name, file, rank: cmFiles.indexOf(file) + 1, files: cmFiles, tokens: r.tokens, ms: cmMs });

  let gnStart = Date.now();
  const gnOut = execFileSync('grep', ['-rln', '--include=*.ts', '\\b' + name + '\\b', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const gnMs = Date.now() - gnStart;
  const gnFiles = gnOut.trim().split('\n').filter(Boolean);
  results.grepNaive.push({ name, file, rank: gnFiles.indexOf(file) + 1, files: gnFiles, tokens: Math.ceil(gnOut.trim().length / 4), ms: gnMs });

  let gtStart = Date.now();
  const gtOut = execFileSync('grep', ['-rln', '--include=*.ts', '^export .*\\b' + name + '\\b', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const gtMs = Date.now() - gtStart;
  const gtFiles = gtOut.trim().split('\n').filter(Boolean);
  results.grepTuned.push({ name, file, rank: gtFiles.indexOf(file) + 1, files: gtFiles, tokens: Math.ceil(gtOut.trim().length / 4), ms: gtMs });
}

const N = SAMPLE.length;
const cmR1 = results.codemap.filter(r => r.rank === 1).length;
const gnR1 = results.grepNaive.filter(r => r.rank === 1).length;
const gtR1 = results.grepTuned.filter(r => r.rank === 1).length;
const cmR5 = results.codemap.filter(r => r.rank >= 1 && r.rank <= 5).length;
const gnR5 = results.grepNaive.filter(r => r.rank >= 1 && r.rank <= 5).length;
const gtR5 = results.grepTuned.filter(r => r.rank >= 1 && r.rank <= 5).length;
const cmM = results.codemap.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / N;
const gnM = results.grepNaive.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / N;
const gtM = results.grepTuned.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / N;
const cmAT = results.codemap.reduce((s, r) => s + r.tokens, 0) / N;
const gnAT = results.grepNaive.reduce((s, r) => s + r.tokens, 0) / N;
const gtAT = results.grepTuned.reduce((s, r) => s + r.tokens, 0) / N;
const cmAMs = results.codemap.reduce((s, r) => s + r.ms, 0) / N;
const gnAMs = results.grepNaive.reduce((s, r) => s + r.ms, 0) / N;
const gtAMs = results.grepTuned.reduce((s, r) => s + r.ms, 0) / N;
const pct = (arr, p) => { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(Math.min(s.length-1, s.length * p))]; };
const cmTm = results.codemap.map(r=>r.tokens);
const gnTm = results.grepNaive.map(r=>r.tokens);
const gtTm = results.grepTuned.map(r=>r.tokens);
const cmMm = results.codemap.map(r=>r.ms);
const gnMm = results.grepNaive.map(r=>r.ms);
const gtMm = results.grepTuned.map(r=>r.ms);

const fmt = v => typeof v === 'number' ? (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4)) : String(v);
const row = (label, cmV, gnV, gtV, invert) => {
  const best = invert ? Math.min(cmV, gnV, gtV) : Math.max(cmV, gnV, gtV);
  const w = cmV === best && gnV === best ? 'tie' : cmV === best && gtV === best ? 'tie' : cmV === best ? 'codemap' : gnV === best ? 'grep-naive' : 'grep-tuned';
  console.log('| ' + label.padEnd(17) + ' | ' + fmt(cmV).padEnd(15) + ' | ' + fmt(gnV).padEnd(15) + ' | ' + fmt(gtV).padEnd(15) + ' | ' + w.padEnd(14) + ' |');
};

console.log('Benchmark: ' + N + ' exported symbols, each defined in exactly one file');
console.log('| Metric            | Codemap          | Grep-naive       | Grep-tuned       | Winner          |');
console.log('|-------------------|-----------------|-----------------|-----------------|-----------------|');
row('Recall@1', cmR1/N, gnR1/N, gtR1/N, false);
row('Recall@5', cmR5/N, gnR5/N, gtR5/N, false);
row('MRR', cmM, gnM, gtM, false);
row('Avg tokens', cmAT, gnAT, gtAT, true);
row('p50 tokens', pct(cmTm, 0.5), pct(gnTm, 0.5), pct(gtTm, 0.5), true);
row('p95 tokens', pct(cmTm, 0.95), pct(gnTm, 0.95), pct(gtTm, 0.95), true);
row('Avg latency ms', cmAMs, gnAMs, gtAMs, true);
row('p50 latency ms', pct(cmMm, 0.5), pct(gnMm, 0.5), pct(gtMm, 0.5), true);
row('p95 latency ms', pct(cmMm, 0.95), pct(gnMm, 0.95), pct(gtMm, 0.95), true);

// Misses
console.log('\n--- Codemap misses (rank !== 1) ---');
for (const r of results.codemap.filter(a => a.rank !== 1)) {
  console.log('  ' + r.name + ' at ' + r.file + ' rank=' + r.rank + ' top=' + (r.files || []).slice(0, 3).join(', '));
}
console.log('\n--- Grep-naive misses (rank !== 1) ---');
for (const r of results.grepNaive.filter(a => a.rank !== 1)) {
  console.log('  ' + r.name + ' at ' + r.file + ' rank=' + r.rank);
}
console.log('\n--- Grep-tuned misses (rank !== 1) ---');
for (const r of results.grepTuned.filter(a => a.rank !== 1)) {
  console.log('  ' + r.name + ' at ' + r.file + ' rank=' + r.rank);
}
