#!/usr/bin/env node
/**
 * AI 执行器（多机部署的数据面）—— 跑在每个成员自己的电脑上。
 *
 *   node runner-agent.mjs init    配置服务器地址与个人 Token
 *   node runner-agent.mjs run     常驻：领任务 → 本机 Codex/Claude 执行 → 回传
 *   node runner-agent.mjs status  看连接状态
 *
 * 安全模型：
 * - Token 是服务器「人员与账号」里发给你的个人推送 Token，只能领到你名下的任务；
 * - 任务在哪个目录执行由你本机配置的 roots 决定，服务器只透传；
 * - 云端员工的 API Key 由服务器在派活瞬间下发，只存在本机内存里。
 *
 * 执行器与服务器之间的协议见 src/workbench/runner/api.mjs。
 */

import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform, hostname } from "node:os";
import { join, isAbsolute, resolve, sep, dirname, relative } from "node:path";

const VERSION = "1.3.0";
const CONFIG_FILE = join(homedir(), ".workbuddy-runner.json");
const CLAIM_INTERVAL_MS = 2500;
const HEARTBEAT_MS = 4000;
const REQUEST_TIMEOUT_MS = 15_000;

const log = (...args) => console.log(new Date().toLocaleTimeString("zh-CN", { hour12: false }), ...args);

const readConfig = () => {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return null; }
};

const saveConfig = (config) => writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const question = (text) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(text, (answer) => { rl.close(); resolve(answer.trim()); });
});

/* ---------------------------------------------------------------- HTTP */

