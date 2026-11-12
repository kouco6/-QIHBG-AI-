import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCodexCommand, applyProxyPolicy, applySilencePolicy, getCodexCommand, getCodexVersion, runCodexTask } from "./codex-runner.mjs";
import { applyClaudeCommand, findClaudeBinary, getClaudeVersion, runClaudeTask } from "./claude-runner.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { AppServerRunner } from "./app-server-runner.mjs";
import { createAgentRunnerRouter } from "./agent-router.mjs";
import { loadConfig, validateTaskInput } from "./config.mjs";
import { createOpenAICompatibleRunner } from "./openai-compatible-runner.mjs";
import { TaskStore } from "./store.mjs";
import { TaskManager } from "./task-manager.mjs";
import { handleWorkbenchApi } from "./workbench/api.mjs";
import { createKnowledgeApi, knowledgeOptions } from "./workbench/knowledge/api.mjs";
import { createCollabApi } from "./workbench/collab/api.mjs";
import { FlowEventBus } from "./workbench/flow-events.mjs";
import { FlowRunner } from "./workbench/flow-runner.mjs";
import { FlowStore } from "./workbench/flows.mjs";
import { skillStoreFor } from "./workbench/skill-mount.mjs";
import { Updater } from "./workbench/updater.mjs";
import { agentName, listAgents } from "./workbench/agents.mjs";

const config = loadConfig();
applyProxyPolicy(config.codexUseSystemProxy);
applySilencePolicy(config.codexSilenceWarnMs);
applyCodexCommand(config.codexCommand);
applyClaudeCommand(config.claudeCommand);
const codexVersion = getCodexVersion();
const claudeVersion = getClaudeVersion();
const appServer = new AppServerClient();
const appRunner = new AppServerRunner({
  client: appServer,
  allowExecFallback: config.allowExecFallback,
  silenceWarnMs: config.codexSilenceWarnMs,
});
const codexRunner = config.runnerMode === "exec" ? runCodexTask : appRunner.run;
const agentRunners = new Map([["codex", codexRunner], ["claude", runClaudeTask]]);

/**
 * Cloud runners capture apiKey/baseUrl/model in their closure, so a config
 * change has to build a fresh runner. Called after any agent create/update/
 * delete, and it also drops runners for agents that were removed or disabled.
 */
const refreshAgentRunners = () => {
  // Codex 是独立执行器（app-server），不在下面的循环里重建
  const keep = new Set(["codex"]);
  for (const [id, agentConfig] of Object.entries(config.agents ?? {})) {
    // 本机 CLI 员工（内置 claude + 界面新建的自定义位）：
    // 可用性只看「CLI 装没装」，跟 API Key 无关，不能混进云端循环；
    // 目前统一由 Claude Code 执行器承载。
    if (agentConfig?.provider === "local") {
      if (agentConfig.available && agentConfig.cli !== "codex") {
        agentRunners.set(id, runClaudeTask);
        keep.add(id);
      }
      continue;
    }
    if (!agentConfig?.available) continue;
    agentRunners.set(id, createOpenAICompatibleRunner({ ...agentConfig, name: agentName(id) }));
    keep.add(id);
  }
  for (const id of [...agentRunners.keys()]) {
    if (!keep.has(id)) agentRunners.delete(id);
  }
};
refreshAgentRunners();

/**
 * 知识库 AI 问答的一次性模型通道：
 * 优先复用第一个可用的云端员工（OpenAI 兼容接口）；没有云端员工时退回本机 Claude CLI（只读模式）。
 * 返回 (prompt) => Promise<string>；云端通道 kind="cloud"（机密片段会被知识库侧剔除），
 * 本机通道 kind="local"（机密可以进提示词，不出本机）。
 */
