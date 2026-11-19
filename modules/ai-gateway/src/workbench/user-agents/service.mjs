/**
 * 个人 AI 员工配置中心（多租户版）。
 *
 * 两层结构：
 * - 模型池（models）：接口地址 + Key + 上游模型名，一个账号配一次，多个员工共用；
 * - 员工（user_agents）：人格（名称/角色/职责）+ 挂载技能 + 引用一个模型。
 *
 * 全局员工（gateway.config.json 的 agents）是「内置位」；每个账号在这里
 * 拥有自己的员工清单：本机执行位（Codex / Claude / DSH）+ 云端模型位。
 *
 * 关键约定：
 * - API Key 只在这里出现明文一次（写入瞬间），落库即 AES-256-GCM 加密，
 *   master key 在 state/master.key（首次启动自动生成）。
 * - 解密后的完整配置只有一个出口：getForDispatch()，只在执行器 claim
 *   任务的那一刻下发，浏览器永远只拿掩码。
 * - 同一模型被多个员工共用时，按模型的 concurrency 做并发上限（默认 1 = 排队）。
 * - 100 人规模：SQLite 单文件足够，读写都是单条记录。
 */

import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeAvatar } from "../avatars.mjs";

/** 允许挂到个人名下的本机执行位：执行器本机的 CLI。dsh = DeepSeek Harness（需本机装有 dsh 且设了 DEEPSEEK_API_KEY）。 */
export const BUILTIN_KINDS = ["codex", "claude", "dsh"];

const KIND_PATTERN = /^[a-z0-9._:/-]{1,120}$/;
// 模型名放宽带符号：各家网关的 id 常见大写、下划线、@ 等（如 Claude-Fable-5.1、gpt_4o_mini），
// 只要不是空格/反斜杠/换行就放行，别让校验挡住自建网关的真实模型名。
const MODEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:@+#/-]{0,199}$/u;
const NAME_MAX = 20;
const SUMMARY_MAX = 40;
const ROLE_MAX = 40;
const DUTIES_MAX = 800;
const MODEL_NAME_MAX = 30;
const MAX_SKILLS_PER_AGENT = 8;
const MAX_AGENTS_PER_ACCOUNT = 30;
const MAX_MODELS_PER_ACCOUNT = 20;
/** 同一模型允许的同时执行数上限（默认排队 = 1） */
const CONCURRENCY_MAX = 8;

class Crypto {
  constructor(keyHex) {
    this.key = Buffer.from(keyHex, "hex");
    if (this.key.length !== 32) throw new Error("master key 必须是 64 位 hex");
  }
  encrypt(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    // 密文格式：iv(12B) || ciphertext || authTag(16B)，与 decrypt 的切法一一对应
    const enc = Buffer.concat([iv, cipher.update(String(plain), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return enc.toString("base64");
  }
  decrypt(blob) {
    const buf = Buffer.from(String(blob || ""), "base64");
    if (buf.length < 29) throw new Error("密文格式不对");
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const iv = data.subarray(0, 12);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(12)), decipher.final()]).toString("utf8");
  }
}

function loadMasterKey(stateDir) {
  const file = join(stateDir, "master.key");
  if (existsSync(file)) {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return hex;
  }
  const hex = randomBytes(32).toString("hex");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, `${hex}\n`, { encoding: "utf8", mode: 0o600 });
  return hex;
}

const normalizePricing = (input) => {
  if (!input || typeof input !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const out = { input: num(input.input), output: num(input.output), cachedInput: num(input.cachedInput) };
  return out.input == null && out.output == null ? null : out;
};

const normalizeCaps = (input) => {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))].slice(0, 10);
};

/** 挂载的工作方法名：派活时自动带上正文，员工不用每次重新勾。 */
const normalizeSkills = (input) => {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))].slice(0, MAX_SKILLS_PER_AGENT);
};

