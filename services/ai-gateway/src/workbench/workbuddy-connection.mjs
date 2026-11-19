/** Server-only WorkBuddy connection. It reuses the gateway's account and TaskManager. */
import { lstatSync, readFileSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { WorkBuddyClient, WorkBuddyOAuth, WorkBuddyError, WORKBUDDY_SCOPES, validateApp, validateGrant } from "./workbuddy-client.mjs";
import { parseFrontmatter } from "./skill-store.mjs";
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = (code, message, status = 503) => { throw new WorkBuddyError(code, message, { status }); };

/** Explicit NEW application credential file only. Never reads a desktop profile,
 * browser session, generic model API key, or an inherited access-token variable.
 */
export class WorkBuddyGrantFile {
  constructor({ app, credentialRoot, allowedRoots = [], ownerId }) {
    this.app = app; this.credentialRoot = credentialRoot; this.allowedRoots = allowedRoots; this.ownerId = ownerId;
  }
  path() {
    if (this.app.enabled !== true || !this.credentialRoot || !isAbsolute(this.credentialRoot) ||
        !this.app.credentialFile || isAbsolute(this.app.credentialFile))
      fail("WORKBUDDY_CREDENTIALS_NOT_CONFIGURED", "请通过服务端安全方式配置新接入应用凭据");
    const base = resolve(this.credentialRoot), path = resolve(base, this.app.credentialFile);
    if (this.allowedRoots.some(root => {
      const rel = relative(resolve(root), base);
      return !rel || (!rel.startsWith(".." + sep) && rel !== "..");
    })) fail("WORKBUDDY_CREDENTIAL_ROOT_EXPOSED", "应用凭据目录必须在普通模型工作目录之外");
    if (existsSync(base) && (lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory() ||
        (process.platform !== "win32" && (lstatSync(base).mode & 0o077))))
      fail("WORKBUDDY_CREDENTIAL_PERMISSIONS", "应用凭据目录须为仅本用户可访问的独立目录");
    const rel = relative(base, path);
    if (!rel || rel.startsWith(".." + sep) || rel === "..")
      fail("WORKBUDDY_CREDENTIAL_PATH_INVALID", "WorkBuddy 应用凭据须在该员工网关私有配置目录内");
    let cursor = base;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        fail("WORKBUDDY_CREDENTIAL_PATH_INVALID", "应用凭据路径不得使用符号链接");
    }
    return path;
  }
  read() {
    const path = this.path();
    if (!existsSync(path)) fail("WORKBUDDY_CREDENTIALS_NOT_CONFIGURED", "新应用的服务端凭据尚未配置");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65536 || (process.platform !== "win32" && (stat.mode & 0o077)))
      fail("WORKBUDDY_CREDENTIAL_PERMISSIONS", "应用凭据须为仅本用户可读写的私有文件");
    let value;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { fail("WORKBUDDY_CREDENTIALS_INVALID", "应用凭据文件无效，不回显内容"); }
    if (value.ownerId !== this.ownerId || value.clientId !== this.app.clientId || typeof value.clientSecret !== "string" || !value.clientSecret)
      fail("WORKBUDDY_CREDENTIAL_SUBJECT_MISMATCH", "应用凭据与当前员工或应用不匹配", 403);
    return value;
  }
  saveGrant(grant) {
    const value = this.read(), path = this.path();
    const temp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...value, grant }), "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}