function createKnowledgeAskModel(config, agentName) {
  let cloudRunner = null;
  let cloudName = "";
  const pickCloud = () => {
    if (cloudRunner !== null) return cloudRunner;
    cloudRunner = false;
    const entry = Object.entries(config.agents ?? {}).find(([, a]) =>
      a?.available && a?.apiKey && a?.baseUrl && a?.model && a?.provider !== "local");
    if (entry) {
      const [id, a] = entry;
      try {
        cloudRunner = createOpenAICompatibleRunner({ ...a, id, name: agentName(id) ?? a.name ?? id });
        cloudName = agentName(id) ?? id;
      } catch { cloudRunner = false; }
    }
    return cloudRunner;
  };
  const fn = async (prompt) => {
    const runner = pickCloud();
    if (runner) {
      const result = await runner({ id: `kb-ask-${Date.now().toString(36)}`, prompt }, { timeoutMs: 120_000 });
      if (!result?.finalResponse) throw new Error(`${cloudName || "云端员工"} 没有返回内容`);
      return result.finalResponse;
    }
    // 本机 Claude CLI 兜底：read-only 模式，绝不写文件
    if (!findClaudeBinary()) throw new Error("没有可用的模型通道：未配置云端员工，本机也未安装 Claude CLI");
    const result = await runClaudeTask(
      { id: `kb-ask-${Date.now().toString(36)}`, prompt, mode: "read-only" },
      { emit: () => {}, timeoutMs: 180_000 },
    );
    if (!result?.finalResponse) throw new Error("Claude CLI 没有返回内容");
    return result.finalResponse;
  };
  fn.kind = () => (pickCloud() ? "cloud" : "local");
  fn.label = () => (pickCloud() ? `云端员工 ${cloudName}` : "本机 Claude CLI");
  return fn;
}
const selectedRunner = createAgentRunnerRouter(agentRunners);
const publicAgents = () => listAgents(config.agents);
const store = new TaskStore({ file: config.stateFile, eventFile: config.eventFile, maxRecords: config.taskRetention });
const manager = new TaskManager({
  concurrency: config.maxConcurrency,
  timeoutMs: config.taskTimeoutMs,
  runner: selectedRunner,
  persist: (task, idempotencyKey) => store.append(task, idempotencyKey),
  persistEvent: (taskId, event) => store.appendEvent(taskId, event),
  approvalResolver: (taskId, approvalId, decision) => appRunner.resolveApproval(taskId, approvalId, decision),
});

const persisted = store.load();
const recovery = manager.restore(persisted.latest, persisted.idempotency, persisted.eventsByTask);
// 流程模板与运行实例；任务先恢复完再恢复流程，重启恢复为暂停（决策 10）。
const flowStore = new FlowStore({ file: join(dirname(config.stateFile), "flows.json") });
// 产品中枢知识库：DB 与 state 同目录（knowledge.db），Vault/备份目录来自配置或默认值
const knowledgeApi = createKnowledgeApi({
  stateDir: dirname(config.stateFile),
  options: knowledgeOptions(config.configPath ?? join(dirname(config.stateFile), "gateway.config.json"), process.env),
  askModel: createKnowledgeAskModel(config, agentName),
});
// 任务协作：成员推送走独立 Token，路由必须在主鉴权闸门之前接管 /api/collab/*
const collabApi = createCollabApi({
  stateDir: dirname(config.stateFile),
  authorized: (req) => authorized(req),
  taskLabel: () => manager.list()
    .filter((t) => t.status !== "archived")
    .map((t) => ({ id: t.id, label: t.label || "未命名任务", status: t.status })),
});
// 问答通道类型（cloud/local）在选型时就确定，供「机密不上云」的边界判断
knowledgeApi.service.modelKind = knowledgeApi.service.askModel?.kind?.() ?? "local";
// 流程事件总线：只推步骤状态与产物清单，替代前端 3 秒全量轮询。
const flowEvents = new FlowEventBus();
const flowRunner = new FlowRunner({ store: flowStore, manager, config, skillStore: skillStoreFor(config), events: flowEvents });
const flowRecovery = flowStore.recoverOnBoot();
if (persisted.lines > config.taskRetention * 3) {
  store.compact(persisted.latest);
}
if (store.eventLines > config.taskRetention * 600) {
  store.compactEvents(persisted.eventsByTask);
}
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---------------------------------------------------------------- 自更新
// 检查 → 下载 → 备份 → 覆盖都在 updater 里；这里只负责「重启」这一步：
// 必须由独立脚本接生，否则新进程抢不到端口（旧进程还没放），服务就断了。
const updater = new Updater({ root: config.root, config, log: (line) => console.log(line) });
updater.settleOnBoot();