/** 把用户填的服务器地址归一成 http://host:port；填错（比如把 Token 粘进来）就明确报错。 */
function normalizeServer(raw) {
  const text = String(raw ?? "").trim().replace(/^["'`]|["'`]$/g, "");
  if (!text) throw new Error("服务器地址不能为空，格式形如 http://192.168.1.10:4317");
  if (/^cb_/i.test(text) || /^(ghp_|sk-)/i.test(text)) {
    throw new Error("这里要填「服务器地址」（如 http://192.168.1.10:4317），不是 Token；Token 填下一项");
  }
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try { parsed = new URL(withScheme); } catch { throw new Error(`服务器地址格式不对：${text}`); }
  if (!parsed.hostname) throw new Error(`服务器地址格式不对：${text}`);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
}

async function api(config, path, { method = "GET", body } = {}) {
  const base = normalizeServer(config.server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `请求失败 ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- init / status */

/** 解析管理员发的配置码：WB1.<base64url(JSON{u:服务器地址, c:一次性码})>。 */
function parseConfigCode(raw) {
  const text = String(raw ?? "").trim().replace(/^["'`]|["'`]$/g, "");
  const match = text.match(/WB1\.([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const data = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return data.u && data.c ? data : null;
  } catch { return null; }
}

async function cmdInit() {
  const existing = readConfig() ?? {};

  // 首选路径：管理员发的一串配置码，粘贴即完成服务器地址 + Token
  const pasted = (await question(`粘贴管理员发的配置码（没有就直接回车，走手动填写）：`)).trim();
  let boot = null;
  if (pasted) {
    boot = parseConfigCode(pasted);
    if (!boot) {
      if (/^cb_/i.test(pasted)) {
        console.log("这串看着是 Token，不是配置码。可以选手动填写（下面把服务器地址和 Token 分开问），或者让管理员重新发一次配置码。");
      } else {
        console.log("配置码格式不对，请完整复制（以 WB1. 开头的一串）。");
      }
      return;
    }
    boot = { u: normalizeServer(boot.u), c: boot.c };
    try {
      const data = await api({ server: boot.u, token: "" }, "/api/runner/bootstrap", { method: "POST", body: { code: boot.c, server: boot.u } });
      if (!data.token) throw new Error("服务器没有返回 Token");
      saveConfig({ server: boot.u, token: data.token, codexCommand: existing.codexCommand || "codex", roots: existing.roots ?? [] });
      log(`已收到服务器下发的 Token（${data.accountName || ""}）`);
    } catch (error) {
      console.log(`配置码兑换失败：${error.message}`);
      return;
    }
  } else {
    let server;
    try {
      server = normalizeServer((await question(`服务器地址 [${existing.server || "http://…:4317"}]：`)) || existing.server);
    } catch (error) {
      console.log(error.message);
      process.exit(1);
    }
    const token = (await question(`个人 Token（在「人员与账号」里发给你，只显示一次）：`)) || existing.token;
    if (!token) { console.log("必须填 Token"); process.exit(1); }
    saveConfig({ server, token, codexCommand: existing.codexCommand || "codex", dshCommand: existing.dshCommand || "dsh", roots: existing.roots ?? [] });
    boot = { u: server };
  }

  // 剩两项轻量配置：允许目录 + Codex 命令（都有默认值，一路回车也能跑）
  const config = readConfig();
  const defaultRoots = (existing.roots ?? []).join(";");
  const roots = (await question(`允许 AI 读写的目录（分号分隔，直接回车 = 用默认「文档」目录）[${defaultRoots}]：`)) || defaultRoots
    || join(homedir(), "Documents");
  const codexCommand = (await question(`Codex 命令 [${config.codexCommand || "codex"}]：`)) || config.codexCommand || "codex";
  const dshCommand = (await question(`DeepSeek Harness 命令（不用 DSH 直接回车）[${config.dshCommand || "dsh"}]：`)) || config.dshCommand || "dsh";
  saveConfig({ ...config, codexCommand, dshCommand, roots: String(roots).split(/[;；]/).map((s) => s.trim()).filter(Boolean) });
  log("配置已写入", CONFIG_FILE);

  // 立刻验证一次：Token 对不对、能不能领到活
  try {
    const status = await api(config, "/api/runner/claim", { method: "POST", body: { version: VERSION } });
    log(`连接成功（${status.task ? "注意：已有一个待领任务，直接 run 会开始执行" : "没有待领任务"}）`);
  } catch (error) {
    console.log(`连接失败：${error.message}`);
    process.exitCode = 1;
  }
}

function cmdStatus() {
  const config = readConfig();
  if (!config) { console.log("还没配置，先跑 node runner-agent.mjs init"); return; }
  log("服务器:", config.server);
  log("Token:", `${String(config.token).slice(0, 8)}…`);
  log("roots:", (config.roots ?? []).join(" ; ") || "(空 = 只允许临时目录)");
  log("配置文件:", CONFIG_FILE);
  try { normalizeServer(config.server); } catch (error) {
    console.log(`配置有问题：${error.message}`);
    console.log("跑一次「重新配置执行器」把它改回来即可。");
  }
}

/* ---------------------------------------------------------------- 执行 */

/** 校验任务 cwd 必须落在允许目录里；返回绝对路径或抛错。 */
function resolveCwd(config, cwd) {
  const roots = (config.roots ?? []).map((root) => resolve(root));
  if (!cwd) {
    if (roots.length) return roots[0];
    throw new Error("任务没给工作目录，执行器也没配允许目录（node runner-agent.mjs init 重配 roots）");
  }
  const target = isAbsolute(cwd) ? resolve(cwd) : null;
  if (!target) throw new Error(`任务工作目录必须是绝对路径：${cwd}`);
  if (!existsSync(target)) throw new Error(`工作目录不存在：${target}`);
  const inside = roots.some((root) => target === root || target.startsWith(root + sep));
  if (!inside && roots.length) throw new Error(`工作目录不在允许范围内：${target}（允许：${roots.join("; ")}）`);
  return target;
}

/** 一次性把输出块送到服务器；失败只打日志，不能因为断网把任务搞挂。 */
const report = (config, path, body) =>
  api(config, path, { method: "POST", body }).catch((error) => log(`[回传失败，稍后重试] ${error.message}`));

/* ---------------------------------------------------------------- 子进程环境 */

const PROXY_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"]);

/**
 * CLI 子进程的环境：剥掉宿主代理，再把 CLI 所在目录放到 PATH 最前。
 *
 * 宿主应用（WorkBuddy、IDE 插件等）常注入指向本机环回口的 HTTP(S)_PROXY，
 * 直接继承给 Codex 会让它的所有外部请求走不通，表现为「退出码 1、只吐一条
 * 清理临时目录的警告」。网关侧一直是显式剥离的，执行器也必须一致。
 */
function buildChildEnv(command) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!PROXY_KEYS.has(key.toLowerCase())) env[key] = value;
  }
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.NO_PROXY;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${dirname(command)};${env[pathKey] ?? ""}`;
  return env;
}

/** Codex：复刻网关 exec 模式的参数与 JSON 事件解析。 */
function runCodex(config, task, { onOutput, signal }) {  return new Promise((resolve) => {
    const mode = task.mode === "read-only" ? "read-only" : "workspace-write";
    const args = [
      "exec", "--json", "--color", "never", "--skip-git-repo-check",
      "-c", `sandbox_mode="${mode}"`,
    ];
    if (mode === "workspace-write") args.push("-c", 'approval_policy="never"');
    if (task.model) args.push("--model", task.model);
    args.push("-");

    const command = config.codexCommand || "codex";
    const child = spawn(command, args, { cwd: task.cwd, env: buildChildEnv(command), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let finalResponse = "";
    let stderrTail = "";
    let eventError = "";

    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalResponse = event.item.text ?? finalResponse;
        }
        // 失败原因常在事件流里（turn.failed / error），比 stderr 的有用
        if (event.type === "error" || event.type === "turn.failed") {
          eventError = String(event.message ?? event.error?.message ?? event.error ?? "").slice(0, 500) || eventError;
        }
        onOutput(JSON.stringify(event).slice(0, 600));
      } catch {
        onOutput(line.slice(0, 600));
      }
    });
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-2000);
      onOutput(line.slice(0, 600));
    });

    const abort = () => { try { child.kill(); } catch { /* already gone */ } };
    if (signal) signal.addEventListener("abort", abort, { once: true });

    child.stdin.write(`${task.prompt}\n`);
    child.stdin.end();
    child.on("error", (error) => resolve({ ok: false, error: `Codex 启动失败：${error.message}` }));
    child.on("close", (code) => {
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, error: "任务已取消" });
      if (code === 0) return resolve({ ok: true, finalResponse: finalResponse || "(Codex 没有返回正文)" });
      const detail = eventError || stderrTail.trim().slice(-500);
      resolve({ ok: false, error: `Codex 退出码 ${code}${detail ? `：${detail}` : ""}` });
    });
  });
}

/** Claude Code：print 模式，纯文本结果。 */
function runClaude(config, task, { signal }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "text"];
    if (task.mode === "read-only") args.push("--permission-mode", "plan");
    if (task.model) args.push("--model", task.model);
    const claudeCommand = config.claudeCommand || "claude";
    const child = spawn(claudeCommand, args, {
      cwd: task.cwd, env: buildChildEnv(claudeCommand), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    createInterface({ input: child.stdout }).on("line", (line) => { output += `${line}\n`; });
    let stderrTail = "";
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-2000);
    });
    const abort = () => { try { child.kill(); } catch { /* already gone */ } };
    if (signal) signal.addEventListener("abort", abort, { once: true });
    child.stdin.write(`${task.prompt}\n`);
    child.stdin.end();
    child.on("error", (error) => resolve({ ok: false, error: `Claude 启动失败：${error.message}` }));
    child.on("close", (code) => {
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, error: "任务已取消" });
      if (code === 0) return resolve({ ok: true, finalResponse: output.trim() || "(Claude 没有返回正文)" });
      resolve({ ok: false, error: `Claude 退出码 ${code}${stderrTail ? `：${stderrTail.trim().slice(-500)}` : ""}` });
    });
  });
}

/** DeepSeek Harness：headless 模式，NDJSON 事件流，最终答案在 final 事件里。 */
function runDsh(config, task, { onOutput, signal }) {
  return new Promise((resolve) => {
    const mode = task.mode === "read-only" ? "read-only" : "workspace-write";
    // "-" 表示任务文本从 stdin 读：长 prompt 走 argv 在 Windows 上会被命令行长度和引号转义坑掉
    const args = ["--profile", "headless", "--json", "--permission-mode", mode];
    if (mode === "workspace-write") args.push("--approval-policy", "never");
    args.push("-");

    const command = config.dshCommand || "dsh";
    // Windows 上 npm 全局装出来的是 dsh.cmd 垫片，spawn 不带 shell 会 EINVAL；走 shell 让 cmd 自己解析 PATH
    const useShell = process.platform === "win32";
    const child = spawn(command, args, { cwd: task.cwd, env: buildChildEnv(command), shell: useShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let finalText = "";
    let lastText = "";
    let threadId = "";
    let stderrTail = "";
    let eventError = "";

    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === "final") finalText = String(event.text ?? "");
        else if (event.type === "text") lastText = String(event.text ?? "");
        else if (event.type === "session") threadId = String(event.sessionId ?? "");
        else if (event.type === "error") eventError = String(event.message ?? "").slice(0, 500) || eventError;
        else if (event.type === "tool_call") onOutput(`[工具] ${String(event.name ?? event.tool ?? "")} ${JSON.stringify(event.input ?? event.args ?? "").slice(0, 200)}`);
        onOutput(JSON.stringify(event).slice(0, 600));
      } catch {
        onOutput(line.slice(0, 600));
      }
    });
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-2000);
      onOutput(line.slice(0, 600));
    });

    const abort = () => { try { child.kill(); } catch { /* already gone */ } };
    if (signal) signal.addEventListener("abort", abort, { once: true });

    child.stdin.write(`${task.prompt}\n`);
    child.stdin.end();
    child.on("error", (error) => resolve({ ok: false, error: `DSH 启动失败：${error.message}` }));
    child.on("close", (code) => {
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, error: "任务已取消" });
      if (code === 0) return resolve({ ok: true, finalResponse: finalText || lastText || "(DSH 没有返回正文)", threadId: threadId || undefined });
      const detail = eventError || stderrTail.trim().slice(-500);
      resolve({ ok: false, error: `DSH 退出码 ${code}${detail ? `：${detail}` : ""}`, threadId: threadId || undefined });
    });
  });
}

/* ---------------------------------------------------------------- 云端员工的基础工具 */

/** 云端工具清单（OpenAI function calling 格式）。关掉 tools 开关就是纯文本模型。 */
const CLOUD_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索。查实时信息（天气、新闻、股价、产品动态等）时用，返回前几条结果的标题、链接和摘要。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词，可以用中文" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "读取一个网页的正文文字（去掉 HTML 标签），用于打开搜索结果或指定链接看内容。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "完整的 http/https 网址" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作目录（或其子目录）里的文件和文件夹。",
      parameters: {
        type: "object",
        properties: { subdir: { type: "string", description: "相对工作目录的子目录，可空（默认列工作目录本身）" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取一个文本文件的内容（限工作目录白名单内）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件路径，相对工作目录或绝对路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把文字写入一个文本文件（限工作目录白名单内，可新建）。产出文件时用它。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，相对工作目录或绝对路径" },
          content: { type: "string", description: "要写入的完整文字内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cmd",
      description: [
        "在执行器本机跑一条命令并返回输出。用途：安装和使用第三方工具（如 pip install openpyxl、npm install -g csvtojson 后直接调用），",
        "处理工作目录里的文件（如 python 脚本、ffmpeg 转格式），或调用系统里已有的工具。",
        "限制：单条命令 120 秒超时；输出截断到 6000 字；网络受执行器本机代理影响。",
        "装不上的工具就换思路（换纯文本方式完成任务），不要反复重试同一条命令。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的完整命令行，例如 pip install openpyxl -q" },
          cwd: { type: "string", description: "可选，命令在哪个目录下执行（必须在白名单内），默认工作目录" },
        },
        required: ["command"],
      },
    },
  },
];

/** 文件类工具的公共守卫：目标必须落在 roots 白名单里。 */
function safeCloudPath(config, cwd, inputPath) {
  const roots = (config.roots ?? []).map((root) => resolve(root));
  const base = resolve(cwd);
  const target = resolve(isAbsolute(inputPath) ? inputPath : join(base, inputPath));
  const inside = roots.some((root) => target === root || target.startsWith(root + sep))
    || (target === base || target.startsWith(base + sep));
  if (!inside) throw new Error(`路径不在允许范围内：${target}（允许：${(roots.length ? roots : [base]).join("; ")}）`);
  return target;
}

const stripHtml = (html) =>
  String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** 必应（中国版）HTML 搜索：无 Key 可用，公司内网直连也通；解析失败返回明确错误。 */
async function toolWebSearch(query) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=8`;
  const resp = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) throw new Error(`搜索源返回 ${resp.status}`);
  const html = await resp.text();
  const results = [];
  // 必应结果条目：<li class="b_algo"> … <h2><a href="URL">TITLE</a></h2> … <p>SNIPPET</p>
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: stripHtml(link[2]).slice(0, 120),
      url: link[1],
      snippet: snippet ? stripHtml(snippet[1]).slice(0, 220) : "",
    });
    if (results.length >= 6) break;
  }
  if (!results.length) throw new Error("搜索源解析不到结果（页面结构可能变化或被拦截）");
  return results;
}

