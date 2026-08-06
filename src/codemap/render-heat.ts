// Relevance-ranked renderer: hot/warm/glow tiers from a heat-diffusion field.
// Adapted generously from pi-fovea (https://github.com/monotykamary/pi-fovea) — MIT license.

const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);

const HOT_TIER = 0.3;
const WARM_TIER = 0.02;
const HEAT_EPS = 1e-9;

export interface RenderNode {
  id: string;      // node key like "name:file"
  name: string;
  kind: string;    // symbol type
  file: string;
  line: number;
  sig: string;     // one-line signature
}

export interface HeatRenderResult {
  text: string;
  tokens: number;
  shown: number;      // individually rendered nodes
  suppressed: number; // skipped because already disclosed
  litTotal: number;   // candidates above threshold before suppression
  truncated: boolean;
  revealedIds: string[];
}

// Sort by field descending, then file/line/name for stability.
const cmpNodes = (nodes: RenderNode[], field: Float64Array) => (x: number, y: number): number => {
  const f = field[y]! - field[x]!;
  if (f !== 0) return f;
  const a = nodes[x]!;
  const b = nodes[y]!;
  return a.file === b.file ? (a.line - b.line || a.name.localeCompare(b.name)) : a.file < b.file ? -1 : 1;
};

export interface HeatRenderOptions {
  header?: string;
  disclosed?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
  budget: number;
  maxCandidates?: number;
}

export const renderHeatField = (
  nodes: RenderNode[],
  field: Float64Array,
  opts: HeatRenderOptions,
): HeatRenderResult => {
  let vmax = 0;
  for (let i = 0; i < field.length; i++) if (field[i]! > vmax) vmax = field[i]!;
  if (vmax <= 0) {
    return {
      text: `${opts.header ?? "codemap"}\n(nothing lit — field is zero)`,
      tokens: 0, shown: 0, suppressed: 0, litTotal: 0, truncated: false, revealedIds: [],
    };
  }
  const candidates: number[] = [];
  let suppressed = 0;
  for (let i = 0; i < nodes.length; i++) {
    const h = field[i]! / vmax;
    if (h < WARM_TIER * 0.1 || field[i]! < HEAT_EPS) continue;
    const id = nodes[i]!.id;
    if (opts.exclude?.has(id)) continue;
    if (opts.disclosed?.has(id)) { suppressed++; continue; }
    candidates.push(i);
  }
  candidates.sort(cmpNodes(nodes, field));
  const cap = opts.maxCandidates ?? 400;
  const capped = candidates.slice(0, cap);
  const litTotal = capped.length;

  // Build lines: hot = full signatures, warm = one-liners, glow = per-file counts
  const glowCounts = new Map<string, number>();
  const lines: string[] = [];
  const ids: string[] = [];
  for (const i of capped) {
    const n = nodes[i]!;
    const h = field[i]! / vmax;
    if (h >= HOT_TIER) {
      lines.push(`▲ ${n.file}:${n.line}  ${n.sig}`);
      ids.push(n.id);
    } else if (h >= WARM_TIER) {
      lines.push(`  · ${n.name} (${n.kind}) ${n.file}:${n.line}`);
      ids.push(n.id);
    } else {
      glowCounts.set(n.file, (glowCounts.get(n.file) ?? 0) + 1);
    }
  }
  const glowLines = [...glowCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file, c]) => `  ~ + ${c} more in ${file}`);
  const items = [...lines, ...glowLines];
  const individual = lines.length;

  const header = `${opts.header ?? "codemap"} · lit ${litTotal}${suppressed ? `, ${suppressed} seen` : ""}`;
  const renderK = (k: number): string => {
    const shownIndiv = Math.min(k, individual);
    const remaining = litTotal - shownIndiv;
    const footer = remaining > 0
      ? `\n… ${remaining} lit below threshold — call dwell to expand (t grows, periphery sharpens)`
      : "";
    return header + "\n" + items.slice(0, k).join("\n") + footer;
  };

  const fits = (k: number): boolean => tokenEstimate(renderK(k)) <= opts.budget;
  let k = items.length;
  if (!fits(k)) {
    let lo = 0;
    let hi = items.length - 1;
    k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!fits(0)) k = -1;
  }
  const text = k >= 0 ? renderK(k) : header;
  const tokens = tokenEstimate(text);
  const shown = k >= 0 ? Math.min(k, individual) : 0;
  return {
    text, tokens, shown, suppressed, litTotal,
    truncated: shown < individual || (k >= 0 && k < items.length),
    revealedIds: ids.slice(0, shown),
  };
};

// Grouped reveal for sketches and impacts.
export interface GroupLine { label: string; mass: number; detail: string; }

export const renderGroups = (
  groups: GroupLine[],
  opts: { header: string; budget: number },
): HeatRenderResult => {
  const ordered = [...groups].sort((a, b) => b.mass - a.mass || (a.label < b.label ? -1 : 1));
  const renderK = (k: number): string => {
    const body = ordered.slice(0, k).map((gl) => `${gl.label.padEnd(2)} ${gl.detail}`);
    const rest = ordered.length - k;
    const footer = rest > 0 ? [`\n… ${rest} groups below threshold`] : [];
    return [opts.header, ...body, ...footer].join("\n");
  };
  let hi = ordered.length;
  let best = renderK(hi);
  if (tokenEstimate(best) > opts.budget) {
    let lo = 0;
    best = renderK(0);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const text = renderK(mid);
      if (tokenEstimate(text) <= opts.budget) {
        best = text;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }
  return {
    text: best,
    tokens: tokenEstimate(best),
    shown: Math.min(ordered.length, ordered.length),
    suppressed: 0,
    litTotal: ordered.length,
    truncated: best.split("\n").some((l) => l.startsWith("…")),
    revealedIds: [],
  };
};
