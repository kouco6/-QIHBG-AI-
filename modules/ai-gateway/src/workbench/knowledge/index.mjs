/**
 * 产品中枢知识库 · 服务组装。
 *
 * 把数据层、Vault、解析器、备份串成一个 KnowledgeService：
 * - importFiles：导入管线（登记来源 → 本地解析 → 切片入索引 → 去重建议 → 生成候选主题）；
 * - publishTopic / archiveTopic 等流转后回写 Vault，并由 VaultWatcher 排除自写误报；
 * - startTimers：每日增量备份 + 每周健康检查 + Vault 外部修改扫描（60s 一轮）；
 * - backup：写入 H:\产品中枢备份（可在配置改），盘不可用时状态标 "unavailable"，
 *   绝不悄悄换个地方写——规格书 13.2 要求设置页持续提示。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { KnowledgeStore, SPACES, TOPIC_TYPES, ensureDirs, uid, sha256 } from "./store.mjs";
import {
  VaultWatcher, writeTopicToVault, writeSourceCard, listVaultTopics, typeToSpace, parseMarkdown,
  TYPE_NAME, SPACE_ROOTS, UNKNOWN_TYPE, topicFolder,
} from "./vault.mjs";
import { parseFile, dedupeSuggestion } from "./parse.mjs";
import { extractSummary, looksTruncated } from "./summarize.mjs";
import { zipStore } from "./zipwrite.mjs";
import { detectOcr, ocrImage, ocrStatus } from "./ocr.mjs";

const DEFAULTS = {
  vaultDir: "E:\\Obsidian\\产品中枢",
  backupDir: "H:\\产品中枢备份",
};
export { DEFAULTS };

/**
 * 问句里的疑问词/口头语。这些词在标题正文里几乎不会原样出现，留着当检索词只会稀释排序，
 * 甚至把整句变成命不中的短语——「凯越有多少人」整串查就是这样零命中的。
 */
const QUESTION_FILLERS = [
  "请问", "帮我", "麻烦", "想知道", "告诉我", "请教", "一下", "能不能", "可不可以",
  "有没有", "是不是", "是什么", "有什么", "有多少", "是多少", "怎么样", "怎么办",
  "为什么", "怎么", "如何", "哪些", "哪个", "多少", "几个", "几家", "多大", "多久",
  "我们", "你们", "他们", "可以", "以及", "还有", "关于",
];

/** 问事实时真正想拿到的度量词：只参与段落打分，不参与全文检索（太常见，会拉回一堆无关页）。 */
const INTENT_WORDS = [
  "人数", "员工", "编制", "团队", "规模", "营收", "收入", "利润", "毛利", "成本", "价格", "报价",
  "成立", "时间", "地址", "客户", "份额", "增速", "注册", "资本", "工厂", "子公司", "事业部",
  "渠道", "风险", "对标", "机会", "需求", "预算", "周期", "产能", "销量",
];

/** 单独成词没有检索价值的中文双字组合。 */
const GRAM_STOP = new Set([
  "多少", "少人", "什么", "怎么", "如何", "哪些", "哪个", "是不", "不是", "有没",
  "没有", "可以", "我们", "你们", "他们", "这个", "那个", "现在", "目前",
]);

/**
 * 问句意图 → 该去正文里找哪些度量词。
 * 「凯越有多少人」字面上只有「人」一个字，落到正文里几乎不成词；必须扩成「人数 / 员工 / 规模」
 * 才能把「员工规模 | 4000 人」这类表格行捞到前面来。
 */
const INTENT_RULES = [
  { when: /多少[人名]|人数|员工数|几个人|团队规模|规模多大/, words: ["人数", "员工", "规模", "团队", "编制", "用工"] },
  { when: /多少钱|价格|报价|单价|成本|贵不贵/, words: ["价格", "报价", "成本", "单价", "费用"] },
  { when: /多少[家个]|几家|几个|数量/, words: ["数量", "家", "个数", "合计"] },
  { when: /营收|收入|营业额|销售额|产值|出口额/, words: ["营收", "收入", "销售额", "出口额", "产值"] },
  { when: /利润|毛利|净利|赚多少/, words: ["利润", "毛利", "净利"] },
  { when: /什么时候|何时|成立|几年|多久|时间/, words: ["成立", "时间", "年"] },
  { when: /地址|在哪|地点|总部/, words: ["地址", "位于", "总部"] },
  { when: /客户|卖给谁|客群/, words: ["客户", "客群"] },
  { when: /份额|占有率|市占/, words: ["份额", "占有率", "市占"] },
  { when: /竞品|对比|对标|差异/, words: ["竞品", "对标", "对比", "差异"] },
];

/**
 * 派生主题的初始正文：保留灵感原文 + 一张验证清单，避免新页面从空白开始，
 * 也避免「流转」变成一句空话——起草的人一眼看到下一步该补什么证据。
 */
function spawnBody(idea, space) {
  const date = new Date().toISOString().slice(0, 10);
  const checks = space === "planning"
    ? ["目标客户与使用场景是否成立", "竞品是否已有同类能力", "成本、交付与资质边界", "立项还缺哪些证据"]
    : ["已有哪些一手证据（客户 / 现场 / 数据）", "结论是否可被证伪", "与现有产品·方案的差异点", "还需要补做的调研动作"];
  return [
    `> 由灵感「${idea.title}」于 ${date} 流转而来，原件保留在灵感空间。以下为灵感原文，验证后改写为正式结论。`,
    "",
    idea.body || idea.summary || "（灵感原件没有正文）",
    "",
    "## 待验证",
    "",
    ...checks.map((c) => `- [ ] ${c}`),
  ].join("\n");
}

export class KnowledgeService {
  constructor({ stateDir, config = {}, askModel = null } = {}) {
    this.vaultDir = config.vaultDir ?? DEFAULTS.vaultDir;
    this.backupDir = config.backupDir ?? DEFAULTS.backupDir;
    this.store = new KnowledgeStore(stateDir);
    this.watcher = new VaultWatcher(this.vaultDir);
    this.timers = [];
    this.bootSummary = null;
    // 首期单用户：默认同时是管理员/编辑/审核员，权限模型在数据里预留（角色字段进审计）
    this.role = config.role ?? "admin";
    // AI 问答的模型通道：server 层注入 (prompt) => Promise<string>；kind 标注 cloud/local，
    // 「机密」来源只在 local 通道里进入提示词（规格书 8.3 云端边界）。
    this.askModel = askModel;
    this.modelKind = config.modelKind ?? "cloud";
    // OCR 引擎进程级探测一次，导入时注入解析器
    this.ocrEngine = detectOcr();
    ensureDirs(this.vaultDir);
  }

  // ---------------------------------------------------------------- 生命周期

  boot() {
    const summary = this.syncVaultIntoDb();
    this.bootSummary = summary;
    // 用户贴了图又没点「收下」：超过一天的孤儿附件连文件带记录清掉，免得 _附件 越堆越多
    try { this.cleanupOrphanAttachments(); } catch { /* 清理失败不阻塞启动 */ }
    this.startTimers();
    return summary;
  }

