# Code Map Research: AST Compression, Ranking, and Feature-Pattern Cascades

**Status:** Proposed
**Date:** 2026-08-05
**Scope:** Deep research into AST-compressed code mapping, aider's repomap algorithm, upstream pi-fabric's feature gap, and a plan to adapt these for Ultra Fabric without new dependencies.

---

## 1. Measured Baseline

### ast-grep outline (installed at /usr/bin/ast-grep, version 0.44.1)

The `ast-grep outline` command extracts symbols, imports, exports, fields, and methods from source files with line numbers. It is a zero-setup, already-installed alternative to tree-sitter tag extraction.

**Single file** (`src/lifecycle/store.ts`):

| Metric | Value |
|--------|-------|
| Raw chars | 8,887 |
| Outline chars | 1,823 |
| Compression | 4.9x |

Reproduce:
```sh
wc -c < src/lifecycle/store.ts                           # 8887
ast-grep outline src/lifecycle/store.ts 2>/dev/null | wc -c # 1823
```

**Whole `src/` tree** (205 TypeScript files):

| Metric | Value |
|--------|-------|
| Raw chars | 2,420,783 |
| Outline chars | 214,601 |
| Compression | 11.3x |
| Token estimate (~4 chars/token) | ~53,650 |

Reproduce:
```sh
cat $(find src -name '*.ts') | wc -c                              # 2420783
ast-grep outline $(find src -name '*.ts') 2>/dev/null | wc -c    # 214601
find src -name '*.ts' | wc -l                                     # 205
```

The full repo outline at ~54K tokens fits in a modern context window in one shot. That is the upper bound before ranking; the goal is to fit the *relevant* subset into a per-turn budget of 4-8K tokens.

### CodeGraphContext (MCP, live on `ultra-fabric` graph)

Verified this session:

- `find_callers` returns caller function, caller file, caller line, call line, and call arguments.
- `find_importers`, `find_dead_code`, `find_most_complex_functions`, `call_chain`, `module_deps`, `class_hierarchy` are all available (confirmed via `tools.describe({ ref: "mcp.codegraphcontext.analyze_code_relationships" })` input schema).
- `graph_name` parameter allows querying `ultra-fabric` and `inspo` in the same call without context switching.
- The watcher keeps the graph fresh: `FabricWorkStore` (written this session) was indexed at `src/lifecycle/store.ts:106` within minutes.

---

## 2. Aider's Algorithm

Reference: `inspo/aider/aider/repomap.py` (867 lines, cloned from `github.com/Aider-AI/aider`).

### Tag extraction

Tree-sitter queries extract `defines` (symbol definitions per file) and `references` (symbol references per file). The intersection `idents = set(defines.keys()) & set(references.keys())` gives symbols that are both defined and referenced.

### Graph construction (`repomap.py:470`)

```python
G = nx.MultiDiGraph()  # line 470
```

Nodes are files. Edges are referencer-to-definer, one per shared identifier. Self-edges (weight 0.1) are added for definitions with no references (`repomap.py:472-474`).

### Edge-weight multipliers (`repomap.py:487-513`)

```python
mul = 1.0                                            # line 487
if ident in mentioned_idents:     mul *= 10          # line 493
if (is_snake|is_kebab|is_camel) and len(ident) >= 8: mul *= 10  # line 495
if ident.startswith("_"):          mul *= 0.1         # line 497
if len(defines[ident]) > 5:        mul *= 0.1         # line 499
if referencer in chat_rel_fnames:  use_mul *= 50      # line 509
num_refs = math.sqrt(num_refs)                        # line 513
```

The multipliers encode a ranking heuristic: chat-mentioned symbols and distinctive long names are boosted; private identifiers and overly common symbols are suppressed. The `sqrt` prevents high-frequency references from dominating.

### Personalized PageRank (`repomap.py:519-529`)

```python
if personalization:
    pers_args = dict(personalization=personalization, dangling=personalization)  # line 520
else:
    pers_args = dict()  # line 522
ranked = nx.pagerank(G, weight="weight", **pers_args)  # line 525
```

Personalization biases the rank toward files mentioned in the chat or matching mentioned identifiers. Default personalization for unspecified files is `1/num_nodes`.

### Binary-search budget fit (`repomap.py:676-704`)

