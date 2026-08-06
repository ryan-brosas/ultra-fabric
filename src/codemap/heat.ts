// Heat diffusion over the conductance graph.
//
// L = I - D^{-1/2} W D^{-1/2} (symmetric normalized Laplacian, spectrum [0,2]).
// The field of an interest vector s at diffusion time t is v(t) = e^{-tL} s.
// Small t: heat sits near the seeds. Larger t: it spreads along
// high-conductance edges until the whole subsystem is warm.
//
// Adapted from pi-fovea (https://github.com/monotykamary/pi-fovea) — MIT license.
// Evaluates e^{-tL} by Chebyshev expansion: rescale M = L - I (spectrum [-1,1]);
// then e^{-tL} = e^{-t} [ I_0(t) T_0(M) + 2 * sum_{k>=1} (-1)^k I_k(t) T_k(M) ].

import type { RankEdge } from "./rank.js";

export interface Csr {
  n: number;
  rowPtr: Uint32Array;
  col: Uint32Array;
  w: Float64Array;
  deg: Float64Array;
}

// Build symmetric CSR from directed-ish RankEdge[] using max conductance per pair.
// nodeKeys maps name:file keys to indices 0..n-1.
export const buildHeatCsr = (nodeKeys: readonly string[], edges: readonly RankEdge[]): Csr => {
  const keyToIdx = new Map<string, number>();
  for (let i = 0; i < nodeKeys.length; i++) keyToIdx.set(nodeKeys[i]!, i);
  const n = nodeKeys.length;
  const best = new Map<string, number>();
  for (const e of edges) {
    const ai = keyToIdx.get(e.from);
    const bi = keyToIdx.get(e.to);
    if (ai === undefined || bi === undefined || ai === bi) continue;
    const key = ai < bi ? `${ai}|${bi}` : `${bi}|${ai}`;
    best.set(key, Math.max(best.get(key) ?? 0, e.weight));
  }
  const pairs: Array<[number, number, number]> = [];
  for (const [key, w] of best) {
    const [a, b] = key.split("|").map(Number) as [number, number];
    pairs.push([a, b, w]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const counts = new Uint32Array(n);
  for (const [a, b] of pairs) { counts[a]!++; counts[b]!++; }
  const rowPtr = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i]! + counts[i]!;
  const col = new Uint32Array(rowPtr[n]!);
  const w = new Float64Array(rowPtr[n]!);
  const cursor = new Uint32Array(n);
  for (let i = 0; i < n; i++) cursor[i] = rowPtr[i]!;
  for (const [a, b, ew] of pairs) {
    col[cursor[a]!] = b; w[cursor[a]!] = ew; cursor[a]!++;
    col[cursor[b]!] = a; w[cursor[b]!] = ew; cursor[b]!++;
  }
  const deg = new Float64Array(n);
  for (const [a, b, ew] of pairs) { deg[a]! += ew; deg[b]! += ew; }
  return { n, rowPtr, col, w, deg };
};

// y = -P~ x where P~ = D^{-1/2} W D^{-1/2}. Isolated nodes (deg 0) map to themselves.
const applyNegP = (csr: Csr, x: Float64Array): Float64Array => {
  const { n, rowPtr, col, w, deg } = csr;
  const invSqrt = new Float64Array(n);
  for (let i = 0; i < n; i++) invSqrt[i] = deg[i]! > 0 ? 1 / Math.sqrt(deg[i]!) : 0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const s = rowPtr[i]!;
    const e = rowPtr[i + 1]!;
    for (let p = s; p < e; p++) acc += w[p]! * invSqrt[col[p]!]! * x[col[p]!]!;
    y[i] = -invSqrt[i]! * acc;
  }
  return y;
};

