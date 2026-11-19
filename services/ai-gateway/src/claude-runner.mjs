/**
 * 本机 Claude Code 执行器（对应 codex-runner.mjs）。
 *
 * 和 Codex 一样是「本机 CLI 员工」：网关 spawn 一次 `claude -p`，读它的
 * stream-json 事件流，把文本/工具调用翻译成前端认识的 agent 事件。
 * 上游是谁（官方、CC Switch 代理、中转）由 Claude Code 自己的
 * ~/.claude/settings.json 决定，网关不碰凭据，也不替它选模型。
 *
 * 为什么不用 `--output-format json`：那个只在结束时吐一坨，长任务会看起来
 * 像卡死；stream-json 能让「正在改哪个文件」实时显示出来。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

let claudeCommand = "";

/** 显式指定可执行文件（配置文件 claudeCommand / 环境变量）。 */
export const applyClaudeCommand = (value) => {
  if (typeof value === "string" && value.trim()) claudeCommand = value.trim();
};

/**
 * Claude Code 2.x 在 Windows 上装的是原生 exe（不是 npm 的 .cmd 壳），
 * 直接 spawn exe 既不用 shell，也不会有 .cmd 注入问题。
 * 探测顺序：显式配置 → npm 全局包的 bin → 用户目录常见位置 → PATH。
 */
export function findClaudeBinary(env = process.env) {
  if (claudeCommand) return claudeCommand;
  const home = env.USERPROFILE || env.HOME || "";
  const appData = env.APPDATA || "";
  const candidates = [];
  if (env.WORKBUDDY_CLAUDE_PATH?.trim()) candidates.push(env.WORKBUDDY_CLAUDE_PATH.trim());
  if (appData) {
    candidates.push(join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }
  if (home) {
    candidates.push(join(home, ".local", "bin", "claude.exe"));
    candidates.push(join(home, ".local", "bin", "claude"));
    candidates.push(join(home, ".claude", "local", "claude.exe"));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      claudeCommand = candidate;
      return candidate;
    }
  }
  // 最后一次机会：交给 PATH（start.ps1 起的实例通常已经带上了 npm 目录）
  claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  return claudeCommand;
}

export function getClaudeVersion() {
  const bin = findClaudeBinary();
  try {
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      shell: process.platform === "win32" && bin.endsWith(".cmd"),
    });
    if (result.status !== 0) return null;
    return (result.stdout || "").trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * 非交互模式下没有「弹窗问你同不同意」，所以权限必须开成自动：
 * - read-only → plan（只读分析，不动文件）
 * - workspace-write → bypassPermissions（和 Codex 的 workspace-write 对齐）
 */
export function buildClaudeArgs(task) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (task.model) args.push("--model", task.model);
  if (task.mode === "read-only") args.push("--permission-mode", "plan");
  else if (task.mode === "web") {
    // 专给「联网查资料」类旁路任务。踩过的坑：
    // - plan 模式：上游模型会拿「plan 不能输出」当借口拒跑；
    // - WebFetch/WebSearch：走中转上游时抓不到外网（实测多次返回空）。
    // 最终形态：bypass 权限 + 只禁写文件类工具。查网页靠 Bash 里的 curl
    // （curl 认系统代理，实测可用）；写文件这条路被工具黑名单堵死。
    args.push(
      "--permission-mode", "bypassPermissions",
      "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit",
    );
  } else args.push("--dangerously-skip-permissions");
  if (task.threadId) args.push("--resume", task.threadId);
  return args;
}

/** Claude 的 usage 字段名和网关内部口径不同，这里一次性摊平。 */
export function normalizeClaudeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const cached = num(raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  // input_tokens 不含缓存部分；缓存读按输入计，缓存写也算输入（单价更高，但网关只记 token）
  const promptTokens = num(raw.input_tokens) + cached + cacheWrite;
  const completionTokens = num(raw.output_tokens);
  const total = promptTokens + completionTokens;
  if (!total) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens: total,
    cachedTokens: cached,
    reasoningTokens: 0,
  };
}

