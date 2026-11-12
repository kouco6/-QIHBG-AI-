/**
 * Workbench product API.
 *
 * This is the layer above the queue: it owns domains, templates, routing and the
 * structured result shape. The existing /v1/* gateway routes stay untouched so the
 * MCP bridge keeps working exactly as before.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { normalizeReasoningEffort, resolveAllowedDirectory, saveServerBind } from "../config.mjs";
import { describeAgent, createAgent, deleteAgent, updateAgentConfig } from "./agent-config.mjs";
import { probeAgent } from "./agent-probe.mjs";
import { AGENTS, CAPABILITIES, assertAgentUsable, listAgents, recommendAgent } from "./agents.mjs";
import { AVATAR_PRESETS } from "./avatars.mjs";
import { PRESET_VIEWS, LOCAL_CLI_PRESETS } from "./model-presets.mjs";
import { probeLocalCli } from "./agent-config.mjs";
import { readArtifact, classifyArtifact, confinePath } from "./artifact-writer.mjs";
import { computeFlowStats, computeStats } from "./stats.mjs";
import { buildPricingPrompt, parsePricingReply } from "./pricing-fetcher.mjs";
import { DOMAINS, TEMPLATES, buildPrompt, findTemplate } from "./templates.mjs";
import { HubClient, HubError } from "./hub-client.mjs";
import { describeHubSettings, saveHubSettings } from "./hub-settings.mjs";
import { applySkills, autoSkillNames, skillStoreFor } from "./skill-mount.mjs";

const MAX_BODY = 2 * 1024 * 1024;

// AI 查价的内存任务表：查价是短生命周期的一次性动作，不值得进任务列表落盘。
// 只留最近 30 条，前端凭 id 轮询。
const pricingJobs = new Map();

const pricingJobView = (job) => ({
  id: job.id,
  status: job.status,
  model: job.model,
  workerId: job.workerId,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  error: job.error,
  pricing: job.pricing,
  source: job.source,
  note: job.note,
  rawReply: job.rawReply ?? null,
});

/** 跑一次查价：派员工 → 拿回复 → 解析校验。结果写回 job，不落配置。 */
const runPricingJob = async (job, { prompt, runner, cwd, timeoutMs, signal }) => {
  try {
    // mode "web"：文件只读但放行 WebSearch/WebFetch，普通只读模式会被权限确认卡死
    const result = await runner(
      { id: job.id, prompt, agent: job.workerId, mode: "web", cwd },
      { signal, timeoutMs, toolContext: null, emit: () => {} },
    );
    const reply = String(result?.finalResponse ?? "");
    const parsed = parsePricingReply(reply);
    if (parsed.error) {
      job.status = "failed";
      job.error = parsed.error;
      // 留一段原文，前端和排查都能看到员工到底回了什么
      job.rawReply = reply.replace(/\s+/g, " ").trim().slice(0, 400);
      return;
    }
    job.status = "completed";
    job.pricing = parsed.pricing;
    job.source = parsed.source;
    job.note = parsed.note;
  } catch (err) {
    job.status = "failed";
    job.error = String(err?.message || err || "查价失败").slice(0, 300);
  } finally {
    job.finishedAt = Date.now();
  }
};

const readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must be valid JSON");
  }
};

const firstLine = (text) => {
  const line = String(text || "").trim().split(/\r?\n/)[0] || "未命名任务";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

const withinRange = (iso, range) => {
  if (!range || range === "all") return true;
  if (!iso) return false;
  const hours = { today: 24, "7d": 24 * 7, "30d": 24 * 30 }[range];
  if (!hours) return true;
  return Date.now() - new Date(iso).getTime() <= hours * 3600 * 1000;
};

/** stat that never throws — a missing file is a normal answer, not an error. */
const safeStatOf = (path) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

const matchesQuery = (task, query) => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [task.label, task.prompt, task.summary, ...(task.tags ?? [])]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
};

const COLUMN_ORDER = ["draft", "running", "attention", "ready", "history"];

/** 技能库读盘失败不能连累整个 bootstrap：给空数组，页面上少一块而已。 */
const safeSkillList = (config) => {
  try {
    return skillStoreFor(config).list();
  } catch {
    return [];
  }
};

/** 员工列表 + 浏览器可安全看到的配置（密钥只给掩码）。 */
const agentViews = (config) => listAgents(config.agents).map((agent) => ({
  ...agent,
  config: describeAgent(config, agent.id),
}));

