/**
 * 产品中枢知识库 · Obsidian Vault 读写与外部修改监测。
 *
 * Vault 里已经有一套 LLMWiki Schema（AGENTS.md + 99-模板），本模块严格对齐它，不另造格式：
 * - 三层结构：原始层 02-待导入 / 知识层 10-调研Wiki·20-企划Wiki·30-产品模型·40-灵感模型 /
 *   规范层 00-系统与规范 + 99-模板；候选只写 80-AI候选更新；来源卡片写 03-资料索引。
 * - 页面 frontmatter 字段：id / type / status / domain / source_refs / evidence_level /
 *   confidence / sensitivity / created / updated / review_due（工作台另存 space 便于导航）。
 * - 工作台内部状态（draft/pending/revise/published/archived）与 Schema 状态
 *   （draft/review/approved/superseded/archived）双向映射，读写都不丢语义。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** 知识层根目录（工作台只扫描这四棵树 + 候选区）。 */
export const SPACE_ROOTS = {
  research: "10-调研Wiki",
  planning: "20-企划Wiki",
  product: "30-产品模型",
  idea: "40-灵感模型",
};

/** 主题类型 → 正式目录（与 AGENTS.md 页面类型表一一对应）。 */
export const TYPE_DIR = {
  综合调研: "10-调研Wiki/00-综合调研",
  行业趋势: "10-调研Wiki/01-行业趋势",
  厂商竞品: "10-调研Wiki/02-厂商竞品",
  技术方案: "10-调研Wiki/03-技术方案",
  政策标准: "10-调研Wiki/04-政策标准",
  客户需求: "10-调研Wiki/05-客户需求",
  招投标: "10-调研Wiki/06-招投标",
  企划项目: "20-企划Wiki/01-企划项目",
  产品线全景: "20-企划Wiki/01-企划项目",
  竞争力十二维度: "20-企划Wiki/02-竞争力12维度",
  企划索引: "20-企划Wiki/02-竞争力12维度",
  竞品跑分: "20-企划Wiki/03-竞品跑分",
  方法论: "20-企划Wiki/03-竞品跑分",
  市场政策: "20-企划Wiki/04-市场政策",
  营销研发计划: "20-企划Wiki/05-营销研发计划",
  产品档案: "30-产品模型/01-产品档案",
  功能库: "30-产品模型/02-功能库",
  需求池: "30-产品模型/03-需求池",
  客户反馈: "30-产品模型/04-客户反馈/02-结构化结论",
  竞品反馈: "30-产品模型/05-竞品反馈/02-结构化结论",
  对比矩阵: "30-产品模型/06-对比矩阵",
  机会建议: "30-产品模型/07-机会与建议",
  灵感收集: "40-灵感模型",
};

/** 类型 → Schema 的 page type（AGENTS.md 的 type 枚举）。 */
export const TYPE_NAME = {
  综合调研: "research_topic",
  行业趋势: "industry",
  厂商竞品: "organization",
  技术方案: "technology",
  政策标准: "standard",
  客户需求: "customer_need",
  招投标: "tender",
  企划项目: "planning_project",
  产品线全景: "product_line",
  竞争力十二维度: "planning_dimension",
  企划索引: "planning_index",
  竞品跑分: "planning_benchmark",
  方法论: "method",
  市场政策: "planning_policy",
  营销研发计划: "planning_plan",
  产品档案: "product",
  功能库: "function_domain",
  需求池: "requirement",
  客户反馈: "customer_feedback_insight",
  竞品反馈: "competitor_feedback_insight",
  对比矩阵: "product_comparison",
  机会建议: "product_opportunity",
  灵感收集: "idea",
};

/** 工作台状态 → Schema 状态。 */
const TO_VAULT_STATUS = { draft: "draft", pending: "review", revise: "draft", published: "approved", archived: "archived", deleted: "superseded" };
/** Schema 状态 → 工作台状态。 */
const FROM_VAULT_STATUS = { draft: "draft", review: "pending", approved: "published", superseded: "archived", archived: "archived" };

/** 密级：工作台 public/internal/secret ↔ Schema public/internal/confidential。 */
const TO_VAULT_SENSITIVITY = { public: "public", internal: "internal", secret: "confidential" };
const FROM_VAULT_SENSITIVITY = { public: "public", internal: "internal", confidential: "secret" };

