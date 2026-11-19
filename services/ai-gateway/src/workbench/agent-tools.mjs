/**
 * Workspace tools injected into cloud agents.
 *
 * Cloud models (豆包 / Kimi / DeepSeek …) are plain chat completions: without
 * tools they can only talk. This module gives them the three things every real
 * coding agent has — read a file, write a file, run a command — scoped to one
 * run's working directory.
 *
 * Boundaries, stated plainly because they matter:
 *   - Every path resolves inside `cwd`; anything else is refused, no exceptions.
 *   - `run_cmd` is a safety net, not a sandbox. Dangerous shapes are blocked and
 *     every call is bounded by a timeout, but a shell is a shell.
 *   - Each step gets its own counter, so a looping model cannot burn the run.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const TOOL_MODES = ["auto", "files", "none"];
export const DEFAULT_MAX_CALLS = 30;
export const MAX_ROUNDS = 8;

const MAX_READ_BYTES = 64 * 1024;
const MAX_READ_LINES = 1500;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST = 200;
const MAX_CMD_OUTPUT = 8 * 1024;
const DEFAULT_CMD_TIMEOUT = 60_000;
const MAX_CMD_TIMEOUT = 300_000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", "dist", "build", "coverage", "__pycache__", ".venv", "venv",
]);

const SCHEMAS = {
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作目录内的一个文本文件。路径相对工作目录，也可用绝对路径（必须在工作目录内）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，例如 src/server.js" },
          start_line: { type: "integer", description: "可选，从第几行开始（1 起）" },
          end_line: { type: "integer", description: "可选，读到第几行为止" },
        },
        required: ["path"],
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "把内容写入工作目录内的文件，目录不存在会自动创建，同名文件会被覆盖。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，例如 src/server.js" },
          content: { type: "string", description: "完整文件内容，不要省略号占位" },
        },
        required: ["path", "content"],
      },
    },
  },
  list_files: {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作目录（或其中某个子目录）下的文件，带大小，用于确认上游产出了什么。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "可选，目录路径，默认工作目录根" },
          depth: { type: "integer", description: "可选，递归层数 1-3，默认 1" },
        },
      },
    },
  },
  run_cmd: {
    type: "function",
    function: {
      name: "run_cmd",
      description: "在工作目录内执行一条 shell 命令，返回退出码与输出。用于跑测试、构建、查看目录。命令会真实执行。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令，例如 npm test" },
          timeout_ms: { type: "integer", description: "可选，超时毫秒，默认 60000，最大 300000" },
        },
        required: ["command"],
      },
    },
  },
};

/** The tool list for one step, by permission mode. */
export function toolSchemasFor(mode = "auto") {
  if (mode === "none") return [];
  const names = mode === "files" ? ["read_file", "write_file", "list_files"] : Object.keys(SCHEMAS);
  return names.map((name) => SCHEMAS[name]);
}

/** Appended to the system prompt only when tools are on. */
export const TOOL_RULES = `【工具已开启】你的上一条规则中"不能访问本机文件系统"不再适用：
你现在可以通过工具读写工作目录内的文件${"{commands}"}。工作目录是 {cwd}。

使用规则：
1. 需要落地代码或文档时，直接用 write_file 写文件；不要只在回答里贴代码然后声称"已保存"。
2. 读取上游产出时用提示词里给出的路径配合 read_file，不要凭记忆猜测文件内容。
3. 同一个失败的工具调用最多换一种方式重试一次，不要重复同样的调用。
4. 回答末尾用「## 产出文件」列出你实际用 write_file 写过的路径，一行一个。`;

/**
 * Force a model-supplied path inside `root`.
 * @returns {{absolute:string, relative:string}|null} null means rejected.
 */
export function confineToRoot(root, rawPath) {
  const raw = String(rawPath ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!raw) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const unified = raw.replace(/\\/g, "/");
  const base = resolve(root);
  const absolute = isAbsolute(unified) ? resolve(unified) : resolve(base, unified);
  const guard = base.endsWith(sep) ? base : `${base}${sep}`;
  if (absolute !== base && !absolute.startsWith(guard)) return null;
  return { absolute, relative: relative(base, absolute).replace(/\\/g, "/") };
}