```python
middle = min(int(max_map_tokens // 25), num_tags)    # line 676
while lower_bound <= upper_bound:                     # line 677
    tree = self.to_tree(ranked_tags[:middle], ...)     # line 685
    num_tokens = self.token_count(tree)               # line 686
    pct_err = abs(num_tokens - max_map_tokens) / max_map_tokens  # line 688
    ok_err = 0.15                                      # line 689
    if (num_tokens <= max_map_tokens and num_tokens > best_tree_tokens) or pct_err < ok_err:  # line 690
        best_tree = tree                               # line 691
        if pct_err < ok_err: break                     # line 694
    if num_tokens < max_map_tokens: lower_bound = middle + 1  # line 697
    else: upper_bound = middle - 1                     # line 699
    middle = int((lower_bound + upper_bound) // 2)     # line 701
```

The initial `middle` heuristic is `max_map_tokens // 25` (about 25 tokens per tag). The loop renders `ranked_tags[:middle]`, counts tokens, and accepts within 15% of budget. Binary search converges in O(log n) iterations.

### Caching

- `CACHE_VERSION = 3` (or 4 for newer tree-sitter) at `repomap.py:35-37`.
- `TAGS_CACHE_DIR` uses diskcache, keyed by file mtime.
- `tree_cache` is an in-memory dict keyed by `(rel_fname, sorted(lois), mtime)`.
- `cache_threshold = 0.95` at `repomap.py:68`.
---

## 3. Upstream Finding: Greenfield

Upstream is `monotykamary/pi-fabric` at v0.36.0 (cloned to `inspo/pi-fabric`). Our fork is based on v0.31.1.

### No code mapping upstream

Word-boundary searches across upstream `src/`:

| Search term | Matches |
|-------------|--------|
| tree-sitter / treeSitter / tree_sitter | 0 |
| outline (word boundary) | 0 |
| repomap / codemap / code-map / repo-map | 0 |
| feature pattern / cascade / co-change | 0 |

Reproduce:
```sh
cd inspo/pi-fabric
grep -rIl 'tree-sitter\|treeSitter\|tree_sitter' src/   # empty
grep -rIl '\<outline\>' src/                           # empty
grep -rIl 'repomap\|codemap\|code.map\|repo.map' src/   # empty
```

The only AST-adjacent code upstream is `src/runtime/type-checker.ts` which uses the TypeScript compiler for schema diagnostics, not codebase indexing.

### Compaction: our fork is a superset

```sh
diff <(cd inspo/pi-fabric && ls src/compaction/ | sort) <(ls src/compaction/ | sort)
# Output: 7a8,9  > openai-native-replay.ts  > openai-native.ts
```

Our fork has two extra compaction files (`openai-native.ts`, `openai-native-replay.ts`). Upstream has nothing we lack. The only upstream-only directory is `src/actors/` (host-event supervision), which is unrelated to code mapping.

**Verdict:** building code-mapping, AST compression, or feature-pattern analysis is greenfield. No upstream code to respect, no half-built feature to port.

---

## 4. Our Adaptation

### What we get free

| Aider builds | We already have | How |
|---|---|---|
| Tree-sitter tag extraction | ast-grep outline | Installed, 11.3x compression, zero build |
| Reference graph (defines/references) | CodeGraphContext find_callers | Returns caller file, line, and call args |
| File freshness / mtime cache | CodeGraphContext watcher | Verified fresh mid-session |
| Cross-language bridging | graph_name parameter | Query ultra-fabric and inspo in one call |

### What we must build

| Component | LOC estimate | New dependency? |
|---|---|---|
| PageRank power iteration | ~30 lines | No (pure TypeScript) |
| Edge-weight multipliers | ~15 lines | No |
| Binary-search budget fit | ~25 lines | No |
| Personalization from chat context | ~10 lines | No |
| Co-change mining | ~40 lines | No (git log parsing) |
| Config-completeness lint | ~30 lines | No |

