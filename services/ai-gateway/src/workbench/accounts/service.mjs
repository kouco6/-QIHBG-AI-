/**
 * 平台账号 · 存储与服务。
 *
 * 模型：一个账号就是一个完整身份——登录平台用账号+密码，本机智能体推送用
 * 系统发给该账号的推送 Token。角色六类：企划/产品/体验/UI/其他/管理。
 *
 * 安全口径：
 * - 密码 scrypt 加盐哈希，库里不落明文；
 * - 会话 Token 与推送 Token 都只存 sha256，明文只在创建/轮换时返回一次；
 * - 「管理类接口」= 网关主 Token 或 role=admin 的会话。
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 六类角色。role 存 key，展示用中文。 */
export const ROLES = {
  planner: "企划人员",
  product: "产品人员",
  ux: "体验人员",
  ui: "UI人员",
  other: "其他人员",
  admin: "管理人员",
};
export const roleLabel = (role) => ROLES[role] ?? ROLES.other;
export const isRole = (role) => Boolean(ROLES[role]);

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
export const SESSION_COOKIE = "wb_session";

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

/** scrypt 加盐哈希，格式：s1$<saltHex>$<hashHex>。 */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [ver, saltHex, hashHex] = String(stored || "").split("$");
  if (ver !== "s1" || !saltHex || !hashHex) return false;
  const hash = scryptSync(String(password), Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export class AccountsService {
  constructor({ stateDir } = {}) {
    this.stateDir = stateDir;
    this.db = null;
  }

  boot() {
    mkdirSync(this.stateDir, { recursive: true });
    this.db = new DatabaseSync(join(this.stateDir, "accounts.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'other',
        pass_hash TEXT NOT NULL,
        push_token_hash TEXT,
        push_token_hint TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
      CREATE TABLE IF NOT EXISTS bootstrap_codes (
        code TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      /* 执行器本机运行配置（roots 白名单等），账号维度各存一份 */
      CREATE TABLE IF NOT EXISTS runner_prefs (
        account_id TEXT PRIMARY KEY,
        roots TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    this.db.prepare("DELETE FROM bootstrap_codes WHERE expires_at < ?").run(new Date().toISOString());
  }

  shutdown() {
    try { this.db?.close(); } catch { /* 已关闭 */ }
  }

  #cleanUsername(v) {
    const clean = String(v ?? "").trim().toLowerCase().slice(0, 64);
    // 允许中文：迁移旧协作成员时直接拿姓名当用户名
    if (!/^[\p{L}\p{N}._-]+$/u.test(clean)) throw new Error("用户名只能用中文、字母、数字、点、横线、下划线");
    return clean;
  }

  #byId(id) {
    return this.db.prepare(
      "SELECT id, username, name, role, pass_hash, push_token_hash, push_token_hint, active, created_at AS createdAt FROM accounts WHERE id = ?"
    ).get(id) ?? null;
  }

  // ---------- 登录与会话 ----------

  /** 账号密码校验。成功返回账号，失败返回 null（不区分「无此号」和「密码错」）。 */
  verifyLogin(username, password) {
    const row = this.db.prepare(
      "SELECT * FROM accounts WHERE username = ?"
    ).get(this.#cleanUsername(username));
    if (!row || !row.active) return null;
    if (!verifyPassword(password, row.pass_hash)) return null;
    return this.#public(row);
  }

  /** 建会话，返回明文 Token（种到 cookie）。 */
  createSession(accountId) {
    const token = `wb_${randomBytes(24).toString("base64url")}`;
    const now = new Date();
    this.db.prepare(
      "INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(sha256(token), accountId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
    return token;
  }

  /** 会话 Token → 账号。过期/不存在返回 null。 */
  accountBySession(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ? AND s.expires_at > ? AND a.active = 1
    `).get(sha256(token), new Date().toISOString());
    return row ? this.#public(row) : null;
  }

  deleteSession(token) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
  }

  /** 删掉某账号的全部会话（改密码/停用后强制重新登录）。 */
  #dropSessions(accountId) {
    this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
  }

  // ---------- 账号管理 ----------

  #public(row) {
    return {
      id: row.id, username: row.username, name: row.name, role: row.role,
      push_token_hint: row.push_token_hint ?? null, active: Boolean(row.active), createdAt: row.created_at,
    };
  }

  createAccount({ username, name, role = "other", password } = {}) {
    const user = this.#cleanUsername(username);
    const cleanName = String(name ?? "").trim().slice(0, 24);
    if (!cleanName) throw new Error("姓名不能为空");
    if (!isRole(role)) throw new Error("未知的人员角色");
    if (String(password ?? "").length < 6) throw new Error("密码至少 6 位");
    if (this.db.prepare("SELECT id FROM accounts WHERE username = ?").get(user)) {
      throw new Error(`用户名「${user}」已存在`);
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO accounts (id, username, name, role, pass_hash, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, user, cleanName, role, hashPassword(password), new Date().toISOString());
    return this.#public(this.#byId(id));
  }

  updateAccount(id, { name, role, active, password } = {}) {
    const cur = this.#byId(id);
    if (!cur) throw new Error("账号不存在");
    if (role !== undefined && !isRole(role)) throw new Error("未知的人员角色");
    // 系统里至少要留一个可用的管理员（降级或停用最后一个管理员都拦下）
    if (cur.role === "admin" && ((role && role !== "admin") || active === false)) {
      const admins = this.db.prepare("SELECT COUNT(*) n FROM accounts WHERE role = 'admin' AND active = 1 AND id != ?").get(id).n;
      if (Number(admins) === 0) throw new Error("至少保留一个管理人员账号");
    }
    this.db.prepare(`
      UPDATE accounts SET name = ?, role = ?, active = ?, pass_hash = ? WHERE id = ?
    `).run(
      String(name ?? cur.name).trim().slice(0, 24) || cur.name,
      role ?? cur.role,
      active === undefined ? (cur.active ? 1 : 0) : (active ? 1 : 0),
      password !== undefined ? hashPassword(password) : cur.pass_hash,
      id,
    );
    if (password !== undefined || active === false) this.#dropSessions(id);
    return this.#public(this.#byId(id));
  }

  listAccounts() {
    return this.db.prepare(
      "SELECT id, username, name, role, push_token_hint, active, created_at AS createdAt FROM accounts ORDER BY created_at"
    ).all().map((r) => ({ ...r, active: Boolean(r.active) }));
  }

  /** 按 ID 取单个账号（找不到返回 null）。 */
  accountById(id) {
    return this.listAccounts().find((item) => item.id === id) ?? null;
  }

  /** 首次启动兜底：一个账号都没有时建管理员 admin/admin123。 */
  ensureAdmin() {
    if (this.db.prepare("SELECT COUNT(*) n FROM accounts").get().n > 0) return null;
    return this.createAccount({ username: "admin", name: "管理员", role: "admin", password: "admin123" });
  }

  // ---------- 推送 Token（本机智能体用） ----------

  /** 生成（或轮换）账号的推送 Token。明文只在返回时出现一次。 */
  issuePushToken(id) {
    const cur = this.#byId(id);
    if (!cur) throw new Error("账号不存在");
    const token = `cb_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("UPDATE accounts SET push_token_hash = ?, push_token_hint = ? WHERE id = ?")
      .run(sha256(token), token.slice(0, 9) + "…", id);
    return { ...this.#public(this.#byId(id)), token };
  }

  // ---------- 一次性配置码（本机执行器免填配置） ----------

  /**
   * 给账号发一枚一次性配置码：员工在执行器 init 里粘贴，即可自动换取推送 Token，
   * 免去手填服务器地址 + Token。10 分钟有效、用一次即焚。
   */
  createBootstrapCode(accountId, ttlMs = 10 * 60_000) {
    const account = this.#byId(accountId);
    if (!account) throw new Error("账号不存在");
    const code = `bs_${randomBytes(12).toString("base64url")}`;
    const now = new Date();
    this.db.prepare(
      "INSERT INTO bootstrap_codes (code, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(code, accountId, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    return { code, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  }

  /** 配置码 → 账号。过期/不存在/已用/账号停用都返回 null；有效则立即销毁（一次性）。 */
  redeemBootstrapCode(code) {
    const clean = String(code ?? "").trim();
    if (!clean) return null;
    const row = this.db.prepare("SELECT * FROM bootstrap_codes WHERE code = ?").get(clean);
    if (!row) return null;
    this.db.prepare("DELETE FROM bootstrap_codes WHERE code = ?").run(clean); // 无论结果如何都焚毁
    if (row.expires_at < new Date().toISOString()) return null;
    const account = this.#byId(row.account_id);
    return account?.active ? account : null;
  }

  /** 直接迁移旧 Token 哈希（collab 成员 → 账号时保持推送端不断）。 */
  importPushToken(id, tokenHash, tokenHint) {
    this.db.prepare("UPDATE accounts SET push_token_hash = ?, push_token_hint = ? WHERE id = ?")
      .run(tokenHash, tokenHint, id);
  }

  // ---------- 执行器运行配置（roots 白名单，平台侧可改） ----------

  /** 账号的执行器目录白名单；没配过返回 null（执行器用本机自己的）。 */
  runnerRoots(id) {
    const row = this.db.prepare("SELECT roots FROM runner_prefs WHERE account_id = ?").get(id);
    if (!row) return null;
    try {
      const list = JSON.parse(row.roots);
      return Array.isArray(list) ? list.map((item) => String(item)).filter(Boolean) : [];
    } catch { return []; }
  }

  /** 保存目录白名单（平台侧覆盖执行器本机配置；null 表示清除覆盖）。 */
  setRunnerRoots(id, roots) {
    const cur = this.#byId(id);
    if (!cur) throw new Error("账号不存在");
    if (roots === null) {
      this.db.prepare("DELETE FROM runner_prefs WHERE account_id = ?").run(id);
      return null;
    }
    const clean = (Array.isArray(roots) ? roots : [])
      .map((item) => String(item ?? "").trim().replace(/\//g, "\\"))
      .filter(Boolean)
      .slice(0, 20);
    this.db.prepare(`
      INSERT INTO runner_prefs (account_id, roots, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET roots = excluded.roots, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(clean), new Date().toISOString());
    return clean;
  }

  /** 推送 Token → 账号。找不到或已停用返回 null。 */
  accountByPushToken(token) {
    if (!token) return null;
    const row = this.db.prepare(
      "SELECT * FROM accounts WHERE push_token_hash = ?"
    ).get(sha256(token));
    return row?.active ? this.#public(row) : null;
  }

  /**
   * 服务器内部用的推送 Token（不挂任何账号）：任务产物自动归档进协作项目时，
   * TaskManager 需要一个合法身份调用 collab.ingest。Token 只存内存，重启换新。
   */
  issueServiceToken() {
    const token = `svc_${randomBytes(24).toString("base64url")}`;
    this.#serviceTokens.add(token);
    return token;
  }

  #serviceTokens = new Set();

  /** Token → 账号（推送 Token / 服务 Token 都认）。 */
  accountByAnyToken(token) {
    if (!token) return null;
    if (this.#serviceTokens.has(token)) return { id: "service", name: "服务器", username: "service", role: "admin", active: true };
    return this.accountByPushToken(token);
  }

  /** 旧「协作成员」迁移：同名建账号、角色带过去、推送 Token 哈希直迁。 */
  migrateFromMembers(members) {
    let created = 0;
    for (const m of members) {
      if (!m.active || this.#byId(m.id)) continue;
      const username = `legacy-${m.id}`;
      this.db.prepare(`INSERT INTO accounts (id, username, name, role, pass_hash, active, created_at, push_token_hash, push_token_hint)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(m.id, username, m.name,
          isRole(m.role) ? m.role : "other", hashPassword(randomBytes(24).toString("base64url")),
          m.created_at || new Date().toISOString(), m.token_hash || null, m.token_hint || null);
      created += 1;
    }
    return created;
  }

  // Portal is the identity authority; its final-admin invariant is enforced there.
  // Preserve the gateway account ID so jobs, model pools and runner bindings survive.
  syncPlatformAccount({ username, name, role }) {
    let current = this.listAccounts().find(a => a.username === username);
    if (!current) return this.createAccount({ username, name, role, password: randomBytes(32).toString("base64url") });
    if (current.name !== name || current.role !== role || !current.active) {
      this.db.prepare("UPDATE accounts SET name = ?, role = ?, active = 1 WHERE id = ?").run(name, role, current.id);
      this.#dropSessions(current.id);
    }
    return this.accountById(current.id);
  }
}
