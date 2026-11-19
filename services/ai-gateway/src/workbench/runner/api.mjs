/**
 * 远程执行器 API（多机部署的控制面）。
 *
 * /api/runner/*   —— 给本机执行器（runner-agent）用：认证用个人推送 Token，
 *                    只能领到自己名下的任务；主 Token 视为管理员本人。
 * /api/user-agents/* —— 给浏览器用：每个人管理自己的 AI 员工（含 API Key，
 *                    服务器端 AES 加密落库，浏览器只见掩码）。
 *
 * 设计底线：
 * - 执行器永远只领「owner 是自己」的任务，别人的活一行代码都摸不到；
 * - 员工配置的明文 Key 只在 claim 响应里出现一跳（服务器 → 执行器），
 *   不落日志、不进任务记录。
 */

import { serverAddressForCode } from "../accounts/api.mjs";
import { probeChatEndpoint, listModelsFromEndpoint } from "../agent-probe.mjs";

const readRaw = async (req, limit = 2 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("请求体必须是合法 JSON");
  }
};

/** 执行器信息：只保留可以给前端展示的字段。 */
const describeRunner = (entry) => ({
  accountId: entry.accountId,
  accountName: entry.accountName,
  version: entry.version || "",
  platform: entry.platform || "",
  host: entry.host || "",
  lastSeen: entry.lastSeen,
  since: entry.since || entry.lastSeen,
  currentTaskId: entry.currentTaskId ?? null,
  // 本机运行配置：执行器在 claim 里带上来，页面直接展示（不含任何密钥）
  roots: entry.roots ?? [],
  /** 平台侧覆盖的目录白名单（runner_prefs 表）；没有覆盖时为 null */
  rootsOverride: entry.rootsOverride ?? null,
  codex: entry.codex ?? null,
  dsh: entry.dsh ?? null,
});