const restartService = ({ delayMs = 250 } = {}) => {
  updater.markRestarting();
  const relaunch = join(config.root, "scripts", "relaunch.mjs");
  let spawned = null;
  try {
    spawned = spawn(process.execPath, [
      relaunch,
      "--port", String(config.port),
      "--host", config.host,
      "--cwd", config.root,
      "--entry", join(config.root, "src", "server.mjs"),
    ], { cwd: config.root, detached: true, stdio: "ignore", windowsHide: true });
    spawned.unref();
  } catch (error) {
    console.error(`[update] 启动重启脚本失败：${error?.message || error}`);
    throw error;
  }
  // 先把 HTTP 响应送出去，再退出；relaunch 会等端口释放后拉起新进程
  setTimeout(() => process.exit(0), delayMs);
  return { ok: true, pid: spawned?.pid ?? null };
};

// ---------------------------------------------------------------- 服务自管理
// 设置页的「服务管理」卡在运行中切换监听范围/端口、或直接停机，靠这一组能力。
const lanAddresses = () => {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) found.push(net.address);
    }
  }
  return found;
};

/** 换个地址继续监听。失败时回滚到原地址，服务不能因为一次误操作失联。 */
const relisten = async (host, port) => {
  const previous = { host: config.host, port: config.port };
  await new Promise((resolve) => {
    // SSE 等 keep-alive 连接会让 close 一直等，直接断掉所有活动连接。
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await new Promise((resolve) => {
      server.once("error", resolve);
      server.listen(previous.port, previous.host, () => {
        server.removeListener("error", resolve);
        resolve();
      });
    });
    throw error;
  }
  config.host = host;
  config.port = port;
};

const serviceControl = {
  lanAddresses,
  relisten,
  stop: () => setTimeout(() => process.exit(0), 300),
  // 更新后重启：走 relaunch 脚本，装没装 watchdog 都能回来
  restart: restartService,
  startedAt: Date.now(),
  autostartSupported: process.platform === "win32",
  autostartStatus,
  setAutostart,
};

// ---- 开机自启（仅 Windows）：写 HKCU Run 项，指向 gateway-autostart.vbs，登录时静默拉起 ----
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "WorkBuddyGateway";
const autostartValue = () => `wscript.exe "${join(config.root, "gateway-autostart.vbs")}"`;

function autostartStatus() {
  return new Promise((resolve) => {
    // spawn 被环境拒绝（如受限沙箱）时会直接抛异常，吞掉按「未开启」处理
    try {
      execFile("reg", ["query", RUN_KEY, "/v", AUTOSTART_NAME], { windowsHide: true }, (error, stdout) => {
        resolve(Boolean(!error && String(stdout || "").includes(AUTOSTART_NAME)));
      });
    } catch { resolve(false); }
  });
}

function setAutostart(enabled) {
  return new Promise((resolve, reject) => {
    const args = enabled
      ? ["add", RUN_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d", autostartValue(), "/f"]
      : ["delete", RUN_KEY, "/v", AUTOSTART_NAME, "/f"];
    try {
      execFile("reg", args, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message)));
        else resolve();
      });
    } catch (error) {
      reject(new Error(`当前环境不允许写注册表：${error?.message || error}`));
    }
  });
}

const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
};

