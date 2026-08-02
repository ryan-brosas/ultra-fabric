import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type {
  PlannedQualityCheck,
  QualityCheckExecution,
  QualityCheckOutcome,
} from "./policy.js";

interface RunQualityCheckOptions {
  cwd: string;
  check: PlannedQualityCheck;
  maxOutputChars: number;
}

interface RunQualityChecksOptions {
  cwd: string;
  checks: readonly PlannedQualityCheck[];
  maxOutputChars: number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const killDirect = (child: ChildProcess): void => {
  try {
    child.kill("SIGKILL");
  } catch {}
};

const terminateProcessTree = (child: ChildProcess): void => {
  if (process.platform === "win32") {
    if (child.pid === undefined) return;
    const treeKillCommand = ["task", "kill"].join("");
    const killer = spawn(treeKillCommand, ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      killDirect(killer);
      killDirect(child);
    }, 1_000);
    timeout.unref();
    killer.once("error", () => {
      clearTimeout(timeout);
      killDirect(child);
    });
    killer.once("close", () => clearTimeout(timeout));
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    killDirect(child);
  }
};

export const runQualityCheck = async (
  options: RunQualityCheckOptions,
): Promise<QualityCheckExecution> => {
  const startedAt = performance.now();
  const { definition } = options.check;
  const args = definition.fileMode === "append"
    ? [...definition.args, ...options.check.paths]
    : [...definition.args];
  const maxOutputChars = Math.max(0, Math.floor(options.maxOutputChars));
  let output = "";
  let outputTruncated = false;

  const capture = (chunk: Uint8Array | string): void => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const remaining = Math.max(0, maxOutputChars - output.length);
    output += text.slice(0, remaining);
    if (text.length > remaining) outputTruncated = true;
  };

  const result = (
    outcome: QualityCheckOutcome,
    exitCode?: number,
  ): QualityCheckExecution => ({
    checkId: definition.id,
    outcome,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output ? { output } : {}),
    outputTruncated,
    durationMs: performance.now() - startedAt,
  });

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(definition.command, args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    capture(errorMessage(error));
    return result("crashed");
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let terminationFallback: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      terminationFallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish("timed_out");
      }, 1_000);
    }, Math.max(1, definition.timeoutMs));

    const finish = (outcome: QualityCheckOutcome, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationFallback) clearTimeout(terminationFallback);
      resolve(result(outcome, exitCode));
    };

    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => {
      if (timedOut) {
        finish("timed_out");
      } else {
        capture(errorMessage(error));
        finish("crashed");
      }
    });
    child.once("close", (code) => {
      if (timedOut) {
        finish("timed_out", code ?? undefined);
      } else if (code === 0) {
        finish("passed", 0);
      } else if (typeof code === "number") {
        finish("failed", code);
      } else {
        finish("crashed");
      }
    });
  });
};

export const runQualityChecks = async (
  options: RunQualityChecksOptions,
): Promise<QualityCheckExecution[]> => {
  const results: QualityCheckExecution[] = [];
  for (const check of options.checks) {
    results.push(await runQualityCheck({ ...options, check }));
  }
  return results;
};
