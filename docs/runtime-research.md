# Runtime Research: Ultra Fabric Improvement Candidates (2026-08-06)

Research sweep across arXiv for the Ultra Fabric runtime. Every claim below was fetched
via the live MCP search surface (mcp.exa.omniroute_web_search / omniroute_web_fetch);
no model-memory citations. No implementation in this task — the user picks the slice.

## 1. Grounded surfaces (file:line)

- Prewalk control loop: src/prewalk/arm.ts:13 armPrewalk; src/prewalk/controller.ts:116 PrewalkController; src/prewalk/handoff.ts:43 checklistContinuationPrompt. The checklist gates the first mutation.
- Agent admission + budgets: src/agents/one-shot-manager.ts:330 OneShotAgentManager (consult scope-guard at :396-400), :78 effectiveAgentTimeoutMs; src/agents/turn-budget.ts:1-4 AgentTurnBudget (maxTurns/graceTurns, capped at MAX_TURNS=200); src/agents/budget-ledger.ts:107 readBudgetLedger.
- Evidence routing: src/evidence/classify.ts, route.ts, execute.ts — capability classifier + health/LRU-balanced plan + DI executor behind mcp.$search.
- Compaction / context QoS: src/context/qos.ts:17 MARKER_KIND, :94 applyContextQos; src/compaction/ (bounds.ts:1 MAX_SUMMARY_BYTES; branch-summary.ts, qa.ts, projections.ts).
- Outcomes: src/providers/outcomes-provider.ts:76 OutcomesProvider (:69 recommend descriptor); src/outcomes/store.ts:147 evaluateDeterministic, :196 FabricOutcomeStore, :403-423 successConfidence/verifiedConfidence interval computation.
- Milestone: .pi/roadmap.md:10 "Current milestone: Slice 8 benchmark and soak gates"; :23-26 "at least 20 representative tasks, paired arms, exact oracles, provenance, cost controls, and comparative analysis".

## 2. arXiv findings (per axis, cited)

### (a) Plan-then-execute / plan compliance
**Evaluating Plan Compliance in Autonomous Programming Agents** (arXiv 2604.12147, cs.SE, Apr 2026, fetched abstract). First extensive systematic analysis of plan compliance in programming agents across 16,991 SWE-bench trajectories (search snippet: "first extensive, systematic analysis of plan compliance in programming agents, examining 16,991 trajectories from SWE-..."). Informs a plan-compliance metric for the prewalk checklist.

### (b) Context management / compaction
**Parallel Context Compaction for Long-Horizon LLM Agent Serving** (arXiv 2605.23296, May 2026, fetched abstract). LLM-based summarization keeps the conversation bounded but is lossy, and the blocking summarization call stalls the loop; parallel compaction is proposed for long-horizon serving (search snippet). Informs src/compaction.

### (c) Tool selection / routing
**Outcome-Aware Tool Selection for Semantic Routers: Latency-Constrained Learning Without LLM Inference** (arXiv 2603.13426, Mar 2026, fetched abstract). Semantic routers select tools in the critical request path where latency matters; outcome-aware, latency-constrained selection without LLM inference (search snippet). Extends the health/LRU balancing in src/evidence/route.ts.

### (d) Reliability / retry / failure taxonomies
**PALADIN: Self-Correcting Language Model Agents to Cure Tool-Failure Cases** (arXiv 2509.25238, Sep 2025; framework site 33k0.github.io/PALADIN-Framework fetched; companion repo github.com/33k0/PALADIN, MIT — cloned into sources/PALADIN). Treats failures as data: 50K+ failure-injected, recovery-annotated trajectories; outperforms CRITIC, ToolReflect, ToolBench by +13% Recovery Rate and +10% Task Success Rate (fetched site). Mechanism locators in the clone:
- sources/PALADIN/data/toolscan_taxonomy_map.json — failure taxonomy (Tool Hallucination, Argument Hallucination, Invalid Tool Invocation, each with concrete error codes).
- sources/PALADIN/data/recovery_dictionary.json — per-error-code recovery paths (thought → action → expected outcome; e.g. 400 → check headers/params, correct Content-Type/Auth, resend).
- sources/PALADIN/data/API_prompts/{annotate_recovery,grader,simulator}_prompt.txt — annotation/grader/simulator prompts.
- sources/PALADIN/src/paladin/ — implementation.

### (e) Benchmarks / soak evaluation
**Long-Horizon-Terminal-Bench: Testing the Limits of Agents...** (arXiv 2607.08964). A terminal benchmark of 46 long-horizon tasks spanning nine categories (search snippet). Template for the Slice 8 soak corpus design.

## 3. Ranking (measurable fit x implementability under fork rules)

| Candidate | Module | Fit | Implementability | Harness metric |
|-----------|--------|-----|------------------|----------------|
| PALADIN failure taxonomy + recovery guidance | prewalk checklist validation | HIGH | HIGH (pure module + recovery table, zero deps) | benchmark-prewalk recovery rate on injected-failure fixtures |
| Outcome/latency-aware scoring | src/evidence/route.ts | HIGH | HIGH (pure scoring change + tests) | evidence-router unit tests; mcp.$search p50 latency |
| Parallel / non-blocking compaction | src/compaction | MEDIUM-HIGH | MEDIUM (deep loop change) | compaction latency in a long-horizon run |
| Plan-compliance metric | prewalk checklist | MEDIUM-HIGH | MEDIUM | plan-compliance rate over the prewalk corpus |
| LHTB task design | Slice 8 soak corpus | HIGH (milestone) | MEDIUM-LOW (corpus adoption heavy) | Slice 8 gate tasks (20+ paired arms) |

## 4. Ranked slice proposals (user picks)

- S1 (LANDED 2026-08-06): failure-taxonomy + recovery-guidance module src/evidence/failure.ts (PALADIN-adapted categories + recovery strings), wired into mcp.$search attempt provenance (execute.ts). Prewalk checklist consumption deferred: every src/prewalk file is dirty with the in-flight runner-refactor WIP; wire it there once that lands. Acceptance met at unit level (22 taxonomy tests; enriched provenance on the fallback path).
- S2 (LANDED 2026-08-06): latency-aware scoring in src/evidence/route.ts — EvidenceHealth.latencyMs EWMA, score = weight x successRate x latencyFactor with latencyFactor = 2000/(2000+ewma) floored at 0.5 so reliability dominates and latency only separates comparably healthy tools. Live mcp.$search p50 lands after a session reload (host-injected MCP config).
- S3 (follow-up): parallel / non-blocking compaction. Acceptance: compaction completes within a bounded budget without stalling the agent loop.

## 5. Rejected / deferred

- Full PALADIN training pipeline: fine-tuning a model is out of scope for a TS runtime; adopt the taxonomy + recovery dictionary only.
- LHTB wholesale adoption: 46-task corpus is heavy; use the design (categories, long-horizon structure) as the Slice 8 evidence template.
- Evaluating Plan Compliance companion code: no public repo found (IBM); use the methodology only.
- Parallel Context Compaction companion code: serving-systems paper, no repo; mechanism adopted conceptually.
