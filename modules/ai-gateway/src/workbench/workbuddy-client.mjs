/** WorkBuddy's documented localassistant/OAuth protocol, not chat/completions.
 * No environment credentials, desktop session or private endpoint is inspected.
 * The caller must explicitly supply a newly authorized application's credentials.
 */
import { randomBytes } from "node:crypto";

export const WORKBUDDY_ORIGIN = "https://www.workbuddy.cn";
export const WORKBUDDY_SCOPES = Object.freeze([
  "user.localassistant.readable", "user.localassistant.invokable",
]);
export class WorkBuddyError extends Error {
  constructor(code, message, { status = 503, uncertain = false, retryAfter = null } = {}) {
    super(message); this.code = code; this.status = status;
    this.uncertain = uncertain; this.retryAfter = retryAfter;
  }
}
const fail = (code, message, options) => { throw new WorkBuddyError(code, message, options); };
const object = x => x && typeof x === "object" && !Array.isArray(x);
const scopesOf = value => typeof value === "string" ? value.split(/\s+/).filter(Boolean) : Array.isArray(value) ? value : [];
export function validateApp(app) {
  if (!app || app.enabled !== true || typeof app.clientId !== "string" || !app.clientId || app.clientId.length > 256 ||
      typeof app.redirectUri !== "string" || !app.redirectUri || app.redirectUri.length > 2048)
    fail("WORKBUDDY_APP_NOT_CONFIGURED", "尚未配置获批 WorkBuddy 应用及回调地址");
  if (!["hardware", "buddy-app"].includes(app.applicationType))
    fail("WORKBUDDY_APP_TYPE_UNCONFIRMED", "请核实应用类型及本地助理 API 接入资格");
  let uri;
  try { uri = new URL(app.redirectUri); } catch { fail("WORKBUDDY_REDIRECT_INVALID", "OAuth 回调地址无效"); }
  // Loopback HTTP support is not documented by the vendor. Do not assume it.
  if (uri.protocol !== "https:" || uri.hash || uri.username || uri.password)
    fail("WORKBUDDY_REDIRECT_INVALID", "需使用与开放平台登记完全一致的 HTTPS 回调地址");
  if (!WORKBUDDY_SCOPES.every(s => scopesOf(app.approvedScopes).includes(s)))
    fail("WORKBUDDY_SCOPE_NOT_APPROVED", "获批应用需包含本地助理读取与调用两项权限");
}
export function validateGrant(grant, { now = Date.now(), allowExpired = false } = {}) {
  if (!object(grant) || typeof grant.access_token !== "string" || !grant.access_token || /[\r\n]/.test(grant.access_token) ||
      typeof grant.token_type !== "string" || grant.token_type.toLowerCase() !== "bearer" ||
      typeof grant.open_id !== "string" || !grant.open_id || !Number.isFinite(grant.expires_at))
    fail("WORKBUDDY_AUTHORIZATION_REQUIRED", "尚未取得该员工的 WorkBuddy 有效授权");
  if (!WORKBUDDY_SCOPES.every(s => scopesOf(grant.scope).includes(s)))
    fail("WORKBUDDY_SCOPE_MISSING", "员工授权未包含本地助理读取与调用权限", { status: 403 });
  if (!allowExpired && grant.expires_at <= now)
    fail("WORKBUDDY_AUTHORIZATION_EXPIRED", "WorkBuddy 员工授权已过期", { status: 401 });
  return grant;
}