export function createRunnerApi({ manager, userAgents, accounts, accountsApi, authorized, json, taskLabelOf }) {
  /** accountId → 注册信息；进程内存即可，重启后执行器下一次心跳自动回来 */
  const runners = new Map();

  /** Bearer Token → 账号；主 Token 视为第一个管理员。 */
  const primaryAdmin = () => accounts.listAccounts().find((a) => a.role === "admin" && a.active) ?? null;
  const accountOf = (req) => {
    const header = req.headers.authorization || "";
    if (authorized(req)) return primaryAdmin();
    if (header.startsWith("Bearer ")) {
      return accounts.accountByPushToken(header.slice(7));
    }
    return null;
  };

  const touch = (account, req, body = {}) => {
    const prev = runners.get(account.id) ?? {};
    const entry = {
      accountId: account.id,
      accountName: account.name || account.username,
      // version / platform 只在携带时刷新：finish 等调用不带这些字段，别把上次的抹掉
      version: body.version ? String(body.version).slice(0, 40) : (prev.version || ""),
      platform: body.platform ? String(body.platform).slice(0, 40) : (prev.platform || ""),
      host: String(req.socket?.remoteAddress ?? "").replace("::ffff:", ""),
      // since = 本次上线的起点（内存态）；执行器重启会重新计
      since: prev.since || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      currentTaskId: prev.currentTaskId ?? null,
    };
    // 运行配置：只有 claim 会带，带上才覆盖
    if (Array.isArray(body.roots)) entry.roots = body.roots.map((item) => String(item).slice(0, 200)).slice(0, 20);
    else if (prev.roots) entry.roots = prev.roots;
    // 平台侧覆盖：每次 touch 都查一遍库（几行数据，开销可忽略），改动下次心跳即生效
    entry.rootsOverride = accounts.runnerRoots(account.id);
    if (body.codex && typeof body.codex === "object") {
      entry.codex = {
        ok: body.codex.ok === true,
        version: String(body.codex.version ?? "").slice(0, 60),
      };
    } else if (prev.codex) entry.codex = prev.codex;
    if (body.dsh && typeof body.dsh === "object") {
      entry.dsh = {
        ok: body.dsh.ok === true,
        version: String(body.dsh.version ?? "").slice(0, 60),
        apiKey: body.dsh.apiKey === true,
      };
    } else if (prev.dsh) entry.dsh = prev.dsh;
    runners.set(account.id, entry);
    return entry;
  };

  const handle = async (req, res, path, url) => {
    const method = req.method || "GET";

    /* ---------------- 配置码兑换（免鉴权：一次性码本身就是凭证） ---------------- */

    if (path === "/api/runner/bootstrap" && method === "POST") {
      const body = await readRaw(req);
      const account = accounts.redeemBootstrapCode(body.code);
      if (!account) {
        return json(res, 400, { error: "配置码无效或已过期（10 分钟有效、只能用一次），请让管理员重新生成" });
      }
      const withToken = accounts.issuePushToken(account.id); // 兑换即发新 Token，明文只此一次
      return json(res, 200, { server: String(body.server || "").trim(), token: withToken.token, accountName: account.name });
    }

    /* ---------------- 执行器通道（push Token / 主 Token） ---------------- */

    if (path === "/api/runner/claim" && method === "POST") {
      const account = accountOf(req);
      if (!account) return json(res, 401, { error: "无效的执行器 Token" });
      const body = await readRaw(req);
      const entry = touch(account, req, body);
      // 模型级排队：同一个模型被几个员工共用时，按模型的 concurrency 限并发。
      // 先数一遍当前跑着的任务，再按最老优先挑第一个「模型不忙」的活。
      const load = new Map();
      for (const item of manager.list()) {
        if (item.runner !== "remote" || item.status !== "running" || !item.modelId) continue;
        load.set(item.modelId, (load.get(item.modelId) ?? 0) + 1);
      }
      const limits = new Map();
      const task = manager.claimRemote(account.id, {
        canRun: (candidate) => {
          if (!candidate.modelId) return true; // 本机执行位不走模型池，不受限
          if (!limits.has(candidate.modelId)) {
            limits.set(candidate.modelId, userAgents.getModel(candidate.modelId)?.concurrency ?? 1);
          }
          return (load.get(candidate.modelId) ?? 0) < limits.get(candidate.modelId);
        },
      });
      if (!task) return json(res, 200, { task: null });
      entry.currentTaskId = task.id;
      const agent = userAgents.getForDispatch(task.agent);
      if (!agent) {
        // 员工被删了或停用了：任务直接失败，不悬挂
        manager.finishRemote(task.id, { ok: false, error: `AI 员工 ${task.agent} 已不可用` });
        entry.currentTaskId = null;
        return json(res, 200, { task: null, note: "agent_unavailable" });
      }
      // 只给执行器干活需要的字段，台账之外的东西不外送
      return json(res, 200, {
        task: {
          id: task.id,
          label: task.label,
          prompt: task.prompt,
          cwd: task.cwd,
          mode: task.mode,
          model: task.model,
          domain: task.domain,
          outputTypes: task.outputTypes,
          skills: task.skills,
        },
        agent,
        // 平台侧覆盖的目录白名单：执行器收到后热写回本机配置，下一个任务立即生效
        runnerPrefs: { roots: entry.rootsOverride },
      });
    }

    if (path === "/api/runner/heartbeat" && method === "POST") {
      const account = accountOf(req);
      if (!account) return json(res, 401, { error: "无效的执行器 Token" });
      const body = await readRaw(req);
      if (body.taskId) {
        const owned = manager.get(String(body.taskId));
        if (!owned || owned.runner !== "remote" || owned.ownerAccountId !== account.id)
          return json(res, 404, { error: "任务不存在或不属于当前执行器" });
      }
      const entry = touch(account, req, body);
      let cancel = false;
      if (body.taskId) {
        entry.currentTaskId = body.taskId;
        if (typeof body.output === "string" && body.output) {
          manager.remoteProgress(body.taskId, body.output);
        }
        cancel = manager.remoteCancelPending(body.taskId);
      }
      return json(res, 200, { ok: true, cancel, runnerPrefs: { roots: entry.rootsOverride } });
    }

    if (path === "/api/runner/finish" && method === "POST") {
      const account = accountOf(req);
      if (!account) return json(res, 401, { error: "无效的执行器 Token" });
      const body = await readRaw(req);
      if (body.taskId) {
        const owned = manager.get(String(body.taskId));
        if (!owned || owned.runner !== "remote" || owned.ownerAccountId !== account.id)
          return json(res, 404, { error: "任务不存在或不属于当前执行器" });
      }
      const entry = touch(account, req, body);
      const task = manager.finishRemote(String(body.taskId ?? ""), {
        ok: body.ok === true,
        cancelled: body.cancelled === true,
        finalResponse: body.finalResponse,
        error: body.error,
        usage: body.usage,
        threadId: body.threadId,
      });
      entry.currentTaskId = null;
      if (!task) return json(res, 404, { error: "任务不存在或不属于远程执行" });
      return json(res, 200, { ok: true, status: task.status });
    }

    /* ---------------- 浏览器通道（会话 / 主 Token） ---------------- */

    const gatewaySession = accountsApi.sessionAccount(req);
    // 平台集成身份：portal 反代带主 Token + X-Integration-Account，用它映射出的账号落归属
    const integrationViewer = gatewaySession ? null : (accountsApi.viewerAccount?.(req) ?? null);
    const sessionAccount = gatewaySession ?? integrationViewer;
    const isPrivileged = integrationViewer
      ? integrationViewer.role === "admin"
      : (authorized(req) || sessionAccount?.role === "admin");
    // 主 Token（程序化集成）没有会话，但操作要落在管理员名下，员工/任务才有归属
    const viewer = sessionAccount ?? (authorized(req) ? primaryAdmin() : null);

    // Each integrated private instance has no separate administrator to pair an ordinary user's runner.
    // Self-pairing grants only the current identity's existing runner capability.
    if (path === "/api/runner/bootstrap-code" && method === "POST") {
      if (!viewer) return json(res, 401, { error: "Unauthorized" });
      const { code, expiresAt } = accounts.createBootstrapCode(viewer.id);
      const server = serverAddressForCode(req, null);
      const packed = `WB1.${Buffer.from(JSON.stringify({ u: server, c: code })).toString("base64url")}`;
      return json(res, 200, { packed, expiresAt, server });
    }

    // 执行器运行配置：本人看/改自己的 roots；管理员可看/改任何人的
    if (path === "/api/runner-prefs" && method === "GET") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const targetId = isPrivileged && url.searchParams.get("accountId") ? url.searchParams.get("accountId") : viewer?.id;
      if (!targetId) return json(res, 401, { error: "Unauthorized" });
      const target = accounts.accountById(targetId);
      return json(res, 200, {
        accountId: targetId,
        accountName: target?.name ?? target?.username ?? "",
        roots: accounts.runnerRoots(targetId),
      });
    }

    if (path === "/api/runner-prefs" && method === "PUT") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      const targetId = isPrivileged && body.accountId ? String(body.accountId) : viewer?.id;
      if (!targetId) return json(res, 401, { error: "Unauthorized" });
      const roots = accounts.setRunnerRoots(targetId, body.roots === null ? null : body.roots);
      return json(res, 200, { ok: true, accountId: targetId, roots });
    }

    // 执行器在线状态：管理员看全员，普通人看自己
    if (path === "/api/runner/status" && method === "GET") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const now = Date.now();
      const items = [...runners.values()]
        .filter((entry) => isPrivileged || entry.accountId === viewer?.id)
        .map((entry) => ({
          ...describeRunner(entry),
          online: now - Date.parse(entry.lastSeen) < 30_000,
        }));
      return json(res, 200, { items });
    }

    // 我自己的员工清单
    if (path === "/api/user-agents" && method === "GET") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const accountId = isPrivileged && url.searchParams.get("all") === "1" ? null : viewer?.id;
      const items = accountId ? userAgents.list(accountId) : userAgents.listAll();
      return json(res, 200, { items });
    }

    /* ---------------- 模型池：一位员工引用一个模型，多个员工可共用 ---------------- */

    if (path === "/api/models" && method === "GET") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const accountId = isPrivileged && url.searchParams.get("all") === "1" ? null : viewer?.id;
      return json(res, 200, { items: userAgents.listModels(accountId) });
    }

    if (path === "/api/models" && method === "POST") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      return json(res, 201, userAgents.createModel(viewer?.id, body));
    }

    // 测试模型连通性 / 拉取模型清单：与员工弹窗里的同一套探针，只是入口更直白
    if ((path === "/api/models/test" || path === "/api/models/pull") && method === "POST") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      let saved = null;
      if (body.modelId) {
        saved = userAgents.getModel(String(body.modelId), isPrivileged ? null : viewer?.id);
        if (!saved) return json(res, 404, { error: "模型不存在" });
      }
      // Key 优先用表单里新填的；留空则用已存的那把（解密只在这一个请求的内存里）
      let apiKey = String(body.apiKey ?? "").trim();
      if (!apiKey && body.modelId) {
        apiKey = userAgents.getModelForDispatch(String(body.modelId))?.apiKey ?? "";
      }
      const source = {
        baseUrl: body.baseUrl || saved?.baseUrl || "",
        apiKey,
        model: body.model || saved?.model || "",
      };
      if (path === "/api/models/pull") {
        return json(res, 200, await listModelsFromEndpoint({ baseUrl: source.baseUrl, apiKey: source.apiKey }));
      }
      return json(res, 200, await probeChatEndpoint({ model: source.model, baseUrl: source.baseUrl, apiKey: source.apiKey }));
    }

    const modelMatch = path.match(/^\/api\/models\/([A-Za-z0-9-]+)$/);
    if (modelMatch) {
      const id = modelMatch[1];
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      if (method === "GET") {
        const record = userAgents.getModel(id, isPrivileged ? null : viewer?.id);
        return record ? json(res, 200, record) : json(res, 404, { error: "模型不存在" });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = await readRaw(req);
        return json(res, 200, userAgents.updateModel(id, isPrivileged ? null : viewer?.id, body));
      }
      if (method === "DELETE") {
        return json(res, 200, userAgents.removeModel(id, isPrivileged ? null : viewer?.id));
      }
    }

    if (path === "/api/user-agents" && method === "POST") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      const created = userAgents.create(viewer?.id, body);
      return json(res, 201, created);
    }

    // 测试连接：只发一次最小请求，不落库。带 agentId 时缺的字段用已保存的，
    // Key 解密后只在这次请求的内存里用一次，接口只回结果不回明文。
    // 注意：这条必须排在下面的 /api/user-agents/:id 之前，"test" 会被当成 id。
    if (path === "/api/user-agents/test" && method === "POST") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      let saved = null;
      if (body.agentId) {
        saved = userAgents.probeSource(String(body.agentId), isPrivileged ? null : viewer?.id);
        if (!saved) return json(res, 404, { error: "员工不存在" });
        if (saved.kind === "builtin") {
          return json(res, 200, { ok: false, error: "本机执行位在执行器电脑上跑，不走网络，无需测试" });
        }
      }
      const result = await probeChatEndpoint({
        model: body.model || saved?.model || "",
        baseUrl: body.baseUrl || saved?.baseUrl || "",
        apiKey: body.apiKey || saved?.apiKey || "",
      });
      return json(res, 200, result);
    }

    // 拉取模型清单：服务端代理转发 GET {baseUrl}/models，绕开浏览器跨域。
    // Key 不落盘，只在这一个请求的内存里用一次；带 agentId 时缺的 Key 用已存的。
    // 注意：这条必须排在下面的 /api/user-agents/:id 之前，"models" 会被当成 id。
    if (path === "/api/user-agents/models" && method === "POST") {
      if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
      const body = await readRaw(req);
      let saved = null;
      if (body.agentId) {
        saved = userAgents.probeSource(String(body.agentId), isPrivileged ? null : viewer?.id);
        if (!saved) return json(res, 404, { error: "员工不存在" });
        if (saved.kind === "builtin") {
          return json(res, 200, { ok: false, models: [], error: "本机执行位不走网络，无需拉取模型" });
        }
      }
      const result = await listModelsFromEndpoint({
        baseUrl: body.baseUrl || saved?.baseUrl || "",
        apiKey: body.apiKey || saved?.apiKey || "",
      });
      return json(res, 200, result);
    }

    const uaMatch = path.match(/^\/api\/user-agents\/([A-Za-z0-9-]+)$/);
    if (uaMatch) {
      const id = uaMatch[1];
      if (method === "GET") {
        if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
        const record = userAgents.get(id, isPrivileged ? null : viewer?.id);
        return record ? json(res, 200, record) : json(res, 404, { error: "员工不存在" });
      }
      if (method === "PATCH" || method === "PUT") {
        if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
        const body = await readRaw(req);
        const record = userAgents.update(id, isPrivileged ? null : viewer?.id, body);
        return json(res, 200, record);
      }
      if (method === "DELETE") {
        if (!viewer && !authorized(req)) return json(res, 401, { error: "Unauthorized" });
        return json(res, 200, userAgents.remove(id, isPrivileged ? null : viewer?.id));
      }
    }

    return false;
  };

  return { handle, runners };
}
