/**
 * 任务协作 · /api/collab/* 路由组。
 *
 * 三种身份：
 * - 平台会话（登录页账号+密码，HttpOnly cookie）：看板/协作页按项目隔离读；
 * - 网关主 Token（Bearer）：程序化集成，等同管理员；
 * - 推送 Token（账号的推送凭证）：只用于推送、读任务/项目列表、读附件。
 * 管理类操作（建删项目、AI 员工、成员管理）只认「主 Token 或 admin 会话」。
 */

import { extname } from "node:path";
import { CollabService, KIND_NAME } from "./service.mjs";

const MAX_UPLOAD = 40 * 1024 * 1024;

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

export function createCollabApi({ stateDir, authorized, taskLabel, accounts, accountsApi }) {
  const service = new CollabService({ stateDir, accounts });
  service.boot();

  const sseClients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  };

  const json = (res, status, body) => {
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    }
    res.end(JSON.stringify(body));
    return true;
  };
  const fail = (res, status, message) => json(res, status, { error: message });

  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  /** 登录会话账号；主 Token 请求没有会话但视为管理员。 */
  const viewer = (req) => {
    const account = accountsApi?.sessionAccount(req) ?? null;
    return { account, isAdmin: Boolean(authorized(req) || account?.role === "admin") };
  };
  const isAdmin = (req) => viewer(req).isAdmin;
  /** 非 admin 会话的可视项目集合；admin/主 Token 为 null（不限定）。 */
  const visibleIdsFor = (req) => {
    const { account, isAdmin: admin } = viewer(req);
    return admin ? null : service.visibleProjectIds(account);
  };
  /** 项目读取权限：admin 全量；普通会话必须是项目成员。 */
  const canSeeProject = (req, projectId) => {
    const { account, isAdmin: admin } = viewer(req);
    if (admin) return true;
    if (!account) return false;
    return service.visibleProjectIds(account).has(projectId);
  };

  const readRaw = async (req, limit = MAX_UPLOAD) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("推送内容超过 40MB 上限");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  const handle = async (req, res, path, url) => {
    const method = req.method || "GET";

    // ---------- 成员推送（成员 Token） ----------
    if (path === "/api/collab/push" && method === "POST") {
      const member = service.memberByToken(bearer(req));
      if (!member) return fail(res, 401, "无效的成员 Token");
      const contentType = req.headers["content-type"] || "";
      let body = "";
      let file = null;
      try {
        if (contentType.startsWith("application/json")) {
          const parsed = JSON.parse((await readRaw(req)).toString("utf8") || "{}");
          body = parsed.text ?? parsed.body ?? "";
          if (parsed.dataUrl?.startsWith("data:")) {
            const [head, data] = parsed.dataUrl.split(",");
            file = { data: Buffer.from(data, "base64"), name: parsed.filename || "file",
              mime: head.slice(5).split(";")[0] };
          }
        } else {
          const raw = await readRaw(req);
          const filename = url.searchParams.get("filename");
          const isText = (contentType || "").startsWith("text/") || contentType.includes("markdown");
          if (filename && !isText) {
            const mime = contentType && contentType !== "application/octet-stream"
              ? contentType : (MIME[extname(filename).toLowerCase()] || "application/octet-stream");
            file = { data: raw, name: filename, mime };
          } else {
            body = raw.toString("utf8");
          }
        }
        const push = service.ingest({
          token: bearer(req),
          taskId: url.searchParams.get("task"),
          projectId: url.searchParams.get("project"),
          agent: url.searchParams.get("agent"),
          kind: url.searchParams.get("kind"),
          title: url.searchParams.get("title") || undefined,
          body,
          file,
        });
        broadcast("push", push);
        return json(res, 200, { ok: true, push });
      } catch (err) {
        return fail(res, 400, err.message);
      }
    }

    // ---------- 任务/项目列表（推送端选目标用：推送 Token、会话、主 Token 均可） ----------
    if (path === "/api/collab/tasks" && method === "GET") {
      if (!service.memberByToken(bearer(req)) && !viewer(req).account && !isAdmin(req)) return fail(res, 401, "Unauthorized");
      return json(res, 200, { items: taskLabel?.() ?? [] });
    }

    // ---------- 项目列表：管理员全量；会话用户按项目隔离；推送端只要 id/name ----------
    if (path === "/api/collab/projects" && method === "GET") {
      const { account, isAdmin: admin } = viewer(req);
      const byPush = service.memberByToken(bearer(req));
      if (!account && !admin && !byPush) return fail(res, 401, "Unauthorized");
      const items = admin
        ? service.listProjects()
        : service.listProjects({ visibleIds: byPush ? null : service.visibleProjectIds(account) });
      const slim = !account && !admin; // 推送端只要 id/name/status
      return json(res, 200, {
        items: slim ? items.map((p) => ({ id: p.id, name: p.name, status: p.status })) : items,
      });
    }

    // ---------- SSE 实时流（登录会话 / 主 Token / query token 均可） ----------
    if (path === "/api/collab/stream" && method === "GET") {
      const qToken = url.searchParams.get("token");
      const ok = qToken
        ? (service.memberByToken(qToken) || authorized({ headers: { authorization: `Bearer ${qToken}` } }))
        : (viewer(req).account || isAdmin(req));
      if (!ok) return fail(res, 401, "Unauthorized");
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-store",
        connection: "keep-alive", "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 断开即清 */ } }, 25000);
      req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      return true;
    }

    // ---------- 附件（登录会话、推送 Token、主 Token 均可读） ----------
    const fileMatch = path.match(/^\/api\/collab\/files\/([\w-]+)$/);
    if (fileMatch && method === "GET") {
      if (!viewer(req).account && !service.memberByToken(bearer(req)) && !isAdmin(req)) return fail(res, 401, "Unauthorized");
      const got = service.readFile(fileMatch[1]);
      if (!got) return fail(res, 404, "附件不存在");
      res.writeHead(200, {
        "content-type": got.mime || "application/octet-stream",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(got.name || "file")}`,
        "cache-control": "private, max-age=3600",
      });
      res.end(got.data);
      return true;
    }

    // ---------- 协作总览（左侧一级「协作」页；会话用户按项目隔离） ----------
    if (path === "/api/collab/overview" && method === "GET") {
      const { account, isAdmin: admin } = viewer(req);
      if (!account && !admin && !service.memberByToken(bearer(req))) return fail(res, 401, "Unauthorized");
      const visibleIds = visibleIdsFor(req);
      const data = service.overview({
        memberId: url.searchParams.get("member") || undefined,
        agent: url.searchParams.get("agent") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        projectId: url.searchParams.get("project") || undefined,
        limit: url.searchParams.get("limit") || undefined,
        visibleIds,
      });
      const labels = new Map((taskLabel?.() ?? []).map((t) => [t.id, t]));
      data.items = data.items.map((p) => {
        const t = labels.get(p.taskId);
        return { ...p, taskLabel: t?.label ?? null, taskStatus: t?.status ?? null };
      });
      data.tasks = data.tasks.map((t) => ({ ...t, label: labels.get(t.taskId)?.label ?? null }));
      data.viewer = { id: account?.id ?? null, role: account?.role ?? "admin", isAdmin: admin };
      return json(res, 200, data);
    }

    // ---------- 项目详情 / 项目成员：读操作对项目成员开放 ----------
    const projectMatch = path.match(/^\/api\/collab\/projects\/([\w-]+)(\/pushes|\/agents|\/members)?$/);
    if (projectMatch && method === "GET" && !projectMatch[2]) {
      if (!canSeeProject(req, projectMatch[1])) return fail(res, 404, "项目不存在");
      const project = service.getProject(projectMatch[1]);
      if (!project) return fail(res, 404, "项目不存在");
      return json(res, 200, {
        project,
        agents: service.listProjectAgents(projectMatch[1]),
        members: service.listProjectMembers(projectMatch[1]),
        pushes: service.listPushes({ projectId: projectMatch[1], limit: url.searchParams.get("limit") }),
      });
    }
    if (projectMatch && method === "GET" && projectMatch[2] === "/members") {
      if (!canSeeProject(req, projectMatch[1])) return fail(res, 404, "项目不存在");
      return json(res, 200, { items: service.listProjectMembers(projectMatch[1]) });
    }

    // ---------- 任务推送读取（任务页一期对登录用户全可见） ----------
    const pushesMatch = path.match(/^\/api\/collab\/tasks\/([\w-]+)\/pushes$/);
    if (pushesMatch && method === "GET") {
      if (!viewer(req).account && !isAdmin(req) && !service.memberByToken(bearer(req))) return fail(res, 401, "Unauthorized");
      const kind = url.searchParams.get("kind") || undefined;
      const items = service.listPushes({ taskId: pushesMatch[1], kind, limit: url.searchParams.get("limit") });
      return json(res, 200, { items, counts: service.countByTask(pushesMatch[1]) });
    }

    // ---------- 新建协作项目：任何在用账号都可以 ----------
    if (path === "/api/collab/projects" && method === "POST") {
      const { account, isAdmin: admin } = viewer(req);
      if (!account && !admin) return fail(res, 401, "请先登录");
      let body = {};
      try { body = JSON.parse((await readRaw(req, 65536)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const created = service.createProject({ ...body, creator: account });
        broadcast("projects", {});
        return json(res, 200, created);
      } catch (err) { return fail(res, 400, err.message); }
    }

    // ---------- 项目级写操作：管理人员，或项目创建人（普通账号建的项目由他自己管） ----------
    // 先分清「没登录」和「登录了但没权限」：前者 401，后者 403
    if (!isAdmin(req) && !viewer(req).account) return fail(res, 401, "Unauthorized");
    const canManageProject = (projectId) =>
      isAdmin(req) || service.isProjectManager(projectId, viewer(req).account);

    const readBody = async () => {
      try { return JSON.parse((await readRaw(req, 65536)).toString("utf8") || "{}"); } catch { return {}; }
    };

    if (projectMatch && method === "PUT" && !projectMatch[2]) {
      if (!canManageProject(projectMatch[1])) return fail(res, 403, "只有项目创建人或管理人员能修改这个项目");
      try {
        const updated = service.updateProject(projectMatch[1], await readBody());
        broadcast("projects", {});
        return json(res, 200, updated);
      } catch (err) { return fail(res, 400, err.message); }
    }
    if (projectMatch && method === "DELETE" && !projectMatch[2]) {
      if (!canManageProject(projectMatch[1])) return fail(res, 403, "只有项目创建人或管理人员能删除这个项目");
      service.deleteProject(projectMatch[1]);
      broadcast("projects", {});
      return json(res, 200, { ok: true });
    }
    // 项目成员管理
    if (projectMatch && method === "POST" && projectMatch[2] === "/members") {
      if (!canManageProject(projectMatch[1])) return fail(res, 403, "只有项目创建人或管理人员能加人");
      const body = await readBody();
      const acc = accounts?.listAccounts().find((a) => a.id === body.accountId);
      if (!acc) return fail(res, 400, "账号不存在");
      service.addProjectMember(projectMatch[1], acc);
      broadcast("projects", {});
      return json(res, 200, { items: service.listProjectMembers(projectMatch[1]) });
    }
    if (projectMatch && method === "DELETE" && projectMatch[2] === "/members") {
      if (!canManageProject(projectMatch[1])) return fail(res, 403, "只有项目创建人或管理人员能移出成员");
      const accountId = url.searchParams.get("account");
      if (!accountId) return fail(res, 400, "缺少账号");
      service.removeProjectMember(projectMatch[1], accountId);
      broadcast("projects", {});
      return json(res, 200, { items: service.listProjectMembers(projectMatch[1]) });
    }
    if (projectMatch && method === "POST" && projectMatch[2] === "/agents") {
      if (!canManageProject(projectMatch[1])) return fail(res, 403, "只有项目创建人或管理人员能配 AI 员工");
      try {
        const created = service.addProjectAgent({ ...(await readBody()), projectId: projectMatch[1] });
        broadcast("projects", {});
        return json(res, 200, created);
      } catch (err) { return fail(res, 400, err.message); }
    }
    // 单个项目 AI 员工的改/删：按它所属项目判断权限
    const agentMatch = path.match(/^\/api\/collab\/project-agents\/([\w-]+)$/);
    const agentProjectOf = (agentId) => service.projectIdOfAgent(agentId);
    if (agentMatch && method === "PUT") {
      const projectId = agentProjectOf(agentMatch[1]);
      if (!projectId) return fail(res, 404, "AI 员工不存在");
      if (!canManageProject(projectId)) return fail(res, 403, "只有项目创建人或管理人员能改 AI 员工");
      try {
        const updated = service.updateProjectAgent(agentMatch[1], await readBody());
        broadcast("projects", {});
        return json(res, 200, updated);
      } catch (err) { return fail(res, 400, err.message); }
    }
    if (agentMatch && method === "DELETE") {
      const projectId = agentProjectOf(agentMatch[1]);
      if (!projectId) return fail(res, 404, "AI 员工不存在");
      if (!canManageProject(projectId)) return fail(res, 403, "只有项目创建人或管理人员能删除 AI 员工");
      service.removeProjectAgent(agentMatch[1]);
      broadcast("projects", {});
      return json(res, 200, { ok: true });
    }

    // ---------- 管理端（主 Token 或 admin 会话） ----------
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");

    if (path === "/api/collab/tasks" && method === "POST") {
      // 预留：二期给任务挂汇总配置
      return fail(res, 404, "Not found");
    }

    const pushMatch = path.match(/^\/api\/collab\/pushes\/([\w-]+)$/);
    if (pushMatch && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readRaw(req, 65536)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const moved = service.movePush(pushMatch[1], body.task);
        if (!moved) return fail(res, 404, "推送记录不存在");
        broadcast("push", moved);
        return json(res, 200, moved);
      } catch (err) { return fail(res, 400, err.message); }
    }
    if (pushMatch && method === "DELETE") {
      service.deletePush(pushMatch[1]);
      broadcast("pushes-changed", {});
      return json(res, 200, { ok: true });
    }

    return false;
  };

  return { handle, service, broadcast, KIND_NAME };
}