/** Installed files are configuration evidence, not a native Skill invocation. */
export function workbuddySkills(app = {}) {
  return Array.from({ length: 12 }, (_, i) => {
    const dimensionId = "DIM-" + String(i + 1).padStart(2, "0");
    const binding = app.skillBindings?.[dimensionId];
    const item = { dimensionId, skillName: binding?.name ?? null, skillVersion: binding?.version ?? null,
      schemaVersion: dimensionId === "DIM-03" ? "v5" : null,
      skillStatus: "unverified", nativeInvocationVerified: false, enabled: false };
    if (!binding?.name || !app.skillRoot) return item;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(binding.name) || !isAbsolute(app.skillRoot))
      return { ...item, skillStatus: "invalid", failureCode: "WORKBUDDY_SKILL_BINDING_INVALID" };
    const folder = join(app.skillRoot, binding.name), file = join(folder, "SKILL.md");
    if (!existsSync(file)) return { ...item, skillStatus: "missing", failureCode: "PROFESSIONAL_SKILL_MISSING" };
    try {
      if (lstatSync(app.skillRoot).isSymbolicLink() || lstatSync(folder).isSymbolicLink() ||
          lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).size > 512 * 1024)
        throw Error("unsafe");
      const raw = readFileSync(file), { meta } = parseFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      const sha256 = hash(raw);
      if (meta.name !== binding.name || !binding.version || !binding.sha256 || binding.sha256 !== sha256 ||
          (meta.version && meta.version !== binding.version)) throw Error("binding");
      return { ...item, skillStatus: "installed", fileSha256: sha256,
        fileVersion: meta.version || null, versionAuthority: "approved-binding",
        evidence: "installed-file-only" };
    } catch { return { ...item, skillStatus: "invalid", failureCode: "WORKBUDDY_SKILL_BINDING_MISMATCH" }; }
  });
}

export class WorkBuddyConnection {
  constructor({ app = {}, credentialRoot, allowedRoots, ownerId, client = new WorkBuddyClient(), credentialStore = null, protocol = null } = {}) {
    this.app = app; this.ownerId = ownerId; this.client = client;
    this.oauth = new WorkBuddyOAuth({ app, client, now: client.now });
    this.credentials = credentialStore ?? new WorkBuddyGrantFile({ app, credentialRoot, allowedRoots, ownerId });
    // No vendor Skill-event/completion mapping has been validated. The default
    // is deliberately absent, not a model's self-reported "skillLoaded:true".
    this.protocol = protocol;
    this.checked = null; this.authorized = false;
  }
  info() {
    let configurationError = null;
    try { validateApp(this.app); } catch (e) { configurationError = e.code; }
    return { provider: "workbuddy-localassistant", configured: !configurationError,
      configurationError, authorizationRequired: !this.authorized,
      connectionVerified: Boolean(this.checked && this.client.now() - Date.parse(this.checked.at) <= 60000),
      online: this.checked?.online ?? null, onlineCheckedAt: this.checked?.at ?? null,
      researchReady: false, executionProtocolVerified: Boolean(this.protocol),
      requiredScopes: [...WORKBUDDY_SCOPES], dimensions: workbuddySkills(this.app),
      setupUrl: "https://open.workbuddy.cn/", oauthPrepared: true,
      callbackPath: "/platform/research/workbuddy/callback",
      genericModelConfigurationSupported: false };
  }
  begin() { return this.oauth.begin(this.ownerId); }
  async complete(body) {
    const grant = await this.oauth.complete(this.ownerId, body, () => this.credentials.read().clientSecret);
    this.credentials.saveGrant(grant); this.checked = null; this.authorized = true;
    return { authorized: true, onlineChecked: false, researchReady: false };
  }
  grant() {
    validateApp(this.app);
    const grant = this.credentials.read().grant;
    return validateGrant(grant, { now: this.client.now() });
  }
  async refresh() {
    validateApp(this.app);
    const value = this.credentials.read();
    const grant = await this.oauth.refresh(value.grant, value.clientSecret);
    this.credentials.saveGrant(grant); this.checked = null; this.authorized = true;
    return { authorized: true, onlineChecked: false, researchReady: false };
  }
  async checkOnline() {
    const online = await this.client.online(this.grant());
    this.authorized = true;
    this.checked = { online, at: new Date(this.client.now()).toISOString() };
    return { online, checkedAt: this.checked.at, researchReady: false };
  }
  requireResearchReady() {
    validateApp(this.app); this.grant();
    const skill = workbuddySkills(this.app).find(s => s.dimensionId === "DIM-03");
    if (skill.skillStatus !== "installed")
      fail(skill.failureCode ?? "WORKBUDDY_SKILL_BINDING_REQUIRED", "需核对 WorkBuddy 已安装专业 Skill 的名称、版本和文件摘要");
    if (!this.checked || this.client.now() - Date.parse(this.checked.at) > 60000)
      fail("WORKBUDDY_ONLINE_CHECK_REQUIRED", "请先核实当前授权员工的 WorkBuddy 在线状态");
    if (!this.checked.online) fail("WORKBUDDY_OFFLINE", "该员工 WorkBuddy 当前离线");
    if (!this.protocol)
      fail("WORKBUDDY_EXECUTION_PROTOCOL_UNVERIFIED", "指定 Skill 执行证据、完成状态和完整双成果回传协议尚待真实联调");
    return skill;
  }

