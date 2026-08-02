import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectRun(error);
    else resolveRun(result);
  };
  const append = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
      child.kill();
      finish(new Error(`${command} exceeded the 2 MiB smoke-test output limit`));
    }
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.on("error", (error) => finish(error));
  child.on("close", (code, signal) => finish(undefined, { code, signal, stdout, stderr }));
  const timeout = setTimeout(() => {
    child.kill();
    finish(new Error(`${command} timed out after ${options.timeoutMs ?? 60_000}ms`));
  }, options.timeoutMs ?? 60_000);
  child.stdin.end(options.input ?? "");
});

const requireSuccess = (result, label) => {
  if (result.code === 0) return result;
  throw new Error([
    `${label} failed with exit code ${result.code ?? "unknown"}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join("\n"));
};

const tempRoot = await mkdtemp(join(tmpdir(), "ultra-fabric-package-smoke-"));
try {
  const packed = requireSuccess(await run(npmCommand, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    tempRoot,
  ], { cwd: projectRoot }), "npm pack");
  const packResult = JSON.parse(packed.stdout);
  const packEntry = Array.isArray(packResult)
    ? packResult[0]
    : Object.values(packResult)[0];
  const filename = packEntry?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");

  const installRoot = join(tempRoot, "install");
  await mkdir(installRoot, { recursive: true });
  requireSuccess(await run(npmCommand, [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    join(tempRoot, filename),
  ], { cwd: tempRoot, timeoutMs: 120_000 }), "isolated package install");

  const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piCli = join(dirname(codingAgentEntry), "cli.js");
  const extension = join(installRoot, "node_modules", "ultra-fabric", "dist", "index.js");
  const agentDir = join(tempRoot, "agent");
  await mkdir(agentDir, { recursive: true });
  const rpc = requireSuccess(await run(process.execPath, [
    piCli,
    "--mode", "rpc",
    "--no-session",
    "--no-approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--extension", extension,
  ], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
    input: '{"id":"commands","type":"get_commands"}\n',
    timeoutMs: 45_000,
  }), "isolated Pi RPC load");

  const responses = rpc.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const response = responses.find((item) => item.id === "commands" && item.type === "response");
  const commands = response?.success === true && Array.isArray(response.data?.commands)
    ? response.data.commands
    : [];
  if (!commands.some((command) => command?.name === "fabric" && command?.source === "extension")) {
    throw new Error("isolated Pi load did not register the /fabric command");
  }
  console.log("Pi package smoke passed: /fabric registered from packed extension");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
