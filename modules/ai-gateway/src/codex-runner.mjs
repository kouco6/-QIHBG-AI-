import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const PROXY_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
// Belt and braces: even with the proxy vars stripped, an intermediate layer
// (corporate agent, Codex's own updater) may re-add them.
const NO_PROXY_HOSTS =
  "127.0.0.1,localhost,::1,api.openai.com,.openai.com,chatgpt.com,.chatgpt.com,auth.openai.com";

let useSystemProxy = false;

/** Escape hatch for networks that can only reach the upstream through a proxy. */
export const applyProxyPolicy = (value) => {
  useSystemProxy = value === true;
};

// Resolved by config at startup (see findCodexBinary). The bare name only works
// when the launcher prepended Codex's bin dir to PATH — which is exactly the
// assumption that breaks when the gateway is started any other way.
let codexCommand = "codex";

/** Point the runner at an explicit codex executable. */
export const applyCodexCommand = (value) => {
  if (typeof value === "string" && value.trim()) codexCommand = value.trim();
};

export const getCodexCommand = () => codexCommand;

const DEFAULT_SILENCE_WARN_MS = 5 * 60 * 1000;
const SILENCE_FLOOR_MS = 30_000;
const SILENCE_POLL_MS = 15_000;
let silenceWarnMs = DEFAULT_SILENCE_WARN_MS;

/**
 * How long Codex may stay quiet before we report it. This is an observation
 * threshold, not a kill switch: a long reasoning turn emits nothing for minutes
 * and is still healthy, so we surface the gap and leave the process untouched.
 */
export const applySilencePolicy = (ms) => {
  const parsed = Number.parseInt(String(ms ?? ""), 10);
  if (parsed === 0) {
    silenceWarnMs = 0;
    return;
  }
  silenceWarnMs = Number.isFinite(parsed) && parsed >= SILENCE_FLOOR_MS ? parsed : DEFAULT_SILENCE_WARN_MS;
};

/**
 * Codex is a long-lived child, so it inherits whatever process.env says at spawn
 * time. The host app can inject HTTP(S)_PROXY pointing at a loopback proxy.
 * Default to an explicit direct environment for reproducibility and keep the
 * proxy opt-in. A 2026-10-22 interleaved 10x10 benchmark did not reproduce an
 * earlier single-run 2.5x slowdown; both modes instead showed stochastic tails.
 */
export function buildCodexEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    // Windows env keys are case-insensitive, but they can arrive in any casing.
    if (!useSystemProxy && PROXY_KEYS.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  if (!useSystemProxy) {
    env.NO_PROXY = NO_PROXY_HOSTS;
    env.no_proxy = NO_PROXY_HOSTS;
  }
  // Codex expects codex-code-mode-host.exe next to itself; prepending its dir
  // keeps that lookup working even when the gateway inherited a bare PATH.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${dirname(codexCommand)};${env[pathKey] ?? ""}`;
  return env;
}