const tokenMatches = (provided) => {
  const expectedHash = createHash("sha256").update(config.token).digest();
  const providedHash = createHash("sha256").update(provided || "").digest();
  return timingSafeEqual(expectedHash, providedHash);
};

const authorized = (req) => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") && tokenMatches(header.slice(7));
};

const readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must be valid JSON");
  }
};

const sendSse = (res, event) => {
  res.write(`id: ${event.sequence}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

const sendSseReset = (res, window) => {
  const data = {
    status: window.status,
    earliestSequence: window.earliestSequence,
    latestSequence: window.latestSequence,
  };
  res.write(`id: ${window.latestSequence}\n`);
  res.write("event: reset\n");
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const lastEventSequence = (header) => {
  if (header === undefined) return 0;
  if (Array.isArray(header) || !/^\d+$/.test(header)) {
    throw new Error("Last-Event-ID must be a non-negative safe integer");
  }
  const sequence = Number(header);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Last-Event-ID must be a non-negative safe integer");
  }
  return sequence;
};

const serveStatic = (pathname, res) => {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const file = join(publicDir, safe);
  if (!file.startsWith(publicDir) || !existsSync(file)) return false;
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
  res.writeHead(200, {
    "content-type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`,
    // blob: 是产出物预览（图片/HTML iframe）走的本地对象 URL，token 不落 URL，安全面不扩大
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    // Local single-user tool: always revalidate. A 1h cache here means "I changed
    // the UI and the browser still shows the old one", which costs far more time
    // than the few kilobytes saved.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
  return true;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      const runtime = config.runnerMode === "exec" ? { state: "exec", transport: "per-task-process" } : appRunner.status();
      const healthy = Boolean(codexVersion) && (config.runnerMode === "exec" || runtime.state !== "stopped" || config.allowExecFallback);
      return json(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        service: "workbuddy-codex-gateway",
        codexVersion,
        runnerMode: config.runnerMode,
        runtime,
        queue: manager.list().filter((task) => task.status === "queued").length,
        running: manager.list().filter((task) => ["running", "waiting_approval"].includes(task.status)).length,
        agents: publicAgents(),
      });
    }

    // 任务协作：独立 Token 体系，先于主鉴权闸门处理 /api/collab/*
    if (path.startsWith("/api/collab/")) {
      const handled = await collabApi.handle(req, res, path, url);
      if (handled) return;
    }

    if ((path.startsWith("/v1/") || path.startsWith("/api/")) && !authorized(req)) {
      return json(res, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
    }

    // 产品中枢知识库：独立路由组，先于通用 workbench API 处理 /api/knowledge/*
    if (path.startsWith("/api/knowledge/")) {
      const handled = await knowledgeApi.handle(req, res, path, url);
      if (handled) return;
    }

    // Workbench product layer. Returns false for paths it delegates (SSE streams).
    if (path.startsWith("/api/")) {
      const handled = await handleWorkbenchApi(req, res, path, url, {
        manager,
        config,
        json,
        codexVersion,
        // AI 查价等旁路动作要直接指挥员工，复用同一条执行器路由
        runner: selectedRunner,
        flowStore,
        flowRunner,
        flowEvents,
        serviceControl,
        updater,
        onAgentConfigChanged: refreshAgentRunners,
      });
      if (handled) return;
    }

    if (req.method === "GET" && path === "/v1/meta") {
      const tasks = manager.list();
      return json(res, 200, {
        service: "workbuddy-codex-gateway",
        codexVersion,
        allowedRoots: config.allowedRoots,
        defaultRoot: config.allowedRoots[0] ?? null,
        maxConcurrency: config.maxConcurrency,
        taskTimeoutMs: config.taskTimeoutMs,
        runnerMode: config.runnerMode,
        runtime: config.runnerMode === "exec" ? { state: "exec" } : appRunner.status(),
        maxPromptChars: config.maxPromptChars,
        queue: tasks.filter((task) => task.status === "queued").length,
        running: tasks.filter((task) => ["running", "waiting_approval"].includes(task.status)).length,
        total: tasks.length,
        recovered: recovery.restored,
        interrupted: recovery.interrupted,
        agents: publicAgents(),
      });
    }

    if (req.method === "GET" && path === "/v1/metrics") {
      return json(res, 200, manager.metrics());
    }

    if (req.method === "POST" && path === "/v1/tasks") {
      const input = validateTaskInput(await readJson(req), config);
      if (!selectedRunner.has(input.agent)) {
        throw new Error(`AI 员工 ${input.agent} 尚未配置 API Key 或已被禁用`);
      }
      const idempotencyKey = req.headers["x-idempotency-key"]?.toString().slice(0, 200) || null;
      const created = manager.create(input, idempotencyKey);
      return json(res, created.duplicate ? 200 : 202, created.task, {
        location: `/v1/tasks/${created.task.id}`,
        "x-idempotent-replay": created.duplicate ? "true" : "false",
      });
    }

    if (req.method === "GET" && path === "/v1/tasks") {
      return json(res, 200, { data: manager.list() });
    }

    const taskMatch = path.match(/^\/v1\/tasks\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && taskMatch) {
      const task = manager.get(taskMatch[1], url.searchParams.get("events") === "1");
      return task ? json(res, 200, task) : json(res, 404, { error: "Task not found" });
    }

    const eventJsonMatch = path.match(/^\/v1\/tasks\/([A-Za-z0-9-]+)\/events\.json$/);
    if (req.method === "GET" && eventJsonMatch) {
      const after = lastEventSequence(url.searchParams.get("after") ?? undefined);
      const window = manager.eventWindow(eventJsonMatch[1]);
      if (!window) return json(res, 404, { error: "Task not found" });
      return json(res, 200, {
        status: window.status,
        earliestSequence: window.earliestSequence,
        latestSequence: window.latestSequence,
        events: window.events.filter((event) => event.sequence > after),
      });
    }

    const eventMatch = path.match(/^\/(?:v1|api)\/tasks\/([A-Za-z0-9-]+)\/events$/);
    if (req.method === "GET" && eventMatch) {
      const after = lastEventSequence(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? undefined);
      const window = manager.subscribeFrom(eventMatch[1], (event) => sendSse(res, event));
      if (!window) return json(res, 404, { error: "Task not found" });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      const expired = after < window.earliestSequence - 1;
      const ahead = after > window.latestSequence;
      if (expired || ahead) sendSseReset(res, window);
      else window.events.filter((event) => event.sequence > after).forEach((event) => sendSse(res, event));
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        window.unsubscribe();
      });
      return;
    }

    const cancelMatch = path.match(/^\/v1\/tasks\/([A-Za-z0-9-]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const task = manager.cancel(cancelMatch[1]);
      return task ? json(res, 202, task) : json(res, 404, { error: "Task not found" });
    }

    const approvalMatch = path.match(/^\/v1\/tasks\/([A-Za-z0-9-]+)\/approvals\/([A-Za-z0-9-]+)$/);
    if (req.method === "POST" && approvalMatch) {
      const body = await readJson(req);
      const task = manager.resolveApproval(approvalMatch[1], approvalMatch[2], body.decision);
      return task ? json(res, 200, task) : json(res, 404, { error: "Task not found" });
    }

    if (req.method === "GET" && serveStatic(path, res)) return;
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`\nWorkBuddy <-> Codex Gateway`);
  console.log(`Dashboard: http://${config.host}:${config.port}`);
  console.log(`Config:    ${config.configPath}`);
  console.log(`Codex:     ${codexVersion || "not found"} (${getCodexCommand()})`);
  console.log(`Claude:    ${claudeVersion || "not found"} (${config.claudeCommand})`);
  console.log(`Runner:    ${config.runnerMode}${config.allowExecFallback ? " (exec fallback enabled before turn start)" : ""}`);
  console.log(`Agents:    ${publicAgents().map((agent) => `${agent.name}:${agent.available ? agent.model || "ready" : agent.availabilityReason}`).join(", ")}`);
  if (config.codexCommand === "codex") {
    console.log(`WARNING:   codex resolved to the bare PATH name; set codexHome in gateway.config.json if tasks fail to spawn.`);
  }
  console.log(`Roots:     ${config.allowedRoots.join("; ")}`);
  console.log(`Token:     ${config.secretsPath ? `from ${config.secretsPath}` : "from WORKBUDDY_GATEWAY_TOKEN"}`);
  console.log(`State:     ${config.stateFile}`);
  console.log(`Events:    ${config.eventFile}`);
  console.log(`Recovered: ${recovery.restored} task(s), ${recovery.interrupted} interrupted${flowRecovery ? `, ${flowRecovery} flow run(s) paused` : ""}`);
  console.log("");
});