function selectTasks(manager, params) {
  const domain = params.get("domain") || "";
  const agent = params.get("agent") || "";
  const outputType = params.get("outputType") || "";
  const query = (params.get("q") || "").trim();
  const range = params.get("range") || "all";
  const column = params.get("column") || "";
  const includeArchived = params.get("archived") === "1";

  const all = manager.list();
  const filtered = all.filter((task) => {
    if (!includeArchived && task.status === "archived") return false;
    if (domain && task.domain !== domain) return false;
    if (agent && task.agent !== agent) return false;
    if (outputType && !(task.outputTypes ?? []).includes(outputType)) return false;
    if (column && task.column !== column) return false;
    if (!withinRange(task.updatedAt || task.createdAt, range)) return false;
    return matchesQuery(task, query);
  });

  const counts = Object.fromEntries(COLUMN_ORDER.map((key) => [key, 0]));
  counts.attention = 0;
  for (const task of all) {
    if (task.status === "archived" && !includeArchived) continue;
    counts[task.column] = (counts[task.column] ?? 0) + 1;
    if (task.unread) counts.unread = (counts.unread ?? 0) + 1;
  }

  return { items: filtered, counts, total: all.length };
}

function buildStats(manager) {
  const all = manager.list().filter((task) => task.status !== "archived");
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = all.filter((task) => new Date(task.createdAt || 0).getTime() >= week);
  const done = recent.filter((task) => task.status === "completed");
  const failed = recent.filter((task) => ["failed", "interrupted"].includes(task.status));
  const durations = done
    .filter((task) => task.startedAt && task.finishedAt)
    .map((task) => new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime());
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : 0;
  const byDomain = {};
  for (const task of recent) byDomain[task.domain ?? "adhoc"] = (byDomain[task.domain ?? "adhoc"] ?? 0) + 1;

  return {
    window: "7d",
    total: recent.length,
    completed: done.length,
    failed: failed.length,
    running: recent.filter((task) => ["queued", "running"].includes(task.status)).length,
    averageDurationSeconds: avg,
    byDomain,
    artifacts: recent.reduce((sum, task) => sum + (task.artifacts?.length ?? 0), 0),
  };
}

/**
 * Facts the gateway process itself knows about how it runs. Everything here is
 * read from live config/process state — no estimates, no health guesses.
 */
