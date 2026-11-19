/**
 * 平台账号 · /api/auth/* 路由组。
 *
 * - login/logout/me 是免鉴权入口（me 未登录时返回 401 供前端跳登录页）；
 * - 账号管理（列表/创建/修改）要求「网关主 Token 或 role=admin 会话」；
 * - 会话走 HttpOnly cookie，网关是本地单机服务，SameSite=Lax 即可。
 */

import os from "node:os";

import { SESSION_COOKIE } from "./service.mjs";

const readRaw = async (req, limit = 65536) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const parseCookies = (req) => {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

const sessionToken = (req) => parseCookies(req)[SESSION_COOKIE] || "";

/**
 * 配置码里编码的服务器地址。
 * 管理员经常用 127.0.0.1:4317 打开平台，直接编码进去的话，同事的机器一兑换
 * 就会去连「它自己的 localhost」——必失败。这里把回环 Host 自动换成服务器
 * 内网 IPv4（端口保留）；管理员也可以在请求体里显式指定 server 覆盖。
 */
function serverAddressForCode(req, explicit) {
  const fromBody = String(explicit ?? "").trim();
  if (fromBody) return fromBody;
  const encrypted = Boolean(req.socket?.encrypted);
  const host = String(req.headers.host ?? "").trim();
  const match = host.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? host.match(/^([^:]+)(?::(\d+))?$/);
  let hostname = match?.[1] ?? host;
  let port = match?.[2] ?? (encrypted ? "443" : "80");
  const isLoopback = /^(localhost|127\.|::1|0\.0\.0\.0)/i.test(hostname);
  let finalHost = host;
  if (isLoopback) {
    const lan = lanIPv4();
    if (lan) finalHost = port ? `${lan}:${port}` : lan;
  }
  return `${encrypted ? "https" : "http"}://${finalHost}`;
}

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      // family 在部分 Node 版本返回字符串 "IPv4"，另一些返回数字 4，两种都要认
      const family = String(ni?.family ?? "");
      if ((family === "IPv4" || family === "4") && !ni.internal && ni.address && !/^169\.254\./.test(ni.address)) {
        return ni.address;
      }
    }
  }
  return null;
}

export function createAccountsApi({ service, authorized, integration }) {
  const json = (res, status, body, extraHeaders = {}) => {
    if (!res.headersSent) {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...extraHeaders,
      });
    }
    res.end(JSON.stringify(body));
    return true;
  };
  const fail = (res, status, message) => json(res, status, { error: message });

  const cookieHeader = (value, maxAge) => ({
    "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  });

  /** 会话里的账号；主 Token 请求视为管理员（返回 null，由调用方按 admin 处理）。 */
  const sessionAccount = (req) => service.accountBySession(sessionToken(req));

  /** 当前请求的有效账号：网关会话优先，其次平台集成身份（portal 反代带 X-Integration-Account 时映射出来的账号）。 */
  const viewerAccount = (req) => sessionAccount(req) ?? (integration ? integration(req) : null);

  const isAdminReq = (req) => authorized(req) || viewerAccount(req)?.role === "admin";

  const handle = async (req, res, path, url) => {
    const method = req.method || "GET";

    if (path === "/api/auth/login" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      const account = service.verifyLogin(body.username, body.password);
      if (!account) return fail(res, 401, "用户名或密码错误");
      const token = service.createSession(account.id);
      return json(res, 200, { account }, cookieHeader(token, 30 * 24 * 3600));
    }

    if (path === "/api/auth/logout" && method === "POST") {
      service.deleteSession(sessionToken(req));
      return json(res, 200, { ok: true }, cookieHeader("", 0));
    }

    if (path === "/api/auth/me" && method === "GET") {
      const account = viewerAccount(req);
      if (!account) return fail(res, 401, "未登录");
      // integration：账号来自平台门户（无网关会话），前端据此把「退出」交回平台
      return json(res, 200, { account, integration: !sessionAccount(req) });
    }

    // ---------- 账号管理（管理员） ----------
    if (!isAdminReq(req)) return fail(res, 401, "Unauthorized");

    if (path === "/api/auth/accounts" && method === "GET") {
      return json(res, 200, { items: service.listAccounts() });
    }
    if (path === "/api/auth/accounts" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const created = service.createAccount(body);
        const withToken = service.issuePushToken(created.id); // 建号即发推送 Token，明文只此一次
        return json(res, 200, withToken);
      } catch (err) { return fail(res, 400, err.message); }
    }
    const idMatch = path.match(/^\/api\/auth\/accounts\/([\w-]+)(\/token|\/bootstrap-code)?$/);
    if (idMatch && method === "PUT" && !idMatch[2]) {
      let body = {};
      try { body = JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const updated = service.updateAccount(idMatch[1], body);
        return json(res, 200, updated);
      } catch (err) { return fail(res, 400, err.message); }
    }
    if (idMatch && method === "POST" && idMatch[2] === "/token") {
      try {
        const reissued = service.issuePushToken(idMatch[1]);
        return json(res, 200, reissued);
      } catch (err) { return fail(res, 400, err.message); }
    }
    if (idMatch && method === "POST" && idMatch[2] === "/bootstrap-code") {
      let body = {};
      try { body = JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { /* 空体 */ }
      try {
        const { code, expiresAt } = service.createBootstrapCode(idMatch[1]);
        // 把服务器地址编码进码里：员工只粘贴这一串，服务器地址和 Token 一次到位。
        // 回环 Host（127.0.0.1/localhost）自动换成内网 IP，同事机器才能兑到。
        const server = serverAddressForCode(req, body.server);
        const packed = `WB1.${Buffer.from(JSON.stringify({ u: server, c: code })).toString("base64url")}`;
        return json(res, 200, { packed, expiresAt, server });
      } catch (err) { return fail(res, 400, err.message); }
    }

    return false;
  };

  return { handle, sessionAccount, viewerAccount, isAdminReq, sessionToken };
}