  shutdown() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.store.close();
  }

  startTimers() {
    // Vault 外部修改扫描：轻量，一分钟一轮（规格书 6.3 的监测服务）
    this.timers.push(setInterval(() => {
      try { this.syncVaultIntoDb(); } catch { /* 扫描失败不拖垮网关 */ }
    }, 60_000));
    this.timers[0].unref?.();
    // 每日增量备份：每 30 分钟检查一次是否到了新的一天且尚未备份
    this.timers.push(setInterval(() => {
      try { this.maybeBackup(); } catch { /* 备份失败进备份状态展示 */ }
    }, 30 * 60_000));
    this.timers[1].unref?.();
  }

  /**
   * Vault → DB：外部（Obsidian）修改回灌。工作台有未保存草稿且内容不同 → 记冲突。
   * 目录即归属：用户在 Obsidian 里把页面挪到另一个知识层目录，等价于一次「空间迁移」，
   * 这里以目录为准修正 space/type，并重写该页 frontmatter（否则 type 会把页面拽回旧目录）。
   * 同一 id 出现多份（迁移残留 / 手工复制）时优先取 DB 记录的 vault_path，其余忽略并留审计。
   */
  syncVaultIntoDb() {
    let changed = 0;
    let conflicts = 0;
    let moved = 0;
    let duplicates = 0;
    const typeByVaultName = Object.fromEntries(Object.entries(TYPE_NAME).map(([cn, en]) => [en, cn]));
    const pages = listVaultTopics(this.vaultDir);
    const groups = new Map();
    for (const vt of pages) {
      const list = groups.get(vt.id) ?? [];
      list.push(vt);
      groups.set(vt.id, list);
    }
    for (const [id, list] of groups) {
      const existing = this.store.getTopic(id);
      const chosen = (existing?.vault_path && list.find((v) => v.relPath === existing.vault_path)) || list[0];
      if (list.length > 1) {
        duplicates += list.length - 1;
        this.store.audit("vault", "vault.duplicate-page", id, chosen.relPath,
          list.filter((v) => v !== chosen).map((v) => v.relPath).join(" | "));
      }
      const vt = chosen;
      const space = vt.space ?? typeToSpace(vt.vaultType);
      // 类型不做「猜一个最像的」：Vault 里出现工作台没登记的类型（product_line / method /
      // planning_index…），旧逻辑会降级成空间主类型（企划项目），语义直接丢失、筛选失真。
      // 现在一律落到「未分类」并保留原 frontmatter type，等注册表补上再自动归位。
      let type = typeByVaultName[vt.vaultType] ?? UNKNOWN_TYPE;
      // 类型与目录打架：以目录（用户实际摆放位置）为准，类型退回未分类
      if (!TOPIC_TYPES[space]?.includes(type)) type = UNKNOWN_TYPE;
      if (!existing) {
        // Vault 里存在但 DB 没有（比如手工建的页面、或 DB 重建后）：登记，状态按 Schema 映射
        // id 必须沿用页面 frontmatter 的 id，否则下一轮扫描会当成新主题重复登记
        this.store.createTopic({
          id: vt.id,
          space, type,
          title: vt.title, summary: vt.summary, body: vt.body,
          status: vt.status,
          classification: vt.classification,
        }, { actor: "vault" });
        this.store.audit("vault", "topic.import-from-vault", vt.id, "", vt.relPath);
        changed++;
        continue;
      }
      // 目录变了 → 迁移空间（页面被手工挪到另一个知识层）
      if (existing.space !== space) {
        const moved0 = this.store.moveTopic(id, { space, type }, { actor: "vault" });
        const updated = this.store.updateTopic(id, { vault_path: vt.relPath }, { actor: "vault" });
        void moved0;
        try {
          const newPath = writeTopicToVault(this.vaultDir, updated, this.store.listCitations(id), this.linksForVault(id));
          this.watcher.markWritten(id, newPath);
          this.store.updateTopic(id, { vault_path: this.watcher.relative(newPath) });
          // 规范化到类型子目录后，旧位置的文件删除，避免同一 id 两份页面来回打架
          if (newPath !== vt.path) { try { rmSync(vt.path); } catch { /* 删不掉下次扫描会提示重复 */ } }
        } catch { /* 写失败保留 DB 结果，发布时再补写 */ }
        this.store.audit("vault", "topic.move-from-vault", id,
          `${existing.space}/${existing.type}`, `${space}/${type} · ${vt.relPath}`);
        moved++;
        continue;
      }
      if (existing.type !== type) this.store.updateTopic(id, { type }, { actor: "vault" });
      // 页面被重命名或挪目录（id 不变）：路径以磁盘为准。否则内容没变时会在下面的
      // 哈希短路里 continue，DB 里就一直留着旧路径——表现为详情页「打开 Vault」点不动。
      if (existing.vault_path !== vt.relPath) {
        this.store.updateTopic(id, { vault_path: vt.relPath }, { actor: "vault" });
      }
      let hash = "";
      try { hash = sha256(readFileSync(vt.path)); } catch { continue; }
      const known = this.watcher.hashes.get(vt.id);
      if (known === hash) continue; // 我们自己写的或已处理过
      this.watcher.hashes.set(vt.id, hash);
      if (existing.draft_body && existing.draft_body !== existing.body && vt.body !== existing.draft_body) {
        // Obsidian 改了，工作台还有没保存的草稿 → 冲突处理，不静默覆盖
        this.store.updateTopic(vt.id, { conflict: JSON.stringify({
          kind: "external-edit", vaultBody: vt.body.slice(0, 4000), draftBody: existing.draft_body.slice(0, 4000),
          at: Date.now(),
        }) });
        this.store.audit("vault", "topic.conflict", vt.id, "Obsidian 外部修改与工作台草稿冲突", vt.title);
        conflicts++;
        continue;
      }
      this.store.updateTopic(vt.id, {
        title: vt.title,
        // 页面里没写「> 摘要：」时不要用空值盖掉库里已有的摘要。
        // 批量编译入库的页面（主题汇编）正文不带摘要行，但工作台补过摘要，扫一次就丢一次。
        summary: vt.summary || existing.summary,
        body: vt.body,
        vault_path: vt.relPath,
      }, { actor: "vault" });
      changed++;
    }
    // 迁移分支会搬文件，此时 pages 快照已经过期，重新扫一遍再修死链
    const repaired = this.repairDeadLinks(moved ? undefined : pages);
    if (changed || conflicts || moved || duplicates || repaired.merged || repaired.cleared) {
      this.store.audit("vault", "vault.sync", "vault", "",
        `变更 ${changed}，冲突 ${conflicts}，迁移 ${moved}，重复 ${duplicates}，重连 ${repaired.merged}，失联 ${repaired.cleared}`);
    }
    return { changed, conflicts, moved, duplicates, ...repaired };
  }

  /**
   * 死链修复：DB 里有记录、磁盘上没这个文件。
   *
   * 典型成因是「批量重编译把页面重新编号」（kt-bc042 → kt-bc043）：文件名和 frontmatter id
   * 都换了，DB 里的旧路径就成了死链——详情页「打开 Vault」点不动，统计也把它当成一篇活页。
   * 处理规则（同标题 + 同空间才算同一篇，不做模糊匹配）：
   * - 找到活页面 → 旧行软删（deleted，审计留痕可追溯），活页面继承标签/密级/摘要；
   * - 找不到 → 清空 vault_path 记审计，暴露成「失联」而不是一直指着空气。
   * 只在启动和每分钟同步时跑，成本是一次目录遍历。
   */
  repairDeadLinks(pages = listVaultTopics(this.vaultDir)) {
    const alive = new Set(pages.map((p) => p.relPath));
    const byId = new Map(pages.map((p) => [p.id, p]));
    const byTitle = new Map();
    for (const p of pages) byTitle.set(`${p.space}|${p.title}`, p);
    let merged = 0;
    let cleared = 0;
    let relinked = 0;
    for (const t of this.store.listTopics({ limit: 5000 })) {
      if (t.status === "deleted" || !t.vault_path || alive.has(t.vault_path)) continue;
      // 同 id 出现在别的路径：纯粹是挪了位置，改路径即可
      const sameId = byId.get(t.id);
      if (sameId) {
        this.store.updateTopic(t.id, { vault_path: sameId.relPath }, { actor: "vault" });
        this.store.audit("vault", "vault.relink-page", t.id, t.vault_path, sameId.relPath, "页面被移动或改名，路径已重连");
        relinked++;
        continue;
      }
      const twin = byTitle.get(`${t.space}|${t.title}`);
      const live = twin && twin.id !== t.id ? this.store.getTopic(twin.id) : null;
      if (live && live.status !== "deleted") {
        const patch = {};
        if (!(Array.isArray(live.tags) ? live.tags.length : 0) && (Array.isArray(t.tags) ? t.tags.length : 0)) patch.tags = t.tags;
        if ((!live.classification || live.classification === "internal") && t.classification && t.classification !== "internal") {
          patch.classification = t.classification;
        }
        if (!live.summary && t.summary) patch.summary = t.summary;
        if (Object.keys(patch).length) this.store.updateTopic(live.id, patch, { actor: "vault" });
        this.store.setTopicStatus(t.id, "deleted", { actor: "vault", note: `重连到 ${twin.relPath}` });
        this.store.audit("vault", "vault.rebind-topic", t.id, t.vault_path, twin.relPath, "同标题页已存在，旧记录软删");
        merged++;
        continue;
      }
      this.store.updateTopic(t.id, { vault_path: "" }, { actor: "vault" });
      this.store.audit("vault", "vault.missing-page", t.id, t.vault_path, "", "Vault 里找不到这篇，已清空路径");
      cleared++;
    }
    return { merged, cleared, relinked };
  }

  // ---------------------------------------------------------------- 发布流转（回写 Vault）

  /**
   * 主题的流向链接（写 Vault source_refs 用）：灵感页记「已流转为…」，派生页记「来源灵感」。
   * 用标题而非路径，Obsidian 的 wikilink 按标题解析；同名时由 Obsidian 自己提示消歧。
   */
  linksForVault(id) {
    return this.store.listRelations({ topicId: id, type: "spawned" }).map((r) => (
      r.from_id === id
        ? { title: r.to_title, note: `已流转为${SPACES[r.to_space]?.name ?? r.to_space} · ${r.to_type}` }
        : { title: r.from_title, note: "来源灵感" }
    ));
  }

  // ---------------------------------------------------------------- 灵感随手记（碎片捕获）

  /**
   * 附件落盘：`40-灵感模型/_附件/<时间戳>-<安全文件名>`。
   * 为什么不进 sources：附件是「证据/截图」，不是要解析的正文，走来源管线会平白切一堆无意义片段。
   */
  saveAttachment(buffer, filename, { actor = "local" } = {}) {
    if (!buffer?.length) throw new Error("文件是空的");
    const dir = join(this.vaultDir, SPACE_ROOTS.idea, "_附件");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const safe = String(filename || "file").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
    const target = join(dir, `${stamp}-${safe}`);
    writeFileSync(target, buffer);
    const rel = relative(this.vaultDir, target).replace(/\\/g, "/");
    const kind = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(safe) ? "image" : "file";
    const row = this.store.createAttachment({
      name: safe, path: rel, kind, ext: extname(safe).toLowerCase(), size: buffer.length, hash: sha256(buffer),
    });
    this.store.audit(actor, "idea.attach", row.id, "", `${safe} · ${(buffer.length / 1024).toFixed(0)}KB`);
    return row;
  }

  /**
   * 收下一条灵感：一句话 + 若干截图/文件，一步成为灵感主题并直接落 Vault。
   * 灵感是「先记下来再整理」的东西，不走草稿→审核的重流程：
   * 页面 frontmatter 的 evidence_level C / confidence 40 已经说明了它的可信度。
   */
  captureInbox({ text = "", title = "", attachments = [], space = "idea", type, actor = "local" } = {}) {
    const clean = String(text ?? "").trim();
    const files = attachments.map((a) => (typeof a === "string" ? this.store.getAttachment(a) : a)).filter(Boolean);
    if (!clean && !files.length) throw new Error("写一句话，或者贴一张图 / 丢一个文件再收下");
    const spaceKey = SPACES[space] ? space : "idea";
    const topicType = TOPIC_TYPES[spaceKey]?.includes(type) ? type : (TOPIC_TYPES[spaceKey]?.[0] ?? "灵感收集");
    const finalTitle = String(title ?? "").trim() || this.ideaTitle(clean, files);

    const parts = [];
    if (clean) parts.push(clean);
    for (const att of files) {
      const fileName = att.path.split("/").pop();
      parts.push(att.kind === "image" ? `![[${fileName}]]` : `- 📎 [[${fileName}]]`);
    }

    const topic = this.store.createTopic({
      space: spaceKey,
      type: topicType,
      title: finalTitle,
      body: parts.join("\n\n"),
      summary: clean ? clean.replace(/\s+/g, " ").slice(0, 120) : `附件 ${files.length} 个`,
      summarySource: "随手记",
      status: "published",
    }, { actor });
    this.store.bindAttachments(topic.id, files.map((f) => f.id));

    // 直接落 Vault：Obsidian 里也能看到这条碎片，不用等审核
    try {
      const path = writeTopicToVault(this.vaultDir, topic, [], this.linksForVault(topic.id));
      this.watcher.markWritten(topic.id, path);
      this.store.updateTopic(topic.id, { vault_path: this.watcher.relative(path) }, { actor });
    } catch { /* 写失败保留 DB 记录，下次编辑保存时再补写 */ }

    this.store.computeQuality(topic.id);
    this.store.audit(actor, "idea.capture", topic.id, "", finalTitle);
    return { topic: this.store.getTopic(topic.id), attachments: files };
  }

  /** 没填标题时从内容里猜一个：首行文字 → 附件名 → 时间。标题只用于识别，别太长。 */
  ideaTitle(text, files = []) {
    const line = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean) ?? "";
    if (line) {
      const clean = line.replace(/[。！？?!，,、；;：:\s]+$/, "");
      return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean;
    }
    const image = files.find((f) => f.kind === "image");
    if (image) {
      const d = new Date();
      return `截图 ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    const doc = files.find((f) => f.name);
    if (doc) return doc.name.replace(/\.\w+$/, "").slice(0, 24);
    const d = new Date();
    return `灵感 ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** 贴了图又没点收下 → 24 小时前的孤儿附件连文件带记录清掉。 */
  cleanupOrphanAttachments(maxAgeMs = 24 * 3600_000) {
    const rows = this.store.listOrphanAttachments(Date.now() - maxAgeMs);
    let removed = 0;
    for (const row of rows) {
      try {
        const abs = join(this.vaultDir, row.path);
        if (existsSync(abs)) rmSync(abs);
        this.store.deleteAttachment(row.id);
        removed++;
      } catch { /* 删不掉下次再试 */ }
    }
    return removed;
  }

  publishTopic(id, { actor = "local" } = {}) {
    // 摘要是摘要层索引的根：发布前若为空，按「产品概述 / 系统概述」这类章节自动摘一次
    const pending = this.store.getTopic(id);
    if (pending && !String(pending.summary ?? "").trim()) {
      const brief = extractSummary({ body: pending.body, space: pending.space, type: pending.type });
      if (brief.summary) {
        this.store.updateTopic(id, { summary: brief.summary, summary_source: brief.source, summary_auto: 1 },
          { actor, note: "发布前自动摘取摘要" });
      }
    }
    const topic = this.store.setTopicStatus(id, "published", { actor });
    const citations = this.store.listCitations(id);
    const oldPath = topic.vault_path ? join(this.vaultDir, topic.vault_path) : "";
    const path = writeTopicToVault(this.vaultDir, topic, citations, this.linksForVault(id));
    this.watcher.markWritten(topic.id, path);
    // 标题改了会导致文件名变化：旧文件删掉，避免 Vault 里同一 id 两份
    if (oldPath && oldPath !== path && existsSync(oldPath)) {
      try { rmSync(oldPath); } catch { /* 删不掉下次扫描会提示重复页面 */ }
    }
    this.store.updateTopic(id, { vault_path: this.watcher.relative(path) });
    this.store.computeQuality(id);
    this.store.audit(actor, "topic.publish", id, "", topic.title);
    return this.store.getTopic(id);
  }

  /**
   * 空间迁移（发布态/草稿态都支持）：把误放到别的空间的主题挪回正确空间。
   * 步骤：先取回 Obsidian 最新内容 → 数据层改 space/type → 写新目录 → 删旧文件 → 记审计。
   * 只改 DB 不搬文件会导致下一轮 Vault 扫描把它按旧目录又迁回去，所以搬文件是必须的。
   */
  moveTopic(id, { space, type, actor = "local" } = {}) {
    const before = this.store.getTopic(id);
    if (!before) throw new Error("主题不存在");
    if (!SPACES[space]) throw new Error(`未知知识空间: ${space}`);
    const targetType = TOPIC_TYPES[space].includes(type) ? type : TOPIC_TYPES[space][0];
    if (before.space === space && before.type === targetType) {
      return { topic: before, moved: false, from: before.vault_path || "", to: before.vault_path || "" };
    }
    const oldRel = before.vault_path || "";
    const oldPath = oldRel ? join(this.vaultDir, oldRel) : "";
    // Vault 里可能有比 DB 更新的内容（Obsidian 编辑过）：先回灌，避免用旧快照覆盖用户改动
    if (oldPath && existsSync(oldPath)) {
      try {
        const parsed = parseMarkdown(readFileSync(oldPath, "utf8"));
        if (parsed && parsed.body && parsed.body !== before.body && !before.conflict) {
          this.store.updateTopic(id, {
            title: parsed.title || before.title,
            summary: parsed.summary || before.summary,
            body: parsed.body,
          }, { actor: "vault" });
        }
      } catch { /* 读不动就按 DB 内容迁移 */ }
    }
    const moved = this.store.moveTopic(id, { space, type: targetType }, { actor });
    let newRel = moved.vault_path || "";
    let removed = "";
    if (oldPath && existsSync(oldPath)) {
      const path = writeTopicToVault(this.vaultDir, moved, this.store.listCitations(id), this.linksForVault(id));
      this.watcher.markWritten(id, path);
      newRel = this.watcher.relative(path);
      this.store.updateTopic(id, { vault_path: newRel }, { actor });
      if (path !== oldPath) {
        try { rmSync(oldPath); removed = oldRel; } catch { /* 删不掉由扫描提示重复 */ }
      }
    }
    this.store.computeQuality(id);
    this.store.audit(actor, "topic.move", id, `${before.space}/${before.type}`,
      `${moved.space}/${moved.type}${newRel ? ` → ${newRel}` : ""}${removed ? `（旧文件已删除：${removed}）` : ""}`);
    return { topic: this.store.getTopic(id), moved: true, from: oldRel, to: newRel, removed };
  }

  /**
   * 灵感流转（B 档）：在目标空间生成派生主题，灵感原件保留——不搬家、不删文件、id 不变。
   * - relations 记一条有向边 spawned（灵感 → 派生），图谱据此画箭头；
   * - 灵感已发布时立即回写 Vault，source_refs 出现指向派生主题的链接；
   * - 派生主题是草稿，发布时由 publishTopic 把「来源灵感」写进自己的 source_refs。
   * 与 moveTopic 的区别：迁移是「放错了搬走」，流转是「长出了新东西，原件留档」。
   */
  spawnFromIdea(id, { space, type, title, actor = "local" } = {}) {
    const idea = this.store.getTopic(id);
    if (!idea) throw new Error("主题不存在");
    if (idea.space !== "idea") throw new Error("只有灵感空间的主题可以流转；其他主题放错了空间请用「迁移」");
    if (!["research", "planning", "product"].includes(space)) {
      throw new Error("流向目标只能是调研 / 企划 / 产品");
    }
    const targetType = TOPIC_TYPES[space].includes(type) ? type : TOPIC_TYPES[space][0];
    const typed = String(title ?? "").trim() || idea.title;
    // 同名派生会在 Vault 里和原件撞文件名（同目录不同类型除外），统一加后缀区分
    const finalTitle = typed === idea.title ? `${idea.title}（立项）` : typed;
    // 幂等：同一条灵感已经往同一标题流过，就把那个派生主题交回去，不重复建
    const known = this.store.listRelations({ topicId: id, type: "spawned" })
      .find((r) => r.from_id === id && r.to_title === finalTitle && r.to_space === space);
    if (known) {
      return { idea: this.store.getTopic(id), topic: this.store.getTopic(known.to_id), reused: true };
    }
    // 别的主题占了这个标题：Vault 里同名页面容易混淆，让人改个名再流转
    const clash = this.store.listTopics({ limit: 1000 })
      .find((t) => t.title === finalTitle && t.status !== "deleted");
    if (clash) throw new Error(`已存在同名主题「${finalTitle}」，请改一个能区分的标题`);
    const topic = this.store.createTopic({
      space,
      type: targetType,
      title: finalTitle,
      summary: idea.summary,
      summarySource: idea.summary ? `继承自灵感「${idea.title}」` : "",
      summaryAuto: 1,
      body: spawnBody(idea, space),
      tags: idea.tags,
      classification: idea.classification,
      status: "draft",
    }, { actor });
    this.store.addRelation({ fromId: id, toId: topic.id, type: "spawned" }, { actor });
    this.rewriteVaultIfPublished(id, { actor });
    this.store.audit(actor, "topic.spawn", id, idea.title, `→ ${space}/${targetType} ${finalTitle}`);
    return { idea: this.store.getTopic(id), topic: this.store.getTopic(topic.id) };
  }

  /** 摘要改了要把已发布页面的 `> 摘要` 一起刷新，否则 Obsidian 里看到的还是旧的。 */
  rewriteVaultIfPublished(id, { actor = "local" } = {}) {
    void actor;
    const topic = this.store.getTopic(id);
    if (!topic || topic.status !== "published" || !topic.vault_path) return "";
    try {
      const path = writeTopicToVault(this.vaultDir, topic, this.store.listCitations(id), this.linksForVault(id));
      this.watcher.markWritten(id, path);
      const rel = this.watcher.relative(path);
      if (rel !== topic.vault_path) this.store.updateTopic(id, { vault_path: rel });
      return rel;
    } catch { return ""; }
  }

  /** 按「产品概述 / 系统概述」等章节重新摘取某主题的摘要（apply=false 时只预览）。 */
  summarizeTopic(id, { apply = false, actor = "local" } = {}) {
    const topic = this.store.getTopic(id);
    if (!topic) throw new Error("主题不存在");
    const brief = extractSummary({ body: topic.body, space: topic.space, type: topic.type });
    if (apply && brief.summary) {
      this.store.updateTopic(id, { summary: brief.summary, summary_source: brief.source, summary_auto: 1 },
        { actor, note: "重新摘取摘要" });
      this.store.audit(actor, "topic.summarize", id, "", brief.source);
      this.rewriteVaultIfPublished(id, { actor });
    }
    return { ...brief, applied: Boolean(apply && brief.summary), topic: apply ? this.store.getTopic(id) : undefined };
  }

  /**
   * 批量重算摘要：默认只补空摘要 + 明显是「前 160 字截断」的历史摘要；force 时全部重算。
   * 摘要层索引会随 topics 触发器同步更新，重算后搜索的「摘要命中」立刻生效。
   */
  recomputeSummaries({ space, force = false, actor = "local", writeVault = true } = {}) {
    const topics = this.store.listTopics({ space, limit: 1000 });
    let updated = 0;
    let skipped = 0;
    for (const t of topics) {
      if (t.status === "deleted") continue;
      const empty = !String(t.summary ?? "").trim();
      if (!force && !empty && !looksTruncated(t.summary)) { skipped++; continue; }
      const brief = extractSummary({ body: t.body, space: t.space, type: t.type });
      if (!brief.summary || brief.summary === t.summary) { skipped++; continue; }
      this.store.updateTopic(t.id, { summary: brief.summary, summary_source: brief.source, summary_auto: 1 },
        { actor, note: "批量重算摘要" });
      // writeVault=false 只补工作台这一层：批量编译入库的页面不想被整篇重写时用这个模式，
      // 页面里没有摘要行也不会被同步清掉（见 syncVaultIntoDb 的 summary 兜底）。
      if (writeVault) this.rewriteVaultIfPublished(t.id, { actor });
      updated++;
    }
    this.store.audit(actor, "topic.summarize-bulk", space ?? "all", "", `重算 ${updated}，跳过 ${skipped}`);
    return { updated, skipped, scanned: topics.length };
  }

  // ---------------------------------------------------------------- 导入管线

  /**
   * 导入一批文件。files: [{ name, buffer, classification?, path? }]。
   * 流程（规格书 7.1/7.4）：登记来源 → 解析 → 切片 → 去重 → 候选主题（草稿，不直接发布）。
   * 返回逐文件结果，前端向导展示预览与建议后确认。
   */
  importFiles(batchName, files, { actor = "local", autoTopic = true } = {}) {
    const batchId = uid("batch");
    const importId = this.store.createImport(batchName || `导入 ${new Date().toLocaleString("zh-CN")}`, files.length);
    const results = [];
    // 现有已解析来源文本，供相似度比对（限制规模：最近 500 条）
    const existing = this.store.listSources({ limit: 500 })
      .map((s) => ({ id: s.id, name: s.name, hash: s.hash, text: this.store.listFragments(s.id).map((f) => f.text).join("\n") }));
    const hashIndex = new Map(existing.filter((s) => s.hash).map((s) => [s.hash, s.id]));
    let done = 0;
    for (const file of files) {
      try {
        const hash = sha256(file.buffer);
        const allText = () => file._text ?? "";
        // 先解析（去重建议需要文本）；OCR 引擎可用时注入，图片/纯图 PPT 直接识别成文字
        const ocr = this.ocrEngine
          ? (buffer, ext) => ocrImage(buffer, ext)
          : undefined;
        const parsed = parseFile(file.buffer, file.name, { ocr });
        const text = parsed.fragments.map((f) => f.text).join("\n");
        const suggestion = dedupeSuggestion(
          { hash, text, name: file.name },
          { existingByHash: hashIndex, candidates: existing.filter((s) => s.text).slice(-200) },
        );
        const sourceId = this.store.createSource({
          batchId,
          name: file.name,
          // 受管原文件按 Schema 放在原始层 02-待导入；外部文件只登记路径不动原文件
          path: file.path ?? join(this.vaultDir, "02-待导入", file.name),
          managed: !file.path,
          hash, type: file.kind ?? "file", ext: extname(file.name),
          size: file.buffer.length,
          mtime: file.mtime ?? Date.now(),
          classification: file.classification ?? "internal",
          parseStatus: parsed.quality === "empty" ? "empty" : parsed.quality,
          parseNote: parsed.note ?? "",
        });
        if (suggestion.action !== "skip") {
          this.store.addFragments(sourceId, parsed.fragments);
          hashIndex.set(hash, sourceId);
          existing.push({ id: sourceId, name: file.name, hash, text });
        }
        // 摘要按章节自动摘取（企划优先「产品概述 / 系统概述」），不是正文前 N 字截断
        const space = file.space ?? "research";
        const topicType = file.topicType ?? TOPIC_TYPES[space][0];
        const brief = parsed.fragments.length
          ? extractSummary({ fragments: parsed.fragments, space, type: topicType, title: parsed.title })
          : { summary: "", source: "" };
        let topicId = null;
        if (autoTopic && suggestion.action !== "skip" && parsed.fragments.length) {
          // 每个文件生成一个候选主题草稿（AI 候选走 reviews，P1；P0 直接建草稿主题，人工确认）
          const topic = this.store.createTopic({
            space,
            type: topicType,
            title: parsed.title || file.name.replace(/\.\w+$/, ""),
            summary: brief.summary,
            summarySource: brief.source,
            summaryAuto: Boolean(brief.summary),
            body: parsed.fragments.map((f) => `## ${f.locator}\n\n${f.text}`).join("\n\n").slice(0, 60_000),
            tags: [],
            classification: file.classification ?? "internal",
            status: "draft",
          }, { actor });
          const fragIds = this.store.listFragments(sourceId).map((f) => f.id);
          this.store.setCitations(topic.id, fragIds);
          this.store.computeQuality(topic.id);
          topicId = topic.id;
        }
        // 受管来源：原文件进原始层 02-待导入（规格书 7.5 混合存储 + Schema 原始层约定）
        let managedPath = "";
        if (!file.path && suggestion.action !== "skip") {
          const rawDir = join(this.vaultDir, "02-待导入");
          mkdirSync(rawDir, { recursive: true });
          managedPath = join(rawDir, file.name);
          try { writeFileSync(managedPath, file.buffer); } catch { /* 只读盘等情况保留外部路径语义 */ }
        }
        // Schema 编译规则 1：新资料先落一张 source 卡片到 03-资料索引
        if (suggestion.action !== "skip") {
          try {
            const cardPath = writeSourceCard(this.vaultDir, {
              id: sourceId, name: file.name, path: managedPath || file.path || "",
              hash, size: file.buffer.length, mtime: file.mtime, ext: extname(file.name),
              classification: file.classification ?? "internal",
              parse_status: parsed.quality === "empty" ? "pending" : parsed.quality,
              created_at: Date.now(),
            }, {
              summary: brief.summary || parsed.note || "",
              fragments: parsed.fragments,
            });
            if (cardPath) this.watcher.markWritten(sourceId, cardPath);
          } catch { /* 卡片写失败不影响入库，运行记录里可从来源再补 */ }
        }
        results.push({
          name: file.name, sourceId, topicId, suggestion,
          fragments: parsed.fragments.length, quality: parsed.quality, note: parsed.note ?? "",
          managedPath,
        });
      } catch (error) {
        results.push({ name: file.name, error: String(error?.message || error) });
      }
      this.store.tickImport(importId, ++done, done === files.length ? "completed" : "running");
    }
    return { batchId, importId, results };
  }

  /** 粘贴文本导入。 */
  importText(name, text, meta) {
    return this.importFiles(name, [{ name, buffer: Buffer.from(text, "utf8"), kind: "text", ...meta }]);
  }

  /** 网页链接导入：抓取一次 HTML 提正文（手动提交，不做自动抓取）。 */
  async importUrl(url, meta) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!resp.ok) throw new Error(`网页返回 ${resp.status}`);
      const html = await resp.text();
      return this.importFiles(url, [{ name: `${url}.html`, buffer: Buffer.from(html, "utf8"), kind: "url", path: url, ...meta }]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- 审核联动（单级审核，规格书 9.4）

  /**
   * 审核结论 → 主题状态联动：
   * 通过 → 发布（回写 Vault）；修改后通过 / 退回 → 待修订；拒绝 → 保持待审核现状并留意见。
   */
  decideReview(id, status, comment, { actor = "local" } = {}) {
    const review = this.store.decideReview(id, status, comment, { actor });
    if (review.topic_id && status === "approved") this.publishTopic(review.topic_id, { actor });
    if (review.topic_id && ["approved_with_changes", "returned"].includes(status)) {
      this.store.setTopicStatus(review.topic_id, "revise", { actor, note: comment });
    }
    return review;
  }

  // ---------------------------------------------------------------- 批量操作

  /**
   * 提交审核（单级审核，规格书 9.4）。
   * 传 ids 时只提交勾选的这些（列表多选），否则按当前筛选（空间/类型/密级）提交全部草稿。
   */
  bulkSubmit({ ids, space, type, classification, actor = "local" } = {}) {
    let drafts;
    if (Array.isArray(ids) && ids.length) {
      drafts = ids
        .map((id) => this.store.getTopic(id))
        .filter((t) => t && t.status === "draft");
    } else {
      drafts = this.store.listTopics({ space, type, classification, status: "draft", limit: 500 });
    }
    for (const topic of drafts) {
      this.store.setTopicStatus(topic.id, "pending", { actor });
      this.store.createReview({ kind: "topic", topicId: topic.id, title: topic.title, createdBy: "local" });
    }
    if (drafts.length) {
      this.store.audit(actor, "topic.bulk-submit", space ?? "selection", "",
        `${drafts.length} 个草稿提交审核`);
    }
    return { submitted: drafts.length, requested: Array.isArray(ids) ? ids.length : undefined };
  }

  /**
   * 批量迁移空间：逐个走 moveTopic（含 Vault 文件搬家与 frontmatter 改写），
   * 单个失败不影响其余，最后统一记一条审计。
   */
  bulkMove({ ids = [], space, type, actor = "local" } = {}) {
    if (!SPACES[space]) throw new Error(`未知知识空间: ${space}`);
    const results = [];
    let moved = 0;
    let unchanged = 0;
    for (const id of ids) {
      try {
        const r = this.moveTopic(id, { space, type, actor });
        if (r.moved) moved++;
        else unchanged++;
        results.push({ id, ok: true, moved: r.moved, space: r.topic.space, type: r.topic.type, vault_path: r.topic.vault_path });
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message || error) });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    if (ids.length) {
      this.store.audit(actor, "topic.bulk-move", space, "",
        `迁移 ${moved}（无变化 ${unchanged}，失败 ${failed}）`);
    }
    return { moved, unchanged, failed, total: ids.length, results };
  }

  /**
   * 批量废止：状态置 deleted，并把 Vault 页面挪进 `90-归档`（不删文件）。
   * 归档目录不在扫描范围里，所以不会被下一轮同步拉回知识层；内容仍可从 Obsidian 找回。
   */
  bulkDelete({ ids = [], actor = "local" } = {}) {
    const archiveRoot = join(this.vaultDir, "90-归档");
    const results = [];
    let deleted = 0;
    for (const id of ids) {
      const topic = this.store.getTopic(id);
      if (!topic) { results.push({ id, ok: false, error: "主题不存在" }); continue; }
      try {
        let archived = "";
        if (topic.vault_path) {
          const from = join(this.vaultDir, topic.vault_path);
          if (existsSync(from)) {
            const dir = join(archiveRoot, topic.space);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const base = topic.vault_path.split("/").pop();
            let to = join(dir, base);
            // 归档目录里已有同名文件（比如同名主题被废止过两次）→ 加时间戳，别覆盖旧归档
            if (existsSync(to)) {
              const dot = base.lastIndexOf(".");
              const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
              to = join(dir, `${dot > 0 ? base.slice(0, dot) : base}-${stamp}${dot > 0 ? base.slice(dot) : ""}`);
            }
            try {
              renameSync(from, to);
              archived = relative(this.vaultDir, to).replace(/\\/g, "/");
            } catch {
              // 跨盘/被占用时退回复制 + 删除；仍失败就只做软删除，文件留在原处
              try { copyFileSync(from, to); rmSync(from); archived = relative(this.vaultDir, to).replace(/\\/g, "/"); }
              catch { archived = ""; }
            }
          }
        }
        this.store.setTopicStatus(id, "deleted", { actor, note: "批量废止" });
        if (archived) this.store.updateTopic(id, { vault_path: archived });
        results.push({ id, ok: true, title: topic.title, archived });
        deleted++;
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message || error) });
      }
    }
    if (ids.length) this.store.audit(actor, "topic.bulk-delete", "selection", "", `废止 ${deleted}/${ids.length}`);
    return { deleted, total: ids.length, results };
  }

  /**
   * 批量导出为 zip（每篇一个 .md，文件名加序号前缀防重名）。
   * 不写临时目录，直接内存打包返回 Buffer。
   */
  bulkExport({ ids = [], actor = "local" } = {}) {
    const files = [];
    const seen = new Set();
    let index = 0;
    for (const id of ids) {
      const topic = this.store.getTopic(id);
      if (!topic) continue;
      const file = this.exportTopic(id, { actor });
      index++;
      let name = file.filename;
      if (seen.has(name)) name = `${index}-${name}`;
      seen.add(name);
      files.push({ name, data: file.content });
    }
    if (!files.length) throw new Error("没有可导出的主题");
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `知识库导出-${stamp}.zip`, buffer: zipStore(files), count: files.length };
  }

  /** 审核中心一键通过全部待审核项（通过即发布回写 Vault）。 */
  bulkApprove({ actor = "local" } = {}) {
    const pending = this.store.listReviews({ status: "pending" });
    let approved = 0;
    const failed = [];
    for (const review of pending) {
      try {
        this.decideReview(review.id, "approved", "批量通过", { actor });
        approved++;
      } catch (error) { failed.push({ id: review.id, error: String(error?.message || error) }); }
    }
    if (approved) this.store.audit(actor, "review.bulk-approve", "reviews", "", `通过 ${approved}/${pending.length}`);
    return { approved, total: pending.length, failed };
  }

  // ---------------------------------------------------------------- AI 问答（带引用，规格书 11.1）

  /**
   * 问句拆检索词。
   * 旧实现「≤6 字整串查」在中文问句上是致命的：「凯越有多少人」正好 6 字，被当成一个短语
   * 去匹配连续子串，必然零命中，于是问答永远回答「没有依据」。
   * 现在：先剥疑问词，再把中文串铺成 2-gram（长词同时保留），单字只作为度量词参与打分。
   */
  askTerms(question) {
    const runs = String(question || "").split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter(Boolean);
    const search = [];
    const seen = new Set();
    const add = (term) => {
      const t = String(term).trim();
      if (t.length < 2 || GRAM_STOP.has(t) || seen.has(t)) return;
      seen.add(t);
      search.push(t);
    };
    for (const run of runs) {
      if (!/[\u4e00-\u9fa5]/.test(run)) { add(run.toLowerCase()); continue; }
      // 长填充词先剥，避免「有多少」拆出「有多」这种半截词
      let cleaned = run;
      for (const word of QUESTION_FILLERS) cleaned = cleaned.split(word).join(" ");
      for (const part of cleaned.split(/\s+/).filter(Boolean)) {
        if (part.length <= 4) add(part); // 整词只在短的时候有价值，长串靠 2-gram
        for (let i = 0; i + 2 <= part.length; i++) {
          const gram = part.slice(i, i + 2);
          // 「越有」「地的」这类一头挂着虚词的 gram 只会制造噪声
          if (/^[的了是有在和与就都也得很把被这那]/.test(gram)) continue;
          if (/[的了着吗呢吧]$/.test(gram)) continue;
          add(gram);
        }
      }
    }
    // 度量词：问句字面 + 意图扩展（「多少人」→ 人数/员工/规模）
    const intent = new Set(INTENT_WORDS.filter((w) => String(question).includes(w)));
    for (const rule of INTENT_RULES) if (rule.when.test(String(question))) rule.words.forEach((w) => intent.add(w));
    return { search, intent: [...intent] };
  }

  /**
   * 从主题正文里挑出最可能回答问题的段落。
   * 问答要的是「凯越 2024 年末约 3950 人」这一行，不是整篇 1.6 万字——整篇塞进提示词既超长
   * 又会让模型抓错重点，所以按段落切、按检索词+度量词+数字密度打分，只取前几段。
   */
  askPassages(topic, searchTerms, intentTerms, max = 4) {
    const body = String(topic.body || "");
    if (!body.trim()) return [];
    const blocks = [];
    let heading = "";
    let buf = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text) blocks.push({ text, heading });
      buf = [];
    };
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      const h = /^#{1,6}\s+(.+)$/.exec(line);
      if (h) { flush(); heading = h[1].trim(); continue; }
      if (!line) { flush(); continue; }
      if (line.startsWith("|")) { flush(); buf.push(line); flush(); continue; } // 表格行各自成段，别糊成一团
      buf.push(line);
      if (buf.join("").length >= 320) flush();
    }
    flush();
    const scored = blocks.map((block) => {
      let score = 0;
      for (const term of searchTerms) {
        const hits = block.text.split(term).length - 1;
        if (hits) score += 2 + Math.min(hits - 1, 3) * 0.4 + Math.min(term.length - 2, 4) * 0.3;
      }
      for (const term of intentTerms) if (block.text.includes(term)) score += 1.8;
      // 「3950 人」「22.91 亿美元」这类数字+单位的组合，往往就是问事实要的那一行
      for (const unit of ["人", "元", "家", "亿", "万", "年"]) {
        if (new RegExp(`\\d[\\d,.]*\\s*(余|多|万|亿)?\\s*${unit}`).test(block.text)) score += 1;
      }
      const numbers = block.text.match(/\d[\d,.]*/g) || [];
      if (numbers.length) score += 0.4 + Math.min(numbers.length, 4) * 0.1;
      if (block.text.length < 12) score -= 0.5;
      return { ...block, score };
    }).filter((block) => block.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max);
  }

  /**
   * 检索增强问答：本地混合检索取「主题正文段落 + 来源片段」，拼上下文给模型，要求逐条标 [n] 引用。
   * 「机密」资料只进 local 通道（本机 CLI），云端通道一律剔除。
   */
  async ask(question, { actor = "local" } = {}) {
    if (!this.askModel) throw new Error("没有可用的模型通道：请先在「AI 员工」里配置一个可用的云端员工，或确认本机 Claude CLI 可用");
    const { search, intent } = this.askTerms(question);
    const fragMap = new Map();
    const topicMap = new Map();
    for (const term of search) {
      try {
        const r = this.store.search(term, { status: "any", limit: 6 });
        for (const f of r.fragments) {
          const cur = fragMap.get(f.id);
          fragMap.set(f.id, { f, score: (cur?.score ?? 0) + 1 });
        }
        for (const t of r.topics) {
          const cur = topicMap.get(t.id);
          topicMap.set(t.id, { t, score: (cur?.score ?? 0) + 1 });
        }
      } catch { /* 单个词查不动就跳过 */ }
    }
    let frags = [...fragMap.values()].sort((a, b) => b.score - a.score).slice(0, 6).map((x) => x.f);
    // 命中 1 个词的主题（「规模」这种通用词很容易撞上）不该跟主命中平起平坐，否则上下文里
    // 一半资料是别的项目，模型反而抓错重点。只在主命中足够强时才按比例砍尾部。
    const ranked = [...topicMap.values()].sort((a, b) => b.score - a.score);
    const floor = ranked.length && ranked[0].score >= 3 ? ranked[0].score * 0.6 : 0;
    const topics = ranked.filter((x) => x.score >= floor).slice(0, 4).map((x) => x.t);
    const cloud = this.modelKind === "cloud";
    let secretBlocked = 0;
    if (cloud) {
      // 云端规则：机密资料不上云
      const kept = frags.filter((f) => (f.source_classification ?? "internal") !== "secret");
      secretBlocked = frags.length - kept.length;
      frags = kept;
    }
    // 主题正文才是知识库的主体（导入的原始文件只有一部分），摘要 + 最相关段落一起进上下文
    const entries = [];
    for (const topic of topics) {
      if (cloud && (topic.classification ?? "internal") === "secret") { secretBlocked++; continue; }
      if (topic.summary) entries.push({ sourceName: `《${topic.title}》`, locator: "摘要", text: topic.summary, topicId: topic.id });
      for (const p of this.askPassages(topic, search, intent)) {
        entries.push({
          sourceName: `《${topic.title}》`,
          locator: p.heading ? `正文 · ${p.heading}` : "正文",
          text: p.text,
          topicId: topic.id,
        });
      }
    }
    // 原文片段兜底补在后面：主题段落是人工沉淀过的，冲突时以它为准
    for (const f of frags) {
      const text = String(f.text ?? "").trim();
      if (!text) continue;
      if (entries.some((e) => e.text.includes(text) || text.includes(e.text))) continue;
      entries.push({ sourceName: f.source_name, locator: f.locator ?? "", text, topicId: null });
    }
    const picked = entries.slice(0, 10);
    if (!picked.length && secretBlocked) {
      throw new Error("命中的都是「机密」资料，云端模型不可用；请改用本机 CLI 员工作为问答通道");
    }
    if (!picked.length) {
      const hint = search.length ? `已尝试检索：${search.slice(0, 6).join("、")}` : "问题里没有可用于检索的关键词";
      const answer = `知识库里没有检索到与「${question}」相关的内容（${hint}）。可以换个说法、补上公司/产品名，或先把相关资料导入知识库。`;
      this.store.audit(actor, "kb.ask", "qa", question.slice(0, 80), `零命中 · ${this.modelKind} 通道`);
      return { answer, citations: [], topics: [], modelKind: this.modelKind, retrieval: { terms: search, topics: 0, entries: 0 } };
    }
    const context = picked.map((e, i) =>
      `[${i + 1}] 来源：${e.sourceName}${e.locator ? ` · ${e.locator}` : ""}\n${String(e.text ?? "").slice(0, 700)}`
    ).join("\n\n");
    const topicList = topics.map((t) => {
      const brief = String(t.summary || "").slice(0, 120);
      return `- 《${t.title}》（${t.space}/${t.type}/${t.status}）${brief ? `摘要：${brief}` : ""}`;
    }).join("\n");
    const prompt = [
      `你是产品中枢知识库的问答助手。请只依据下面的知识库资料回答问题。`,
      `规则：1) 每个关键结论后面用 [编号] 标注来源，编号对应资料条目；`,
      `2) 资料里有具体数字、名称、时间就直接引用原文，不要改写成"约数"或"较多"；`,
      `3) 资料只能覆盖一部分时，先答已覆盖的部分，再明确说剩下哪部分"知识库中没有相关依据"；`,
      `4) 完全不相关时才回答"知识库中没有相关依据"，不要编造。`,
      `5) 先给一句结论，再列不超过 6 条要点；别写成报告体。`,
      `6) 用简体中文，简洁分点。`,
      ``,
      `【知识库资料】`,
      context,
      topicList ? `\n【相关主题】\n${topicList}` : "",
      ``,
      `【问题】${question}`,
    ].join("\n");
    const answer = String(await this.askModel(prompt)).trim();
    const citations = picked.map((e, i) => ({
      n: i + 1, sourceName: e.sourceName, locator: e.locator, text: String(e.text ?? "").slice(0, 220), topicId: e.topicId,
    }));
    this.store.audit(actor, "kb.ask", "qa", question.slice(0, 80), `引用 ${citations.length} 条 · ${this.modelKind} 通道`);
    return {
      answer, citations, topics: topics.map((t) => ({ id: t.id, title: t.title })), modelKind: this.modelKind,
      retrieval: { terms: search, topics: topics.length, entries: picked.length },
    };
  }

  // ---------------------------------------------------------------- 导出（规格书 11.4）

  /**
   * 主题导出为 Markdown 交付文件：frontmatter + 正文 + 来源证据附录。
   * 返回 { filename, content }，API 层负责下载响应；导出行为记审计。
   */
  exportTopic(id, { actor = "local" } = {}) {
    const topic = this.store.getTopic(id);
    if (!topic) throw new Error("主题不存在");
    const citations = this.store.listCitations(id);
    const fm = [
      "---",
      `id: ${topic.id}`,
      `title: "${topic.title.replace(/"/g, "'")}"`,
      `space: ${topic.space}`,
      `type: ${topic.type}`,
      `status: ${topic.status}`,
      `classification: ${topic.classification}`,
      `version: ${topic.version}`,
      `exported: ${new Date().toISOString()}`,
      `tags: [${(topic.tags ?? []).map((t) => `"${t.replace(/"/g, "'")}"`).join(", ")}]`,
      "---",
    ].join("\n");
    const appendix = citations.length
      ? `\n\n## 来源证据\n\n${citations.map((c, i) => `${i + 1}. **${c.source_name}**${c.frag_locator ? `（${c.frag_locator}）` : ""}\n   > ${(c.frag_text ?? "").replace(/\n/g, "\n   > ").slice(0, 300)}`).join("\n")}`
      : "";
    this.store.audit(actor, "topic.export", id, "", topic.title);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      filename: `${topic.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}-${stamp}.md`,
      content: `${fm}\n\n# ${topic.title}\n\n${topic.body}${appendix}\n`,
    };
  }

  // ---------------------------------------------------------------- 健康检查（P0 简化版）

  healthCheck({ scope = "all" } = {}) {
    const issues = [];
    // 失联来源
    for (const s of this.store.listSources({ limit: 1000 })) {
      if (s.managed) continue;
      if (s.path && !existsSync(s.path)) {
        issues.push({ type: "missing-source", severity: "medium", target: s.id, title: `来源不可用：${s.name}`, detail: s.path });
      }
    }
    // 无引用的已发布主题
    for (const t of this.store.listTopics({ status: "published", limit: 500 })) {
      const cites = this.store.listCitations(t.id).length;
      if (!cites) issues.push({ type: "no-citation", severity: "low", target: t.id, title: `证据不足：${t.title}`, detail: "已发布但没有任何来源引用" });
    }
    // 冲突
    for (const t of this.store.listTopics({ limit: 500 })) {
      if (t.conflict) issues.push({ type: "conflict", severity: "high", target: t.id, title: `内容冲突：${t.title}`, detail: "Obsidian 与工作台草稿冲突，需要人工处理" });
    }
    void scope;
    return { checkedAt: Date.now(), issues };
  }

  // ---------------------------------------------------------------- 备份（规格书 13.2）

  backupStatus() {
    const ok = existsSync(this.backupDir);
    let history = [];
    if (ok) {
      history = readdirSync(this.backupDir).filter((n) => n.startsWith("kb-")).sort().reverse().slice(0, 30);
    }
    return { dir: this.backupDir, available: ok, history };
  }

  backup(kind = "incremental") {
    if (!existsSync(this.backupDir)) {
      return { ok: false, error: `备份目标不可用：${this.backupDir}（未加密备份盘未挂载或路径不存在）` };
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const dir = join(this.backupDir, `kb-${kind}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    // 1) DB + 审计（直接拷贝，WAL 模式下 checkpoint 后的 db 文件可用）
    copyFileSync(this.store.dbPath, join(dir, "knowledge.db"));
    // 2) Vault
    const vaultTarget = join(dir, "vault");
    this.copyTree(this.vaultDir, vaultTarget);
    // 3) 配置（gateway.config.json 的 knowledge 段在主配置里，这里存一份服务参数）
    writeFileSync(join(dir, "knowledge-config.json"), JSON.stringify({ vaultDir: this.vaultDir, backupDir: this.backupDir, at: Date.now(), kind }, null, 2));
    this.store.audit("local", "backup.run", dir, "", kind);
    return { ok: true, dir, kind, at: Date.now() };
  }

  maybeBackup() {
    // 简化策略：每天第一次触发做增量；周日做全量。状态由 backupStatus 展示。
    const last = this.store.getSetting("lastBackupDay");
    const today = new Date().toISOString().slice(0, 10);
    if (last === today) return null;
    const kind = new Date().getDay() === 0 ? "full" : "incremental";
    const result = this.backup(kind);
    if (result.ok) this.store.setSetting("lastBackupDay", today);
    return result;
  }

  copyTree(from, to) {
    if (!existsSync(from)) return;
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dst = join(to, name);
      const st = statSync(src);
      if (st.isDirectory()) this.copyTree(src, dst);
      else copyFileSync(src, dst);
    }
  }

  /** 恢复：把备份的 vault 与 db 覆盖回来（管理员 + 前端二次确认后调用）。 */
  restore(backupName) {
    const dir = join(this.backupDir, backupName);
    if (!existsSync(join(dir, "knowledge.db"))) throw new Error("备份不存在或不完整");
    this.copyTree(join(dir, "vault"), this.vaultDir);
    copyFileSync(join(dir, "knowledge.db"), this.store.dbPath);
    this.store.audit("local", "backup.restore", dir, "", "恢复完成，重启网关后生效");
    return { ok: true, note: "已恢复，重启网关服务后生效" };
  }

  // ---------------------------------------------------------------- 设置

  describe() {
    return {
      vaultDir: this.vaultDir,
      backupDir: this.backupDir,
      spaces: Object.values(SPACES),
      types: TOPIC_TYPES,
      boot: this.bootSummary,
      backup: this.backupStatus(),
      ocr: ocrStatus(),
      askChannel: this.askModel ? this.modelKind : "none",
      cloudRule: { public: "可使用普通云模型", internal: "仅摘要或脱敏片段可上云", secret: "禁止上云，只能本地处理" },
    };
  }
}