const rowToModel = (row, crypto) => ({
  id: row.id,
  accountId: row.account_id,
  name: row.name,
  baseUrl: row.base_url || "",
  model: row.model || "",
  maxOutputTokens: Number(row.max_output_tokens) || 16384,
  pricing: JSON.parse(row.pricing || "null"),
  // 同模型同时跑几个任务：默认 1 = 排队
  concurrency: Math.max(1, Math.min(CONCURRENCY_MAX, Number(row.concurrency) || 1)),
  enabled: row.enabled === 0 ? false : true,
  createdAt: row.created_at,
  apiKeyMasked: row.api_key_enc ? maskKey(crypto.decrypt(row.api_key_enc)) : "",
  configured: Boolean(row.api_key_enc),
});

const rowToRecord = (row, crypto) => ({
  id: row.id,
  accountId: row.account_id,
  kind: row.kind,
  ref: row.ref || null,
  name: row.name,
  summary: row.summary || "",
  // 人格：角色（我是谁）+ 职责（我做什么 / 不做什么）
  role: row.role || "",
  duties: row.duties || "",
  // 挂载的工作方法（技能名数组）：派活时自动带上，不用每次重新挂
  skills: JSON.parse(row.skills || "[]"),
  // 员工默认写权限：read-only / workspace-write
  defaultMode: row.default_mode === "read-only" ? "read-only" : "workspace-write",
  // 头像只存白名单 key，空串表示走「名字首字」兜底
  avatar: normalizeAvatar(row.avatar) ?? "",
  // 云端员工引用模型池；本机执行位没有模型
  modelId: row.model_id || null,
  model: row.model || "",
  baseUrl: row.base_url || "",
  maxOutputTokens: Number(row.max_output_tokens) || 16384,
  capabilities: JSON.parse(row.capabilities || "[]"),
  pricing: JSON.parse(row.pricing || "null"),
  enabled: Boolean(row.enabled),
  // 老库没这列时 row.tools 是 undefined → 视为开启；显式 0 才是关
  tools: row.tools === 0 ? false : true,
  createdAt: row.created_at,
  // 浏览器只见掩码；kind=builtin 没有 key
  apiKeyMasked: row.api_key_enc ? maskKey(crypto.decrypt(row.api_key_enc)) : "",
  configured: row.kind === "builtin" ? true : Boolean(row.api_key_enc || row.model_id),
});

const maskKey = (key) => {
  const text = String(key || "");
  if (!text) return "";
  if (text.length <= 8) return "••••••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
};

export class UserAgentsService {
  constructor({ stateDir } = {}) {
    this.stateDir = stateDir;
    this.crypto = new Crypto(loadMasterKey(stateDir));
    this.db = null;
  }