export function topicFileName(topic) {
  const safe = String(topic.title ?? "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "未命名";
  return `${safe} [${topic.id}].md`;
}

/**
 * 主题落盘目录：**已有页面原地更新**，新页面才按类型目录。
 *
 * 目录优先是刚需：Vault 里除了「类型目录」还有人按主题分册的目录（如
 * `10-调研Wiki/02-主题汇编`、`20-企划Wiki/04-主题汇编`），这些页面的 frontmatter
 * type 与普通主题相同（research_topic / planning_project）。如果只按 type 决定目录，
 * 用户在工作台里编辑一篇汇编页并发布，文件就会被写到 `00-综合调研`，原页留在汇编目录
 * 变成同 id 两份。所以只要页面已经在某个知识层根目录下，就沿用它所在目录。
 *
 * 页面被挪到另一个知识层（空间迁移）时，旧路径不在新空间根下，仍然走类型目录。
 */
export function topicDir(vaultDir, topic) {
  const spaceRoot = SPACE_ROOTS[topic.space];
  const current = String(topic.vault_path ?? "").replace(/\\/g, "/");
  if (current && spaceRoot && current.startsWith(spaceRoot + "/")) {
    const relDir = current.slice(0, current.lastIndexOf("/"));
    // 只在「认识的目录」里原地更新；临时目录（比如手工剪贴到的 00-临时）仍然规范化
    if (KNOWN_DIRS.has(relDir)) return join(vaultDir, relDir);
  }
  const typeDir = TYPE_DIR[topic.type];
  const spaceOfType = typeDir ? spaceOfPath(typeDir) : null;
  const rel = (typeDir && (!topic.space || spaceOfType === topic.space))
    ? typeDir
    : (spaceRoot ?? typeDir ?? SPACE_ROOTS.research);
  return join(vaultDir, rel);
}

/** Vault 里出现了工作台没有登记的类型/类型与目录打架时的兜底类型。 */
export const UNKNOWN_TYPE = "未分类";

/**
 * 按主题分册、但共用同一套 frontmatter type 的目录（主题汇编就是这种）。
 * 这些目录里的页面不允许被「规范化」搬走，否则一次发布就会把汇编页打散到类型目录。
 */
const EXTRA_DIRS = [
  "10-调研Wiki/02-主题汇编",
  "20-企划Wiki/04-主题汇编",
];

/** 认识的落盘目录 = 类型目录 ∪ 分册目录 ∪ 空间根。不在名单里的目录视为临时目录，会被收进类型目录。 */
export const KNOWN_DIRS = new Set([
  ...Object.values(TYPE_DIR),
  ...EXTRA_DIRS,
  ...Object.values(SPACE_ROOTS),
]);

/** 主题在 Vault 里的相对目录（`10-调研Wiki/02-主题汇编`），用作「目录」分组维度。 */
export function topicFolder(vaultPath) {
  const p = String(vaultPath ?? "").replace(/\\/g, "/");
  if (!p.includes("/")) return "";
  return p.slice(0, p.lastIndexOf("/"));
}


/** 从 Vault 相对路径反推所属空间，用于扫描回灌。 */
export function spaceOfPath(relPath) {
  const p = relPath.replace(/\\/g, "/");
  for (const [space, root] of Object.entries(SPACE_ROOTS)) {
    if (p.startsWith(root + "/")) return space;
  }
  return null;
}

const isoDate = (ts) => new Date(ts ?? Date.now()).toISOString().slice(0, 10);

/**
 * 生成符合 Schema 的 Markdown。source_refs 用可读的「来源名 · 定位」列表（工作台详情里
 * 同时保留 DB 里的精确片段），正文原样保留 Markdown。
 * links 是主题间的流向链接（灵感 ↔ 派生主题），同样写进 source_refs —— Schema 里它就是
 * 「内部链接列表」，Obsidian 里点得动，图谱也不会因为只在 DB 里记录而在 Vault 中丢线索。
 */
export function buildMarkdown(topic, citations = [], links = []) {
  const tags = Array.isArray(topic.tags) ? topic.tags : JSON.parse(topic.tags || "[]");
  const refs = [
    ...citations.map((c) => `- [[${String(c.source_name ?? "").replace(/\.\w+$/, "")}]] ${c.frag_locator || ""}`.trim()),
    ...links.filter((l) => l?.title).map((l) => `- [[${l.title}]] ${l.note ?? ""}`.trim()),
  ];
  const fm = [
    "---",
    `id: ${topic.id}`,
    `type: ${TYPE_NAME[topic.type] ?? "research_topic"}`,
    `status: ${TO_VAULT_STATUS[topic.status] ?? "draft"}`,
    "domain: 声光电视讯",
    `space: ${topic.space}`,
    `title: ${topic.title}`,
    `tags: [${tags.join(", ")}]`,
    `source_refs:${refs.length ? "" : " []"}`,
    ...(refs.length ? refs.map((r) => `  ${r}`) : []),
    `evidence_level: ${citations.length >= 3 ? "A" : citations.length ? "B" : "C"}`,
    `confidence: ${citations.length >= 3 ? 85 : citations.length ? 65 : 40}`,
    `sensitivity: ${TO_VAULT_SENSITIVITY[topic.classification] ?? "internal"}`,
    `created: ${isoDate(topic.created_at)}`,
    `updated: ${isoDate(topic.updated_at)}`,
    "review_due:",
    `version: ${topic.version}`,
    "---",
    "",
    `# ${topic.title}`,
    "",
    topic.summary ? `> 摘要：${topic.summary}` : "",
    "",
    topic.body || "",
  ].filter((line) => line !== null).join("\n");
  const evidence = citations.length
    ? `\n\n## 证据与来源\n\n${citations.map((c) => `- **${c.source_name}** · ${c.frag_locator || "未定位"}：${(c.frag_text || "").slice(0, 160)}`).join("\n")}`
    : "";
  return fm + evidence + "\n";
}

/** 解析 Vault .md：支持 Schema 字段，并兼容早期字段名。非本系统页面（无 id）返回 null。 */
export function parseMarkdown(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const fm = {};
  let lastKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) { fm[kv[1]] = kv[2].trim(); lastKey = kv[1]; continue; }
    if (lastKey && /^\s+-\s*/.test(line)) fm[lastKey] = `${fm[lastKey]} ${line.trim()}`.trim(); // source_refs 列表项
  }
  if (!fm.id) return null;
  const rest = match[2];
  const title = /^# (.*)$/m.exec(rest)?.[1] ?? fm.title ?? "未命名";
  const summaryMatch = /^> 摘要：(.*)$/m.exec(rest);
  const body = rest
    .replace(/^#\s+.*$/m, "")
    .replace(/^> 摘要：.*$/m, "")
    .replace(/\n## (证据与来源|来源证据)[\s\S]*$/, "")
    .trim();
  return {
    id: fm.id,
    // 目录路径优先用于判定空间，其次用扩展字段 space
    space: fm.space ?? null,
    vaultType: fm.type ?? "",
    type: fm.type ?? "",
    status: FROM_VAULT_STATUS[fm.status] ?? "draft",
    vaultStatus: fm.status ?? "draft",
    classification: FROM_VAULT_SENSITIVITY[fm.sensitivity] ?? "internal",
    version: Number(fm.version) || 0,
    evidenceLevel: fm.evidence_level ?? "",
    confidence: Number(fm.confidence) || 0,
    title,
    summary: summaryMatch?.[1] ?? "",
    body,
    vault_updated: fm.updated,
  };
}

/** 递归收集目录下的 .md（知识层四棵树 + 候选区）。 */
function walkMarkdown(dir, out, limit = 5000) {
  if (!existsSync(dir) || out.length >= limit) return;
  for (const name of readdirSync(dir)) {
    if (out.length >= limit) return;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) { walkMarkdown(path, out); continue; }
    if (name.endsWith(".md")) out.push(path);
  }
}