// Modified Bessel function I_k(t) via log-space series.
export const besselI = (k: number, t: number): number => {
  if (t === 0) return k === 0 ? 1 : 0;
  if (t < 1e-8) return k === 0 ? 1 : 0;
  const logHalf = Math.log(t / 2);
  let logSum = Number.NEGATIVE_INFINITY;
  const logGamma = gammaLn;
  for (let m = 0; m < 400; m++) {
    const logTerm = (2 * m + k) * logHalf - logGamma(m + 1) - logGamma(m + k + 1);
    if (logTerm < logSum - 40 && m > k) break;
    logSum = logAddExp(logSum, logTerm);
  }
  return Math.exp(logSum);
};

const logAddExp = (a: number, b: number): number => {
  if (a === Number.NEGATIVE_INFINITY) return b;
  if (b === Number.NEGATIVE_INFINITY) return a;
  const hi = Math.max(a, b);
  return hi + Math.log(Math.exp(a - hi) + Math.exp(b - hi));
};

// Stirling-series log-gamma (Lanczos-free).
const gammaLn = (x: number): number => {
  const c = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6,
    1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
  const z = x - 1;
  let acc = c[0]!;
  for (let i = 1; i < c.length; i++) acc += c[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
};

export const chooseOrder = (t: number): number => Math.min(90, Math.ceil(2.2 * t) + 16);

// Chebyshev coefficient c_k(t) of e^{-tL} under M = L - I.
const heatCoeff = (k: number, t: number): number => {
  const base = Math.exp(-t) * besselI(k, t);
  if (k === 0) return base;
  return 2 * (k % 2 === 0 ? 1 : -1) * base;
};

// Chebyshev evaluation vectors: tk[k] = T_k(M) s.
export const chebyshevVectors = (csr: Csr, s: Float64Array, K: number): Float64Array[] => {
  const tk: Float64Array[] = new Array(K + 1);
  tk[0] = Float64Array.from(s);
  if (K >= 1) tk[1] = applyNegP(csr, tk[0]!);
  for (let k = 2; k <= K; k++) {
    const prev = tk[k - 1]!;
    const mv = applyNegP(csr, prev);
    const out = new Float64Array(csr.n);
    const p2 = tk[k - 2]!;
    for (let i = 0; i < csr.n; i++) out[i] = 2 * mv[i]! - p2[i]!;
    tk[k] = out;
  }
  return tk;
};

export const heatField = (tk: Float64Array[], t: number, n: number): Float64Array => {
  const K = tk.length - 1;
  const v = new Float64Array(n);
  for (let k = 0; k <= K; k++) {
    const c = heatCoeff(k, t);
    if (Math.abs(c) < 1e-16) continue;
    const vec = tk[k]!;
    for (let i = 0; i < n; i++) v[i]! += c * vec[i]!;
  }
  return v;
};

// One-shot convenience: field at time t with internally chosen order.
export const heatAt = (csr: Csr, s: Float64Array, t: number): Float64Array => {
  const K = chooseOrder(t);
  return heatField(chebyshevVectors(csr, s, K), t, csr.n);
};

// Reference implementation for tests: e^{-tL} via scaling-and-squaring Taylor.
export const taylorReference = (csr: Csr, s: Float64Array, t: number): Float64Array => {
  const m = Math.max(0, Math.ceil(Math.log2(t / 0.5)));
  const tau = t / 2 ** m;
  const lpApply = (x: Float64Array): Float64Array => {
    const neg = applyNegP(csr, x);
    const out = new Float64Array(csr.n);
    for (let i = 0; i < csr.n; i++) out[i] = x[i]! + neg[i]!;
    return out;
  };
  const expTauApply = (x: Float64Array): Float64Array => {
    const y = Float64Array.from(x);
    let term: Float64Array = Float64Array.from(x);
    let factor = 1;
    for (let k = 0; k < 80; k++) {
      const next = lpApply(term);
      for (let i = 0; i < csr.n; i++) next[i]! *= -tau;
      term = next;
      factor /= k + 1;
      if (k > 2 && Math.abs(factor) * 8 < 1e-18) break;
      for (let i = 0; i < csr.n; i++) y[i]! += factor * term[i]!;
    }
    return y;
  };
  let v: Float64Array = Float64Array.from(s);
  for (let i = 0; i < 2 ** m; i++) v = expTauApply(v);
  return v;
};
