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
import { LocalResearch } from "../local-research.mjs";
import { researchView } from "../research.mjs";

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

export function createCollabApi({ stateDir, authorized, taskLabel, manager, config, ownerId, nativeEvidenceVerifier }) {
  const service = new CollabService({ stateDir });
  service.boot();
  const research = manager && config && ownerId ? new LocalResearch({manager,collab:service,config,ownerId,nativeEvidenceVerifier}) : null;

  const sseClients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      const task = manager?.tasks.get(data?.taskId);
      if (task?.research?.transport === "local-pull" && res.researchMemberId &&
          task.research.memberId !== res.researchMemberId) continue;
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
    if (path.startsWith("/api/collab/research/")) {
      if (!research) return json(res,503,{code:"LOCAL_RESEARCH_NOT_CONFIGURED",error:"本地研究领取未配置"});
      const member = service.memberByToken(bearer(req));
      if (!member) return json(res,401,{code:"COLLAB_MEMBER_REQUIRED",error:"协作成员身份无效"});
      try {
        if (path === "/api/collab/research/pending" && method === "GET")
          return json(res,200,research.pending(member));
        if (path === "/api/collab/research/info" && method === "GET")
          return json(res,200,research.info());
        const match=path.match(/^\/api\/collab\/research\/tasks\/([A-Za-z0-9._-]{1,120})\/(claim|heartbeat|status|complete|files\/md|files\/json)$/);
        if (!match) return json(res,404,{code:"ENDPOINT_NOT_FOUND",error:"研究领取接口不存在"});
        const [,id,action]=match;
        if (method === "GET" && action === "status") {
          const task=research.requireTask(id,member);research.expire(task);
          return json(res,200,{...researchView(task),phase:task.research.localPull.phase});
        }
        if (method !== "POST") return json(res,405,{code:"METHOD_NOT_ALLOWED",error:"操作方法无效"});
        if (action.startsWith("files/"))
          return json(res,200,research.upload(id,member,req.headers,action.slice(6),await readRaw(req,8*1024*1024)));
        if (!(req.headers["content-type"]??"").startsWith("application/json"))
          return json(res,415,{code:"JSON_REQUIRED",error:"控制请求须使用 JSON"});
        const body=JSON.parse((await readRaw(req,65536)).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json(res,422,{code:"INVALID_REQUEST",error:"请求字段无效"});
        if(action === "claim") return json(res,200,research.claim(id,member,body));
        if(action === "heartbeat") return json(res,200,research.heartbeat(id,member,req.headers));
        if(action === "status") return json(res,200,research.report(id,member,req.headers,body));
        const value=await research.complete(id,member,req.headers,body);
        return json(res,value.verificationRequired?202:200,value);
      } catch(error) {
        return json(res,error.status??422,{code:error.code??"RESEARCH_REQUEST_INVALID",error:error.code?error.message:"研究请求无法处理"});
      }
    }

    // ---------- 成员推送（成员 Token） ----------
    if (path === "/api/collab/push" && method === "POST") {
      const member = service.memberByToken(bearer(req));
      if (!member) return fail(res, 401, "无效的成员 Token");
      if (manager?.tasks.get(url.searchParams.get("task"))?.research?.transport === "local-pull")
        return json(res,409,{code:"RESEARCH_UPLOAD_REQUIRES_LEASE",error:"研究原件须经租约绑定的文件接口上传"});
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
      const member=service.memberByToken(bearer(req));
      if (!member && !isAdmin(req)) return fail(res, 401, "Unauthorized");
      const items=(taskLabel?.()??[]).filter(item=>!member ||
        manager?.tasks.get(item.id)?.research?.transport!=="local-pull" || research?.owned(manager.tasks.get(item.id),member));
      return json(res, 200, { items });
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
      res.researchMemberId = qToken ? service.memberByToken(qToken)?.id ?? null : null;
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 断开即清 */ } }, 25000);
      req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      return true;
    }

    // ---------- 附件（工作台或成员都可读） ----------
    const fileMatch = path.match(/^\/api\/collab\/files\/([\w-]+)$/);
    if (fileMatch && method === "GET") {
      const member=service.memberByToken(bearer(req));
      if (!member && !isAdmin(req)) return fail(res, 401, "Unauthorized");
      const push=service.getPush(fileMatch[1]),task=manager?.tasks.get(push?.taskId);
      if(member&&task?.research?.transport==="local-pull"&&!research?.owned(task,member))
        return fail(res,404,"附件不存在或无权限");
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
    if(pushMatch && ["POST","DELETE"].includes(method) &&
      manager?.tasks.get(service.getPush(pushMatch[1])?.taskId)?.research?.transport==="local-pull")
      return fail(res,409,"研究原件不能移动或删除");
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

  return { handle, service, research, broadcast, KIND_NAME };
}