/** The injectable transport is for protocol tests, never a configurable API URL. */
export class WorkBuddyClient {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000, maxBytes = 20 * 1024 * 1024 } = {}) {
    this.fetchImpl = fetchImpl; this.now = now; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }
  async request(method, path, { grant, form, body } = {}) {
    if (!path.startsWith("/openapi/v2/") || path.includes("://") || path.includes("#") || path.includes("\\"))
      fail("WORKBUDDY_ENDPOINT_INVALID", "仅允许官方 WorkBuddy Open API");
    const headers = { Accept: "application/json" };
    if (grant) { validateGrant(grant, { now: this.now() }); headers.Authorization = "Bearer " + grant.access_token; }
    let payload;
    if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      // No automatic retry of POST: the official message API has no documented idempotency key.
      response = await this.fetchImpl(WORKBUDDY_ORIGIN + path, {
        method, headers, body: payload, redirect: "error", signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        const status = response.status;
        fail(status === 401 ? "WORKBUDDY_AUTHORIZATION_EXPIRED" :
          status === 403 ? "WORKBUDDY_PERMISSION_DENIED" :
          status === 429 ? "WORKBUDDY_RATE_LIMITED" : "WORKBUDDY_API_UNAVAILABLE",
          "WorkBuddy 接口拒绝或暂不可用；未回显上游内容",
          { status: status === 401 || status === 403 || status === 429 ? status : 503,
            uncertain: method === "POST" && status >= 500,
            retryAfter: status === 429 ? response.headers.get("retry-after") : null });
      }
      if (Number(response.headers.get("content-length")) > this.maxBytes)
        fail("WORKBUDDY_RESPONSE_TOO_LARGE", "返回内容超过完整读取限额，不截断", { uncertain: method === "POST" });
      const reader = response.body?.getReader();
      const chunks = []; let length = 0;
      if (!reader) fail("WORKBUDDY_RESPONSE_INVALID", "WorkBuddy 响应缺少正文", { uncertain: method === "POST" });
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > this.maxBytes) { await reader.cancel(); fail("WORKBUDDY_RESPONSE_TOO_LARGE", "返回内容超过完整读取限额，不截断", { uncertain: method === "POST" }); }
        chunks.push(Buffer.from(value));
      }
      let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail("WORKBUDDY_RESPONSE_INVALID", "WorkBuddy 响应不是完整 JSON", { uncertain: method === "POST" }); }
      if (!object(value) || (value.code !== undefined && value.code !== 0))
        fail("WORKBUDDY_API_REJECTED", "WorkBuddy 未确认本次请求成功", { uncertain: method === "POST" });
      return object(value.data) ? value.data : value;
    } catch (error) {
      if (error instanceof WorkBuddyError) throw error;
      fail("WORKBUDDY_TRANSPORT_UNCERTAIN", "WorkBuddy 连接未确认；发送请求不会自动重发",
        { uncertain: method === "POST" });
    } finally { clearTimeout(timer); }
  }
  async online(grant) {
    const data = await this.request("GET", "/openapi/v2/localassistant", { grant });
    if (typeof data.online !== "boolean") fail("WORKBUDDY_RESPONSE_INVALID", "未返回可靠的本地助理在线状态");
    return data.online;
  }
  async sendMessage(grant, content) {
    if (typeof content !== "string" || !content.trim()) fail("WORKBUDDY_MESSAGE_INVALID", "任务消息不能为空", { status: 422 });
    const data = await this.request("POST", "/openapi/v2/localassistant/message", { grant, body: { content, msg_type: "text" } });
    if (typeof data.message_id !== "string" || !data.message_id || data.message_id.length > 512)
      fail("WORKBUDDY_DISPATCH_UNCERTAIN", "WorkBuddy 未返回消息编号，不重发本次研究", { uncertain: true });
    return { messageId: data.message_id };
  }
  async messages(grant, messageId) {
    if (typeof messageId !== "string" || !messageId) fail("WORKBUDDY_MESSAGE_ID_REQUIRED", "需关联原始 WorkBuddy 消息");
    const data = await this.request("GET", "/openapi/v2/localassistant/message?" +
      new URLSearchParams({ message_id: messageId }), { grant });
    if (!Array.isArray(data.messages) || data.messages.some(m => !object(m) ||
        !Array.isArray(m.content) || !Array.isArray(m.attachments) || !object(m.metadata)))
      fail("WORKBUDDY_RESPONSE_INVALID", "消息历史结构不完整；不推断完成状态");
    return data.messages; // No invented completion state or artifact-download URL.
  }
  async token(form, { previous = null } = {}) {
    const value = await this.request("POST", "/openapi/v2/token", { form });
    if (!Number.isFinite(value.expires_in) || value.expires_in <= 0)
      fail("WORKBUDDY_RESPONSE_INVALID", "未返回有效授权时限");
    const grant = { access_token: value.access_token, token_type: value.token_type,
      refresh_token: value.refresh_token ?? previous?.refresh_token ?? null,
      open_id: value.open_id, scope: value.scope, expires_at: this.now() + value.expires_in * 1000 };
    validateGrant(grant, { now: this.now() });
    if (previous && previous.open_id !== grant.open_id)
      fail("WORKBUDDY_SUBJECT_CHANGED", "刷新授权的员工主体发生变化", { status: 403 });
    return grant;
  }
}

/** OAuth state store only; it is not an AI task queue. Grants stay server-only. */
export class WorkBuddyOAuth {
  constructor({ app, client = new WorkBuddyClient(), now = Date.now }) {
    this.app = app; this.client = client; this.now = now; this.pending = new Map();
  }
  begin(ownerId) {
    validateApp(this.app);
    if (!ownerId) fail("WORKBUDDY_OWNER_REQUIRED", "授权必须绑定平台员工", { status: 403 });
    for (const [state, item] of this.pending) if (item.expires <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 100) fail("WORKBUDDY_AUTHORIZATION_BUSY", "授权请求过多，请稍后重试");
    const state = randomBytes(32).toString("base64url");
    this.pending.set(state, { ownerId, expires: this.now() + 10 * 60 * 1000 });
    return { authorizationUrl: WORKBUDDY_ORIGIN + "/openapi/v2/authorize?" + new URLSearchParams({
      response_type: "code", client_id: this.app.clientId, redirect_uri: this.app.redirectUri,
      scope: WORKBUDDY_SCOPES.join(" "), state,
    }), expiresIn: 600 };
  }
  async complete(ownerId, { state, code }, clientSecret) {
    validateApp(this.app);
    const pending = this.pending.get(state);
    if (!pending || pending.ownerId !== ownerId || pending.expires <= this.now())
      fail("WORKBUDDY_OAUTH_STATE_INVALID", "授权请求无效、过期或不属于当前员工", { status: 403 });
    this.pending.delete(state); // Single-use, including uncertain token exchanges.
    if (typeof clientSecret === "function") clientSecret = await clientSecret();
    if (typeof code !== "string" || !code || typeof clientSecret !== "string" || !clientSecret)
      fail("WORKBUDDY_OAUTH_INPUT_INVALID", "缺少有效授权码或服务端应用凭据", { status: 422 });
    return this.client.token({ grant_type: "authorization_code", code,
      redirect_uri: this.app.redirectUri, client_id: this.app.clientId, client_secret: clientSecret });
  }
  async refresh(grant, clientSecret) {
    validateApp(this.app); validateGrant(grant, { now: this.now(), allowExpired: true });
    if (!grant.refresh_token || !clientSecret) fail("WORKBUDDY_AUTHORIZATION_REQUIRED", "需要员工重新授权");
    return this.client.token({ grant_type: "refresh_token", refresh_token: grant.refresh_token,
      client_id: this.app.clientId, client_secret: clientSecret }, { previous: grant });
  }
}