const DANGEROUS = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~)(\s|$)/, reason: "删除根目录" },
  { pattern: /\b(mkfs|fdisk|diskpart)\b/i, reason: "磁盘格式化" },
  { pattern: /(^|\s)format\s+[a-zA-Z]:/i, reason: "格式化磁盘" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "关机或重启" },
  { pattern: /\bdel\s+\/[sfq]/i, reason: "批量删除" },
  { pattern: /\b(rd|rmdir)\s+\/[sq]/i, reason: "批量删除目录" },
  { pattern: /\bRemove-Item\b[\s\S]*(-Recurse[\s\S]*-Force|-Force[\s\S]*-Recurse)/i, reason: "递归强制删除" },
  { pattern: /:\s*\(\s*\)\s*\{/, reason: "fork 炸弹" },
  { pattern: /\bgit\s+push\b/i, reason: "推送远端仓库" },
  { pattern: /\bcurl\b[^\n|]*\|\s*(bash|sh|zsh)\b/i, reason: "下载脚本直接执行" },
];

/** @returns {string|null} the matched reason, or null when the command looks safe. */
export function dangerousCommand(command) {
  const text = String(command ?? "");
  for (const rule of DANGEROUS) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

const countLines = (text) => (text ? text.split("\n").length : 0);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…（输出已截断，共 ${text.length} 字）` : text);

/**
 * One step's tool sandbox.
 * `files()` returns everything the model actually wrote, for the run index.
 */
export function createToolSandbox({
  cwd,
  runDir = null,
  mode = "auto",
  maxCalls = DEFAULT_MAX_CALLS,
  allowCommands = true,
} = {}) {
  if (!cwd) throw new Error("tool sandbox requires a cwd");
  const root = resolve(cwd);
  const activeMode = TOOL_MODES.includes(mode) ? mode : "auto";
  const written = new Map();
  let calls = 0;

  const commandAllowed = allowCommands && activeMode === "auto";

  const fail = (message) => `错误：${message}`;

  const resolveForWrite = (rawPath) => {
    const confined = confineToRoot(root, rawPath);
    if (!confined) return null;
    if (confined.relative === "") return null;
    const lower = confined.relative.toLowerCase();
    if (lower === ".git" || lower.startsWith(".git/")) return null;
    return confined;
  };

  const read = ({ path: rawPath, start_line, end_line } = {}) => {
    const confined = confineToRoot(root, rawPath);
    if (!confined || confined.relative === "") return fail(`路径不合法或超出工作目录：${rawPath ?? ""}`);
    let stat;
    try {
      stat = statSync(confined.absolute);
    } catch {
      return fail(`文件不存在：${confined.relative}`);
    }
    if (!stat.isFile()) return fail(`${confined.relative} 不是文件`);
    if (stat.size > MAX_READ_BYTES * 8) {
      return fail(`${confined.relative} 有 ${Math.round(stat.size / 1024)}KB，太大；请用 start_line/end_line 分段读取`);
    }
    let content;
    try {
      content = readFileSync(confined.absolute, "utf8");
    } catch (error) {
      return fail(`读取失败：${error?.message || error}`);
    }
    const lines = content.split("\n");
    const from = Number.isInteger(start_line) && start_line > 0 ? start_line : 1;
    const to = Number.isInteger(end_line) && end_line >= from ? Math.min(end_line, lines.length) : lines.length;
    let slice = lines.slice(from - 1, to);
    if (slice.length > MAX_READ_LINES) slice = slice.slice(0, MAX_READ_LINES);
    let body = slice.join("\n");
    if (body.length > MAX_READ_BYTES) body = `${body.slice(0, MAX_READ_BYTES)}\n…（内容已截断）`;
    const range = from === 1 && to === lines.length ? "" : `（第 ${from}-${to} 行，共 ${lines.length} 行）`;
    return `文件 ${confined.relative}${range}：\n${body}`;
  };

  const write = ({ path: rawPath, content } = {}) => {
    const confined = resolveForWrite(rawPath);
    if (!confined) return fail(`路径不合法或超出工作目录：${rawPath ?? ""}`);
    const body = typeof content === "string" ? content : String(content ?? "");
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_WRITE_BYTES) {
      return fail(`内容 ${Math.round(bytes / 1024)}KB 超过单文件上限 ${MAX_WRITE_BYTES / 1024}KB，请拆成多个文件`);
    }
    try {
      mkdirSync(dirname(confined.absolute), { recursive: true });
      const temp = `${confined.absolute}.${process.pid}.tmp`;
      writeFileSync(temp, body, "utf8");
      renameSync(temp, confined.absolute);
    } catch (error) {
      return fail(`写入失败：${error?.message || error}`);
    }
    written.set(confined.relative, {
      path: confined.relative,
      absolute: confined.absolute,
      bytes,
      lines: countLines(body),
      note: "",
      source: "tool",
    });
    return `已写入 ${confined.relative}（${countLines(body)} 行 / ${bytes} 字节）`;
  };

  const list = ({ path: rawPath = "", depth = 1 } = {}) => {
    const confined = rawPath ? confineToRoot(root, rawPath) : { absolute: root, relative: "" };
    if (!confined) return fail(`路径不合法或超出工作目录：${rawPath}`);
    let stat;
    try {
      stat = statSync(confined.absolute);
    } catch {
      return fail(`目录不存在：${confined.relative || "."}`);
    }
    if (!stat.isDirectory()) return fail(`${confined.relative} 不是目录`);
    const levels = Math.min(Math.max(Number(depth) || 1, 1), 3);
    const rows = [];
    const walk = (dir, level) => {
      if (rows.length >= MAX_LIST) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (rows.length >= MAX_LIST) return;
        if (entry.name.startsWith(".") && entry.name !== ".flows") continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const absolute = resolve(dir, entry.name);
        const shown = relative(root, absolute).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          rows.push(`${shown}/`);
          if (level < levels) walk(absolute, level + 1);
        } else {
          let size = 0;
          try { size = statSync(absolute).size; } catch { /* 读不到大小不影响列出 */ }
          rows.push(`${shown}  ${size}B`);
        }
      }
    };
    walk(confined.absolute, 1);
    if (!rows.length) return `${confined.relative || "."} 下没有文件`;
    const more = rows.length >= MAX_LIST ? `\n…（只列前 ${MAX_LIST} 项）` : "";
    return `工作目录 ${confined.relative || "."} 的内容：\n${rows.join("\n")}${more}`;
  };

  const runCommand = ({ command, timeout_ms } = {}) => new Promise((done) => {
    const text = String(command ?? "").trim();
    if (!text) return done(fail("命令为空"));
    if (!commandAllowed) return done(`错误：本步骤未开启命令执行权限（模式 ${activeMode}）`);
    const blocked = dangerousCommand(text);
    if (blocked) return done(`错误：命令被拦截（${blocked}）。这类操作需要人工确认后自行执行。`);
    const timeout = Math.min(Math.max(Number(timeout_ms) || DEFAULT_CMD_TIMEOUT, 1000), MAX_CMD_TIMEOUT);
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(payload);
    };
    try {
      child = spawn(text, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
    } catch (error) {
      return done(fail(`启动命令失败：${error?.message || error}`));
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* 杀不掉也要把结果交回去 */ }
      finish(`错误：命令超过 ${timeout}ms 未结束，已终止。\n已捕获输出：\n${clip(stdout + stderr, MAX_CMD_OUTPUT)}`);
    }, timeout);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(fail(`命令执行失败：${error?.message || error}`)));
    child.on("close", (code) => {
      const parts = [`退出码 ${code ?? "unknown"}`];
      if (stdout.trim()) parts.push(`stdout:\n${clip(stdout.trim(), MAX_CMD_OUTPUT)}`);
      if (stderr.trim()) parts.push(`stderr:\n${clip(stderr.trim(), MAX_CMD_OUTPUT / 2)}`);
      finish(parts.join("\n"));
    });
  });

  const execute = async (name, args = {}) => {
    calls += 1;
    if (calls > maxCalls) {
      return `错误：本步骤工具调用已达上限（${maxCalls} 次）。请基于已有信息给出结论，不要再调用工具。`;
    }
    switch (name) {
      case "read_file": return read(args ?? {});
      case "write_file": return write(args ?? {});
      case "list_files": return list(args ?? {});
      case "run_cmd": return runCommand(args ?? {});
      default: return fail(`未知工具：${name}。可用工具：${toolSchemasFor(activeMode).map((item) => item.function.name).join("、")}`);
    }
  };

  return {
    cwd: root,
    runDir: runDir ? resolve(runDir) : null,
    mode: activeMode,
    allowCommands: commandAllowed,
    maxCalls,
    get calls() { return calls; },
    execute,
    files: () => [...written.values()],
    systemRules: () => TOOL_RULES
      .replace("{cwd}", root.replace(/\\/g, "/"))
      .replace("{commands}", commandAllowed ? "、执行命令" : ""),
  };
}