/** run_cmd 的安全网：危险形态直接拒绝，超时与输出都有上限。这不是沙箱，是减速带。 */
const CMD_BLOCKLIST = [
  /\bformat\b/i, /\bdiskpart\b/i, /\bshutdown\b/i, /\brd\s+\/s\b/i, /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[qs]/i, /\brm\s+-rf\b/, /\bmkfs\b/, /\bdd\s+if=/, /\breg\s+delete\b/i,
  /\bvssadmin\b/i, /\bbcdedit\b/i, /\bcipher\s+\/w\b/i,
];
const CMD_TIMEOUT_MS = 120_000;
const CMD_OUTPUT_MAX = 6_000;

function runCmdTool(config, cwd, args) {
  return new Promise((resolveOutput) => {
    const command = String(args.command ?? "").trim();
    if (!command) return resolveOutput(JSON.stringify({ error: "命令为空" }));
    if (command.length > 2000) return resolveOutput(JSON.stringify({ error: "命令过长（>2000 字符）" }));
    if (CMD_BLOCKLIST.some((pattern) => pattern.test(command))) {
      return resolveOutput(JSON.stringify({ error: "命令被拒绝：属于破坏性操作（格式化/删盘/改引导等），执行器不允许" }));
    }
    let dir = resolve(cwd || process.cwd());
    if (args.cwd) {
      try { dir = safeCloudPath(config, cwd, String(args.cwd)); } catch (error) {
        return resolveOutput(JSON.stringify({ error: String(error.message) }));
      }
    }
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, shellArgs, { cwd: dir, env: buildChildEnv("cmd.exe"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const collect = (chunk) => { if (out.length < CMD_OUTPUT_MAX + 2000) out += chunk; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, CMD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveOutput(JSON.stringify({ error: `命令启动失败：${error.message}` }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.length > CMD_OUTPUT_MAX ? `${out.slice(0, CMD_OUTPUT_MAX)}\n…(输出过长已截断)` : out;
      resolveOutput(JSON.stringify({ exitCode: code, output: text.trim() || "(无输出)" }));
    });
  });
}

/** 执行一个工具调用；所有错误都转成给模型看的文字，不让循环挂掉。 */
async function runCloudTool(config, cwd, name, args, onOutput) {
  try {
    let result;
    if (name === "web_search") {
      result = await toolWebSearch(String(args.query || "").slice(0, 200));
    } else if (name === "fetch_url") {
      const target = String(args.url || "");
      if (!/^https?:\/\//i.test(target)) throw new Error("只支持 http/https 链接");
      const resp = await fetch(target, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0" } });
      const html = await resp.text();
      result = { status: resp.status, text: stripHtml(html).slice(0, 6000) };
    } else if (name === "list_files") {
      const dir = args.subdir ? safeCloudPath(config, cwd, String(args.subdir)) : resolve(cwd);
      if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
      result = readdirSync(dir, { withFileTypes: true }).slice(0, 100).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        size: entry.isFile() ? statSync(join(dir, entry.name)).size : undefined,
      }));
    } else if (name === "read_file") {
      const target = safeCloudPath(config, cwd, String(args.path || ""));
      const stat = statSync(target);
      if (stat.size > 200_000) throw new Error(`文件太大（${Math.round(stat.size / 1024)}KB），只支持 200KB 内的文本`);
      result = { path: target, content: readFileSync(target, "utf8").slice(0, 100_000) };
    } else if (name === "run_cmd") {
      result = await runCmdTool(config, cwd, args);
    } else if (name === "write_file") {
      const target = safeCloudPath(config, cwd, String(args.path || ""));
      const content = String(args.content ?? "");
      if (content.length > 400_000) throw new Error("单次写入内容超过 400KB 上限");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      result = { saved: target, bytes: Buffer.byteLength(content, "utf8") };
    } else {
      throw new Error(`未知工具：${name}`);
    }
    onOutput?.(`[工具] ${name} ✓`);
    return JSON.stringify(result).slice(0, 8000);
  } catch (error) {
    onOutput?.(`[工具] ${name} ✗ ${String(error.message).slice(0, 80)}`);
    return JSON.stringify({ error: String(error.message).slice(0, 300) });
  }
}

/**
 * 员工配置里的模型三件套。新版是 agent.model（模型池对象），
 * 老版是平铺的 agent.model 字符串 + baseUrl + apiKey —— 两种都认。
 */
function modelOf(agent) {
  const box = agent?.model;
  if (box && typeof box === "object") {
    return {
      name: box.model || "",
      baseUrl: box.baseUrl || "",
      apiKey: box.apiKey || "",
      maxOutputTokens: box.maxOutputTokens ?? 16384,
      concurrency: box.concurrency ?? 1,
    };
  }
  return {
    name: typeof box === "string" ? box : "",
    baseUrl: agent?.baseUrl || "",
    apiKey: agent?.apiKey || "",
    maxOutputTokens: agent?.maxOutputTokens ?? 16384,
    concurrency: 1,
  };
}

/** 人设：角色 + 职责 + 挂载的工作方法，云端与 CLI 两条通道共用。 */
function personaLines(agent) {
  const lines = [];
  if (agent?.role) lines.push(`你的角色：${agent.role}。`);
  if (agent?.duties) lines.push(`你的职责：${agent.duties}`);
  const skills = Array.isArray(agent?.skills) ? agent.skills.filter(Boolean) : [];
  if (skills.length) lines.push(`你挂载了这些工作方法：${skills.join("、")}（正文已随任务给出，按它执行）。`);
  return lines.join("\n");
}

/** 云端员工：OpenAI 兼容 chat/completions，Key 由服务器派活时下发。 */
async function runCloud(task, agent, { config, cwd, onOutput, signal } = {}) {
  const model = modelOf(agent);
  if (!model.apiKey) return { ok: false, error: `员工「${agent.name}」用的模型没有 API Key，请到「设置 · 我的模型」补上` };
  if (!model.baseUrl) return { ok: false, error: `员工「${agent.name}」用的模型缺 Base URL，请到「设置 · 我的模型」补上` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const base = String(model.baseUrl).trim();
    if (!base) return { ok: false, error: `模型「${model.name || "?"}」的 Base URL 为空` };
    const weekday = "日一二三四五六"[new Date().getDay()];
    const persona = personaLines(agent);
    const systemHint = [
      `今天是 ${new Date().toLocaleDateString("sv-SE")}（星期${weekday}）。`,
      `你是「${agent.name}」，一名通过接口接单的 AI 员工，不知道提问者所在城市。`,
      persona,
      agent.tools === false
        ? "你没有联网和工具能力，遇到需要实时信息的问题直接说明做不到，严禁编造。"
        : [
          "你有这些工具：web_search（联网搜索）、fetch_url（读网页）、list_files / read_file / write_file（工作目录内的文件读写）、run_cmd（在执行器本机跑命令）。",
          "run_cmd 让你能自己动手：需要某个工具库时先搜索它的安装命令（如 pip install openpyxl、npm i -g 某工具），装好后直接用 run_cmd 调用；处理文件格式（Excel/PDF/图片/音视频）优先走 run_cmd 调本机工具。",
          "run_cmd 有 120 秒超时和破坏性命令拦截；连续失败两次就换思路，不要死磕。",
          "引用搜索结果时注明来源链接；产出文件用 write_file 写到工作目录。",
        ].join("\n"),
    ].filter(Boolean).join("\n");
    const workDirNote = cwd ? `\n\n[工作目录] ${cwd}（文件工具的相对路径基于这里）` : "";
    const messages = [
      { role: "system", content: systemHint },
      { role: "user", content: `${task.prompt}${workDirNote}` },
    ];
    const useTools = agent.tools !== false;
    let usage = null;
    const addUsage = (data) => {
      if (!data.usage) return;
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + (data.usage.prompt_tokens ?? 0),
        completionTokens: (usage?.completionTokens ?? 0) + (data.usage.completion_tokens ?? 0),
        cachedTokens: (usage?.cachedTokens ?? 0) + (data.usage.prompt_tokens_details?.cached_tokens ?? 0),
      };
    };

    // 工具循环：模型要查/要装/要跑就让它来，上限 12 轮（装工具+用工具比纯问答多几轮），防失控
    for (let round = 0; round < 12; round++) {
      const resp = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify({
          model: model.name,
          max_tokens: model.maxOutputTokens ?? 16384,
          messages,
          ...(useTools ? { tools: CLOUD_TOOLS } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return { ok: false, error: data.error?.message || `云端 API 返回 ${resp.status}` };
      addUsage(data);
      const message = data.choices?.[0]?.message;
      if (!message) {
        return { ok: false, error: `云端 API 返回了空结果：响应里没有 choices（model=${model.name || "?"}）` };
      }
      messages.push(message);

      // 模型要调工具 → 本地执行 → 把结果喂回去接着问
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        for (const call of message.tool_calls) {
          if (call.function?.name) {
            let args = {};
            try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* 参数烂就当空对象 */ }
            const output = await runCloudTool(config ?? {}, cwd ?? process.cwd(), call.function.name, args, onOutput);
            messages.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }
        continue;
      }

      // 没有工具调用 → 这就是最终回答
      const text = String(message.content ?? "");
      if (!text.trim()) {
        return { ok: false, error: "云端 API 返回了空结果：模型返回了空内容" };
      }
      return { ok: true, finalResponse: text, usage };
    }
    return { ok: false, error: "工具调用超过 12 轮上限，任务终止（可在任务描述里让员工少查几轮）" };
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted) return { ok: false, cancelled: true, error: "任务已取消" };
    // undici 的「fetch failed」不带原因基本没法排障，把底层 cause 拼上
    const cause = error.cause?.code || error.cause?.message || "";
    return { ok: false, error: `云端 API 调用失败：${error.message}${cause ? `（${cause}）` : ""}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 平台侧下发的目录白名单（runnerPrefs.roots）热写回本机配置。
 * 服务器上改了 roots，执行器下一次心跳/领单就带下来，不用回去重跑 init。
 * 目录不存在时只记日志不拦截：可能是一台插了 U 盘的机器，目录暂时缺席。
 */
function applyRunnerPrefs(config, prefs) {
  if (!prefs || !Array.isArray(prefs.roots)) return false;
  const next = prefs.roots.map((item) => String(item).trim()).filter(Boolean);
  const cur = (config.roots ?? []).map((item) => String(item).trim());
  if (cur.length === next.length && cur.every((item, i) => item === next[i])) return false;
  config.roots = next;
  try {
    const disk = readConfig();
    if (disk) saveConfig({ ...disk, roots: next });
  } catch { /* 配置盘写不进去就先用内存里的 */ }
  log(`目录白名单已按平台配置更新：${next.join(" ; ") || "(空)"}`);
  return true;
}

/** 领到任务 → 执行 → 回传，整条链路任何一步都不能把常驻循环搞死。 */
async function executeTask(config, { task, agent, runnerPrefs }) {
  applyRunnerPrefs(config, runnerPrefs);
  const startedAt = Date.now();
  const controller = new AbortController();
  let pendingOutput = "";
  const flushOutput = () => {
    if (!pendingOutput) return;
    const text = pendingOutput;
    pendingOutput = "";
    report(config, "/api/runner/heartbeat", { taskId: task.id, output: text });
  };
  const onOutput = (text) => {
    pendingOutput = `${pendingOutput}\n${text}`.slice(-8000);
  };

  const heartbeatTimer = setInterval(() => {
    flushOutput();
    api(config, "/api/runner/heartbeat", { method: "POST", body: { taskId: task.id, version: VERSION, platform: platform() } })
      .then((data) => {
        if (data.cancel) { log("服务器已取消该任务"); controller.abort(); }
        applyRunnerPrefs(config, data.runnerPrefs);
      })
      .catch(() => { /* 下一次心跳再试 */ });
  }, HEARTBEAT_MS);

  try {
    log(`▶ 执行任务 ${task.id.slice(0, 8)}「${task.label || task.prompt.slice(0, 30)}」员工=${agent.name} kind=${agent.kind}/${agent.ref ?? "cloud"}`);
    let result;
    try {
      if (agent.kind === "builtin") {
        const cwd = resolveCwd(config, task.cwd);
        // 本机 CLI 也带人设：角色/职责写在任务最前面，CLI 会当成首条要求
        const persona = personaLines(agent);
        const localTask = persona
          ? { ...task, cwd, prompt: `${persona}\n\n${task.prompt}` }
          : { ...task, cwd };
        result = agent.ref === "claude"
          ? await runClaude(config, localTask, { signal: controller.signal })
          : agent.ref === "dsh"
            ? await runDsh(config, localTask, { onOutput, signal: controller.signal })
            : await runCodex(config, localTask, { onOutput, signal: controller.signal });
      } else {
        // 云端员工的文件工具也要落在白名单里；没有合法目录时文件工具会给出明确错误，文本任务不受影响
        let cloudCwd = null;
        try { cloudCwd = resolveCwd(config, task.cwd); } catch { /* 保持 null */ }
        result = await runCloud(task, agent, { config, cwd: cloudCwd, onOutput, signal: controller.signal });
      }
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (!result.ok && !result.cancelled) {
      // 失败细节回传，前端任务卡能看到原因
      log(`✗ 任务失败：${result.error}`);
    } else {
      log(`${result.cancelled ? "⊘ 已取消" : "✓ 完成"}（${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }
    await report(config, "/api/runner/finish", {
      taskId: task.id,
      ok: result.ok === true,
      cancelled: result.cancelled === true,
      finalResponse: result.finalResponse,
      error: result.error,
      threadId: result.threadId,
      usage: result.usage,
    });
  } finally {
    clearInterval(heartbeatTimer);
    flushOutput();
  }
}

async function cmdRun() {
  const config = readConfig();
  if (!config?.server || !config?.token) {
    console.log("还没配置，先跑 node runner-agent.mjs init");
    process.exit(1);
  }
  try {
    config.server = normalizeServer(config.server);
  } catch (error) {
    console.log(`配置有问题：${error.message}`);
    console.log("跑一次「重新配置执行器」把它改回来，再启动。");
    process.exit(1);
  }
  const probe = spawnSync(config.codexCommand || "codex", ["--version"], { encoding: "utf8", windowsHide: true });
  const codexReady = probe.status === 0;
  const dshProbe = spawnSync(config.dshCommand || "dsh", ["--version"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  const dshReady = dshProbe.status === 0;
  log(`AI 执行器 v${VERSION} 启动 → ${config.server}`);
  log("每 2.5 秒向服务器领一次活；Ctrl+C 退出。");
  log(`Codex: ${codexReady ? `就绪（${String(probe.stdout || "").trim().slice(0, 60)}）` : "未检测到（本机 Codex 员工会领不了活）"}`);
  log(`DSH:   ${dshReady ? `就绪（${String(dshProbe.stdout || "").trim().slice(0, 60)}）` : "未检测到（DeepSeek Harness 员工会领不了活）"}${process.env.DEEPSEEK_API_KEY ? "" : "；未设置 DEEPSEEK_API_KEY"}`);

  // 每次领活都带上本机配置摘要，平台的「执行器」页直接展示，不用再去翻本地窗口
  const meta = {
    version: VERSION,
    platform: `${platform()}/${hostname()}`,
    roots: config.roots ?? [],
    codex: { ok: codexReady, version: String(probe.stdout || "").trim().slice(0, 60) },
    dsh: { ok: dshReady, version: String(dshProbe.stdout || "").trim().slice(0, 60), apiKey: Boolean(process.env.DEEPSEEK_API_KEY) },
  };

  process.on("SIGINT", () => { log("退出"); process.exit(0); });

  // 主循环：任何异常都只记日志，循环本身永不退出（执行器必须是打不死的小强）
  for (;;) {
    try {
      const data = await api(config, "/api/runner/claim", { method: "POST", body: meta });
      applyRunnerPrefs(config, data.runnerPrefs);
      if (data.task) {
        await executeTask(config, data);
      } else if (data.note === "agent_unavailable") {
        log("服务器上有个任务的员工已不可用，已按失败处理");
      }
    } catch (error) {
      log(`[等待重试] ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_INTERVAL_MS));
  }
}

const [command] = process.argv.slice(2);
if (command === "init") await cmdInit();
else if (command === "status") cmdStatus();
else if (command === "run" || !command) await cmdRun();
else { console.log("用法：node runner-agent.mjs [init|run|status]"); process.exit(1); }