export function getCodexVersion() {
  const result = spawnSync(codexCommand, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function appendTuning(args, task) {
  if (task.model) args.push("--model", task.model);
  // Reasoning effort affects latency, but it is not a transport-reliability
  // control. Keep it explicit so benchmarks can compare like with like.
  if (task.reasoningEffort) args.push("-c", `model_reasoning_effort="${task.reasoningEffort}"`);
}

function buildArgs(task) {
  if (task.threadId) {
    // `codex exec resume` has no --sandbox / --approve-for-me flags, so without
    // these overrides the requested mode is silently dropped and Codex falls
    // back to its own default (read-only in practice) — a resume that asked for
    // workspace-write could not write a single file. Restore the mode via -c.
    const mode = task.mode === "workspace-write" ? "workspace-write" : "read-only";
    const args = [
      "exec", "resume", "--json", "--skip-git-repo-check",
      "-c", `sandbox_mode="${mode}"`,
    ];
    if (mode === "workspace-write") args.push("-c", 'approval_policy="never"');
    appendTuning(args, task);
    args.push(task.threadId, "-");
    return args;
  }

  // `--sandbox` and `--approve-for-me` are mutually exclusive in Codex 0.163
  // (approve-for-me already implies the workspace-write sandbox), so combining
  // them made every workspace-write run die with exit code 2. Drive the mode
  // through -c instead, which works for both exec and exec resume.
  const mode = task.mode === "workspace-write" ? "workspace-write" : "read-only";
  const args = [
    "exec",
    "--json",
    "--color", "never",
    "--skip-git-repo-check",
    "-c", `sandbox_mode="${mode}"`,
  ];
  // mode "web"（查价等旁路任务）：只读沙箱 + 放行联网检索
  if (task.mode === "web") args.push("--search");
  if (mode === "workspace-write") args.push("-c", 'approval_policy="never"');
  appendTuning(args, task);
  args.push("-");
  return args;
}

export function runCodexTask(task, { emit, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexCommand, buildArgs(task), {
      cwd: task.cwd,
      env: buildCodexEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let threadId = task.threadId || null;
    let finalResponse = "";
    let settled = false;
    let closed = false;
    let exitCode = null;
    let exitSignal = null;
    let spawnError = null;
    let stopError = null;
    let forceKillTimer = null;
    let forceStopPromise = null;

    // Silence watchdog. Emits one event per elapsed threshold multiple (5m, 10m,
    // 15m …) so the UI can show a growing, factual gap instead of a frozen card.
    // It never signals the child — a quiet turn is not a broken turn.
    let lastOutputAt = Date.now();
    let silenceNotified = 0;
    let silenceTimer = null;

    const noteOutput = () => {
      lastOutputAt = Date.now();
      // A recovered run must be able to warn again on its next quiet stretch,
      // otherwise the counter stays latched at its old high-water mark.
      silenceNotified = 0;
    };

    const stopSilenceWatch = () => {
      if (silenceTimer) clearInterval(silenceTimer);
      silenceTimer = null;
    };

    silenceTimer = silenceWarnMs > 0 ? setInterval(() => {
      if (closed || settled) return;
      const silentMs = Date.now() - lastOutputAt;
      const multiples = Math.floor(silentMs / silenceWarnMs);
      if (multiples <= silenceNotified) return;
      silenceNotified = multiples;
      emit("silence", {
        silentSeconds: Math.round(silentMs / 1000),
        thresholdSeconds: Math.round(silenceWarnMs / 1000),
        lastOutputAt: new Date(lastOutputAt).toISOString(),
      });
    }, SILENCE_POLL_MS) : null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      stopSilenceWatch();
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ threadId, finalResponse });
    };

    const forceStop = () => {
      if (forceStopPromise) return forceStopPromise;
      if (!child.pid) return Promise.resolve({ attempted: false, exitCode: null });
      // `child.killed` only reports that a signal was handed over, not that the
      // process died, and Codex spawns helpers that outlive the CLI itself.
      // Reap the whole tree by pid and record the reaper's actual result.
      forceStopPromise = new Promise((done) => {
        if (process.platform !== "win32") {
          try {
            process.kill(child.pid, "SIGKILL");
            emit("process", { phase: "reaped", pid: child.pid, method: "SIGKILL", exitCode: 0 });
            done({ attempted: true, exitCode: 0 });
          } catch (error) {
            emit("process", { phase: "reaped", pid: child.pid, method: "SIGKILL", error: error?.message || String(error) });
            done({ attempted: true, exitCode: null });
          }
          return;
        }
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", (error) => {
          emit("process", { phase: "reaped", pid: child.pid, method: "taskkill", error: error?.message || String(error) });
          done({ attempted: true, exitCode: null });
        });
        killer.once("close", (code) => {
          emit("process", { phase: "reaped", pid: child.pid, method: "taskkill", exitCode: code });
          done({ attempted: true, exitCode: code });
        });
      });
      return forceStopPromise;
    };

    const stop = (error) => {
      // A second signal path (cancel while timing out) must not re-arm the timer.
      if (stopError) return;
      stopError = error;
      if (closed) return;
      // Ask politely first so Codex can flush its JSONL tail, then reap the tree.
      if (!child.killed) child.kill();
      if (!forceKillTimer) forceKillTimer = setTimeout(forceStop, 1_500);
    };

    const onAbort = () => {
      const error = new Error("Task cancelled");
      error.name = "AbortError";
      stop(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      const error = new Error(`Task timed out after ${timeoutMs} ms`);
      error.code = "TASK_TIMEOUT";
      stop(error);
    }, timeoutMs);

    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("exit", (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
    });
    child.on("close", (code, closeSignal) => {
      closed = true;
      exitCode ??= code;
      exitSignal ??= closeSignal;
      emit("process", { phase: "closed", pid: child.pid, exitCode, exitSignal });
      if (stopError) {
        // The direct child is gone, but helpers it spawned may still hold the
        // working directory open. Fire the tree kill here instead of letting
        // finish() clear the timer that was supposed to do it.
        return forceStop().finally(() => finish(stopError));
      }
      if (spawnError) return finish(spawnError);
      if (exitCode === 0) return finish();
      const error = new Error(`Codex exited with code ${exitCode ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}`);
      error.code = "CODEX_EXIT";
      finish(error);
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      if (closed) return;
      if (!line.trim()) return;
      noteOutput();
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalResponse = event.item.text ?? finalResponse;
        }
        emit("codex", event);
      } catch {
        emit("stdout", { text: line });
      }
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (closed) return;
      if (!line.trim()) return;
      noteOutput();
      emit("stderr", { text: line });
    });

    child.stdin.end(task.prompt);
    emit("process", { phase: "started", pid: child.pid, command: codexCommand, args: buildArgs(task) });
    if (signal?.aborted) onAbort();
  });
}