  /** Prepared integration seam. Uses only the existing TaskManager's durable
   * research metadata, never another task queue. Not exposed as a bypass API.
   */
  async dispatch(taskId, manager, projectContext) {
    const skill = this.requireResearchReady(), task = manager.tasks.get(taskId), r = task?.research;
    if (!r || r.ownerId !== this.ownerId || task.agent !== "workbuddy" || r.dimensionId !== "DIM-03" ||
        r.skillName !== skill.skillName || r.skillVersion !== skill.skillVersion || r.skillSha256 !== skill.fileSha256)
      fail("WORKBUDDY_TASK_BINDING_INVALID", "研究任务与员工或专业 Skill 关联不符", 403);
    if (r.workbuddy?.dispatchPhase) return { taskId, messageId: r.workbuddy.messageId ?? null,
      phase: r.workbuddy.dispatchPhase, duplicate: true };
    // The localassistant API exposes a user-level conversation, not a proven
    // isolated session per platform task. Hold unresolved dispatches, including
    // after restart; elapsed time is not evidence that the old job has stopped.
    const busy = [...manager.tasks.values()].some(other => other.id !== taskId &&
      other.research?.ownerId === this.ownerId && other.research.workbuddy?.dispatchPhase &&
      !["completed", "failed", "cancelled"].includes(other.status));
    if (busy) fail("WORKBUDDY_DISPATCH_PENDING", "该员工已有未确认终结的 WorkBuddy 研究，不能并发重发", 409);
    const state = { attemptId: randomUUID(), dispatchPhase: "sending", messageId: null,
      expectedOpenIdSha256: hash(this.grant().open_id) };
    // Persist BEFORE sending. A crash in this window is deliberately unresolved.
    manager.researchCheckpoint(taskId, state);
    try {
      const content = this.protocol.buildResearchMessage({ taskId, research: { ...r }, projectContext, attemptId: state.attemptId });
      const { messageId } = await this.client.sendMessage(this.grant(), content);
      manager.researchCheckpoint(taskId, { ...state, dispatchPhase: "sent", messageId });
      return { taskId, messageId, phase: "sent", duplicate: false };
    } catch (e) {
      // Even if saving the messageId fails, never issue a second outbound POST.
      try { manager.researchCheckpoint(taskId, { ...state, dispatchPhase: "uncertain" }); } catch {}
      throw new WorkBuddyError("WORKBUDDY_DISPATCH_UNCERTAIN", "任务发送或回执保存未确认；保留原任务待核查，不自动重发", { uncertain: true });
    }
  }
  async observations(taskId, manager) {
    const task = manager.tasks.get(taskId), r = task?.research;
    if (!r || r.ownerId !== this.ownerId || !r.workbuddy?.messageId)
      fail("WORKBUDDY_TASK_NOT_FOUND", "当前员工下没有已关联的 WorkBuddy 消息", 404);
    if (hash(this.grant().open_id) !== r.workbuddy.expectedOpenIdSha256)
      fail("WORKBUDDY_SUBJECT_CHANGED", "当前 WorkBuddy 授权主体与研究任务不符", 403);
    const messages = await this.client.messages(this.grant(), r.workbuddy.messageId);
    // Vendor messages alone are not a terminal-state or native Skill proof.
    return { taskId, messageId: r.workbuddy.messageId, messages, completionVerified: false };
  }
}
