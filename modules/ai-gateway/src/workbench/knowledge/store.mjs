/**
 * 产品中枢知识库 · 数据层（SQLite）。
 *
 * 设计要点（对应《产品中枢知识库工作台功能需求规格书》V1.0）：
 * - 元数据、全文索引、审核、审计都在本地 SQLite；向量索引与图数据库是 P1，不在此。
 * - 全文检索用 FTS5 trigram 分词：中文按任意 ≥3 字子串命中，英文型号子串也能命中；
 *   1~2 字的短词走 LIKE 回退（规模一万主题内可接受，满足 1 秒关键词目标）。
 * - 正式知识唯一事实源是 Obsidian Vault（vault.mjs 负责 .md 回写与外部修改扫描），
 *   这里的 DB 只是可重建缓存 + 工作流状态（审核、版本、审计不存 Vault）。
 * - 审计表只追加：不提供 update/delete 语句。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 四个知识空间对应 Vault 既有知识层根目录（与 AGENTS.md / README 一致，不另造目录）。 */
export const SPACES = {
  research: { key: "research", name: "调研", dir: "10-调研Wiki" },
  planning: { key: "planning", name: "企划", dir: "20-企划Wiki" },
  product: { key: "product", name: "产品", dir: "30-产品模型" },
  idea: { key: "idea", name: "灵感", dir: "40-灵感模型" },
};

export const TOPIC_TYPES = {
  research: ["综合调研", "行业趋势", "厂商竞品", "技术方案", "政策标准", "客户需求", "招投标", "未分类"],
  planning: ["企划项目", "产品线全景", "竞争力十二维度", "企划索引", "竞品跑分", "方法论", "市场政策", "营销研发计划", "未分类"],
  product: ["产品档案", "功能库", "需求池", "客户反馈", "竞品反馈", "对比矩阵", "机会建议", "未分类"],
  idea: ["灵感收集", "未分类"],
};

/** 十二个竞争力维度（企划空间主数据，规格书 5.2）。 */
export const COMPETITIVE_DIMENSIONS = [
  "产品线齐全", "行业应用场景", "资质要求", "技术先进", "功能强", "性能稳",
  "AI 智慧力强", "成本优势", "控标能力强", "应标能力强", "外观高端大气", "体验感好",
];