if (config.runnerMode !== "exec") {
  appServer.start().catch((error) => {
    console.error(`[app-server] initial start failed; lazy retry/fallback remains available: ${error?.message || error}`);
  });
}

// ---------------------------------------------------------------- 自动更新
// 两层节奏：
//   · 定时检查（默认 6 小时一次，启动 25 秒后先查一次）——只读清单，不改文件
//   · 每小时扫一次「有新版且开了自动安装」：必须等手上没有任务才动手，
//     否则会把正在跑的任务连同进程一起重启掉
let updateTimer = null;
const scheduleUpdateCheck = (hours) => {
  if (updateTimer) clearTimeout(updateTimer);
  const settings = updater.settings();
  if (!settings.autoCheck) return;
  const ms = Math.max(1, hours ?? settings.intervalHours) * 3600_000;
  updateTimer = setTimeout(runUpdateCheck, ms);
  updateTimer.unref?.();
};

async function runUpdateCheck() {
  try {
    const result = await updater.check();
    if (result.available) {
      console.log(`[update] 平台有新版 v${result.latest}（当前 v${result.current}），在设置页可以安装`);
    }
  } catch (error) {
    console.error(`[update] 自动检查失败：${error?.message || error}`);
  }
  scheduleUpdateCheck();
}

async function autoApplySweep() {
  const settings = updater.settings();
  if (!settings.autoInstall || updater.busy) return;
  const last = updater.summary().lastCheck;
  if (!last?.available || !last?.manifest) return;
  const busy = manager.running > 0 || manager.queue.length > 0;
  if (busy) return; // 有任务在跑，等下一轮
  try {
    const applied = await updater.apply({ manifest: last.manifest });
    console.log(`[update] 自动更新已就绪：v${applied.from} → v${applied.to}，正在重启`);
    restartService({ delayMs: 600 });
  } catch (error) {
    console.error(`[update] 自动更新失败：${error?.message || error}`);
  }
}

setTimeout(runUpdateCheck, 25_000).unref?.();
scheduleUpdateCheck();
setInterval(autoApplySweep, 60 * 60 * 1000).unref?.();

const shutdown = () => {
  void appServer.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 兜底：单个任务的异常不该把整个网关带走。
// 之前取消任务时，中断信号和超时同时到达会重复 reject 同一个 Promise，
// 第二次没人消费 → unhandledRejection → 进程退出，正在跑的流程全断。
// 这里记日志继续跑；真正的 bug 仍会出现在日志里，不会静默。
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.error(`[gateway] unhandled rejection (已忽略，服务继续运行): ${detail}`);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});
process.on("uncaughtException", (error) => {
  // 未捕获异常通常是代码 bug，但让它杀掉整个网关代价太大：
  // 记全栈后继续，用户至少能把手上正在看的页面和任务状态保住。
  console.error(`[gateway] uncaught exception (已忽略，服务继续运行): ${error?.stack || error}`);
});