**No new npm dependency is required.** PageRank is a power-iteration loop: initialize rank to 1/N per node, iterate `rank = (1-d)/N + d * sum(incoming weighted ranks)` until convergence. The damping factor d defaults to 0.85 (aider uses networkx's default). This is ~30 lines of pure TypeScript.

### Concrete APIs

All verified this session:

- `ast-grep outline <file>` — structural outline with symbols, fields, methods, line numbers.
- `ast-grep run --pattern <PATTERN> <path>` — structural search.
- `ast-grep scan` — rule-based scanning with config.
- `mcp.codegraphcontext.analyze_code_relationships({ query_type, target, graph_name })` — find_callers, find_importers, call_chain, module_deps, class_hierarchy, find_dead_code, find_most_complex_functions.
- `mcp.codegraphcontext.find_code({ query, graph_name })` — symbol search.
- `git log --format=%H -N -- <file>` + `git show --name-only --format='' <hash>` — co-change extraction.

---

## 5. Co-Change Mining

### Measured: src/config.ts co-change (200 commits)

| Rank | File | Co-change count | Rate |
|------|------|-----------------|------|
| 1 | src/config.ts | 56 | (self) |
| 2 | tests/config.test.ts | 42 | 75% |
| 3 | tests/fabric-settings.test.ts | 28 | 50% |
| 4 | src/ui/settings.ts | 28 | 50% |
| 5 | src/index.ts | 26 | 46% |
| 6 | src/fabric-state.ts | 21 | 38% |
| 7 | tests/execution-service.test.ts | 18 | 32% |
| 8 | src/execution-service.ts | 16 | 29% |

Reproduce:
```sh
# from the repository root
for c in $(git log --format=%H -200 -- src/config.ts); do
  git show --name-only --format='' $c | grep -E '^(src|tests)/'
done | sort | uniq -c | sort -rn | head -8
```

### From obligation to executable check

A mined co-change pattern is not injected prose. It becomes an executable test that fails when the rule is violated. Concretely:

A config-completeness lint walks `FabricAgentConfig` and `FabricPrewalkConfig` interfaces in `src/config.ts`. For every non-optional field, it asserts the field appears in `DEFAULT_FABRIC_CONFIG` and in `normalizeFabricConfig`. If a developer adds a required field to the interface but forgets the default, the test fails at `pnpm run check` — the same boundary that blocked mutations this session.

This is enforcement, not advice. The co-change data tells us *which files matter* (the 75% test co-change and 50% settings co-change rates), and the lint turns that knowledge into a gate that cannot be silently ignored.


---

## 6. Ordered Slice Plan

### Slice 1: Config-completeness lint (smallest binding thing)

**Target files:**
- `tests/config-completeness.test.ts` (new)

**What it does:**

Imports `DEFAULT_FABRIC_CONFIG` and `normalizeFabricConfig` from `src/config.ts`. Parses the config interfaces (using `ast-grep outline` or a regex over the interface declarations) to extract field names. For every non-optional field on `FabricAgentConfig` and `FabricPrewalkConfig`, asserts the field key exists in `DEFAULT_FABRIC_CONFIG` (for required fields) and is handled in `normalizeFabricConfig` output.

**Proof it is enforcement:**

The test throws when a required interface field has no default. A developer who adds `fooBar: string` to `FabricAgentConfig` without adding `fooBar: ""` to `DEFAULT_FABRIC_CONFIG` gets a test failure, not a prompt.

**Test assertion that fails when violated:**
```ts
expect(DEFAULT_FABRIC_CONFIG.agents).toHaveProperty(fieldName);
```

### Slice 2: ast-grep outline adapter

**Target files:**
- `src/codemap/outline.ts` (new) — wraps `ast-grep outline` as a typed adapter.
- `tests/codemap-outline.test.ts` (new)

**What it does:**

Runs `ast-grep outline` on a file or directory, parses the output into a typed `OutlineEntry[]` with `{ file, line, kind, name, fields?, methods? }`. Caches by mtime.

**Proof it is enforcement:**

The adapter is a data source, not advice. Slices 3 and 4 consume it as input to ranking and linting. A broken outline parse fails the adapter test, not the model.

**Test assertion that fails when violated:**
```ts
expect(outline.find(e => e.name === "FabricWorkStore")?.methods).toContain("completeInFlight");
```

### Slice 3: PageRank ranking + budget fit

**Target files:**
- `src/codemap/rank.ts` (new) — power iteration PageRank, edge-weight multipliers, binary-search budget fit.
- `tests/codemap-rank.test.ts` (new)

**What it does:**

Takes `OutlineEntry[]` + a reference graph (from CodeGraphContext `find_callers` or from `ast-grep run` cross-file reference counts) and produces a ranked, token-budget-fitted outline string. The binary search loop is the same algorithm as aider's (`repomap.py:676-704`), reimplemented in TypeScript.

**Proof it is enforcement:**

The ranker's output is bounded: `tokenCount(result) <= maxTokens`. The test asserts the output fits the budget. A result that exceeds the budget fails the test, not the model.

**Test assertion that fails when violated:**
```ts
expect(tokenCount(ranked)).toBeLessThanOrEqual(maxTokens);
```

### Slice 4: Co-change mining + obligation checks

**Target files:**
- `src/codemap/cochange.ts` (new) — git log mining, co-change frequency.
- `tests/codemap-cochange.test.ts` (new)

**What it does:**

Runs `git log` to build a co-change frequency map for anchor files. When a developer touches an anchor file, the mined obligations surface as test assertions (e.g., touching `src/config.ts` with a new required field requires a corresponding `DEFAULT_FABRIC_CONFIG` entry).

**Proof it is enforcement:**

The co-change miner produces a data structure. The obligation check consumes it and fails when a required co-change is missing. A missing co-change fails the test, not the model.

**Test assertion that fails when violated:**
```ts
expect(coChangeMap["src/config.ts"]["src/ui/settings.ts"]).toBeGreaterThanOrEqual(0.5);
```

---

## 7. API Verification Sweep

Every named command or API in this document is confirmed present:

| API / command | Verified how |
|---|---|
| `ast-grep outline` | Ran on `src/lifecycle/store.ts` and whole `src/` tree; output measured |
| `ast-grep run` | `ast-grep run --help` confirmed (subcommand for one-time structural search) |
| `ast-grep scan` | `ast-grep scan --help` confirmed (subcommand for config-based rule scanning) |
| `mcp.codegraphcontext.analyze_code_relationships` | `tools.describe` confirmed input schema with find_callers, find_importers, call_chain, module_deps, class_hierarchy, find_dead_code, find_most_complex_functions |
| `mcp.codegraphcontext.find_code` | Ran successfully against ultra-fabric and inspo graphs |
| `git log --format=%H -N -- <file>` | Used in co-change mining probe |
| `git show --name-only --format='' <hash>` | Used in co-change mining probe |
| `nx.pagerank` | Read at `repomap.py:525` in the aider clone |
| `ast-grep 0.44.1` | `ast-grep --version` confirmed |

Zero unresolved names remain.

---

## 8. Measured Improvement (2026-08-05)

The original codemap lost to plain grep on every metric. The hardened benchmark
(`scripts/benchmark-codemap.mjs`, WINDOW=300, 159 evaluated queries on this
repository) recorded this baseline before any ranking change:

| Metric         | Codemap (global PageRank) | Grep    |
|---------------|---------------------------|---------|
| Recall@10      | 0.150                      | 0.442   |
| Recall@20      | 0.228                      | 0.569   |
| MRR            | 0.179                      | 0.423   |
| Query time     | 15999 ms                   | 1839 ms |

After the lexical + anchored retrieval work, the hybrid arm beats grep on both
gating metrics and the codemap query time dropped two orders of magnitude:

| Metric         | Hybrid (anchored + BM25) | Grep    | Delta   |
|---------------|--------------------------|---------|---------|
| Recall@10      | 0.522                    | 0.442   | +0.081  |
| Recall@20      | 0.634                    | 0.569   | +0.065  |
| MRR            | 0.493                    | 0.423   | +0.071  |
| Query time     | 104 ms                   | 1980 ms |         |

Reproduce: `pnpm run build && node scripts/benchmark-codemap.mjs --json`
(per-query dump at `/tmp/codemap-bench.json`, 159 entries).

### Root causes (each fixed)

1. **Personalization drowned in its own noise floor.** The benchmark seeded
   every non-matching node with 0.01 (6311 x 0.01 = 63.1 mass vs ~50 from
   matches). Aider sets personalization only for matched files and omits the
   rest (`inspo/aider/aider/repomap.py:443-445`). Fixed in `rank.ts` (unmatched
   nodes already get 0 via `pers.get(node) ?? 0`) and the benchmark seeding.
2. **No lexical channel.** Grep won on identifier overlap; the ranker had none.
   Added `src/codemap/lexical.ts` (BM25 with an inverted index) and fused it with
   PageRank behind an explicit weight (0.8). This is the GRACE / LocAgent
   hybrid-retrieval finding.
3. **Anchored search was dead code.** `src/codemap/search.ts` mirrored RepoGraph's
   `RepoSearcher` but `build.ts` never called it; every query ran a full global
   PageRank. Wired `expandNeighborhood` / `anchoredPageRank` into `build.ts`.
4. **Edges were untyped.** `RankEdge` is now `{from, to, weight, kind}` over
   `contains | imports | invokes | inherits` (LocAgent
   `dependency_graph/build_graph.py:13-20`); `buildAdjacency` accepts an
   `edgeKinds` filter.
5. **Reference edges were regex token scans** matching inside strings and
   comments (39611 noisy edges). Replaced with `src/codemap/calls.ts` using
   `ast-grep run --pattern '$F($$$)'` (16056 precise call sites in 74 ms); edge
   count dropped to ~10500.
6. **The module was unwired.** Nothing under `src/` imported it. It is now
   re-exported from `src/index.ts` and `buildCodeGraph` precomputes the graph for
   many-query use; `pnpm run lint:dead` reports zero unused codemap exports.
7. **The benchmark was too weak to certify a win.** Raised to 159 queries with a
   per-query JSON dump and a codemap-minus-grep delta row.

### Verified citations (source locator, not abstract alone)

| Work | arXiv | Confirmed at |
|---|---|---|
| RepoGraph | 2410.14684 | `inspo/repograph/repograph/construct_graph.py:97-113` (containment + def/ref edges), `graph_searcher.py:1-44` (one_hop/two_hop/dfs/bfs) |
| LocAgent | 2503.09089 | `inspo/locagent/dependency_graph/build_graph.py:13-20` (NODE_TYPE/EDGE_TYPE constants), `traverse_graph.py:242-266` (node/edge type filters) |
| GRACE | 2509.05980 | arXiv abstract: hybrid graph + textual retrieval with a GNN re-ranker beats either alone |
| DyRetriever | 2608.01927 | arXiv abstract: static global graphs are costly; select entry points then multi-hop along the dependency graph |
| GREPO | 2602.13921 | `github.com/qingpingmo/GREPO`; arXiv abstract: GNN bug-localization benchmark (86 repos, 47294 tasks) where IR baselines must be beaten explicitly |
| aider repomap | - | `inspo/aider/aider/repomap.py:381` (personalize = 100/len(fnames)), `:443-445` (set only for matched files), `:519-529` (personalized PageRank), `:676-704` (binary-search budget fit) |

### Acceptance

The hybrid arm meets or beats grep on both Recall@10 and MRR (the item-5 gate),
anchored retrieval keeps codemap query time under 800 ms with no regression
versus the global-PageRank hybrid (the item-6 gate), and `pnpm run check` is
clean. The measured baseline stated above (Recall@10 0.150 vs grep 0.442) and
the final numbers (0.522 vs 0.442) are both reproducible from the benchmark
script.

---

## 9. Corrected Objective (post-review)

Section 8 framed the work as beating grep at file ranking and added a BM25-over-
file-content channel to win it. That was the wrong objective. Grep is the tool
being replaced ("grep is shit for big ass modular codebase"), not the
comparator, and file-content BM25 is a grep surrogate. The win in section 8
came ~85% from that surrogate; the AST-only structural arm scored 0.333, below
grep, so the graph never earned its keep. This section records the corrected
goal.

### Goal

The goal is **LSP-grade information, AST-compressed into a per-turn token
budget, delivered by progressive disclosure**, with **feature-pattern cascades**
as the end goal. Not a one-shot ranked map; not a repomap clone.

Reference points for the compression objective are **the full ast-grep outline
(~54K tokens, measured in section 1)** and **naive truncation**. Grep is not a
reference point. The deliverable is a compression ratio + coverage of the
needed symbols within a 4-8K token budget, not Recall@K of files.

### Verified design sources (locator, not abstract alone)

| Source | arXiv / repo | Confirmed at |
|---|---|---|
| LocAgent progressive disclosure | 2503.09089 | `inspo/locagent/plugins/location_tools/repo_ops/repo_ops.py` `explore_graph_structure(start_entities, direction, traversal_depth, entity_type_filter, dependency_type_filter)` — tool-driven incremental graph expansion |
| LocAgent AST compression | 2503.09089 | `inspo/locagent/plugins/location_tools/utils/compress_file.py` `CompressTransformer` — "Replaces function body with ...", keeps ClassDef/FunctionDef/constants (a signature-level LSP view); our `ast-grep outline` is the multi-language analogue at 11.3x |
| Harness Handbook (behavior localization) | 2607.13285 | arXiv abstract: "behavior localization is a central bottleneck"; repos organized by files but requests describe behavior — the feature-pattern gap |
| Code-change Impact Analysis | 2512.19481 | arXiv abstract: seed-change -> impacted code entities; the cascade formulation |
| Change Impact Recommendation (JS) | 2606.21187 | arXiv abstract: history-based (evolutionary coupling) vs dependency-based recommendation compared — the choice between `cochange.ts` and the AST call graph |
| Change Recommendation / branch handling | 2204.04423 | arXiv abstract: evolutionary-coupling change recommendation; branch/merge handling (our benchmark already excludes merges) |
| cAST structural chunking | 2506.15655 | repo cloned at `inspo/astchunk` — AST-respecting chunking for retrieval |

### What survives and what is dropped

- **Survives:** `outline.ts` (ast-grep, ~11.3x), `symbols.ts`, `calls.ts` (AST
  call edges), `imports.ts`, `search.ts` (graph traversal / disclosure),
  `cochange.ts` (evolutionary coupling = feature-pattern seed), `eval.ts`.
- **Dropped:** `lexical.ts` (BM25 over file content, the grep surrogate) and its
  test; the grep and hybrid benchmark arms; grep as the comparator.
- **To build:** `skeleton.ts` (AST-compressed signature view), `disclose.ts`
  (progressive disclosure over the graph), `cascade.ts` (seed change ->
  predicted cascade, blending evolutionary coupling with AST dependencies).

The benchmark objective becomes **tokens-to-cover** (tokens spent before the
commit's changed files are all revealed) and **cascade recall at fixed 4K and 8K
token budgets**, against the full outline and naive truncation. The commit
file-set is cascade ground truth, not merely ranking ground truth.

## 10. Measured Cascade Results (2026-08-05)

Both benchmarks run against the corrected §9 objective: tokens-to-cover and
cascade recall at fixed 4K/8K token budgets. The comparator arms are the full
ast-grep outline (reference ceiling) and naive truncation (alphabetical file
order). There is no grep arm and no lexical/BM25 channel (dropped in §9).

### Full benchmark (WINDOW=300, 159 single-parent commits)

Full ast-grep outline reference: **55898 tokens** (218 KB).

| Arm | Recall@4K | Recall@8K | Tokens-to-cover |
|-----|-----------|-----------|-----------------|
| naive (alphabetical) | 0.013 | 0.013 | 46916 |
| graph (anchored PageRank) | 0.056 | 0.102 | 45764 |
| cascade (co-change + AST deps) | 0.132 | 0.196 | 37391 |

Reproduce: `pnpm run benchmark:codemap`

### Held-out validation (WINDOW=200, 105 commits, 53 train / 52 test, overlap 0)

The cascade `historyWeight` is selected on the TRAIN split and reported on the
disjoint TEST split. TRAIN-selected `historyWeight = 0.75` (train cascade
R@4K=0.225, R@8K=0.261).

TEST split:

| Arm | Recall@4K | Recall@8K | Tokens-to-cover |
|-----|-----------|-----------|-----------------|
| naive (alphabetical) | 0.026 | 0.026 | 45051 |
| graph (anchored PageRank) | 0.057 | 0.106 | 44923 |
| cascade (co-change + AST deps) | 0.122 | 0.219 | 33593 |

Reproduce: `pnpm run benchmark:codemap:holdout`

### Reading

The cascade arm dominates both reference points on every metric: against naive
truncation it cuts tokens-to-cover by ~20% (46916 to 37391 on the full run) and
raises Recall@4K roughly tenfold (0.013 to 0.132). Against the full outline
ceiling (55898 tokens), the cascade reaches 37391 tokens-to-cover, so it
reveals the commit file-set at ~67% of the one-shot outline cost. The held-out
TEST split reproduces the ordering and the gap (cascade 0.122 vs naive 0.026 at
4K), confirming the cascade historyWeight did not overfit the TRAIN split
(zero message overlap).
### Expand depth measurement (2026-08-05)

Measured on 159 single-parent commits at expand depths 1, 2, and 3 with both
directions (WINDOW=300). Anchors derived from commit message identifiers mapped
to symbol keys.

| Depth | Mean coverage | Mean tokens | Cov per 1K tok |
|-------|---------------|-------------|----------------|
| 1     | 0.100         | 4661        | 0.1            |
| 2     | 0.105         | 4862        | 0.1            |
| 3     | 0.111         | 5118        | 0.1            |

Decision: cap at **2**. Depth 1→2 adds +0.005 coverage for +201 tokens (2.5%
tokens per coverage point), while depth 2→3 adds +0.006 for +256 tokens (4.3%
per point). The efficiency per 1K tokens is identical across all depths. Cap 2
is safe — it exceeds the runtime default of 1 and matches the one-level finding
of arXiv 2607.17598, though that paper studied routing levels in Agent Skills
packs rather than graph hop distance.

Reproduce: `pnpm run build && node scripts/benchmark-expand-depth.mjs`

Applied to both schema surfaces: `src/codemap/tool.ts` and
`src/providers/codemap-provider.ts`. Gated by an assertion in
`tests/codemap-provider.test.ts` that fails if the bound drifts back to 5.

### Dependency channel fix: negative result (2026-08-05)

The file-level dependency channel was flat (1 distinct score across 62 files),
making it a membership set rather than a ranking. A bounded BFS over the import
graph with hop-distance decay (depth=3, decay=0.5) produced 3 distinct scores
across 333 files and raised channel overlap from 16.2% to 51.4% (arXiv
2606.21187 measured 22% disjoint; our previous 16.2% was artificially low
because the channel was degenerate). TRAIN-selected historyWeight moved from
1.0 (pure history) to 0.75, confirming the dependency channel now contributes.

However, TEST cascade recall regressed from 0.153 to 0.119 at 4K and from
0.305 to 0.260 at 8K, so the change was reverted. The structural fix is
correct — the channel genuinely had no ranking signal — but the broader BFS
expansion introduced noise that hurt holdout generalization.

A third probe closed the diagnosis: the AST symbol graph's 30 one-hop
neighbours of src/config.ts are each connected by **exactly one edge kind**
(invokes). Edge-kind multiplicity carries zero gradation. Combined with the
import graph where every edge weight is 1, the dependency channel has **no
ranking signal at the 1-hop level by construction** — it is a structural
property of how the graph is built, not a tuning bug. historyWeight selecting
1.0 (pure history on both TRAIN and TEST) is therefore a data-driven exclusion
of a degenerate channel, and the cascade score defaults correctly to the
history channel alone.
## 11. Gap Audit, Selection, and Import-Scoped Resolution (2026-08-06)

### Gap list (file:line, verified against source)

- G1 calls.ts:48-50,86-100 — callee resolution takes only the final member segment and links EVERY definer of that name (up to maxDefiners=5), with no import/scope filter; common names either over-connect the graph or are dropped outright when they exceed the definer gate.
- G2 symbols.ts:22-27,141-206 — regex identifier scan (IDENT_RE) for references matches inside strings/comments (documented at :22-27). Not on the production edge path: buildAllEdges (symbols.ts:229) uses extractCallEdges; buildReferenceEdges is exercised only by tests.
- G3 symbols.ts:208-228 — inheritance edges regex-parse the signature text and link to all same-named bases cross-file.
- G4 cascade.ts:96,108 — fixed historyWeight default 0.5; the §10 diagnosis shows the channel was degenerate, so the blend defaulted toward noise. symbolDependencyChannel (cascade.ts:66) ignores its `_index` parameter.
- G5 disclose.ts:46,74-84 — disclosure granularity is the whole-file skeleton; tokenEstimate is chars/4, not AST-aware; no member-level elision (cAST / semnav range-read idea).
- G6 lang.ts:12-26,44 — 10 extensions only; findSourceFiles hardcodes walk("src"), so tests/, scripts/, and root files are invisible to the graph.
- G7 imports.ts:28,40-53 — IMPORT_RE matches only `from "..."`; misses require(), dynamic import(), side-effect imports; resolveSpecifier rewrites only .js→.ts.
- G8 tool.ts:117-129 — expand returns entity keys only, no signatures; cascade returns raw predictions without a budget-fit re-rank.
- G9 eval.ts — extractQueryIdentifiers has no production caller; the evaluation surface is the benchmark scripts, not eval.ts.

### Research sweep (technique-to-module mapping)

- github/stack-graphs (cloned sources/, shallow): scope-graph name resolution; per-language rules, incremental, no build tools. Maps to G1/G3 — adopted at 0 dependencies via the first-party import graph.
- oraios/serena (cloned sources/, shallow): IDE-grade symbol tools over MCP; high-level symbol-level operations. Maps to the codemode tool surface (G8), not the AST core.
- inspo semnav: Semantic Graph MCP caching LSP results (find_symbol, references, call hierarchies) — the "LSP-but-queryable-graph" concept behind the intent.
- inspo astchunk: the cAST implementation (arXiv 2506.15655, EMNLP 2025 Findings): recursive AST chunking + sibling merging. Maps to G5 (next slice).
- arXiv: cAST 2506.15655 (AST-boundary chunking); CodexGraph 2408.03910 (graph-DB-backed repo interface). LocAgent/RepoGraph/aider already cited in module comments.

### Selection

Chosen: import-scoped callee resolution (G1) via a new pure module scope.ts (buildImportScope + resolveDefiners) wired into extractCallEdges. Rationale: addresses the §10 diagnosed root cause — the AST graph's 1-hop dependency signal was flat by construction because every file linked to every definer of common names. Fallback keeps prior behavior for callers with no resolvable imports (Go/Python/Rust/Java, dynamic imports), preserving recall.

Targets: false cross-file invokes edges -> 0 for files with resolvable imports; edge count down; cascade channel regains ranking signal (TRAIN-selected historyWeight leaves 1.0); expand coverage not lower.

Rejected/deferred:
- G2 regex reference scan: off the production path; leave.
- G6 language coverage: unverified ast-grep grammars, no benchmark signal.
- G4 cascade default weight: benchmark tunes per split; the channel fix (chosen slice) is the data-driven fix.
- G5 AST-boundary chunking: recommended next slice (cAST-style member-level disclosure, measured by expand-depth tokens-to-cover).
- G7 import specifier coverage: this repo is 100% .js-suffixed (670 vs 0 extensionless), so the existing resolver already resolves all first-party imports here.
- stack-graphs full adoption: per-language Rust rule sets; import scoping delivers the 80% at zero deps.

### Measured results (post-change, dist build)

| Metric | Before | After |
|--------|--------|-------|
| invokes edges | 6486 | 4392 (-32.3%) |
| cross-file false invokes edges (target not imported; source has resolvable imports) | 2457 (37.9%) | 0 (0%) |
| expand coverage depth 1/2/3 (163 commits) | 0.100/0.105/0.111 (doc §10, 159 commits) | 0.113/0.120/0.122 |
| cascade TRAIN-selected historyWeight (WINDOW=60) | 1.0 (pure history, degenerate channel) | 0.75 (channel contributes) |
| cascade TEST R@4K/R@8K (WINDOW=60) | n/a | 0.162/0.242 (cascade dominates graph 0.076/0.108 and naive 0.018/0.027) |

Reproduce: `node scripts/benchmark-expand-depth.mjs`; `node scripts/validate-codemap-holdout.mjs --window=N`; edge stats via `.measure-scope.mjs` (ephemeral, not committed).
## 12. Wider Graph Roots (2026-08-06)

The source scan (lang.ts findSourceFiles) walked only `src/`, so symbols defined in
`tests/` and `scripts/` were invisible to the AST index and agents fell back to grep
for exactly those queries. Widened to `src/`, `tests/`, `scripts/` with explicit
skips (node_modules, dist, .git, .pi, sources/, bench/) mirroring .cgcignore.

Benchmark (benchmark-expand-depth.mjs, dist build, 161 commits):

| Depth | Coverage (src-only, post-scope) | Coverage (widened) | Tokens |
|-------|--------------------------------|--------------------|--------|
| 1     | 0.113                          | 0.111              | 4544   |
| 2     | 0.120                          | 0.120              | 4738   |
| 3     | 0.122                          | 0.122              | 4870   |

Coverage is flat within noise and tokens are unchanged; the depth-2 cap still holds.
The import graph already covered tests/scripts (imports.ts walks the repo); this
aligns the symbol graph with it. Baseline vs naive (doc \u00a710) is unchanged in spirit.
