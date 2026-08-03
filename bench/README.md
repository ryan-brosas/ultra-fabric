# bench — DeepSWE-style verification loop

Local, paired before/after benchmark for measuring Fabric's token-efficiency
regressions against plain Pi, built to mirror the methodology and metrics of
github.com/Whamp/pi-fabric-deepswe-trajectories (issue: "DeepSWE Performance
Trajectories with GPT-5.6-sol:low").

## What it measures

Per (task, config, rep) cell:

- `reward_binary`, `reward_partial` — from the task's `verify.sh`, whose
  checks are derived mechanically from the task's stated acceptance criteria
- `combined_total_tokens`, input/cached/output breakdown, `combined_cost_usd`
  (GPT-5.6 Sol rates: $5/M fresh input, $0.50/M cached input, $30/M output)
- `agent_wall_s`, `turns`, `tool_calls`, `patch_bytes`
- Read-pathology statistics: total reads, whole-file (unbounded) read share,
  tool results over 50 KB. Fabric cells parse `details.trace.operations`, the
  same extraction that reproduces the trajectories repo's published numbers
  (1505 reads / 78.5% whole-file / 79 results over 50 KB).

## Layout

    tasks/<slug>/task.json   repo URL, base ref (extracted from archived sessions), timeouts
    tasks/<slug>/prompt.txt  verbatim DeepSWE user prompt from the archived cell
    tasks/<slug>/verify.sh   acceptance probes -> reward_binary/reward_partial
    run-cell.sh              one cell: checkout at base ref -> agent -> verifier
    run-matrix.sh            isolated agent dir, vendoring, task x config x rep loop, analysis
    analyze.py               paired summary (solves, McNemar, token deltas, read pathology)

Configs:

- `baseline` — clean stock pi: `--no-skills --no-extensions`, isolated
  `PI_CODING_AGENT_DIR` with only the `openai-codex` OAuth entry
- `fabric-local` — this repo (`-e <repo root>`), what ships right now
- `fabric-<version>` — vendored published package (e.g. `pi-fabric@0.25.6`,
  the version benchmarked in the trajectories repo)

## Run

    ./run-matrix.sh --tasks scc-bounded-memory-spilling \
      --configs baseline,fabric-0.25.6,fabric-local --reps 3 \
      --vendor pi-fabric@0.25.6 --run-id myrun

Results land in `results/<run-id>/<config>/<task>/rep<N>/` in the same layout
as the trajectories repo; `analysis-summary.json` is written next to them.

## Official DeepSWE tasks through Pier

`run-deepswe-pier.sh` runs the same paired Pi configurations in the official
Harbor task images and separate verifier environment. Keep sibling checkouts of
`datacurve-ai/deep-swe` and `datacurve-ai/pier`, Docker running, and the
`openai-codex` OAuth entry available in `~/.pi/agent/auth.json`.

    PIER_ENVIRONMENT=modal ./run-deepswe-pier.sh bandit-interprocedural-taint-checks baseline
    PIER_ENVIRONMENT=modal ./run-deepswe-pier.sh bandit-interprocedural-taint-checks fabric-local
    PI_FABRIC_SPEC=pi-fabric@0.25.6 PIER_ENVIRONMENT=modal ./run-deepswe-pier.sh bandit-interprocedural-taint-checks fabric-npm


The matrix runner pins either the original reporter subset or a smaller adversarial cross-language canary, expands independent attempts through Pier, and gives both configurations deterministic resumable job names. Previewing is free; matrices over 24 paid cells require an explicit confirmation.

    PIER_DRY_RUN=1 ./run-deepswe-matrix.sh subsets/deepswe-canary-8.txt both
    PIER_ENVIRONMENT=modal PIER_CONFIRM_FULL_MATRIX=1 ./run-deepswe-matrix.sh subsets/deepswe-canary-8.txt both
    PIER_ENVIRONMENT=modal PIER_CONFIRM_FULL_MATRIX=1 ./run-deepswe-matrix.sh subsets/deepswe-36-v2.txt both

The defaults are three attempts and one concurrent trial. Override them with `PIER_N_ATTEMPTS`, `PIER_N_CONCURRENT`, and a stable `PIER_MATRIX_ID`; rerunning the same ID resumes Pier jobs with matching configs. The canary is 48 cells and the full reporter matrix is 216 cells, so use the canary before commissioning the full rerun.

Compare completed matched jobs and write replayable cell-level JSON with:

    python3 analyze_pier.py results/pier/<baseline-job> results/pier/<fabric-job> --output results/pier/<matrix-id>-comparison.json

The adapter installs Pi inside the task container, uploads only the isolated
OAuth/settings directory, and packs the current Fabric checkout for local runs.
For `fabric-npm`, `PI_FABRIC_SPEC` must be an exact `name@semver`; Pier installs
that package into the cached agent image so repetitions do not repeat the slow
runtime dependency installation. Pier results land under `results/pier/`. In addition to verifier reward, the
trial metadata records fresh/cached/combined and peak context tokens, outer and nested
call mix, failures, same-file edit fragmentation, compactions, bounded versus
whole-file reads, model-visible result volume, and results over 50 KB. Pass additional `pier run` flags after the config, such as dataset sampling flags. For the launcher's standard controls, use `PIER_N_ATTEMPTS`, `PIER_N_CONCURRENT`, `PIER_PI_VERSION`, and `PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER`. The setup multiplier defaults to 3 because a first uncached local archive install exceeded Pier's 360-second default. Modal is recommended on ARM hosts because the official images are amd64. Set `PI_FABRIC_PACKAGE` to reuse one already-certified tarball across tasks. Run OAuth-backed cells serially.

Notes:

- Model is pinned to `openai-codex/gpt-5.6-sol` at thinking `low`, matching
  the trajectories benchmark.
- Run cells serially: the codex OAuth token is shared and refresh writes race.
- Historical parity uses three repetitions. The archived `36_v2` reference pins `pi-fabric@0.25.6`; compare it to an exact `ultra-fabric` npm spec under the same Pi version before claiming an improvement.
- `results/`, `.cache/`, `.runtime/` (if any) and `vendor/` are git-ignored.