export function listVaultTopics(vaultDir) {
  const out = [];
  const files = [];
  for (const root of [...Object.values(SPACE_ROOTS), "80-AI候选更新"]) {
    walkMarkdown(join(vaultDir, root), files);
  }
  for (const path of files) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseMarkdown(raw);
      if (!parsed) continue;
      const relPath = relative(vaultDir, path).replace(/\\/g, "/");
      const space = spaceOfPath(relPath) ?? parsed.space;
      if (!space) continue; // 不属于四个知识层（模板、README、规范文件）
      out.push({ path, name: path.split(/[\\/]/).pop(), relPath, ...parsed, space });
    } catch { /* 单文件读取失败不阻塞扫描 */ }
  }
  return out;
}

/** 从任务类型反查工作台空间（扫描到只有 type 的页面时用）。 */
export function typeToSpace(vaultType) {
  const entry = Object.entries(TYPE_NAME).find(([, name]) => name === vaultType);
  if (!entry) return "research";
  const dir = TYPE_DIR[entry[0]] ?? "";
  return Object.entries(SPACE_ROOTS).find(([, root]) => dir.startsWith(root))?.[0] ?? "research";
}

export function writeTopicToVault(vaultDir, topic, citations, links = []) {
  const dir = topicDir(vaultDir, topic);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, topicFileName(topic));
  writeFileSync(path, buildMarkdown(topic, citations, links), "utf8");
  return path;
}