export const TOPIC_STATUS = ["draft", "pending", "revise", "published", "archived", "deleted"];
export const TOPIC_STATUS_NAME = {
  draft: "草稿", pending: "待审核", revise: "待修订",
  published: "已发布", archived: "已归档", deleted: "已废止",
};
export const CLASSIFICATIONS = ["public", "internal", "secret"];
export const CLASSIFICATION_NAME = { public: "公开", internal: "内部", secret: "机密" };
/** 密级 → 云端规则（规格书 12.1）。机密禁止任何片段上云，由调用方在派 AI 前检查。 */
export const CLOUD_RULE = {
  public: { cloud: true, note: "可使用普通云模型" },
  internal: { cloud: "summary", note: "仅摘要或脱敏片段可上云" },
  secret: { cloud: false, note: "禁止上云，只能本地处理" },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT '',
  summary_auto INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  draft_body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  classification TEXT NOT NULL DEFAULT 'internal',
  quality INTEGER NOT NULL DEFAULT 0,
  quality_detail TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT 'local',
  vault_path TEXT NOT NULL DEFAULT '',
  draft_saved_at INTEGER,
  conflict TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE TABLE IF NOT EXISTS topic_attachments (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_topic ON topic_attachments(topic_id);
CREATE TABLE IF NOT EXISTS topic_versions (
  topic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, version)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'file',
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'internal',
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_note TEXT NOT NULL DEFAULT '',
  missing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'zh',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  fragment_id TEXT NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'candidate',
  topic_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  candidate TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'pending',
  comment TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'ai',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  files_total INTEGER NOT NULL DEFAULT 0,
  files_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user TEXT NOT NULL DEFAULT 'local',
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before TEXT NOT NULL DEFAULT '',
  after TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'ok'
);
CREATE TABLE IF NOT EXISTS vocab (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  merged_to TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 双索引：正文层（标题 + 正文）与摘要层（标题 + 摘要）各一份，互不重叠
CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
  title, body, content='topics', content_rowid='rowid', tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS topics_summary_fts USING fts5(
  title, summary, content='topics', content_rowid='rowid', tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
  text, content='fragments', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS topics_ai AFTER INSERT ON topics BEGIN
  INSERT INTO topics_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS topics_ad AFTER DELETE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS topics_au AFTER UPDATE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO topics_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS topics_summary_ai AFTER INSERT ON topics BEGIN
  INSERT INTO topics_summary_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS topics_summary_ad AFTER DELETE ON topics BEGIN
  INSERT INTO topics_summary_fts(topics_summary_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS topics_summary_au AFTER UPDATE ON topics BEGIN
  INSERT INTO topics_summary_fts(topics_summary_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO topics_summary_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fragments_ai AFTER INSERT ON fragments BEGIN
  INSERT INTO fragments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS fragments_ad AFTER DELETE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS fragments_au AFTER UPDATE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO fragments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE INDEX IF NOT EXISTS idx_fragments_source ON fragments(source_id);
CREATE INDEX IF NOT EXISTS idx_citations_topic ON citations(topic_id);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(hash);
CREATE INDEX IF NOT EXISTS idx_topics_space ON topics(space, status);
`;

export const uid = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export class KnowledgeStore {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.dbPath = join(stateDir, "knowledge.db");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 老库升级：新增列与摘要索引补齐。
   * 行量级在千条内，重建 FTS 一次在毫秒级，所以每次启动都重建，避免升级后索引缺行。
   */
  migrate() {
    const cols = new Set(this.db.prepare("PRAGMA table_info(topics)").all().map((c) => c.name));
    if (!cols.has("summary_source")) this.db.exec("ALTER TABLE topics ADD COLUMN summary_source TEXT NOT NULL DEFAULT ''");
    if (!cols.has("summary_auto")) this.db.exec("ALTER TABLE topics ADD COLUMN summary_auto INTEGER NOT NULL DEFAULT 0");
    // 老库的正文索引还带着 summary 列：拆成真正的双索引（正文层不再吃摘要命中）
    const ftsCols = new Set(this.db.prepare("PRAGMA table_info(topics_fts)").all().map((c) => c.name));
    if (ftsCols.has("summary")) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS topics_ai;
        DROP TRIGGER IF EXISTS topics_ad;
        DROP TRIGGER IF EXISTS topics_au;
        DROP TABLE IF EXISTS topics_fts;
        CREATE VIRTUAL TABLE topics_fts USING fts5(
          title, body, content='topics', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER topics_ai AFTER INSERT ON topics BEGIN
          INSERT INTO topics_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        CREATE TRIGGER topics_ad AFTER DELETE ON topics BEGIN
          INSERT INTO topics_fts(topics_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
        END;
        CREATE TRIGGER topics_au AFTER UPDATE ON topics BEGIN
          INSERT INTO topics_fts(topics_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
          INSERT INTO topics_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
      `);
    }
    // 索引是缓存：每次启动重建一次，保证升级后摘要层与正文层都齐全（千条内毫秒级）
    try {
      this.db.exec("INSERT INTO topics_fts(topics_fts) VALUES('rebuild')");
      this.db.exec("INSERT INTO topics_summary_fts(topics_summary_fts) VALUES('rebuild')");
    } catch { /* 空库或被占用时忽略 */ }
  }

  // ---------------------------------------------------------------- 主题
  createTopic(input, { actor = "local" } = {}) {
    const now = Date.now();
    const topic = {
      // Vault 同步回灌时要沿用页面 frontmatter 的 id，否则每轮扫描都会当成新主题重复登记
      id: input.id ?? uid("kt"),
      space: input.space,
      type: input.type,
      title: input.title || "未命名主题",
      summary: input.summary || "",
      summary_source: input.summarySource ?? "",
      summary_auto: input.summaryAuto ? 1 : 0,
      body: input.body || "",
      draft_body: input.body || "",
      tags: JSON.stringify(input.tags ?? []),
      status: input.status ?? "draft",
      classification: input.classification ?? "internal",
      version: 0,
      created_at: now,
      updated_at: now,
      published_at: input.status === "published" ? now : null,
    };
    const cols = Object.keys(topic);
    this.db.prepare(
      `INSERT INTO topics (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => topic[c]));
    this.audit(actor, "topic.create", topic.id, "", topic.title);
    return this.getTopic(topic.id);
  }

  getTopic(id) {
    const row = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
    if (!row) return null;
    const topic = this.inflateTopic(row);
    // 流向关系（灵感 → 派生主题）随详情一起返回：detail 要展示「已流转为 / 来源灵感」，
    // 发布时也要据此把双向链接写进 Vault frontmatter 的 source_refs
    const rels = this.listRelations({ topicId: id, type: "spawned" });
    topic.derived = rels.filter((r) => r.from_id === id).map((r) => ({
      relId: r.id, id: r.to_id, title: r.to_title, space: r.to_space, type: r.to_type, status: r.to_status, createdAt: r.created_at,
    }));
    topic.spawnedFrom = rels.filter((r) => r.to_id === id).map((r) => ({
      relId: r.id, id: r.from_id, title: r.from_title, space: r.from_space, type: r.from_type, status: r.from_status, createdAt: r.created_at,
    }));
    topic.attachments = this.listAttachments(id);
    return topic;
  }

  inflateTopic(row) {
    return { ...row, tags: JSON.parse(row.tags || "[]"), quality_detail: JSON.parse(row.quality_detail || "{}") };
  }

  /** 更新主题字段。写正文时同步草稿区；status 变化走专门的流转方法。 */
  updateTopic(id, patch, { actor = "local", note = "" } = {}) {
    const before = this.getTopic(id);
    if (!before) throw new Error("主题不存在");
    // 空间变更必须走 moveTopic（要搬 Vault 文件），直接 patch 会让 DB 与目录不一致
    if (patch.space !== undefined && patch.space !== before.space) {
      throw new Error("空间迁移请调用 moveTopic（需要同步搬移 Vault 文件）");
    }
    const allowed = ["title", "summary", "summary_source", "summary_auto", "body", "draft_body", "tags", "type", "classification", "vault_path", "conflict"];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      let value = patch[key];
      if (key === "tags") value = JSON.stringify(value ?? []);
      sets.push(`${key} = ?`);
      vals.push(value);
    }
    if (!sets.length) return before;
    // 更新正文 = 同时刷新草稿与工作台版本；Obsidian 外部编辑冲突时由 vault.mjs 写 conflict 字段
    if (patch.body !== undefined && patch.draft_body === undefined) {
      sets.push("draft_body = ?");
      vals.push(patch.body);
      sets.push("draft_saved_at = ?");
      vals.push(Date.now());
    }
    sets.push("updated_at = ?");
    vals.push(Date.now());
    vals.push(id);
    this.db.prepare(`UPDATE topics SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    this.audit(actor, "topic.update", id, before.title, Object.keys(patch).join(","));
    return this.getTopic(id);
  }

  /**
   * 空间迁移（数据层）：把主题从误放的空间挪到正确空间。
   * 类型若不属于目标空间，自动落到目标空间主类型，避免「招投标」留在企划空间。
   * Vault 文件搬移由服务层做（数据层不碰文件系统）。
   */
  moveTopic(id, { space, type }, { actor = "local" } = {}) {
    const before = this.getTopic(id);
    if (!before) throw new Error("主题不存在");
    if (!SPACES[space]) throw new Error(`未知知识空间: ${space}`);
    const targetType = TOPIC_TYPES[space].includes(type) ? type : TOPIC_TYPES[space][0];
    if (before.space === space && before.type === targetType) return before;
    this.db.prepare("UPDATE topics SET space = ?, type = ?, updated_at = ? WHERE id = ?")
      .run(space, targetType, Date.now(), id);
    void actor; // 审计由服务层统一写（带 Vault 路径与文件搬移结果）
    return this.getTopic(id);
  }

  /** 保存版本快照并递增版本号。发布/审核通过时调用。 */
  snapshotTopic(id, note, { actor = "local" } = {}) {
    const topic = this.getTopic(id);
    if (!topic) throw new Error("主题不存在");
    const version = topic.version + 1;
    this.db.prepare(
      "INSERT INTO topic_versions (topic_id, version, snapshot, note, author, created_at) VALUES (?,?,?,?,?,?)"
    ).run(id, version, JSON.stringify({
      title: topic.title, summary: topic.summary, body: topic.body, tags: topic.tags,
      type: topic.type, classification: topic.classification, status: topic.status,
    }), note, actor, Date.now());
    this.db.prepare("UPDATE topics SET version = ?, updated_at = ? WHERE id = ?").run(version, Date.now(), id);
    return version;
  }

  /** 状态流转：统一入口，便于审计与非法流转拦截。 */
  setTopicStatus(id, status, { actor = "local", note = "" } = {}) {
    if (!TOPIC_STATUS.includes(status)) throw new Error(`未知状态: ${status}`);
    const before = this.getTopic(id);
    if (!before) throw new Error("主题不存在");
    this.db.prepare("UPDATE topics SET status = ?, updated_at = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END WHERE id = ?")
      .run(status, Date.now(), status, Date.now(), id);
    if (status === "published") this.snapshotTopic(id, note || "发布", { actor });
    this.audit(actor, "topic.status", id, TOPIC_STATUS_NAME[before.status], TOPIC_STATUS_NAME[status]);
    return this.getTopic(id);
  }

  rollbackTopic(id, version, { actor = "local" } = {}) {
    const snap = this.db.prepare("SELECT * FROM topic_versions WHERE topic_id = ? AND version = ?").get(id, version);
    if (!snap) throw new Error("版本不存在");
    const data = JSON.parse(snap.snapshot);
    this.updateTopic(id, { title: data.title, summary: data.summary, body: data.body, tags: data.tags, type: data.type, classification: data.classification }, { actor });
    this.snapshotTopic(id, `回滚到 v${version}`, { actor });
    this.audit(actor, "topic.rollback", id, `v${this.getTopic(id).version - 1}`, `v${version}`);
    return this.getTopic(id);
  }

  listTopics({ space, status, type, classification, limit = 100, offset = 0 } = {}) {
    const where = [];
    const vals = [];
    if (space) { where.push("space = ?"); vals.push(space); }
    if (status) { where.push("status = ?"); vals.push(status); }
    // 默认不列已废止：废止是软删（留审计），不该在空间列表里当成幽灵卡片占位置
    else { where.push("status != 'deleted'"); }
    if (type) { where.push("type = ?"); vals.push(type); }
    if (classification) { where.push("classification = ?"); vals.push(classification); }
    const sql = `SELECT * FROM topics ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const items = this.db.prepare(sql).all(...vals, limit, offset).map((r) => this.inflateTopic(r));
    // 灵感卡片要显示「已孵化 N」——一次批量查，不在渲染时逐条问库
    const spawned = this.countSpawned(items.filter((t) => t.space === "idea").map((t) => t.id));
    // 随手丢进来的截图/文件，卡片上要有角标，否则用户不知道这条带图
    const attachInfo = this.attachSummaries(items.map((t) => t.id));
    return items.map((t) => {
      const info = attachInfo.get(t.id);
      return {
        ...t,
        spawned_count: spawned.get(t.id) ?? 0,
        attachment_count: info?.count ?? 0,
        cover: info?.cover ?? null,
      };
    });
  }

  countTopics({ space } = {}) {
    return this.db.prepare("SELECT COUNT(*) n FROM topics WHERE status != 'deleted'").get().n;
  }

  // ---------------------------------------------------------------- 搜索
  /**
   * 双索引混合检索：
   * - 摘要层索引 topics_summary_fts（标题 + 摘要）：命中即「摘要命中」，权重最高；
   * - 全文索引 topics_fts（标题 + 摘要 + 正文）：提供正文召回；
   * - 来源片段索引 fragments_fts：命中后反向带出引用它的主题。
   * scope ∈ all（默认）| summary（只搜摘要层）| body（只搜正文）。
   * trigram 对 1~2 字词无效，短词回退 LIKE。
   */
  search(query, { space, status = "published", scope = "all", limit = 20 } = {}) {
    const q = String(query || "").trim();
    if (!q) return { topics: [], fragments: [] };
    const scored = new Map();
    const addTopic = (row, reason, score) => {
      const cur = scored.get(row.id);
      if (!cur) { scored.set(row.id, { topic: this.inflateTopic(row), reason, score }); return; }
      if (score > cur.score) { cur.reason = reason; cur.score = score; }
      else if (score === cur.score && cur.reason !== reason) cur.reason = `${cur.reason}/${reason}`;
    };
    // 命中位置加权：标题 > 摘要 > 正文；再叠加命中层权重（摘要层 3 / 全文层 1 / 片段层 .5）
    const weightOf = (row, layer) => {
      const title = String(row.title ?? "");
      const summary = String(row.summary ?? "");
      const body = String(row.body ?? "");
      let w = layer;
      if (title === q) w += 6;
      else if (title.includes(q)) w += 4;
      if (summary.includes(q)) w += 3;
      else if (body.includes(q)) w += 1;
      return w;
    };
    const escaped = q.replace(/"/g, '""'); // FTS5 短语用双引号包，内部双引号翻倍转义
    const fts = q.length >= 3 ? `"${escaped}"` : null;
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const spaceSql = space ? "AND t.space = ?" : "";
    const args = (head) => (space ? [...head, space, limit] : [...head, limit]);

    if (scope !== "body") {
      if (fts) {
        const rows = this.db.prepare(
          `SELECT t.*, snippet(topics_summary_fts, 1, '「', '」', '…', 16) AS _snip
           FROM topics_summary_fts f JOIN topics t ON t.rowid = f.rowid
           WHERE topics_summary_fts MATCH ? AND t.status != 'deleted' ${spaceSql}
           LIMIT ?`
        ).all(...args([fts]));
        rows.forEach((row) => addTopic(row, "摘要命中", weightOf(row, 3)));
      } else {
        const rows = this.db.prepare(
          `SELECT * FROM topics WHERE status != 'deleted' AND (title LIKE ? OR summary LIKE ?) ${spaceSql} LIMIT ?`
        ).all(...args([like, like]));
        rows.forEach((row) => addTopic(row, "摘要命中", weightOf(row, 2.5)));
      }
    }
    if (scope !== "summary") {
      if (fts) {
        const rows = this.db.prepare(
          `SELECT t.*, snippet(topics_fts, 1, '「', '」', '…', 12) AS _snip
           FROM topics_fts f JOIN topics t ON t.rowid = f.rowid
           WHERE topics_fts MATCH ? AND t.status != 'deleted' ${spaceSql}
           LIMIT ?`
        ).all(...args([fts]));
        rows.forEach((row) => addTopic(row, "正文命中", weightOf(row, 1)));
      } else {
        const rows = this.db.prepare(
          `SELECT * FROM topics WHERE status != 'deleted' AND (title LIKE ? OR summary LIKE ? OR body LIKE ?) ${spaceSql} LIMIT ?`
        ).all(...args([like, like, like]));
        rows.forEach((row) => addTopic(row, "正文命中", weightOf(row, 1)));
      }
    }

    // 来源片段命中 → 带出引用它的主题
    let fragments = [];
    if (scope !== "summary") {
      if (fts) {
        fragments = this.db.prepare(
          `SELECT fr.*, s.name AS source_name, s.path AS source_path, s.type AS source_type, s.classification AS source_classification,
                  snippet(fragments_fts, 0, '「', '」', '…', 14) AS _snip
           FROM fragments_fts f JOIN fragments fr ON fr.rowid = f.rowid JOIN sources s ON s.id = fr.source_id
           WHERE fragments_fts MATCH ? LIMIT ?`
        ).all(fts, limit);
      } else {
        fragments = this.db.prepare(
          `SELECT fr.*, s.name AS source_name, s.path AS source_path, s.type AS source_type, s.classification AS source_classification
           FROM fragments fr JOIN sources s ON s.id = fr.source_id
           WHERE fr.text LIKE ? LIMIT ?`
        ).all(like, limit);
        fragments.forEach((f) => { f._snip = f.text.slice(0, 80); });
      }
      // 片段所属主题（通过引用关系反向带出，未引用的作为独立证据展示）
      const fragTopic = this.db.prepare(
        "SELECT t.* FROM citations c JOIN topics t ON t.id = c.topic_id WHERE c.fragment_id = ? LIMIT 1"
      );
      for (const frag of fragments) {
        const t = fragTopic.get(frag.id);
        if (t) addTopic(t, "来源片段命中", weightOf(t, 0.5));
      }
    }

    let list = [...scored.values()];
    if (status && status !== "any") {
      list = list.filter((x) => x.topic.status === status || x.topic.status === "pending");
    }
    list.sort((a, b) => b.score - a.score || (b.topic.updated_at ?? 0) - (a.topic.updated_at ?? 0));
    return {
      topics: list.slice(0, limit).map((x) => ({ ...x.topic, _match: x.reason, _score: Math.round(x.score * 10) / 10 })),
      fragments,
    };
  }

  // ---------------------------------------------------------------- 来源与片段
  createSource(input) {
    const id = uid("src");
    this.db.prepare(
      `INSERT INTO sources (id, batch_id, name, path, managed, hash, type, ext, size, mtime, classification, parse_status, parse_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, input.batchId ?? "", input.name, input.path, input.managed ? 1 : 0, input.hash ?? "",
      input.type ?? "file", input.ext ?? "", input.size ?? 0, input.mtime ?? 0,
      input.classification ?? "internal", input.parseStatus ?? "pending", input.parseNote ?? "", Date.now(),
    );
    return id;
  }

  findSourceByHash(hash) {
    if (!hash) return null;
    return this.db.prepare("SELECT * FROM sources WHERE hash = ? LIMIT 1").get(hash) ?? null;
  }

  updateSource(id, patch) {
    const sets = [];
    const vals = [];
    for (const key of ["parse_status", "parse_note", "missing", "classification", "mtime", "size", "hash"]) {
      if (patch[key] === undefined) continue;
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  addFragments(sourceId, items) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO fragments (id, source_id, locator, text, lang, created_at) VALUES (?,?,?,?,?,?)"
    );
    const now = Date.now();
    const ids = [];
    for (const item of items) {
      const id = item.id ?? uid("frag");
      stmt.run(id, sourceId, item.locator ?? "", item.text ?? "", item.lang ?? "zh", now);
      ids.push(id);
    }
    return ids;
  }

  listFragments(sourceId) {
    return this.db.prepare("SELECT * FROM fragments WHERE source_id = ? ORDER BY rowid").all(sourceId);
  }

  listSources({ batchId, limit = 200 } = {}) {
    if (batchId) return this.db.prepare("SELECT * FROM sources WHERE batch_id = ? ORDER BY created_at DESC").all(batchId);
    return this.db.prepare("SELECT * FROM sources ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  // ---------------------------------------------------------------- 引用
  setCitations(topicId, fragmentIds, { locatorByFrag = {} } = {}) {
    this.db.prepare("DELETE FROM citations WHERE topic_id = ?").run(topicId);
    const stmt = this.db.prepare("INSERT INTO citations (id, topic_id, fragment_id, locator, note) VALUES (?,?,?,?,?)");
    for (const fid of fragmentIds) {
      stmt.run(uid("cite"), topicId, fid, locatorByFrag[fid] ?? "", "");
    }
  }

  listCitations(topicId) {
    return this.db.prepare(
      `SELECT c.*, f.locator AS frag_locator, f.text AS frag_text, s.name AS source_name, s.path AS source_path, s.id AS source_id, s.type AS source_type
       FROM citations c JOIN fragments f ON f.id = c.fragment_id JOIN sources s ON s.id = f.source_id
       WHERE c.topic_id = ? ORDER BY c.rowid`
    ).all(topicId);
  }

  // ---------------------------------------------------------------- 审核（单级）
  createReview(input) {
    const id = uid("rev");
    this.db.prepare(
      `INSERT INTO reviews (id, kind, topic_id, title, candidate, evidence, risk, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, input.kind ?? "candidate", input.topicId ?? "", input.title ?? "",
      typeof input.candidate === "string" ? input.candidate : JSON.stringify(input.candidate ?? {}),
      JSON.stringify(input.evidence ?? []), input.risk ?? "low", "pending",
      input.createdBy ?? "ai", Date.now(),
    );
    return id;
  }

  decideReview(id, status, comment, { actor = "local" } = {}) {
    if (!["approved", "approved_with_changes", "rejected", "returned"].includes(status)) {
      throw new Error("未知审核结论");
    }
    this.db.prepare("UPDATE reviews SET status = ?, comment = ?, decided_at = ? WHERE id = ?")
      .run(status, comment ?? "", Date.now(), id);
    this.audit(actor, "review.decide", id, "pending", status);
    return this.getReview(id);
  }

  getReview(id) {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    return row ? { ...row, evidence: JSON.parse(row.evidence || "[]") } : null;
  }

  listReviews({ status = "pending", kind, limit = 100 } = {}) {
    const rows = kind
      ? this.db.prepare("SELECT * FROM reviews WHERE status = ? AND kind = ? ORDER BY created_at DESC LIMIT ?").all(status, kind, limit)
      : this.db.prepare("SELECT * FROM reviews WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
    return rows.map((r) => ({ ...r, evidence: JSON.parse(r.evidence || "[]") }));
  }

  countPendingReviews() {
    return this.db.prepare("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'").get().n;
  }

  // ---------------------------------------------------------------- 导入批次
  createImport(name, total) {
    const id = uid("imp");
    this.db.prepare(
      "INSERT INTO imports (id, name, files_total, files_done, status, created_at, updated_at) VALUES (?,?,?,0,'running',?,?)"
    ).run(id, name, total, Date.now(), Date.now());
    return id;
  }

  tickImport(id, done, status, error = "") {
    this.db.prepare(
      "UPDATE imports SET files_done = ?, status = ?, error = ?, updated_at = ? WHERE id = ?"
    ).run(done, status, error, Date.now(), id);
  }

  listImports(limit = 50) {
    return this.db.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  // ---------------------------------------------------------------- 质量分（规格书 10.3 权重）
  computeQuality(topicId) {
    const topic = this.getTopic(topicId);
    if (!topic) return { score: 0, detail: {} };
    const citations = this.listCitations(topicId);
    // 来源权威性 30%：有受管来源给满，仅外部路径给 60%
    const managed = citations.filter((c) => c.source_id).length;
    const authority = managed ? 1 : citations.length ? 0.6 : 0;
    // 证据完整性 25%：引用数 ≥3 满，1~2 线性
    const evidence = Math.min(1, citations.length / 3);
    // 人工审核情况 20%：已发布且有版本记录视为通过
    const reviewed = topic.status === "published" && topic.version > 0 ? 1 : topic.status === "pending" ? 0.5 : 0;
    // 信息新鲜度 15%：90 天内线性衰减
    const days = (Date.now() - (topic.published_at ?? topic.updated_at)) / 86_400_000;
    const freshness = Math.max(0, 1 - days / 90);
    // 内容一致性 10%：正文与摘要非空且摘要 ≤ 正文，视为一致（本地启发，P1 交给语义检查）
    const consistent = topic.summary && topic.body && topic.body.includes(topic.summary.slice(0, 30)) ? 1 : topic.summary ? 0.6 : 0;
    const detail = {
      来源权威性: Math.round(authority * 30),
      证据完整性: Math.round(evidence * 25),
      人工审核情况: Math.round(reviewed * 20),
      信息新鲜度: Math.round(freshness * 15),
      内容一致性: Math.round(consistent * 10),
    };
    const score = Object.values(detail).reduce((a, b) => a + b, 0);
    this.db.prepare("UPDATE topics SET quality = ?, quality_detail = ? WHERE id = ?").run(score, JSON.stringify(detail), topicId);
    return { score, detail };
  }

  // ---------------------------------------------------------------- 审计（只追加）
  audit(user, action, target, before = "", after = "", detail = "", result = "ok") {
    this.db.prepare(
      "INSERT INTO audit (ts, user, action, target, before, after, detail, result) VALUES (?,?,?,?,?,?,?,?)"
    ).run(Date.now(), user, action, String(target), String(before).slice(0, 2000), String(after).slice(0, 2000), String(detail).slice(0, 2000), result);
  }

  listAudit({ limit = 100, action } = {}) {
    if (action) return this.db.prepare("SELECT * FROM audit WHERE action = ? ORDER BY id DESC LIMIT ?").all(action, limit);
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ---------------------------------------------------------------- 受控词表（标签治理，规格书 10）
  /** 高频标签统计：受控词表的底账，重命名/合并以此为准。 */
  vocabStats() {
    const rows = this.db.prepare("SELECT tags FROM topics WHERE status != 'deleted'").all();
    const counts = new Map();
    for (const row of rows) {
      for (const tag of JSON.parse(row.tags || "[]")) {
        const key = String(tag).trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([name, uses]) => ({ name, uses })).sort((a, b) => b.uses - a.uses);
  }

  /** 把一个标签改名为另一个（即合并）：所有主题的标签数组同步替换去重。tags 不进 FTS，直接走 SQL。 */
  renameTag(from, to, { actor = "local" } = {}) {
    const source = String(from).trim();
    const target = String(to).trim();
    if (!source || !target) throw new Error("新旧标签名都不能为空");
    if (source === target) throw new Error("新旧标签相同，无需改名");
    const rows = this.db.prepare("SELECT id, tags FROM topics WHERE tags LIKE ?").all(`%"${source.replace(/"/g, "")}"%`);
    let changed = 0;
    const update = this.db.prepare("UPDATE topics SET tags = ? WHERE id = ?");
    for (const row of rows) {
      const tags = JSON.parse(row.tags || "[]");
      if (!tags.includes(source)) continue;
      update.run(JSON.stringify([...new Set(tags.map((t) => (t === source ? target : t)))]), row.id);
      changed++;
    }
    // 词表里登记一条规范名记录（aliases 记历史名），供后续治理参考
    const existing = this.db.prepare("SELECT * FROM vocab WHERE type = 'tag' AND name = ?").get(target);
    if (existing) {
      const aliases = new Set(JSON.parse(existing.aliases || "[]"));
      aliases.add(source);
      this.db.prepare("UPDATE vocab SET aliases = ? WHERE id = ?").run(JSON.stringify([...aliases]), existing.id);
    } else {
      this.db.prepare("INSERT INTO vocab (id, type, name, aliases) VALUES (?,?,?,?)")
        .run(uid("vocab"), "tag", target, JSON.stringify([source]));
    }
    this.audit(actor, "vocab.rename", "vocab", source, `${target}（${changed} 个主题）`);
    return { changed, from: source, to: target };
  }

  // ---------------------------------------------------------------- 主题关系（灵感流向）
  /**
   * 显式关系。目前只启用一种有向关系：spawned（灵感 → 派生主题）。
   * 与图谱里「共享标签 / 共享来源」的自动边不同，这是人手确认过的流向，
   * 所以落库保存、不随标签变化消失。同一对 from/to/type 只留一条（重复流转幂等）。
   */
  addRelation({ fromId, toId, type = "spawned", origin = "manual", confidence = 1, status = "confirmed" }, { actor = "local" } = {}) {
    if (!fromId || !toId) throw new Error("关系两端不能为空");
    if (fromId === toId) throw new Error("不能把主题关联到自己");
    const existing = this.db.prepare("SELECT * FROM relations WHERE from_id = ? AND to_id = ? AND type = ?").get(fromId, toId, type);
    if (existing) return existing;
    const id = uid("rel");
    this.db.prepare(
      "INSERT INTO relations (id, from_id, to_id, type, origin, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(id, fromId, toId, type, origin, confidence, status, Date.now());
    this.audit(actor, "relation.create", id, "", `${fromId} → ${toId}（${type}）`);
    return this.db.prepare("SELECT * FROM relations WHERE id = ?").get(id);
  }

  /** 查关系，可按主题（任一端）与类型过滤；带出对端标题，直接用于展示与回写 Vault 链接。 */
  listRelations({ topicId, type, status = "confirmed" } = {}) {
    const where = [];
    const vals = [];
    if (type) { where.push("r.type = ?"); vals.push(type); }
    if (status) { where.push("r.status = ?"); vals.push(status); }
    if (topicId) { where.push("(r.from_id = ? OR r.to_id = ?)"); vals.push(topicId, topicId); }
    return this.db.prepare(`
      SELECT r.*,
             f.title AS from_title, f.space AS from_space, f.type AS from_type, f.status AS from_status,
             t.title AS to_title,   t.space AS to_space,   t.type AS to_type,   t.status AS to_status
      FROM relations r
      JOIN topics f ON f.id = r.from_id
      JOIN topics t ON t.id = r.to_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.created_at ASC
    `).all(...vals);
  }

  /** 列表页角标用：一次查出这批主题各自的流出数，避免逐条查关系。 */
  countSpawned(ids) {
    if (!ids?.length) return new Map();
    const rows = this.db.prepare(
      `SELECT from_id, COUNT(*) n FROM relations
       WHERE type = 'spawned' AND status = 'confirmed' AND from_id IN (${ids.map(() => "?").join(",")})
       GROUP BY from_id`
    ).all(...ids);
    return new Map(rows.map((r) => [r.from_id, r.n]));
  }

  // ---------------------------------------------------------------- 灵感附件（截图 / 文件）
  /**
   * 附件先落盘再登记，topic_id 允许为空：用户贴了图还没点「收下」时，
   * 附件已经是收纳区的孤儿，提交时再 bind。孤儿在下次启动时清理。
   */
  createAttachment({ topicId = "", name, path, kind = "file", ext = "", size = 0, hash = "" }) {
    const row = {
      id: uid("att"), topic_id: topicId, name, path, kind, ext, size, hash, created_at: Date.now(),
    };
    const cols = Object.keys(row);
    this.db.prepare(
      `INSERT INTO topic_attachments (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => row[c]));
    return row;
  }

  getAttachment(id) {
    return this.db.prepare("SELECT * FROM topic_attachments WHERE id = ?").get(id) ?? null;
  }

  listAttachments(topicId) {
    if (!topicId) return [];
    return this.db.prepare(
      "SELECT * FROM topic_attachments WHERE topic_id = ? ORDER BY created_at ASC"
    ).all(topicId);
  }

  countAttachments(ids) {
    if (!ids?.length) return new Map();
    const rows = this.db.prepare(
      `SELECT topic_id, COUNT(*) n FROM topic_attachments
       WHERE topic_id IN (${ids.map(() => "?").join(",")}) GROUP BY topic_id`
    ).all(...ids);
    return new Map(rows.map((r) => [r.topic_id, r.n]));
  }

  /** 列表用：每个主题的附件数 + 第一张图（做卡片封面），一次查完。 */
  attachSummaries(ids) {
    if (!ids?.length) return new Map();
    const rows = this.db.prepare(
      `SELECT id, topic_id, name, kind FROM topic_attachments
       WHERE topic_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`
    ).all(...ids);
    const map = new Map();
    for (const row of rows) {
      const cur = map.get(row.topic_id) ?? { count: 0, cover: null };
      cur.count += 1;
      if (!cur.cover && row.kind === "image") cur.cover = { id: row.id, name: row.name };
      map.set(row.topic_id, cur);
    }
    return map;
  }

  /** 收下时把散落的附件挂到新主题上。 */
  bindAttachments(topicId, ids) {
    if (!topicId || !ids?.length) return 0;
    const info = this.db.prepare(
      `UPDATE topic_attachments SET topic_id = ? WHERE id IN (${ids.map(() => "?").join(",")})`
    ).run(topicId, ...ids);
    return Number(info.changes ?? 0);
  }

  /** 未挂主题的附件（用户贴了图但没提交），供启动清理用。 */
  listOrphanAttachments(before = Date.now()) {
    return this.db.prepare(
      "SELECT * FROM topic_attachments WHERE topic_id = '' AND created_at < ?"
    ).all(before);
  }

  deleteAttachment(id) {
    this.db.prepare("DELETE FROM topic_attachments WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- 知识图谱（规格书 11.2）
  /**
   * 主题关联图：边来自「共享标签」（权重=共同标签数，封顶3）与「共享来源」（权重3）。
   * 不落库、每次现算（量级 ≤ 数百主题，毫秒级），relations 表留给 AI 生成的候选关系（P2）。
   */
  buildGraph({ limit = 150 } = {}) {
    const topics = this.db.prepare(
      "SELECT id, title, space, type, status, tags, quality, updated_at FROM topics WHERE status != 'deleted' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit).map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
    const ids = new Set(topics.map((t) => t.id));
    const map = new Map();
    // directed=true 时保留方向（灵感 → 派生主题），前端据此画箭头
    const addEdge = (a, b, type, weight, directed = false) => {
      if (a === b || !ids.has(a) || !ids.has(b)) return;
      const key = directed ? `${a}>${b}` : [a, b].sort().join("|");
      const edge = map.get(key);
      if (edge) {
        edge.weight += weight;
        if (!edge.types.includes(type)) edge.types.push(type);
      } else map.set(key, {
        a: directed ? a : key.split("|")[0],
        b: directed ? b : key.split("|")[1],
        types: [type], weight, directed,
      });
    };
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        const shared = topics[i].tags.filter((t) => topics[j].tags.includes(t));
        if (shared.length) addEdge(topics[i].id, topics[j].id, "shared-tag", Math.min(shared.length, 3));
      }
    }
    if (topics.length) {
      const rows = this.db.prepare(
        `SELECT c.topic_id, fr.source_id FROM citations c
         JOIN fragments fr ON fr.id = c.fragment_id
         WHERE c.topic_id IN (${topics.map(() => "?").join(",")})`
      ).all(...topics.map((t) => t.id));
      const bySource = new Map();
      for (const row of rows) {
        const list = bySource.get(row.source_id) ?? [];
        list.push(row.topic_id);
        bySource.set(row.source_id, list);
      }
      for (const list of bySource.values()) {
        const uniq = [...new Set(list)];
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) addEdge(uniq[i], uniq[j], "shared-source", 3);
        }
      }
    }
    // 显式流向（灵感 → 派生主题）：人手确认的有向关系，权重最高，前端画箭头
    const spawned = this.db.prepare(
      "SELECT from_id, to_id FROM relations WHERE type = 'spawned' AND status = 'confirmed'"
    ).all();
    for (const rel of spawned) addEdge(rel.from_id, rel.to_id, "spawned", 5, true);
    return {
      nodes: topics,
      edges: [...map.values()].sort((x, y) => y.weight - x.weight).slice(0, 500),
    };
  }

  // ---------------------------------------------------------------- 设置
  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").run(key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------- 统计
  stats() {
    const one = (sql) => this.db.prepare(sql).get().n;
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      topics: one("SELECT COUNT(*) n FROM topics WHERE status != 'deleted'"),
      sources: one("SELECT COUNT(*) n FROM sources"),
      fragments: one("SELECT COUNT(*) n FROM fragments"),
      pendingReviews: this.countPendingReviews(),
      failedImports: one("SELECT COUNT(*) n FROM imports WHERE status = 'failed'"),
      weekNew: one(`SELECT COUNT(*) n FROM topics WHERE created_at > ${weekAgo}`),
      published: one("SELECT COUNT(*) n FROM topics WHERE status = 'published'"),
      avgQuality: Math.round(one("SELECT COALESCE(AVG(quality),0) n FROM topics WHERE status = 'published'")),
    };
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

/** 确保 Vault 约定的知识层目录与来源/候选目录存在；不创建任何 Schema 之外的目录。 */
export function ensureDirs(vaultDir) {
  const dirs = [
    vaultDir,
    ...Object.values(SPACES).map((s) => join(vaultDir, s.dir)),
    join(vaultDir, "03-资料索引"),
    join(vaultDir, "80-AI候选更新"),
  ];
  for (const dir of dirs) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export { dirname };