const ERROR_HINTS = [
  [/invalid api key|please run \/login|unauthorized|401/i, "Claude Code 没有可用的登录态：先在本机终端跑一次 claude，确认能用再来派活"],
  [/ECONNREFUSED|connect failed|fetch failed|socket hang up/i, "连不上 Claude Code 的上游：检查 CC Switch 之类的本地代理是否在运行（settings.json 里的 ANTHROPIC_BASE_URL）"],
  [/credit balance|quota|rate limit|429/i, "上游额度不足或被限流"],
];

const explain = (text) => {
  for (const [pattern, hint] of ERROR_HINTS) {
    if (pattern.test(text)) return hint;
  }
  return "";
};

/**
 * 跑一次 Claude Code。
 * 返回 { threadId, finalResponse, usage }，失败时抛带人话提示的错误。
 */
export function runClaudeTask(task, { emit, signal, timeoutMs, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findClaudeBinary();
    const args = buildClaudeArgs(task);
    const child = spawnImpl(bin, args, {
      cwd: task.cwd,
      env: process.env,
      shell: process.platform === "win32" && bin.endsWith(".cmd"),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let sessionId = task.threadId || null;
    let finalResponse = "";
    let narrative = "";
    // 两条兜底文本流：上游有时不给 result.result（中转实现差异），
    // 那时用 assistant 整段 / partial 增量拼回来，别把成功当失败。
    let turnText = "";
    let streamText = "";
    let startedEmitted = false;
    let usage = null;
    let model = task.model || null;
    let toolRounds = 0;
    let settled = false;
    let closed = false;
    let exitCode = null;
    let spawnError = null;
    let stopError = null;
    let stderrTail = "";
    let forceKillTimer = null;
    let timeout = null;

    // tool_use_id → 工具名，Claude 的 tool_result 只回 id，不带名字
    const toolNames = new Map();
    // 它明确写过的文件：只认 Write/Edit 的目标路径，比扫目录准
    const writtenFiles = new Set();
    const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ threadId: sessionId, finalResponse, usage, toolRounds, files: [...writtenFiles] });
    };

    const killTree = () => {
      if (!child.pid) return Promise.resolve();
      return new Promise((done) => {
        if (process.platform !== "win32") {
          try { process.kill(child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
          done();
          return;
        }
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", done);
        killer.once("close", done);
      });
    };

    const stop = (error) => {
      if (stopError) return;
      stopError = error;
      if (closed) return;
      if (!child.killed) child.kill();
      if (!forceKillTimer) forceKillTimer = setTimeout(killTree, 1_500);
    };

    const onAbort = () => {
      const error = new Error("Task cancelled");
      error.name = "AbortError";
      stop(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      const error = new Error(`Task timed out after ${timeoutMs} ms`);
      error.code = "TASK_TIMEOUT";
      stop(error);
    }, timeoutMs);

    child.on("error", (error) => { spawnError = error; });
    child.on("exit", (code) => { exitCode = code; });
    child.on("close", (code) => {
      closed = true;
      exitCode ??= code;
      emit("process", { phase: "closed", pid: child.pid, exitCode });
      if (stopError) {
        return killTree().finally(() => finish(stopError));
      }
      if (spawnError) {
        const error = new Error(`启动 Claude Code 失败（${bin}）：${spawnError.message}`);
        error.code = "CLAUDE_SPAWN";
        return finish(error);
      }
      // result 事件没带 result 字段（部分中转会这样），用已收到的文本兜底
      if (!finalResponse.trim()) finalResponse = streamText || turnText;
      if (!finalResponse.trim()) {
        // 没有 result 事件就退出 = 上游/登录/权限层面出错，别报「成功但空结果」
        const detail = stderrTail.trim().split(/\r?\n/).slice(-4).join("\n");
        const hint = explain(`${detail}\n${narrative}`);
        const error = new Error(
          hint
            ? `Claude Code 没有返回结果：${hint}${detail ? `\n${detail}` : ""}`
            : `Claude Code 没有返回结果（退出码 ${exitCode ?? "null"}）${detail ? `\n${detail}` : ""}`,
        );
        error.code = "CLAUDE_EMPTY";
        return finish(error);
      }
      if (exitCode !== 0 && !finalResponse.trim()) {
        const error = new Error(`Claude Code 退出码 ${exitCode}`);
        error.code = "CLAUDE_EXIT";
        return finish(error);
      }
      finish();
    });

    const handle = (event) => {
      if (!event || typeof event !== "object") return;

      if (event.type === "system" && event.subtype === "init") {
        if (event.session_id) sessionId = event.session_id;
        if (event.model) model = event.model;
        emit("process", {
          phase: "started",
          pid: child.pid,
          command: bin,
          args,
          sessionId: sessionId ?? undefined,
          model: model ?? undefined,
        });
        return;
      }

      // 逐字增量（--include-partial-messages）；结构不熟就静默跳过，绝不让它中断任务
      if (event.type === "stream_event") {
        const delta = event.event?.delta;
        if (event.event?.type === "content_block_delta" && typeof delta?.text === "string" && delta.text) {
          streamText += delta.text;
          emit("agent", { type: "output.delta", agent: "claude", model, delta: delta.text });
        }
        return;
      }

      if (event.type === "assistant") {
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) return;
        let text = "";
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string") text += block.text;
          if (block?.type === "tool_use") {
            toolRounds += 1;
            if (block.id) toolNames.set(block.id, block.name);
            if (WRITE_TOOLS.has(block.name) && typeof block.input?.file_path === "string") {
              writtenFiles.add(block.input.file_path);
            }
            emit("agent", {
              type: "tool.started",
              agent: "claude",
              model,
              tool: block.name,
              args: JSON.stringify(block.input ?? {}).slice(0, 400),
            });
          }
        }
        if (text.trim()) {
          narrative = text;
          // 开了 partial 之后，一轮答复会被拆成多个 assistant 事件，
          // 直接首尾相接还原原文；插换行会得到「已\n创建 `claude\n-demo.md`」这种碎句
          turnText = turnText ? `${turnText}${text}` : text;
          if (!startedEmitted) {
            startedEmitted = true;
            emit("agent", { type: "item.started", agent: "claude", model, item: { type: "agent_message", name: "Claude" } });
          }
        }
        return;
      }

      if (event.type === "user") {
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          if (block?.type !== "tool_result") continue;
          const tool = toolNames.get(block.tool_use_id) ?? "tool";
          const text = Array.isArray(block.content)
            ? block.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
            : String(block.content ?? "");
          emit("agent", {
            type: "tool.completed",
            agent: "claude",
            model,
            tool,
            ok: !block.is_error,
            result: text.slice(0, 800),
          });
        }
        return;
      }

      if (event.type === "result") {
        if (event.is_error) {
          const detail = typeof event.result === "string" ? event.result : "";
          const hint = explain(detail) || "Claude Code 报告了错误";
          const error = new Error(`${hint}${detail ? `：${detail.slice(0, 300)}` : ""}`);
          error.code = "CLAUDE_RESULT_ERROR";
          stopError = stopError ?? error;
          // result 已经到了，进程即将退出，直接结束比等 close 更快
          finish(error);
          return;
        }
        if (typeof event.result === "string" && event.result.trim()) finalResponse = event.result;
        // 增量流拼出来的文本最连贯，优先用它；没有 partial 时才退回 assistant 整段
        else finalResponse = streamText || turnText;
        usage = normalizeClaudeUsage(event.usage);
        if (event.duration_ms) {
          emit("agent", {
            type: "turn.completed",
            agent: "claude",
            model,
            finishReason: event.subtype ?? "success",
            durationMs: event.duration_ms,
            usage,
            toolRounds,
          });
        } else {
          emit("agent", { type: "turn.completed", agent: "claude", model, usage, toolRounds });
        }
      }
    };

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      if (!line.trim()) return;
      try {
        handle(JSON.parse(line));
      } catch {
        // 不是 JSON 的原样透出，方便排查上游打印的噪音
        emit("stdout", { text: line.slice(0, 500) });
      }
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (!line.trim()) return;
      stderrTail = `${stderrTail}\n${line}`.slice(-2000);
      emit("stderr", { text: line.slice(0, 500) });
    });

    emit("process", { phase: "spawned", pid: child.pid, command: bin, args });
    child.stdin.on("error", () => { /* 子进程提前退出时写 stdin 会 EPIPE，忽略 */ });
    child.stdin.end(task.prompt ?? "");
    if (signal?.aborted) onAbort();
  });
}
