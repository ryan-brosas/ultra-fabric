#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <task-slug|task-path|dataset-path> <baseline|fabric-local|fabric-prewalk|fabric-npm> [pier run args...]" >&2
  exit 2
fi

TARGET=$1
CONFIG=$2
shift 2

BENCH=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$BENCH/.." && pwd)
OPEN_SOURCE_ROOT=$(cd "$REPO_ROOT/.." && pwd)
PIER_ROOT=${PIER_ROOT:-$OPEN_SOURCE_ROOT/pier}
DEEPSWE_ROOT=${DEEPSWE_ROOT:-$OPEN_SOURCE_ROOT/deep-swe}
PIER_ENVIRONMENT=${PIER_ENVIRONMENT:-docker}
PIER_N_ATTEMPTS=${PIER_N_ATTEMPTS:-1}
PIER_N_CONCURRENT=${PIER_N_CONCURRENT:-1}
PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER=${PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER:-3}
PIER_AGENT_TIMEOUT_MULTIPLIER=${PIER_AGENT_TIMEOUT_MULTIPLIER:-2}
PIER_PI_VERSION=${PIER_PI_VERSION:-0.83.0}

if ! [[ "$PIER_N_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PIER_N_CONCURRENT" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_CONCURRENT must be a positive integer" >&2
  exit 2
fi
if ! python3 - "$PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER" <<'PY'
import sys

try:
    value = float(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if value > 0 else 1)
PY
then
  echo "PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER must be positive" >&2
  exit 2
fi
if ! [[ "$PIER_PI_VERSION" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "PIER_PI_VERSION must be an exact semantic version" >&2
  exit 2
fi

if [[ -d "$TARGET" ]]; then
  TASK_PATH=$(cd "$TARGET" && pwd)
elif [[ -d "$DEEPSWE_ROOT/tasks/$TARGET" ]]; then
  TASK_PATH="$DEEPSWE_ROOT/tasks/$TARGET"
else
  echo "DeepSWE task or dataset not found: $TARGET" >&2
  exit 2
fi
if [[ ! -f "$PIER_ROOT/pyproject.toml" ]]; then
  echo "Pier checkout not found at $PIER_ROOT" >&2
  exit 2
fi

RUNTIME="$BENCH/.runtime/pier-$CONFIG"
AGENT_DIR="$RUNTIME/agent"
ARTIFACT_DIR="$BENCH/.artifacts"
rm -rf "$RUNTIME"
mkdir -p "$AGENT_DIR" "$ARTIFACT_DIR" "$BENCH/results/pier"
chmod 700 "$RUNTIME" "$AGENT_DIR"

python3 - "$AGENT_DIR" <<'PY'
import json
import os
import sys

agent_dir = sys.argv[1]
auth_path = os.path.expanduser("~/.pi/agent/auth.json")
auth = json.load(open(auth_path)) if os.path.exists(auth_path) else {}
selected = {key: auth[key] for key in ("openai-codex", "omniroute") if key in auth}
if not selected:
    raise SystemExit("openai-codex OAuth credentials are unavailable")
with open(os.path.join(agent_dir, "auth.json"), "w") as handle:
    json.dump(selected, handle)
with open(os.path.join(agent_dir, "settings.json"), "w") as handle:
    json.dump({
        "defaultModel": "makora/deepseek-ai/DeepSeek-V4-Flash",
        "defaultProvider": "makora",
        "defaultThinkingLevel": "low",
        "packages": ["npm:pi-makora-provider"],
    }, handle)
PY
chmod 600 "$AGENT_DIR"/*.json

FABRIC_ARGS=()
case "$CONFIG" in
  baseline)
    ;;
fabric-local|fabric-prewalk)
    if [[ "$CONFIG" == "fabric-prewalk" ]]; then
      PIER_MODEL=${PIER_MODEL:-omniroute/opencode-go/deepseek-v4-flash}
      # Isolated prewalk-first fabric.json loaded by Pi as the global config
      # inside the cell (PI_CODING_AGENT_DIR=/tmp/pi-agent). Opt-in flags only:
      # cheap scout/explorer context roles, checklist reuse, gate-failure
      # memory, handoff retirement, and plan-then-delegate. No credentials.
      PREWALK_EXECUTOR=${PI_FABRIC_EXECUTOR_MODEL:-omniroute/opencode-go/deepseek-v4-flash}
      python3 - "$AGENT_DIR" "$PREWALK_EXECUTOR" <<'PY'
import json
import os
import sys

agent_dir, executor = sys.argv[1], sys.argv[2]
with open(os.path.join(agent_dir, "settings.json"), "w") as handle:
    json.dump({
        "defaultModel": executor,
        "defaultProvider": "omniroute",
        "defaultThinkingLevel": "low",
        "packages": [],
    }, handle)
config = {
    "configVersion": 3,
    "prewalk": {
        "arm": "task",
        "model": executor,
        "autoScout": True,
        "failureMemory": True,
        "reuseChecklists": True,
        "handoffRetirement": True,
        "delegateContext": True,
    },
    "agents": {
        "enabled": True,
        "roleModels": {
            "scout": executor,
            "explorer": executor,
            "planner": executor,
            "reviewer": executor,
        },
    },
}
with open(os.path.join(agent_dir, "fabric.json"), "w") as handle:
    json.dump(config, handle, indent=2)
PY
    fi
    if [[ -n "${PI_FABRIC_PACKAGE:-}" ]]; then
      FABRIC_PACKAGE=$(cd "$(dirname "$PI_FABRIC_PACKAGE")" && pwd)/$(basename "$PI_FABRIC_PACKAGE")
      if [[ ! -f "$FABRIC_PACKAGE" ]]; then
        echo "PI_FABRIC_PACKAGE does not exist: $FABRIC_PACKAGE" >&2
        exit 2
      fi
    else
      rm -f "$ARTIFACT_DIR"/*.tgz
      (
        cd "$REPO_ROOT"
        pnpm run build
        npm pack --ignore-scripts --pack-destination "$ARTIFACT_DIR"
      )
      PACKAGES=("$ARTIFACT_DIR"/*.tgz)
      if [[ ${#PACKAGES[@]} -ne 1 || ! -f "${PACKAGES[0]}" ]]; then
        echo "Expected exactly one packed Fabric archive under $ARTIFACT_DIR" >&2
        exit 2
      fi
      FABRIC_PACKAGE=${PACKAGES[0]}
    fi
    FABRIC_PACKAGE_NAME=$(
      python3 - "$FABRIC_PACKAGE" <<'PY'
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    package = json.load(archive.extractfile("package/package.json"))
print(package["name"])
PY
    )
    FABRIC_ARGS=(
      --agent-kwarg "fabric_package_path=$FABRIC_PACKAGE"
      --agent-kwarg "fabric_package_name=$FABRIC_PACKAGE_NAME"
    )
    if [[ "$CONFIG" == "fabric-prewalk" ]]; then
      FABRIC_ARGS+=(
        --agent-kwarg "omniroute_provider_path=${PI_OMNIROUTE_PROVIDER:-$OPEN_SOURCE_ROOT/pi-omniroute-provider}"
        --agent-kwarg "omniroute_url=${PI_OMNIROUTE_URL_CELL:-http://host.docker.internal:20128/v1}"
      )
    fi
    ;;
  fabric-npm)
    FABRIC_SPEC=${PI_FABRIC_SPEC:-}
    if [[ -z "$FABRIC_SPEC" ]]; then
      echo "PI_FABRIC_SPEC is required for fabric-npm" >&2
      exit 2
    fi
    FABRIC_ARGS=(--agent-kwarg "fabric_package_spec=$FABRIC_SPEC")
    ;;
  *)
    echo "unknown config: $CONFIG" >&2
    exit 2
    ;;
esac

if [[ "$PIER_ENVIRONMENT" == "docker" ]]; then
  if ! docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=$(command -v docker-compose || true)
    if [[ -z "$COMPOSE_BIN" ]]; then
      echo "Pier requires Docker Compose" >&2
      exit 2
    fi
    ACTIVE_CONTEXT=$(docker context show)
    DAEMON_HOST=$(docker context inspect "$ACTIVE_CONTEXT" --format '{{.Endpoints.docker.Host}}')
    DOCKER_CONFIG_DIR="$RUNTIME/docker-config"
    mkdir -p "$DOCKER_CONFIG_DIR/cli-plugins"
    ln -sf "$COMPOSE_BIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-compose"
    BUILDX_BIN=$(command -v docker-buildx || true)
    if [[ -n "$BUILDX_BIN" ]]; then
      ln -sf "$BUILDX_BIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-buildx"
    fi
    export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
    export DOCKER_HOST="$DAEMON_HOST"
  fi
  export DOCKER_DEFAULT_PLATFORM=${DOCKER_DEFAULT_PLATFORM:-linux/amd64}
  docker info >/dev/null
  docker compose version >/dev/null
fi

TASK_NAME=$(basename "$TASK_PATH")
JOB_NAME=${PIER_JOB_NAME:-"pi-$CONFIG-$TASK_NAME-$(date +%Y%m%d-%H%M%S)"}
export PYTHONPATH="$BENCH${PYTHONPATH:+:$PYTHONPATH}"

PIER_ARGS=(
  uv run --directory "$PIER_ROOT" pier run
  --path "$TASK_PATH"
  --agent-import-path pier_pi_agent:PiCodingAgent
--model "${PIER_MODEL:-openai-codex/gpt-5.6-sol}"
  --agent-kwarg "pi_agent_dir=$AGENT_DIR"
  --agent-kwarg "pi_version=$PIER_PI_VERSION"
)
PIER_ARGS+=("${FABRIC_ARGS[@]}")
PIER_ARGS+=(
  --env "$PIER_ENVIRONMENT"
  --n-attempts "$PIER_N_ATTEMPTS"
  --n-concurrent "$PIER_N_CONCURRENT"
  --job-name "$JOB_NAME"
  --jobs-dir "$BENCH/results/pier"
	--agent-timeout-multiplier "$PIER_AGENT_TIMEOUT_MULTIPLIER"
  --agent-setup-timeout-multiplier "$PIER_AGENT_SETUP_TIMEOUT_MULTIPLIER"
  --yes
)
PIER_ARGS+=("$@")
"${PIER_ARGS[@]}"