/** 写入来源卡片到 03-资料索引（AGENTS.md 编译规则 1：新资料先建 source 卡片）。 */
export function writeSourceCard(vaultDir, source, extra = {}) {
  const dir = join(vaultDir, "03-资料索引");
  if (!existsSync(dir)) return "";
  const safe = String(source.name ?? "来源").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const path = join(dir, `${safe} [${source.id}].md`);
  const fm = [
    "---",
    `id: ${source.id}`,
    "type: source",
    `status: ${source.parse_status === "full" ? "approved" : "draft"}`,
    "domain: 声光电视讯",
    `source_kind: ${source.ext ? source.ext.replace(/^\./, "") : "text"}`,
    `original_path: ${source.path ?? ""}`,
    `file_hash: ${source.hash ?? ""}`,
    `file_size: ${source.size ?? 0}`,
    `file_modified: ${isoDate(source.mtime)}`,
    `parse_status: ${source.parse_status ?? "pending"}`,
    `evidence_level: ${source.parse_status === "full" ? "B" : "C"}`,
    "confidence: 60",
    `sensitivity: ${TO_VAULT_SENSITIVITY[source.classification] ?? "internal"}`,
    "source_refs: []",
    `created: ${isoDate(source.created_at)}`,
    `updated: ${isoDate(Date.now())}`,
    "review_due:",
    "---",
    "",
    `# ${source.name}`,
    "",
    "## 来源说明",
    "",
    `- 原始路径：${source.path ?? "(工作台上传)"}`,
    `- 文件类型：${source.ext || "文本"}`,
    `- 大小：${source.size ?? 0} 字节`,
    "",
    "## 本地解析摘要",
    "",
    extra.summary || "(待补充)",
    "",
    "## 关键事实",
    "",
    extra.facts || "(待人工补充)",
    "",
    "## 可引用证据",
    "",
    (extra.fragments ?? []).slice(0, 6).map((f) => `- ${f.locator || "段落"}：${String(f.text ?? "").slice(0, 120)}`).join("\n") || "(暂无)",
  ].join("\n");
  writeFileSync(path, fm + "\n", "utf8");
  return path;
}

/**
 * 扫描 Vault 外部修改。返回变动的页面，由上层决定回灌与冲突提示。
 * 进程重启后首轮把所有文件登记为已知（不做误报），之后的差异才是外部修改。
 */
export class VaultWatcher {
  constructor(vaultDir) {
    this.vaultDir = vaultDir;
    this.hashes = new Map();
    this.primed = false;
  }

  scan() {
    const changed = [];
    for (const vt of listVaultTopics(this.vaultDir)) {
      let hash = "";
      try { hash = sha256(readFileSync(vt.path)); } catch { continue; }
      const prev = this.hashes.get(vt.id);
      if (this.primed && prev && prev !== hash) changed.push(vt);
      this.hashes.set(vt.id, hash);
    }
    this.primed = true;
    return changed;
  }

  /** 工作台发布后登记自写 hash，避免下一轮把自己的写入误判为外部修改。 */
  markWritten(topicId, path) {
    try { this.hashes.set(topicId, sha256(readFileSync(path))); } catch { /* 忽略 */ }
  }

  relative(path) {
    return relative(this.vaultDir, path).replace(/\\/g, "/");
  }
}