function buildRuntimeFacts(config) {
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    runnerMode: config.runnerMode ?? "exec",
    taskTimeoutMinutes: Math.round((config.taskTimeoutMs ?? 0) / 60_000),
    silenceWarnMinutes: Math.round((config.codexSilenceWarnMs ?? 0) / 60_000),
    useSystemProxy: config.codexUseSystemProxy === true,
    reasoningEffort: config.codexReasoningEffort ?? null,
    codexCommand: config.codexCommand ?? "codex",
  };
}

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
export async function handleWorkbenchApi(req, res, path, url, ctx) {
  const { manager, config, json } = ctx;
  if (!path.startsWith("/api/")) return false;
  const method = req.method;
  const params = url.searchParams;
  const segment = path.slice(5).split("/").filter(Boolean); // after "/api/"

  const skillStore = () => skillStoreFor(config);
  const hubClient = () => new HubClient(config.hub);

  // ---------------------------------------------------------------- skills（工作方法库）
  // 云端目录、拉取安装、本地列表、删除，都走这几个口。平台账号密码只在服务端用。
  if (segment[0] === "skills") {
    if (method === "GET" && path === "/api/skills/hub") {
      try {
        const items = await hubClient().list({
          query: params.get("q") ?? "",
          category: params.get("category") ?? "",
          sort: params.get("sort") ?? "new",
          type: "skill",
        });
        const installed = new Map(skillStore().list().map((item) => [item.name, item.version]));
        json(res, 200, {
          items: items.map((item) => ({
            ...item,
            installed: installed.has(item.name),
            localVersion: installed.get(item.name) ?? "",
            // 云端有新版就提示升级；没有版本号时按「已装」处理，不制造假更新
            upgradable: installed.has(item.name) && Boolean(item.version) && item.version !== installed.get(item.name),
          })),
          hub: describeHubSettings(config.hub),
        });
      } catch (error) {
        json(res, error instanceof HubError && error.kind === "auth" ? 401 : 502, {
          error: error?.message || String(error),
          kind: error?.kind ?? "hub",
        });
      }
      return true;
    }

    if (method === "GET" && path === "/api/skills/hub/detail") {
      const name = params.get("name") ?? "";
      if (!name) return json(res, 400, { error: "缺少 name" }), true;
      try {
        json(res, 200, await hubClient().detail(name));
      } catch (error) {
        json(res, 502, { error: error?.message || String(error) });
      }
      return true;
    }

    // 拉取安装：可以一次拉多个，逐个汇报成败——一个失败不该让整批看起来全挂。
    if (method === "POST" && path === "/api/skills/pull") {
      const body = await readJson(req);
      const names = [...new Set((Array.isArray(body.names) ? body.names : [body.name])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean))].slice(0, 20);
      if (!names.length) return json(res, 400, { error: "没说要拉哪个技能" }), true;

      const client = hubClient();
      const store = skillStore();
      const results = [];
      for (const name of names) {
        try {
          const { buffer, version } = await client.download(name);
          const record = store.install({
            buffer,
            expectedName: name,
            hub: { baseUrl: config.hub.baseUrl, version, pulledAt: new Date().toISOString() },
          });
          results.push({
            name: record.name,
            ok: true,
            title: record.title,
            version: version || record.version,
            replaced: record.replaced,
            files: record.files,
            bytes: record.bytes,
          });
        } catch (error) {
          results.push({ name, ok: false, error: error?.message || String(error) });
        }
      }
      const ok = results.filter((item) => item.ok).length;
      json(res, ok ? 200 : 502, { results, ok, failed: results.length - ok, items: store.list() });
      return true;
    }

    if (method === "GET" && segment.length === 1) {
      json(res, 200, { items: skillStore().list(), dir: config.skillDir, hub: describeHubSettings(config.hub) });
      return true;
    }

    // 看正文：前端「展开看它写了什么」用，别让人为了看一眼去开资源管理器
    if (method === "GET" && segment.length === 2) {
      try {
        const { meta, body, file } = skillStore().readBody(segment[1]);
        json(res, 200, { name: segment[1], meta, body, file });
      } catch (error) {
        json(res, 404, { error: error?.message || String(error) });
      }
      return true;
    }

    if (method === "DELETE" && segment.length === 2) {
      try {
        json(res, 200, { ...skillStore().remove(segment[1]), items: skillStore().list() });
      } catch (error) {
        json(res, 400, { error: error?.message || String(error) });
      }
      return true;
    }

    // 保存编辑：只改入口文件的 frontmatter 与正文，包里的脚本/模板不动
    if ((method === "PATCH" || method === "PUT") && segment.length === 2) {
      const body = await readJson(req);
      try {
        const saved = skillStore().save(segment[1], {
          title: body.title,
          summary: body.summary,
          body: body.body,
          version: body.version,
          category: body.category,
          tags: body.tags,
        });
        json(res, 200, { ...saved, items: skillStore().list() });
      } catch (error) {
        json(res, 400, { error: error?.message || String(error) });
      }
      return true;
    }
  }

  // 平台账号：只写不读（密码回显永远是掩码）
  if (method === "GET" && path === "/api/hub/settings") {
    json(res, 200, describeHubSettings(config.hub));
    return true;
  }

  if (method === "PATCH" && path === "/api/hub/settings") {
    const body = await readJson(req);
    try {
      json(res, 200, saveHubSettings(config, body));
    } catch (error) {
      json(res, 400, { error: error?.message || String(error) });
    }
    return true;
  }

  // 存之前先连一次：地址/账号写错，用户当场就知道
  if (method === "POST" && path === "/api/hub/test") {
    const body = await readJson(req);
    const probe = new HubClient({
      baseUrl: body.baseUrl || config.hub.baseUrl,
      username: body.username || config.hub.username,
      password: typeof body.password === "string" && body.password.trim() ? body.password.trim() : config.hub.password,
    });
    try {
      await probe.login();
      const items = await probe.list({ type: "skill" });
      json(res, 200, { ok: true, count: items.length, sample: items.slice(0, 3).map((item) => item.title) });
    } catch (error) {
      json(res, 200, { ok: false, error: error?.message || String(error), kind: error?.kind ?? "hub" });
    }
    return true;
  }


  // ---------------------------------------------------------------- bootstrap
  if (method === "GET" && path === "/api/bootstrap") {
    const { items, counts, total } = selectTasks(manager, new URLSearchParams());
    json(res, 200, {
      service: "workbuddy-workbench",
      codexVersion: ctx.codexVersion,
      domains: DOMAINS,
      agents: agentViews(config),
      capabilities: CAPABILITIES,
      // 本机 CLI 磁贴放最前：新增员工时默认选它，整张表单都不用碰 API Key。
      // installed 是服务端探测的结果，前端磁贴直接标「已安装 / 未检测到」
      agentPresets: [
        ...LOCAL_CLI_PRESETS.map((preset) => ({ ...preset, installed: probeLocalCli(preset.cli) })),
        ...PRESET_VIEWS,
      ],
      avatars: AVATAR_PRESETS,
      templates: TEMPLATES,
      allowedRoots: config.allowedRoots,
      defaultRoot: config.allowedRoots[0] ?? null,
      maxConcurrency: config.maxConcurrency,
      queue: manager.queue.length,
      running: manager.running,
      runtime: buildRuntimeFacts(config),
      // 工作方法库：本地已装的技能（外带平台配置，密码只给掩码）
      skills: safeSkillList(config),
      hub: describeHubSettings(config.hub),
      service: {
        host: config.host,
        port: config.port,
        mode: config.host === "127.0.0.1" || config.host === "localhost" ? "local" : "lan",
        lanAddresses: ctx.serviceControl?.lanAddresses?.() ?? [],
        autostartSupported: Boolean(ctx.serviceControl?.autostartSupported),
        autostart: ctx.serviceControl?.autostartSupported ? await ctx.serviceControl.autostartStatus() : null,
      },
      tasks: items,
      counts,
      total,
      // 版本与更新：设置页要显示当前版本、有没有新版、上次检查结果
      update: ctx.updater?.summary() ?? null,
      stats: buildStats(manager),
    });
    return true;
  }

  // ---------------------------------------------------------------- 服务管理（设置页）
  if (method === "GET" && path === "/api/service") {
    const svc = ctx.serviceControl;
    json(res, 200, {
      host: config.host,
      port: config.port,
      mode: config.host === "127.0.0.1" || config.host === "localhost" ? "local" : "lan",
      lanAddresses: svc?.lanAddresses?.() ?? [],
      uptimeSeconds: svc ? Math.floor((Date.now() - svc.startedAt) / 1000) : 0,
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      autostartSupported: Boolean(svc?.autostartSupported),
      autostart: svc?.autostartSupported ? await svc.autostartStatus() : null,
    });
    return true;
  }

  // 开机自启开关：写/删 HKCU Run 项（无需管理员权限），立即生效
  if (method === "POST" && path === "/api/service/autostart") {
    const body = await readJson(req);
    const enabled = Boolean(body.enabled);
    if (!ctx.serviceControl?.autostartSupported) {
      return json(res, 400, { error: "开机自启目前只在 Windows 上支持" }), true;
    }
    try {
      await ctx.serviceControl.setAutostart(enabled);
    } catch (error) {
      return json(res, 500, { error: `注册表写入失败：${error?.message || error}` }), true;
    }
    json(res, 200, { ok: true, enabled: await ctx.serviceControl.autostartStatus() });
    return true;
  }

  // 切监听范围/端口：写回配置（重启后仍生效）+ 后台热切换。
  // 注意切换会断开所有连接（包括正在响应的这条），必须先应答、延迟执行。
  if (method === "POST" && path === "/api/service/listen") {
    const body = await readJson(req);
    const port = Number(body.port ?? config.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return json(res, 400, { error: "端口要在 1024–65535 之间" }), true;
    }
    const host = body.mode === "lan" ? "0.0.0.0" : "127.0.0.1";
    const changed = host !== config.host || port !== config.port;
    if (changed) {
      const svc = ctx.serviceControl;
      setTimeout(() => {
        svc.relisten(host, port)
          .then(() => { try { saveServerBind(config.configPath, host, port); } catch { /* 持久化失败不影响本次监听 */ } })
          .catch(() => { /* 失败已自动回滚旧地址；前端回到页面后从实际状态发现未生效 */ });
      }, 400);
    }
    json(res, 200, {
      ok: true,
      requestedMode: body.mode === "lan" ? "lan" : "local",
      requestedPort: port,
      note: changed ? "切换正在后台执行" : "配置未变化",
    });
    return true;
  }

  // 停机：先把响应发出去，300ms 后退出进程。重新启动用桌面图标。
  if (method === "POST" && path === "/api/service/stop") {
    ctx.serviceControl?.stop();
    json(res, 200, { ok: true, note: "服务将在 1 秒内停止，用桌面图标可重新启动" });
    return true;
  }

  // ---------------------------------------------------------------- 版本与更新
  // 网关本体更新：检查平台清单 → 下载 → 备份 → 覆盖，重启交给 /api/system/restart。
  // 每一步都返回人能看懂的结果，失败时把原因（连不上 / 没清单 / 校验不过）说清楚。
  if (path === "/api/system/update" || path.startsWith("/api/system/update/")) {
    const updater = ctx.updater;
    if (!updater) return json(res, 501, { error: "当前网关没有启用更新能力" }), true;

    if (method === "GET" && path === "/api/system/update") {
      json(res, 200, { ...updater.summary(), backups: updater.backups() });
      return true;
    }

    if (method === "POST" && path === "/api/system/update/check") {
      const body = await readJson(req);
      const result = await updater.check({ manifestUrl: body?.manifestUrl });
      json(res, result.ok ? 200 : 502, result);
      return true;
    }

    if (method === "POST" && path === "/api/system/update/apply") {
      const body = await readJson(req);
      try {
        const result = await updater.apply({ manifest: body?.manifest });
        json(res, 200, result);
      } catch (error) {
        const status = error?.kind === "busy" || error?.kind === "noop" ? 409 : error?.kind === "download" ? 502 : 400;
        json(res, status, { error: error?.message || String(error), kind: error?.kind ?? "update" });
      }
      return true;
    }

    if (method === "POST" && path === "/api/system/update/rollback") {
      const body = await readJson(req);
      try {
        json(res, 200, await updater.rollback({ backupDir: body?.backupDir }));
      } catch (error) {
        json(res, 400, { error: error?.message || String(error), kind: error?.kind ?? "rollback" });
      }
      return true;
    }

    if (method === "PATCH" && path === "/api/system/update/settings") {
      const body = await readJson(req);
      try {
        json(res, 200, updater.saveSettings(body ?? {}));
      } catch (error) {
        json(res, 400, { error: error?.message || String(error) });
      }
      return true;
    }
  }

  // 重启：先回响应再退出，由 scripts/relaunch.mjs 等端口释放后拉起新进程。
  // 装了 watchdog 时它会先一步接手，relaunch 检测到端口已被占用就自己退出，不会双开。
  if (method === "POST" && path === "/api/system/restart") {
    if (!ctx.serviceControl?.restart) return json(res, 501, { error: "当前网关不支持自动重启，请用桌面图标启动" }), true;
    json(res, 200, { ok: true, note: "服务将在 1 秒内重启，页面会自动重连" });
    setTimeout(() => {
      try {
        ctx.serviceControl.restart({ delayMs: 500 });
      } catch (error) {
        console.error(`[gateway] 重启失败：${error?.message || error}`);
      }
    }, 150);
    return true;
  }

  if (method === "GET" && path === "/api/stats") {
    // 原有字段继续服务设置页；看板页用 ?days=7|30 拿 totals + trend + 各聚合。
    const days = Number(params.get("days")) || 7;
    const runs = ctx.flowStore ? ctx.flowStore.listRuns() : [];
    // 单价只存在配置里，不写进任务记录：改价后历史金额跟着重算，但 token 不变。
    const pricingOf = (agentId) => config.agents?.[agentId]?.pricing ?? null;
    json(res, 200, {
      ...buildStats(manager),
      ...computeStats(manager.list(), { days, pricingOf }),
      flows: computeFlowStats(runs),
    });
    return true;
  }

  if (method === "GET" && path === "/api/agents") {
    json(res, 200, { items: agentViews(config) });
    return true;
  }

  // 在线改配置：写回文件 + 就地更新内存，云端 runner 由 server 重建
  if (method === "PATCH" && segment[0] === "agents" && segment[1] && segment.length === 2) {
    const body = await readJson(req);
    const agent = updateAgentConfig(config, segment[1], body);
    ctx.onAgentConfigChanged?.();
    json(res, 200, { agent, agents: agentViews(config) });
    return true;
  }

  // 新增员工：只支持 OpenAI 兼容的云端员工
  if (method === "POST" && segment[0] === "agents" && segment.length === 1) {
    const body = await readJson(req);
    const agent = createAgent(config, body);
    ctx.onAgentConfigChanged?.();
    json(res, 201, { agent, agents: agentViews(config) });
    return true;
  }

  if (method === "DELETE" && segment[0] === "agents" && segment[1] && segment.length === 2) {
    const result = deleteAgent(config, segment[1]);
    ctx.onAgentConfigChanged?.();
    json(res, 200, { ...result, agents: agentViews(config) });
    return true;
  }

  // 新建时还没有 id：直接用表单里的模型 / 地址 / 密钥探一次，让用户存之前就能确认 Key 对不对
  if (method === "POST" && segment[0] === "agents" && segment[1] === "test" && segment.length === 2) {
    const body = await readJson(req);
    const result = await probeAgent(config, null, {
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    json(res, 200, result);
    return true;
  }

  // 测试连接：用表单里的值打一次最小请求，不写任何文件
  if (method === "POST" && segment[0] === "agents" && segment[1] && segment[2] === "test") {
    const body = await readJson(req);
    const result = await probeAgent(config, segment[1], {
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    json(res, 200, result);
    return true;
  }

  // AI 查价：派一个能联网的本机员工查模型最新公开单价。
  // 查价目标用表单里当前填的模型名（新增 / 编辑都能用）；结果只回填表单，保存才落盘。
  if (method === "POST" && segment[0] === "agents" && segment[1] === "pricing" && segment[2] === "refresh" && segment.length === 3) {
    const body = await readJson(req);
    let prompt;
    try {
      prompt = buildPricingPrompt({ name: body.name, model: body.model });
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    // 只有本机 CLI 员工真有联网工具；云端 runner 是裸 chat，查不了网页
    const workers = ["claude", "codex"].filter((id) => ctx.runner?.has?.(id) && config.agents?.[id]?.available);
    const workerId = workers.includes(body.workerId) ? body.workerId : workers[0];
    if (!workerId) {
      json(res, 409, { error: "没有能联网的员工可派（需要 Claude Code 或 Codex 可用）" });
      return true;
    }
    const job = {
      id: `price-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      status: "running",
      model: String(body.model || "").trim() || String(body.name || "").trim(),
      workerId,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      pricing: null,
      source: "",
      note: "",
      abort: null,
    };
    pricingJobs.set(job.id, job);
    // 只留最近 30 条已结束的，防内存慢慢长
    const finished = [...pricingJobs.values()].filter((item) => item.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > 30) pricingJobs.delete(finished.shift().id);

    const controller = new AbortController();
    job.abort = controller;
    runPricingJob(job, {
      prompt,
      runner: ctx.runner,
      cwd: config.allowedRoots?.[0] ?? process.cwd(),
      // 查价是短任务：网关默认 30 分钟对它太宽，封顶 8 分钟
      timeoutMs: Math.min(config.taskTimeoutMs ?? 300_000, 8 * 60_000),
      signal: controller.signal,
    }).catch(() => {});
    json(res, 202, { job: pricingJobView(job) });
    return true;
  }

  if (method === "GET" && segment[0] === "agents" && segment[1] === "pricing" && segment[2] === "jobs" && segment[3] && segment.length === 4) {
    const job = pricingJobs.get(segment[3]);
    if (!job) {
      json(res, 404, { error: "查价任务不存在或网关已重启" });
      return true;
    }
    json(res, 200, { job: pricingJobView(job) });
    return true;
  }

  // ---------------------------------------------------------------- flows
  if (segment[0] === "flows" && ctx.flowStore && ctx.flowRunner) {
    const { flowStore, flowRunner, flowEvents } = ctx;

    if (method === "GET" && segment.length === 1) {
      json(res, 200, { items: flowStore.listFlows(), runs: flowStore.listRuns().slice(0, 30) });
      return true;
    }

    // 运行实例相关路由放在具体 flow id 之前判断
    if (method === "GET" && segment[1] === "runs" && segment.length === 2) {
      json(res, 200, { items: flowStore.listRuns() });
      return true;
    }

    if (method === "GET" && segment[1] === "runs" && segment.length === 3) {
      const run = flowStore.getRun(segment[2]);
      if (!run) return json(res, 404, { error: "运行实例不存在" }), true;
      json(res, 200, run);
      return true;
    }

    // 流程运行事件流：只推步骤状态与产物清单，前端据此重画，取代 3 秒全量轮询。
    // 语义与 /api/tasks/:id/events 一致：Last-Event-ID 续传，窗口过期给 reset。
    if (method === "GET" && segment[1] === "runs" && segment.length === 4 && segment[3] === "events") {
      const runId = segment[2];
      if (!flowStore.getRun(runId)) return json(res, 404, { error: "运行实例不存在" }), true;
      if (!flowEvents) return json(res, 501, { error: "流程事件流未启用" }), true;

      const raw = req.headers["last-event-id"] ?? params.get("after") ?? undefined;
      let after = 0;
      if (raw !== undefined) {
        if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
          return json(res, 400, { error: "Last-Event-ID 必须是非负整数" }), true;
        }
        after = Number(raw);
      }

      // 先订阅再取窗口，两步之间不会漏事件（同步代码不会被别的回调插入）。
      const window = flowEvents.subscribeFrom(runId, (event) => {
        res.write(`id: ${event.sequence}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      const expired = after < window.earliestSequence - 1;
      const ahead = after > window.latestSequence;
      if (expired || ahead) {
        // 窗口滚掉了：让前端丢掉增量、重新拉一次完整快照。
        res.write(`id: ${window.latestSequence}\n`);
        res.write("event: reset\n");
        res.write(
          `data: ${JSON.stringify({
            earliestSequence: window.earliestSequence,
            latestSequence: window.latestSequence,
          })}\n\n`,
        );
      } else {
        for (const event of window.events) {
          if (event.sequence <= after) continue;
          res.write(`id: ${event.sequence}\n`);
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        window.unsubscribe();
      });
      return true;
    }

    // 读取运行目录里的单个工件（路径校验在 readArtifact 里做）
    if (method === "GET" && segment[1] === "runs" && segment.length === 4 && segment[3] === "files") {
      const run = flowStore.getRun(segment[2]);
      if (!run) return json(res, 404, { error: "运行实例不存在" }), true;
      const target = params.get("path") ?? "";
      if (!target) return json(res, 400, { error: "缺少 path 参数" }), true;
      const { kind, mime } = classifyArtifact(target);
      // 工具写入的是真实项目文件，可能在运行目录，也可能在工作目录；两处都试。
      const bases = [run.runDir, run.cwd].filter(Boolean);
      // 二进制（图片等）按原始字节返回，前端可以直接当 src 用，不做 base64 往返。
      if (params.get("raw") === "1") {
        for (const base of bases) {
          const resolved = confinePath(target, base);
          if (!resolved) continue;
          const stat = safeStatOf(resolved.absolute);
          if (!stat?.isFile()) continue;
          res.writeHead(200, {
            "content-type": mime || "application/octet-stream",
            "content-length": stat.size,
            "cache-control": "private, max-age=60",
            "x-content-type-options": "nosniff",
          });
          res.end(readFileSync(resolved.absolute));
          return true;
        }
        return json(res, 404, { error: "文件不存在或路径越界" }), true;
      }
      try {
        json(res, 200, { ...readArtifact(target, run.runDir), kind, mime });
      } catch (error) {
        // 工具写入的是真实项目文件，不在运行目录里：回退到工作目录再读一次。
        if (!run.cwd) throw error;
        json(res, 200, { ...readArtifact(target, run.cwd), kind, mime });
      }
      return true;
    }

    if (method === "POST" && segment[1] === "runs" && segment.length === 4) {
      const body = await readJson(req);
      const action = segment[3];

      if (action === "apply") {
        // 副本运行的改动回写源目录，只动这次运行登记过的文件。
        const result = flowRunner.applyRun(segment[2], Array.isArray(body.paths) ? body.paths : null);
        json(res, 200, result);
        return true;
      }

      if (!["continue", "retry", "retry-step", "ignore", "cancel", "reject"].includes(action)) {
        return json(res, 404, { error: `未知动作：${action}` }), true;
      }
      const run = action === "continue"
        ? flowRunner.continueRun(segment[2])
        : action === "retry"
          ? flowRunner.retry(segment[2])
          : action === "retry-step"
            // 单步重跑：只重跑这一节点，下游成功产出原样留着，用旧产出继续。
            ? flowRunner.retryStep(segment[2], String(body.stepKey ?? ""))
            : action === "ignore"
              ? flowRunner.ignoreRun(segment[2])
              : action === "reject"
                ? flowRunner.rejectRun(segment[2])
                : flowRunner.cancel(segment[2]);
      json(res, 200, run);
      return true;
    }

    // 清理副本作业目录（含副本里的工件，删后文件预览会失效）
    if (method === "DELETE" && segment[1] === "runs" && segment.length === 4 && segment[3] === "workspace") {
      json(res, 200, flowRunner.dropWorkspace(segment[2]));
      return true;
    }

    if (method === "POST" && segment[1] && segment[2] === "run" && segment.length === 3) {
      const body = await readJson(req);
      const run = flowRunner.start(segment[1], {
        input: body.input,
        variables: body.variables,
        cwd: body.cwd,
        mode: body.mode,
      });
      json(res, 201, run);
      return true;
    }

    if (method === "POST" && segment.length === 1) {
      const body = await readJson(req);
      const flow = flowStore.createFlow(config, body);
      json(res, 201, { flow, items: flowStore.listFlows() });
      return true;
    }

    if (method === "PATCH" && segment.length === 2) {
      const body = await readJson(req);
      const flow = flowStore.updateFlow(config, segment[1], body);
      json(res, 200, { flow, items: flowStore.listFlows() });
      return true;
    }

    if (method === "DELETE" && segment.length === 2) {
      const result = flowStore.deleteFlow(segment[1]);
      json(res, 200, { ...result, items: flowStore.listFlows() });
      return true;
    }
  }

  if (method === "GET" && path === "/api/templates") {
    json(res, 200, { items: TEMPLATES, domains: DOMAINS });
    return true;
  }

  if (method === "POST" && path === "/api/route") {
    const body = await readJson(req);
    const template = body.taskType ? findTemplate(body.taskType) : null;
    const recommendation = recommendAgent({
      domain: body.domain ?? template?.domain ?? "adhoc",
      taskType: body.taskType ?? null,
      prompt: body.prompt ?? "",
      outputTypes: body.outputTypes ?? template?.outputTypes ?? [],
      model: body.model ?? null,
    }, config.agents);
    json(res, 200, recommendation);
    return true;
  }

  // ---------------------------------------------------------------- tasks
  if (method === "GET" && path === "/api/tasks") {
    json(res, 200, selectTasks(manager, params));
    return true;
  }

  if (method === "POST" && path === "/api/tasks") {
    const body = await readJson(req);
    const template = body.taskType ? findTemplate(body.taskType) : null;
    const values = body.values && typeof body.values === "object" ? body.values : {};
    let prompt = String(body.prompt ?? "").trim() || (template ? buildPrompt(template, values) : "");
    if (!prompt) throw new Error("至少需要一句任务描述");

    // 工作方法挂载：显式勾选的优先；没勾就按任务描述自动匹配（可在设置里关）。
    // 技能正文插在指令前面，任务本体原样保留在后面。
    const pickedSkills = Array.isArray(body.skills) ? body.skills : [];
    const autoSkills = pickedSkills.length ? [] : autoSkillNames(config, prompt);
    const skillResult = applySkills(config, pickedSkills.length ? pickedSkills : autoSkills, prompt);
    if (skillResult.mounted.length) prompt = skillResult.prompt;
    if (prompt.length > config.maxPromptChars) {
      throw new Error(`任务描述超过 ${config.maxPromptChars} 字（挂了工作方法后更容易超，可以少挂一个）`);
    }

    const domain = body.domain || template?.domain || "adhoc";
    const outputTypes = Array.isArray(body.outputTypes) && body.outputTypes.length
      ? body.outputTypes
      : template?.outputTypes ?? ["markdown"];

    const recommendation = recommendAgent({
      domain,
      taskType: body.taskType ?? null,
      prompt,
      outputTypes,
      model: body.model ?? null,
    }, config.agents);
    const agent = body.agent || recommendation.recommendedAgent;
    const agentChoice = body.agent ? "manual" : "auto";
    if (!body.draft) assertAgentUsable(agent, config.agents);

    const cwd = resolveAllowedDirectory(body.cwd || config.allowedRoots[0], config.allowedRoots);
    const mode = ["read-only", "workspace-write"].includes(body.mode) ? body.mode : "workspace-write";

    const created = manager.create(
      {
        prompt,
        cwd,
        mode,
        model: body.model || null,
        reasoningEffort: normalizeReasoningEffort(body.reasoningEffort, config.codexReasoningEffort),
        threadId: body.threadId || null,
        label: String(body.title ?? "").trim() || firstLine(prompt),
        tags: Array.isArray(body.tags) ? body.tags : [],
        domain,
        taskType: body.taskType ?? null,
        priority: ["high", "normal", "low"].includes(body.priority) ? body.priority : "normal",
        outputTypes,
        agent,
        agentChoice,
        skills: skillResult.mounted,
      },
      req.headers["x-idempotency-key"]?.toString().slice(0, 200) || null,
      { draft: body.draft === true }
    );

    json(res, created.duplicate ? 200 : 201, {
      ...created.task,
      route: recommendation,
      skills: { mounted: skillResult.mounted, missing: skillResult.missing, auto: autoSkills.length > 0 },
      duplicate: created.duplicate,
    });
    return true;
  }

  const taskId = segment[1];
  const action = segment[2];

  if (taskId && method === "GET" && segment.length === 2) {
    const task = manager.get(taskId, params.get("events") === "1");
    if (!task) return json(res, 404, { error: "任务不存在" }), true;
    json(res, 200, { ...task, queuePosition: manager.queuePosition(taskId) });
    return true;
  }

  if (taskId && method === "PATCH" && segment.length === 2) {
    const task = manager.update(taskId, await readJson(req));
    if (!task) return json(res, 404, { error: "任务不存在" }), true;
    json(res, 200, task);
    return true;
  }

  if (taskId && segment.length === 3) {
    if (method === "GET" && action === "events") return false; // handled by server.mjs SSE route
    if (method === "GET" && action === "artifacts") {
      const task = manager.get(taskId);
      if (!task) return json(res, 404, { error: "任务不存在" }), true;
      json(res, 200, { items: task.artifacts ?? [] });
      return true;
    }
    if (method === "POST" && action) {
      const body = action === "rerun" || action === "archive" || action === "read" ? await readJson(req) : {};
      let result = null;
      if (action === "dispatch") result = manager.dispatch(taskId);
      else if (action === "cancel") result = manager.cancel(taskId);
      else if (action === "rerun") result = manager.rerun(taskId, { resume: body.resume === true });
      else if (action === "archive") result = manager.archive(taskId, body.archived !== false);
      else if (action === "restore") result = manager.archive(taskId, false);
      else if (action === "read") result = manager.markRead(taskId, body.read !== false);
      else return json(res, 404, { error: `未知动作：${action}` }), true;
      if (!result) return json(res, 404, { error: "任务不存在" }), true;
      json(res, 200, { ...result, queuePosition: manager.queuePosition(taskId) });
      return true;
    }
  }

  // ---------------------------------------------------------------- artifact preview
  if (method === "GET" && segment[0] === "artifacts" && segment[2] === "content") {
    const task = manager.get(segment[1]);
    const artifact = task?.artifacts?.find((item) => item.id === segment[3]);
    if (!artifact) return json(res, 404, { error: "产出物不存在" }), true;
    if (!existsSync(artifact.path)) return json(res, 410, { error: "文件已被移动或删除" }), true;
    const stat = statSync(artifact.path);
    // ?raw=1：图片/HTML 等二进制或需要原样呈现的文件，按原始字节返回（供 <img>/<iframe> 用）
    const raw = params.get("raw") === "1";
    if (raw) {
      if (stat.size > 30 * 1024 * 1024) return json(res, 413, { error: "文件过大，无法预览" }), true;
      const ext = artifact.path.split(".").pop()?.toLowerCase() ?? "";
      const mime = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
        html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
        pdf: "application/pdf",
      }[ext] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Cache-Control": "no-store" });
      res.end(readFileSync(artifact.path));
      return true;
    }
    if (stat.size > 1024 * 1024) return json(res, 413, { error: "文件过大，请直接下载" }), true;
    json(res, 200, {
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      content: readFileSync(artifact.path, "utf8"),
    });
    return true;
  }

  json(res, 404, { error: `未知接口：${method} ${path}` });
  return true;
}

export { AGENTS, DOMAINS, TEMPLATES };
