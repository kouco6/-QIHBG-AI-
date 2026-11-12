/**
 * 任务协作 · /api/collab/* 路由组。
 *
 * 双 Token 体系：
 * - 成员推送（POST /api/collab/push）只认成员 Token，独立于网关主 Token——
 *   所以这组路由必须在 server.mjs 的主鉴权闸门**之前**接管。
 * - 管理端（成员管理、流转、删除）只认网关主 Token。
 * - SSE（/api/collab/stream）把新推送实时推给工作台页面。
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

export function createCollabApi({ stateDir, authorized, taskLabel }) {
  const service = new CollabService({ stateDir });
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
  const isAdmin = (req) => authorized(req);

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

    // ---------- 成员视角任务列表（选「当前任务」用） ----------
    if (path === "/api/collab/tasks" && method === "GET") {
      if (!service.memberByToken(bearer(req)) && !isAdmin(req)) return fail(res, 401, "Unauthorized");
      return json(res, 200, { items: taskLabel?.() ?? [] });
    }

    // ---------- SSE 实时流（工作台页面，主 Token 或 query token） ----------
    if (path === "/api/collab/stream" && method === "GET") {
      const qToken = url.searchParams.get("token");
      const ok = qToken
        ? (service.memberByToken(qToken) || authorized({ headers: { authorization: `Bearer ${qToken}` } }))
        : isAdmin(req);
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

    // ---------- 附件（工作台或成员都可读） ----------
    const fileMatch = path.match(/^\/api\/collab\/files\/([\w-]+)$/);
    if (fileMatch && method === "GET") {
      if (!service.memberByToken(bearer(req)) && !isAdmin(req)) return fail(res, 401, "Unauthorized");
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

    // ---------- 管理端（主 Token） ----------
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");

    if (path === "/api/collab/members" && method === "GET") {
      return json(res, 200, { items: service.listMembers() });
    }
    // ---------- 协作总览（左侧一级「协作」页） ----------
    if (path === "/api/collab/overview" && method === "GET") {
      const data = service.overview({
        memberId: url.searchParams.get("member") || undefined,
        agent: url.searchParams.get("agent") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      });
      const labels = new Map((taskLabel?.() ?? []).map((t) => [t.id, t]));
      data.items = data.items.map((p) => {
        const t = labels.get(p.taskId);
        return { ...p, taskLabel: t?.label ?? null, taskStatus: t?.status ?? null };
      });
      data.tasks = data.tasks.map((t) => ({ ...t, label: labels.get(t.taskId)?.label ?? null }));
      return json(res, 200, data);
    }
    if (path === "/api/collab/members" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readRaw(req, 65536)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const created = service.createMember(body.name);
        broadcast("members", {});
        return json(res, 200, created); // 明文 Token 只在这里返回一次
      } catch (err) { return fail(res, 400, err.message); }
    }
    const memberMatch = path.match(/^\/api\/collab\/members\/([\w-]+)(\/token)?$/);
    if (memberMatch && method === "POST" && memberMatch[2]) {
      const m = service.listMembers().find((x) => x.id === memberMatch[1]);
      if (!m) return fail(res, 404, "成员不存在");
      const reissued = service.issueMember(m.id, m.name);
      return json(res, 200, reissued);
    }
    if (memberMatch && method === "DELETE") {
      service.removeMember(memberMatch[1]);
      broadcast("members", {});
      return json(res, 200, { ok: true });
    }

    if (path === "/api/collab/tasks" && method === "POST") {
      // 预留：二期给任务挂汇总配置
      return fail(res, 404, "Not found");
    }

    const pushesMatch = path.match(/^\/api\/collab\/tasks\/([\w-]+)\/pushes$/);
    if (pushesMatch && method === "GET") {
      const kind = url.searchParams.get("kind") || undefined;
      const items = service.listPushes({ taskId: pushesMatch[1], kind, limit: url.searchParams.get("limit") });
      return json(res, 200, { items, counts: service.countByTask(pushesMatch[1]) });
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