  boot() {
    this.db = new DatabaseSync(join(this.stateDir, "user-agents.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_agents (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT,
        name TEXT NOT NULL,
        summary TEXT DEFAULT '',
        model TEXT DEFAULT '',
        base_url TEXT DEFAULT '',
        api_key_enc TEXT,
        max_output_tokens INTEGER DEFAULT 16384,
        capabilities TEXT DEFAULT '[]',
        pricing TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_agents_account ON user_agents(account_id, created_at);

      -- 模型池：一个账号配一次地址+Key+模型名，多个员工共用
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key_enc TEXT,
        model TEXT NOT NULL DEFAULT '',
        max_output_tokens INTEGER DEFAULT 16384,
        pricing TEXT,
        concurrency INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_models_account ON models(account_id, created_at);
    `);
    // 存量库迁移：基础工具开关（web_search / 文件读写 / 网页阅读），老员工默认开
    const cols = this.db.prepare("PRAGMA table_info(user_agents)").all().map((col) => col.name);
    if (!cols.includes("tools")) {
      this.db.exec("ALTER TABLE user_agents ADD COLUMN tools INTEGER DEFAULT 1");
    }
    // 头像（白名单 key，空表示用名字首字）
    if (!cols.includes("avatar")) {
      this.db.exec("ALTER TABLE user_agents ADD COLUMN avatar TEXT");
    }
    // 模型与员工解耦：员工只引用 model_id，人格与技能挂在员工身上
    if (!cols.includes("model_id")) this.db.exec("ALTER TABLE user_agents ADD COLUMN model_id TEXT");
    if (!cols.includes("role")) this.db.exec("ALTER TABLE user_agents ADD COLUMN role TEXT DEFAULT ''");
    if (!cols.includes("duties")) this.db.exec("ALTER TABLE user_agents ADD COLUMN duties TEXT DEFAULT ''");
    if (!cols.includes("skills")) this.db.exec("ALTER TABLE user_agents ADD COLUMN skills TEXT DEFAULT '[]'");
    if (!cols.includes("default_mode")) this.db.exec("ALTER TABLE user_agents ADD COLUMN default_mode TEXT DEFAULT 'workspace-write'");
    this.#migrateModelPool();
    return this;
  }

  /**
   * 老数据迁移：openai 员工的 model + base_url + Key 原本写在员工行里，
   * 抽成模型池记录后员工只留 model_id。同账号下「地址 + Key + 模型名」
   * 完全相同的员工共用一个模型记录（迁移完自动享受同一并发上限）。
   * 旧列保持不动，回滚旧版本也能读。
   */
  #migrateModelPool() {
    const rows = this.db.prepare(`
      SELECT * FROM user_agents
      WHERE kind = 'openai'
        AND (model_id IS NULL OR model_id = '')
        AND model <> '' AND base_url <> ''
    `).all();
    if (!rows.length) return;
    let created = 0;
    for (const row of rows) {
      let found = row.api_key_enc
        ? this.db.prepare("SELECT id FROM models WHERE account_id = ? AND base_url = ? AND model = ? AND api_key_enc = ?")
          .get(row.account_id, row.base_url, row.model, row.api_key_enc)
        : this.db.prepare("SELECT id FROM models WHERE account_id = ? AND base_url = ? AND model = ? AND api_key_enc IS NULL")
          .get(row.account_id, row.base_url, row.model);
      let modelId = found?.id;
      if (!modelId) {
        modelId = `md-${randomUUID().slice(0, 8)}`;
        // 名称默认用上游模型名，重名就加序号，别让人一屏全是同名模型
        let base = row.model.slice(0, MODEL_NAME_MAX);
        let name = base;
        let seq = 1;
        while (this.db.prepare("SELECT 1 FROM models WHERE account_id = ? AND name = ?").get(row.account_id, name)) {
          seq += 1;
          name = `${base} (${seq})`.slice(0, MODEL_NAME_MAX);
        }
        this.db.prepare(`
          INSERT INTO models (id, account_id, name, base_url, api_key_enc, model, max_output_tokens, pricing, concurrency, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
        `).run(modelId, row.account_id, name, row.base_url, row.api_key_enc ?? null, row.model,
          Number(row.max_output_tokens) || 16384, row.pricing ?? null, row.created_at || new Date().toISOString());
        created += 1;
      }
      this.db.prepare("UPDATE user_agents SET model_id = ? WHERE id = ?").run(modelId, row.id);
    }
    if (created) console.log(`[user-agents] 模型池初始化：从存量员工抽出了 ${created} 个模型`);
  }

  shutdown() { this.db?.close(); this.db = null; }

  #assertQuota(accountId) {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM user_agents WHERE account_id = ?").get(accountId)?.n ?? 0;
    if (count >= MAX_AGENTS_PER_ACCOUNT) throw new Error(`每个账号最多 ${MAX_AGENTS_PER_ACCOUNT} 位员工`);
  }

  #assertModelQuota(accountId) {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM models WHERE account_id = ?").get(accountId)?.n ?? 0;
    if (count >= MAX_MODELS_PER_ACCOUNT) throw new Error(`每个账号最多 ${MAX_MODELS_PER_ACCOUNT} 个模型`);
  }

  /* ============================ 模型池 ============================ */

  /**
   * 校验并整理模型输入。partial=true 时只校验出现的字段（编辑场景）。
   * 地址 / Key / 模型名三件套决定「能不能真的调通」，所以都做硬校验。
   */
  #modelFields(input = {}, { partial = false } = {}) {
    const out = {};
    if (!partial || "name" in input) {
      const name = String(input.name ?? "").trim();
      if (!name) throw new Error("先给模型起个名字（如「自建网关 · Claude」）");
      if (name.length > MODEL_NAME_MAX) throw new Error(`模型名最多 ${MODEL_NAME_MAX} 个字`);
      out.name = name;
    }
    if (!partial || "model" in input) {
      const model = String(input.model ?? "").trim();
      if (!model) throw new Error("先填写上游模型名");
      if (!MODEL_PATTERN.test(model)) throw new Error("模型名含不支持的特殊符号（不能用空格 / \\ / 换行）");
      out.model = model;
    }
    if (!partial || "baseUrl" in input) {
      const raw = String(input.baseUrl ?? "").trim();
      if (!raw) throw new Error("先填写接口地址（Base URL）");
      let url;
      try { url = new URL(raw); } catch { throw new Error("Base URL 不是合法网址"); }
      if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL 必须是 http 或 https");
      out.base_url = raw.replace(/\/+$/, "");
    }
    if (!partial || "maxOutputTokens" in input) {
      const n = Number(input.maxOutputTokens ?? 16384);
      if (!Number.isFinite(n) || n < 256 || n > 65536) throw new Error("最大输出 tokens 需在 256–65536");
      out.max_output_tokens = Math.round(n);
    }
    if (!partial || "concurrency" in input) {
      const n = Number(input.concurrency ?? 1);
      if (!Number.isFinite(n) || n < 1 || n > CONCURRENCY_MAX) throw new Error(`同时执行数需在 1–${CONCURRENCY_MAX}（1 = 排队）`);
      out.concurrency = Math.round(n);
    }
    if (!partial || "pricing" in input) {
      out.pricing = normalizePricing(input.pricing);
    }
    if (!partial || "enabled" in input) {
      out.enabled = input.enabled === false ? 0 : 1;
    }
    return out;
  }

  createModel(accountId, input = {}) {
    const fields = this.#modelFields(input);
    const apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("先填写 API Key");
    if (/\s/.test(apiKey)) throw new Error("API Key 不能包含空格");
    if (apiKey.length < 8 || apiKey.length > 512) throw new Error("API Key 长度异常");
    const taken = this.db.prepare("SELECT 1 FROM models WHERE account_id = ? AND name = ?").get(accountId, fields.name);
    if (taken) throw new Error(`你已经有叫「${fields.name}」的模型`);
    this.#assertModelQuota(accountId);
    const record = {
      id: `md-${randomUUID().slice(0, 8)}`,
      account_id: accountId,
      created_at: new Date().toISOString(),
      api_key_enc: this.crypto.encrypt(apiKey),
      ...fields,
    };
    this.db.prepare(`
      INSERT INTO models (id, account_id, name, base_url, api_key_enc, model, max_output_tokens, pricing, concurrency, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.account_id, record.name, record.base_url, record.api_key_enc, record.model,
      record.max_output_tokens, record.pricing ? JSON.stringify(record.pricing) : null,
      record.concurrency, record.enabled, record.created_at,
    );
    return this.getModel(record.id, accountId);
  }

  updateModel(id, accountId, patch = {}) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    if (!row || (accountId && row.account_id !== accountId)) throw new Error("模型不存在或不属于你");
    const next = this.#modelFields(patch, { partial: true });
    if (next.name) {
      const taken = this.db.prepare("SELECT 1 FROM models WHERE account_id = ? AND name = ? AND id <> ?")
        .get(row.account_id, next.name, id);
      if (taken) throw new Error(`你已经有叫「${next.name}」的模型`);
    }
    if ("pricing" in next) next.pricing = next.pricing ? JSON.stringify(next.pricing) : null;
    if (patch.clearApiKey === true) next.api_key_enc = null;
    else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
      const apiKey = patch.apiKey.trim();
      if (/\s/.test(apiKey)) throw new Error("API Key 不能包含空格");
      if (apiKey.length < 8 || apiKey.length > 512) throw new Error("API Key 长度异常");
      next.api_key_enc = this.crypto.encrypt(apiKey);
    }
    const keys = Object.keys(next);
    if (!keys.length) throw new Error("没有需要保存的改动");
    this.db.prepare(`UPDATE models SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => next[key]), id);
    return this.getModel(id, null);
  }

  /** 被员工引用时不许删：先让人把员工改绑，避免员工莫名不能用。 */
  removeModel(id, accountId) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    if (!row || (accountId && row.account_id !== accountId)) throw new Error("模型不存在或不属于你");
    const used = this.db.prepare("SELECT name FROM user_agents WHERE model_id = ?").all(id);
    if (used.length) {
      throw new Error(`还有 ${used.length} 位员工在用它（${used.map((item) => item.name).join("、")}），先给它们换模型再删`);
    }
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
    return { id, deleted: true };
  }

  getModel(id, accountId = null) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    if (!row) return null;
    if (accountId && row.account_id !== accountId) return null;
    return this.#withUsage(rowToModel(row, this.crypto));
  }

  listModels(accountId) {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM models WHERE account_id = ? ORDER BY created_at").all(accountId)
      : this.db.prepare("SELECT * FROM models ORDER BY created_at").all();
    return rows.map((row) => this.#withUsage(rowToModel(row, this.crypto)));
  }

  /** 有多少员工在用这个模型：前端卡片直接显示，删之前也心里有数。 */
  #withUsage(model) {
    const used = this.db.prepare("SELECT id, name FROM user_agents WHERE model_id = ?").all(model.id);
    return { ...model, agentCount: used.length, agentNames: used.slice(0, 5).map((item) => item.name) };
  }

  /** 派发专用：带上明文 Key，只在 claim 那一刻调用。 */
  getModelForDispatch(id) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    if (!row || row.enabled === 0) return null;
    const model = rowToModel(row, this.crypto);
    return { ...model, apiKey: row.api_key_enc ? this.crypto.decrypt(row.api_key_enc) : null };
  }

  create(accountId, input = {}) {
    const kind = String(input.kind || "builtin").trim();
    if (!["builtin", "openai"].includes(kind)) throw new Error("员工类型只能是 builtin 或 openai");

    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("先给员工起个名字");
    if (name.length > NAME_MAX) throw new Error(`名称最多 ${NAME_MAX} 个字`);

    const record = {
      id: `ua-${randomUUID().slice(0, 8)}`,
      account_id: accountId,
      kind,
      ref: null,
      name,
      summary: String(input.summary ?? "").trim().slice(0, SUMMARY_MAX),
      role: String(input.role ?? "").trim().slice(0, ROLE_MAX),
      duties: String(input.duties ?? "").trim().slice(0, DUTIES_MAX),
      skills: JSON.stringify(normalizeSkills(input.skills)),
      default_mode: input.defaultMode === "read-only" ? "read-only" : "workspace-write",
      avatar: normalizeAvatar(input.avatar),
      model_id: null,
      model: "",
      base_url: "",
      api_key_enc: null,
      max_output_tokens: 16384,
      capabilities: normalizeCaps(input.capabilities),
      pricing: null,
      enabled: input.enabled !== false,
      tools: input.tools !== false ? 1 : 0,
      created_at: new Date().toISOString(),
    };

    if (kind === "builtin") {
      const ref = String(input.ref || "codex").trim();
      if (!BUILTIN_KINDS.includes(ref)) throw new Error(`本机执行位只支持：${BUILTIN_KINDS.join("、")}`);
      if (!KIND_PATTERN.test(ref)) throw new Error("ref 格式不对");
      record.ref = ref;
    } else {
      // 云端员工：只引用模型池里的一个模型，地址/Key/模型名都归模型管
      const modelId = String(input.modelId ?? "").trim();
      if (modelId) {
        const model = this.db.prepare("SELECT id FROM models WHERE id = ? AND account_id = ?").get(modelId, accountId);
        if (!model) throw new Error("选的模型不存在或不属于你");
        record.model_id = modelId;
      } else if (input.model && input.baseUrl && input.apiKey) {
        // 兼容老调用方（脚本 / 未升级的前端）：直接给三件套时顺手建一个模型
        const created = this.createModel(accountId, {
          name: String(input.modelName || input.model).slice(0, MODEL_NAME_MAX),
          model: input.model,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          maxOutputTokens: input.maxOutputTokens,
          pricing: input.pricing,
        });
        record.model_id = created.id;
      } else {
        throw new Error("先选一个模型（没有就去「我的模型」新建一个）");
      }
    }

    this.#assertQuota(accountId);
    const taken = this.db
      .prepare("SELECT 1 FROM user_agents WHERE account_id = ? AND name = ?")
      .get(accountId, name);
    if (taken) throw new Error(`你已经有叫「${name}」的员工`);

    this.db.prepare(`
      INSERT INTO user_agents (id, account_id, kind, ref, name, summary, role, duties, skills, default_mode,
        avatar, model_id, model, base_url, api_key_enc, max_output_tokens, capabilities, pricing, enabled, tools, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.account_id, record.kind, record.ref, record.name, record.summary,
      record.role, record.duties, record.skills, record.default_mode, record.avatar, record.model_id,
      record.model, record.base_url, record.api_key_enc, record.max_output_tokens,
      JSON.stringify(record.capabilities), record.pricing ? JSON.stringify(record.pricing) : null,
      record.enabled ? 1 : 0, record.tools, record.created_at,
    );
    return this.get(record.id, accountId);
  }

  get(id, accountId = null) {
    const row = this.db.prepare("SELECT * FROM user_agents WHERE id = ?").get(id);
    if (!row) return null;
    // 非本人只能由管理员读（管理员校验在 API 层做，这里只拦普通账号看别人的）
    if (accountId && row.account_id !== accountId) return null;
    return rowToRecord(row, this.crypto);
  }

  list(accountId) {
    const rows = this.db
      .prepare("SELECT * FROM user_agents WHERE account_id = ? ORDER BY created_at")
      .all(accountId);
    return rows.map((row) => rowToRecord(row, this.crypto));
  }

  /** 管理员视角：全员员工清单（只带掩码）。 */
  listAll() {
    return this.db.prepare("SELECT * FROM user_agents ORDER BY created_at")
      .all().map((row) => rowToRecord(row, this.crypto));
  }

  update(id, accountId, patch = {}) {
    const row = this.db.prepare("SELECT * FROM user_agents WHERE id = ?").get(id);
    if (!row || (accountId && row.account_id !== accountId)) throw new Error("员工不存在或不属于你");
    const next = {};

    /* ---- 两种类型通用：人格与技能挂在员工身上 ---- */
    if ("name" in patch) {
      const name = String(patch.name ?? "").trim();
      if (!name || name.length > NAME_MAX) throw new Error(`名称要 1-${NAME_MAX} 个字`);
      next.name = name;
    }
    if ("summary" in patch) next.summary = String(patch.summary ?? "").trim().slice(0, SUMMARY_MAX);
    if ("role" in patch) next.role = String(patch.role ?? "").trim().slice(0, ROLE_MAX);
    if ("duties" in patch) next.duties = String(patch.duties ?? "").trim().slice(0, DUTIES_MAX);
    if ("skills" in patch) next.skills = JSON.stringify(normalizeSkills(patch.skills));
    if ("defaultMode" in patch) next.default_mode = patch.defaultMode === "read-only" ? "read-only" : "workspace-write";
    if ("avatar" in patch) next.avatar = normalizeAvatar(patch.avatar);
    if ("enabled" in patch) next.enabled = patch.enabled === true ? 1 : 0;

    /* ---- 只有云端员工有模型与工具字段 ---- */
    let touchedModel = false;
    if (row.kind !== "builtin") {
      if ("modelId" in patch) {
        const modelId = String(patch.modelId ?? "").trim();
        if (!modelId) throw new Error("先选一个模型");
        const model = this.db.prepare("SELECT id FROM models WHERE id = ? AND account_id = ?").get(modelId, row.account_id);
        if (!model) throw new Error("选的模型不存在或不属于你");
        next.model_id = modelId;
      }
      // 兼容老调用：直接改三件套时同步更新模型池里的那一条，不再写回员工行
      if ("model" in patch || "baseUrl" in patch || (typeof patch.apiKey === "string" && patch.apiKey.trim())) {
        const modelRow = row.model_id
          ? this.db.prepare("SELECT * FROM models WHERE id = ?").get(row.model_id)
          : null;
        if (modelRow) {
          this.updateModel(modelRow.id, null, {
            ...(("model" in patch) ? { model: patch.model } : {}),
            ...(("baseUrl" in patch) ? { baseUrl: patch.baseUrl } : {}),
            ...(typeof patch.apiKey === "string" && patch.apiKey.trim() ? { apiKey: patch.apiKey } : {}),
            ...(("maxOutputTokens" in patch) ? { maxOutputTokens: patch.maxOutputTokens } : {}),
            ...(("pricing" in patch) ? { pricing: patch.pricing } : {}),
          });
          touchedModel = true;
        } else {
          // 没有模型的老员工：走原来的内联字段（保证旧客户端还能改）
          if ("model" in patch) {
            const model = String(patch.model ?? "").trim();
            if (!model || !MODEL_PATTERN.test(model)) throw new Error("模型名含不支持的特殊符号（不能用空格 / \\ / 换行）");
            next.model = model;
          }
          if ("baseUrl" in patch) {
            const raw = String(patch.baseUrl ?? "").trim();
            if (!raw) throw new Error("先填写 Base URL");
            try { if (!/^https?:$/.test(new URL(raw).protocol)) throw new Error(); } catch { throw new Error("Base URL 必须是 http 或 https"); }
            next.base_url = raw.replace(/\/+$/, "");
          }
          if (patch.clearApiKey === true) next.api_key_enc = null;
          else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
            const apiKey = patch.apiKey.trim();
            if (/\s/.test(apiKey)) throw new Error("API Key 不能包含空格");
            if (apiKey.length < 8 || apiKey.length > 512) throw new Error("API Key 长度异常");
            next.api_key_enc = this.crypto.encrypt(apiKey);
          }
          if ("maxOutputTokens" in patch) {
            const n = Number(patch.maxOutputTokens);
            if (!Number.isFinite(n) || n < 256 || n > 65536) throw new Error("最大输出 tokens 需在 256–65536");
            next.max_output_tokens = Math.round(n);
          }
          if ("pricing" in patch) next.pricing = normalizePricing(patch.pricing) ? JSON.stringify(normalizePricing(patch.pricing)) : null;
        }
      }
      if ("capabilities" in patch) next.capabilities = JSON.stringify(normalizeCaps(patch.capabilities));
      if ("tools" in patch) next.tools = patch.tools === false ? 0 : 1;
    }

    const keys = Object.keys(next);
    if (!keys.length) {
      // 只改了模型池里的字段（地址/Key/模型名），员工行本身没变化也算保存成功
      if (touchedModel) return this.get(id, null);
      throw new Error("没有需要保存的改动");
    }
    this.db.prepare(`UPDATE user_agents SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => next[key]), id);
    return this.get(id, null);
  }

  remove(id, accountId) {
    const row = this.db.prepare("SELECT * FROM user_agents WHERE id = ?").get(id);
    if (!row || (accountId && row.account_id !== accountId)) throw new Error("员工不存在或不属于你");
    this.db.prepare("DELETE FROM user_agents WHERE id = ?").run(id);
    return { id, deleted: true };
  }

  /**
   * 派发专用：解密完整配置。只在执行器 claim 任务时调用，结果不落日志。
   * 返回 null 表示员工不存在；员工或它引用的模型停用，都拒绝派发。
   *
   * 结构：员工（人格/技能/工具） + model（地址/Key/上游模型/并发上限）。
   * 同时保留 model 字符串之外的旧字段（baseUrl/modelName）给老执行器兼容。
   */
  getForDispatch(id) {
    const row = this.db.prepare("SELECT * FROM user_agents WHERE id = ?").get(id);
    if (!row || !row.enabled) return null;
    const record = rowToRecord(row, this.crypto);
    let model = null;
    if (record.modelId) {
      model = this.getModelForDispatch(record.modelId);
      if (!model) return null; // 模型被停用：员工也派不出去，避免拿空 Key 打网络
    } else if (row.model && row.base_url) {
      // 老数据兜底：还没迁到模型池的员工
      model = {
        id: null,
        name: row.model,
        baseUrl: row.base_url,
        model: row.model,
        maxOutputTokens: record.maxOutputTokens,
        concurrency: 1,
        pricing: record.pricing,
        apiKey: row.api_key_enc ? this.crypto.decrypt(row.api_key_enc) : null,
      };
    }
    return {
      id: record.id,
      accountId: row.account_id, // 归属账号：流程步骤转远程时，任务记到员工主人名下
      kind: record.kind,
      ref: record.ref,
      name: record.name,
      // 人格：角色 + 职责，执行器拼进 system prompt
      role: record.role,
      duties: record.duties,
      // 挂载的工作方法：服务端已把正文注进 prompt，这里只是给执行器做提示
      skills: record.skills,
      capabilities: record.capabilities,
      // 基础工具开关：关了就是纯文本模型，开了才有搜索/文件读写
      tools: record.tools,
      // 模型池：地址 / Key / 上游模型名 / 输出上限 / 并发上限
      model,
      // 兼容字段（老执行器仍读这三个）
      modelName: model?.model ?? record.model,
      baseUrl: model?.baseUrl ?? record.baseUrl,
      maxOutputTokens: model?.maxOutputTokens ?? record.maxOutputTokens,
      apiKey: model?.apiKey ?? (row.api_key_enc ? this.crypto.decrypt(row.api_key_enc) : null),
    };
  }

  /**
   * 测试连接专用：只把「地址 / 模型 / Key」交给探针，同样只认本人（管理员可传 null）。
   * 停用的员工也能测——测试是为了决定要不要启用它。
   */
  probeSource(id, accountId = null) {
    const row = this.db.prepare("SELECT * FROM user_agents WHERE id = ?").get(id);
    if (!row || (accountId && row.account_id !== accountId)) return null;
    let model = null;
    if (row.model_id) {
      const modelRow = this.db.prepare("SELECT * FROM models WHERE id = ?").get(row.model_id);
      if (modelRow) {
        model = {
          model: modelRow.model || "",
          baseUrl: modelRow.base_url || "",
          apiKey: modelRow.api_key_enc ? this.crypto.decrypt(modelRow.api_key_enc) : "",
        };
      }
    }
    return {
      kind: row.kind,
      name: row.name,
      model: model?.model ?? row.model ?? "",
      baseUrl: model?.baseUrl ?? row.base_url ?? "",
      apiKey: model?.apiKey ?? (row.api_key_enc ? this.crypto.decrypt(row.api_key_enc) : ""),
    };
  }

  stats() {
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM user_agents").get()?.n ?? 0;
    const byKind = {};
    for (const row of this.db.prepare("SELECT kind, COUNT(*) AS n FROM user_agents GROUP BY kind").all()) {
      byKind[row.kind] = row.n;
    }
    return { total, byKind };
  }
}
