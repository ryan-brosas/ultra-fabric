from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import Any

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


NPM_PACKAGE_NAME_PATTERN = (
    r"(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*"
)
EXACT_SEMVER_PATTERN = (
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
)


def validate_package_name(package_name: str) -> str:
    if not re.fullmatch(NPM_PACKAGE_NAME_PATTERN, package_name):
        raise ValueError(f"Invalid npm package name: {package_name}")
    return package_name


def package_name_from_spec(package_spec: str) -> str:
    match = re.fullmatch(
        rf"(?P<name>{NPM_PACKAGE_NAME_PATTERN})@{EXACT_SEMVER_PATTERN}",
        package_spec,
    )
    if match is None:
        raise ValueError(
            "Fabric npm package must use an exact name@semver spec"
        )
    return match.group("name")


def fabric_extension_flags(package_name: str) -> str:
    package_name = validate_package_name(package_name)
    return f'-e "$(npm root -g)/{package_name}"'


class PiCodingAgent(BaseInstalledAgent):
    """Pier adapter for paired baseline and Fabric DeepSWE trials."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args: Any,
        pi_agent_dir: str,
        fabric_package_path: str | None = None,
        fabric_package_name: str | None = None,
        fabric_package_spec: str | None = None,
        omniroute_provider_path: str | None = None,
        omniroute_url: str | None = None,
        thinking_level: str = "low",
        pi_version: str = "0.83.0",
        **kwargs: Any,
    ) -> None:
        self._pi_agent_dir = Path(pi_agent_dir).resolve()
        if fabric_package_path and fabric_package_spec:
            raise ValueError(
                "fabric_package_path and fabric_package_spec are mutually exclusive"
            )
        self._fabric_package_path = (
            Path(fabric_package_path).resolve() if fabric_package_path else None
        )
        self._fabric_package_spec = fabric_package_spec
        self._omniroute_provider_path = omniroute_provider_path
        self._omniroute_url = omniroute_url
        if fabric_package_spec:
            spec_name = package_name_from_spec(fabric_package_spec)
            if fabric_package_name and fabric_package_name != spec_name:
                raise ValueError(
                    "fabric_package_name does not match fabric_package_spec"
                )
            self._fabric_package_name = spec_name
        elif self._fabric_package_path:
            self._fabric_package_name = validate_package_name(
                fabric_package_name or "ultra-fabric"
            )
        else:
            if fabric_package_name:
                raise ValueError(
                    "fabric_package_name requires a package path or npm spec"
                )
            self._fabric_package_name = None
        self._thinking_level = thinking_level
        self._pi_version = pi_version
        self._session_logs_dir: Path | None = None
        if not (self._pi_agent_dir / "auth.json").is_file():
            raise ValueError(f"Pi auth.json not found under {self._pi_agent_dir}")
        if self._fabric_package_path and not self._fabric_package_path.is_file():
            raise ValueError(
                f"Fabric package not found: {self._fabric_package_path}"
            )
        super().__init__(*args, version=pi_version, **kwargs)

    @staticmethod
    def name() -> str:
        return "pi"

    def get_version_command(self) -> str | None:
        return "pi --version"

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(
            domains=[
                "api.openai.com",
                "auth.openai.com",
                "chatgpt.com",
            ]
        )

    def install_spec(self) -> AgentInstallSpec:
        packages = [f"@earendil-works/pi-coding-agent@{self._pi_version}"]
        if self._fabric_package_spec:
            packages.append(self._fabric_package_spec)
        package_args = " ".join(shlex.quote(package) for package in packages)
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._pi_version,
            steps=[
                InstallStep(
                    user="root",
                    run=(
                        "set -euo pipefail; "
                        "if ! command -v npm >/dev/null; then "
                        "  echo 'Pi requires Node.js and npm' >&2; exit 1; "
                        "fi; "
                        "if ! command -v rg >/dev/null; then "
                        "  if command -v apt-get >/dev/null; then "
                        "    apt-get update && apt-get install -y ripgrep; "
                        "  elif command -v apk >/dev/null; then apk add --no-cache ripgrep; "
                        "  elif command -v yum >/dev/null; then yum install -y ripgrep; "
                        "  else echo 'Pi requires ripgrep' >&2; exit 1; fi; "
                        "fi; "
                        "npm install -g --ignore-scripts --legacy-peer-deps "
                        f"{package_args}; "
                        "pi --version"
                    ),
                )
            ],
            verification_command="pi --version",
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.upload_dir(self._pi_agent_dir, "/tmp/pi-agent")
        ownership = ""
        if environment.default_user is not None:
            user = shlex.quote(str(environment.default_user))
            ownership = f"chown -R {user} /tmp/pi-agent; "
        await self.exec_as_root(
            environment,
            command=(
                ownership
                + "chmod 700 /tmp/pi-agent; "
                + "find /tmp/pi-agent -type f -exec chmod 600 {} +"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "git -C /app config user.name 'Pi Agent'; "
                "git -C /app config user.email 'pi-agent@localhost'"
            ),
        )
        if self._omniroute_provider_path:
            import tarfile as _tarfile
            import tempfile as _tempfile
            provider_root = Path(self._omniroute_provider_path)
            # Package the local provider dir so it lands at a stable in-container
            # path the -e flag can point at.
            archive = provider_root / ".omniroute-provider.tgz"
            with _tarfile.open(archive, "w:gz") as tf:
                tf.add(provider_root, arcname="pi-omniroute-provider",
                       filter=lambda info: (
                           None if "node_modules" in info.name or ".git" in info.name else info
                       ))
            await environment.upload_file(str(archive), "/tmp/pi-omniroute-provider.tgz")
            await self.exec_as_root(
                environment,
                command=(
                    "mkdir -p /tmp/omniroute-ext && tar -xzf /tmp/pi-omniroute-provider.tgz -C /tmp/omniroute-ext && "
                    "npm install --prefix /tmp/omniroute-ext/pi-omniroute-provider --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || true"
                ),
            )
        if self._fabric_package_path:
            await environment.upload_file(
                self._fabric_package_path, "/tmp/fabric-package.tgz"
            )
            await self.exec_as_root(
                environment,
                command=(
                    "npm install -g --ignore-scripts --legacy-peer-deps "
                    "/tmp/fabric-package.tgz"
                ),
            )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("Pi agent requires model_name")
        remote_session_dir = "/tmp/pi-session"
        local_session_dir = self.logs_dir / "pi-session"
        self._session_logs_dir = local_session_dir
        extension_flags = ""
        if self._fabric_package_name:
            extension_flags = fabric_extension_flags(self._fabric_package_name)
        else:
            extension_flags = "--no-skills --no-extensions"
        if self._omniroute_provider_path:
            extension_flags += " -e /tmp/omniroute-ext/pi-omniroute-provider"
        command = " ".join(
            [
                "mkdir -p /tmp/pi-session /logs/agent;",
                "PI_CODING_AGENT_DIR=/tmp/pi-agent",
                "pi --print",
                f"--thinking {shlex.quote(self._thinking_level)}",
                f"--model {shlex.quote(self.model_name)}",
                f"--session-dir {remote_session_dir}",
                "--no-prompt-templates --no-context-files --no-themes",
                extension_flags,
                shlex.quote(instruction),
                "2>&1 </dev/null | tee /logs/agent/pi.txt",
            ]
        )
        try:
            await self.exec_as_agent(
                environment,
                command=command,
                env=self.process_env(),
                cwd="/app",
            )
        finally:
            try:
                await environment.download_dir(
                    remote_session_dir, local_session_dir
                )
            except Exception as exc:
                self.logger.warning("Failed to download Pi session: %s", exc)

    def process_env(self) -> dict[str, str]:
        """Runtime env for the cell process: the configured OmniRoute URL
        rides here so the omniroute provider extension inside the container
        reaches the host gateway instead of its own localhost."""
        base: dict[str, str | None] = {"PI_CODING_AGENT_DIR": "/tmp/pi-agent"}
        if self._omniroute_url:
            base["OMNIROUTE_URL"] = self._omniroute_url
        return self.build_process_env(base)

    def populate_context_post_run(self, context: AgentContext) -> None:
        if not self._session_logs_dir or not self._session_logs_dir.exists():
            return
        metrics = collect_pi_session_metrics(self._session_logs_dir)
        context.n_input_tokens = metrics["input_tokens"]
        context.n_cache_tokens = metrics["cache_tokens"]
        context.n_output_tokens = metrics["output_tokens"]
        context.cost_usd = metrics["cost_usd"]
        context.peak_context_tokens = metrics["peak_context_tokens"]
        context.summarization_count = metrics["summarization_count"]
        context.n_agent_steps = metrics["assistant_turns"]
        context.metadata = {
            "combined_total_tokens": metrics["combined_total_tokens"],
            "fresh_input_tokens": metrics["fresh_input_tokens"],
            "outer_tool_calls": metrics["outer_tool_calls"],
            "outer_calls_by_name": metrics["outer_calls_by_name"],
            "nested_tool_calls": metrics["nested_tool_calls"],
            "nested_calls_by_ref": metrics["nested_calls_by_ref"],
            "fabric_failures": metrics["fabric_failures"],
            "same_file_extra_edits": metrics["same_file_extra_edits"],
            "model_visible_result_chars": metrics["model_visible_result_chars"],
            "max_result_chars": metrics["max_result_chars"],
            "whole_file_reads": metrics["whole_file_reads"],
            "bounded_reads": metrics["bounded_reads"],
            "results_over_50kb": metrics["results_over_50kb"],
            "fabric_enabled": self._fabric_package_name is not None,
            "fabric_package_name": self._fabric_package_name,
        }


def collect_pi_session_metrics(session_dir: Path) -> dict[str, Any]:
    input_tokens = 0
    fresh_input_tokens = 0
    cache_tokens = 0
    output_tokens = 0
    combined_total_tokens = 0
    cost_usd = 0.0
    peak_context_tokens = 0
    assistant_turns = 0
    outer_tool_calls = 0
    outer_calls_by_name: dict[str, int] = {}
    nested_tool_calls = 0
    fabric_failures = 0
    same_file_extra_edits = 0
    model_visible_result_chars = 0
    max_result_chars = 0
    summarization_count = 0
    whole_file_reads = 0
    bounded_reads = 0
    results_over_50kb = 0
    nested_calls_by_ref: dict[str, int] = {}

    for session_path in sorted(session_dir.rglob("*.jsonl")):
        for raw_line in session_path.read_text(errors="replace").splitlines():
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if record.get("type") == "compaction":
                summarization_count += 1
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "assistant":
                assistant_turns += 1
                usage = message.get("usage") or {}
                fresh = int(usage.get("input") or 0) + int(
                    usage.get("cacheWrite") or 0
                )
                cached = int(usage.get("cacheRead") or 0)
                output = int(usage.get("output") or 0)
                input_tokens += fresh + cached
                fresh_input_tokens += fresh
                cache_tokens += cached
                output_tokens += output
                combined_total_tokens += int(usage.get("totalTokens") or 0)
                cost_usd += float((usage.get("cost") or {}).get("total") or 0)
                peak_context_tokens = max(
                    peak_context_tokens, fresh + cached
                )
                for item in message.get("content") or []:
                    if not isinstance(item, dict) or item.get("type") != "toolCall":
                        continue
                    outer_tool_calls += 1
                    name = str(item.get("name") or "unknown")
                    outer_calls_by_name[name] = outer_calls_by_name.get(name, 0) + 1
                    if name == "read":
                        args = item.get("arguments") or {}
                        if "offset" in args or "limit" in args:
                            bounded_reads += 1
                        else:
                            whole_file_reads += 1
            elif role == "toolResult":
                text = "".join(
                    item.get("text", "")
                    for item in message.get("content") or []
                    if isinstance(item, dict)
                )
                text_chars = len(text)
                model_visible_result_chars += text_chars
                max_result_chars = max(max_result_chars, text_chars)
                if text_chars > 50_000:
                    results_over_50kb += 1
                details = message.get("details") or {}
                trace = details.get("trace") or {}
                if message.get("toolName") == "fabric_exec" and (
                    message.get("isError") is True
                    or trace.get("outcome") not in (None, "succeeded")
                ):
                    fabric_failures += 1
                edit_paths: dict[str, int] = {}
                for operation in trace.get("operations") or []:
                    if not isinstance(operation, dict):
                        continue
                    nested_tool_calls += 1
                    ref = str(operation.get("ref") or "unknown")
                    nested_calls_by_ref[ref] = nested_calls_by_ref.get(ref, 0) + 1
                    args = operation.get("args") or {}
                    if ref == "pi.edit" and isinstance(args.get("path"), str):
                        path = args["path"]
                        edit_paths[path] = edit_paths.get(path, 0) + 1
                    if ref == "pi.read":
                        if "offset" in args or "limit" in args:
                            bounded_reads += 1
                        else:
                            whole_file_reads += 1
                same_file_extra_edits += sum(
                    max(0, count - 1) for count in edit_paths.values()
                )

    return {
        "input_tokens": input_tokens,
        "fresh_input_tokens": fresh_input_tokens,
        "cache_tokens": cache_tokens,
        "output_tokens": output_tokens,
        "combined_total_tokens": combined_total_tokens,
        "cost_usd": round(cost_usd, 6),
        "peak_context_tokens": peak_context_tokens,
        "assistant_turns": assistant_turns,
        "outer_tool_calls": outer_tool_calls,
        "outer_calls_by_name": dict(sorted(outer_calls_by_name.items())),
        "nested_tool_calls": nested_tool_calls,
        "nested_calls_by_ref": dict(sorted(nested_calls_by_ref.items())),
        "fabric_failures": fabric_failures,
        "same_file_extra_edits": same_file_extra_edits,
        "model_visible_result_chars": model_visible_result_chars,
        "max_result_chars": max_result_chars,
        "summarization_count": summarization_count,
        "whole_file_reads": whole_file_reads,
        "bounded_reads": bounded_reads,
        "results_over_50kb": results_over_50kb,
    }
