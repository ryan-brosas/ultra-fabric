export type EdgeKind = "contains" | "imports" | "invokes" | "inherits";

export interface RankEdge {
  from: string;
  to: string;
  weight: number;
  kind: EdgeKind;
}

export const computeEdgeWeight = (
  ident: string,
  numRefs: number,
  isMentioned: boolean,
  isChatReferencer: boolean,
  definerCount: number,
): number => {
  let mul = 1.0;
  if (isMentioned) mul *= 10;
  const isSnake = ident.includes("_") && /[a-z]/i.test(ident);
  const isKebab = ident.includes("-") && /[a-z]/i.test(ident);
  const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
  if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
  if (ident.startsWith("_")) mul *= 0.1;
  if (definerCount > 5) mul *= 0.1;
  if (isChatReferencer) mul *= 50;
  return mul * Math.sqrt(numRefs);
};

export const pageRank = (
  nodes: readonly string[],
  edges: readonly RankEdge[],
  options: {
    damping?: number;
    maxIterations?: number;
    epsilon?: number;
    personalization?: Map<string, number>;
  } = {},
): Map<string, number> => {
  const d = options.damping ?? 0.85;
  const maxIter = options.maxIterations ?? 100;
  const eps = options.epsilon ?? 1e-6;
  const n = nodes.length;
  if (n === 0) return new Map();

  const incoming = new Map<string, RankEdge[]>();
  for (const node of nodes) incoming.set(node, []);
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
  }

  const outWeight = new Map<string, number>();
  for (const edge of edges) {
    outWeight.set(edge.from, (outWeight.get(edge.from) ?? 0) + edge.weight);
  }

  // Build normalized personalization vector (defaults to uniform 1/n).
  // The teleport term uses this vector every iteration, not just as a seed.
  const pers = options.personalization;
  const persVec = new Map<string, number>();
  if (pers && pers.size > 0) {
    let sum = 0;
    for (const v of pers.values()) sum += v;
    if (sum > 0) {
      let hasKey = false;
      for (const node of nodes) {
        const v = pers.get(node) ?? 0;
        if (v > 0) hasKey = true;
        persVec.set(node, v / sum);
      }
      if (!hasKey) {
        // No overlap between personalization keys and node set — fall back to uniform
        for (const node of nodes) persVec.set(node, 1 / n);
      }
    } else {
      for (const node of nodes) persVec.set(node, 1 / n);
    }
  } else {
    for (const node of nodes) persVec.set(node, 1 / n);
  }

  let rank = new Map<string, number>();
  for (const node of nodes) rank.set(node, persVec.get(node) ?? 1 / n);

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map<string, number>();
    // Dangling mass: rank from nodes with no outgoing edges, redistributed by persVec
    let dangling = 0;
    for (const node of nodes) {
      if ((outWeight.get(node) ?? 0) === 0) {
        dangling += rank.get(node) ?? 0;
      }
    }
    for (const node of nodes) {
      const edgesIn = incoming.get(node)!;
      let sum = 0;
      for (const edge of edgesIn) {
        const fromRank = rank.get(edge.from) ?? 0;
        const ow = outWeight.get(edge.from) ?? 0;
        if (ow > 0) sum += (fromRank * edge.weight) / ow;
      }
      const teleport = (1 - d) * (persVec.get(node) ?? 1 / n);
      const dangle = d * dangling * (persVec.get(node) ?? 1 / n);
      next.set(node, teleport + dangle + d * sum);
    }
    let diff = 0;
    for (const node of nodes) {
      diff += Math.abs((next.get(node) ?? 0) - (rank.get(node) ?? 0));
    }
    rank = next;
    if (diff < eps) break;
  }
  return rank;
};
