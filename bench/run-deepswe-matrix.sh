#!/usr/bin/env bash
set -euo pipefail

BENCH=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$BENCH/.." && pwd)
OPEN_SOURCE_ROOT=$(cd "$REPO_ROOT/.." && pwd)
DEEPSWE_ROOT=${DEEPSWE_ROOT:-$OPEN_SOURCE_ROOT/deep-swe}
SUBSET=${1:-$BENCH/subsets/deepswe-36-v2.txt}
CONFIG_SET=${2:-both}
if [[ $# -ge 1 ]]; then shift; fi
if [[ $# -ge 1 ]]; then shift; fi
EXTRA_ARGS=("$@")

PIER_N_ATTEMPTS=${PIER_N_ATTEMPTS:-3}
PIER_N_CONCURRENT=${PIER_N_CONCURRENT:-1}
PIER_MATRIX_ID=${PIER_MATRIX_ID:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}
PIER_DRY_RUN=${PIER_DRY_RUN:-0}

if [[ ! -f "$SUBSET" ]]; then
  echo "DeepSWE subset file not found: $SUBSET" >&2
  exit 2
fi
if [[ ! -d "$DEEPSWE_ROOT/tasks" ]]; then
  echo "DeepSWE dataset not found at $DEEPSWE_ROOT/tasks" >&2
  exit 2
fi
if ! [[ "$PIER_N_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PIER_N_CONCURRENT" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_CONCURRENT must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PIER_MATRIX_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "PIER_MATRIX_ID may contain only letters, digits, dot, underscore, and dash" >&2
  exit 2
fi

CONFIGS=()
case "$CONFIG_SET" in
  both)
    CONFIGS=(baseline fabric-local)
    ;;
  baseline|fabric-local|fabric-npm)
    CONFIGS=("$CONFIG_SET")
    ;;
  *)
    echo "usage: $0 [subset-file] [both|baseline|fabric-local|fabric-npm] [pier run args...]" >&2
    exit 2
    ;;
esac

TASKS=()
TASK_ARGS=()
while IFS= read -r raw || [[ -n "$raw" ]]; do
  task=${raw%%#*}
  task=${task#"${task%%[![:space:]]*}"}
  task=${task%"${task##*[![:space:]]}"}
  [[ -z "$task" ]] && continue
  if [[ ! -d "$DEEPSWE_ROOT/tasks/$task" ]]; then
    echo "DeepSWE task from subset is unavailable: $task" >&2
    exit 2
  fi
  TASKS+=("$task")
  TASK_ARGS+=(--include-task-name "$task")
done < "$SUBSET"

if [[ ${#TASKS[@]} -eq 0 ]]; then
  echo "DeepSWE subset is empty: $SUBSET" >&2
  exit 2
fi

CELL_COUNT=$((${#TASKS[@]} * PIER_N_ATTEMPTS * ${#CONFIGS[@]}))
SUBSET_NAME=$(basename "$SUBSET")
SUBSET_NAME=${SUBSET_NAME%.txt}
printf 'DeepSWE matrix: %s tasks × %s attempts × %s configs = %s cells\n' \
  "${#TASKS[@]}" "$PIER_N_ATTEMPTS" "${#CONFIGS[@]}" "$CELL_COUNT"
printf 'Subset: %s\nMatrix ID: %s\nConcurrency per job: %s\n' \
  "$SUBSET" "$PIER_MATRIX_ID" "$PIER_N_CONCURRENT"

if [[ "$PIER_DRY_RUN" != 1 && "$CELL_COUNT" -gt 24 && "${PIER_CONFIRM_FULL_MATRIX:-0}" != 1 ]]; then
  echo "Refusing to launch $CELL_COUNT paid cells without PIER_CONFIRM_FULL_MATRIX=1" >&2
  exit 2
fi
if [[ "$PIER_DRY_RUN" != 1 && "${PIER_ALLOW_DIRTY:-0}" != 1 ]]; then
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "Refusing to benchmark a dirty worktree; commit changes or set PIER_ALLOW_DIRTY=1" >&2
    exit 2
  fi
fi

for config in "${CONFIGS[@]}"; do
  JOB_NAME="deepswe-$SUBSET_NAME-$config-$PIER_MATRIX_ID"
  CMD=("$BENCH/run-deepswe-pier.sh" "$DEEPSWE_ROOT/tasks" "$config")
  CMD+=("${TASK_ARGS[@]}")
  CMD+=("${EXTRA_ARGS[@]}")
  printf '\n[%s]\n' "$JOB_NAME"
  if [[ "$PIER_DRY_RUN" == 1 ]]; then
    printf 'PIER_JOB_NAME=%q PIER_N_ATTEMPTS=%q PIER_N_CONCURRENT=%q ' \
      "$JOB_NAME" "$PIER_N_ATTEMPTS" "$PIER_N_CONCURRENT"
    printf '%q ' "${CMD[@]}"
    printf '\n'
    continue
  fi
  PIER_JOB_NAME="$JOB_NAME" \
  PIER_N_ATTEMPTS="$PIER_N_ATTEMPTS" \
  PIER_N_CONCURRENT="$PIER_N_CONCURRENT" \
    "${CMD[@]}"
done
