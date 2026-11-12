/**
 * 产品中枢知识库 · /api/knowledge/* 路由组。
 *
 * 独立于现有 workbench API，避免主 API 继续膨胀（规格书 14.2）。
 * 文件上传不走 api.mjs 的 2MB JSON 限制：POST /api/knowledge/imports/files
 * 用 raw body + query 传元数据，单文件上限 200MB（超大文件建议登记外部路径）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { KnowledgeService, DEFAULTS } from "./index.mjs";
import { SPACES, TOPIC_TYPES, CLASSIFICATIONS, TOPIC_STATUS_NAME, CLASSIFICATION_NAME, CLOUD_RULE } from "./store.mjs";

const MAX_UPLOAD = 200 * 1024 * 1024;

/** 灵感附件预览要按真实类型返回，否则浏览器把 png 当下载。 */
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 从 gateway.config.json 的 knowledge 段或 env 解析目录参数。 */
export function knowledgeOptions(configPath, env = {}) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(configPath, "utf8"))?.knowledge ?? {};
  } catch { /* 没有配置段用默认 */ }
  return {
    vaultDir: env.WORKBUDDY_KNOWLEDGE_VAULT?.trim() || fileConfig.vaultDir || DEFAULTS.vaultDir,
    backupDir: env.WORKBUDDY_KNOWLEDGE_BACKUP?.trim() || fileConfig.backupDir || DEFAULTS.backupDir,
  };
}

export function createKnowledgeApi({ stateDir, options, askModel = null }) {
  const service = new KnowledgeService({ stateDir, config: options, askModel });
  const boot = service.boot();

  const json = (res, status, body) => {
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    }
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, message) => json(res, status, { error: message });

  const readRawBody = async (req, limit = MAX_UPLOAD) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("上传内容超过上限");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  const readJsonBody = async (req, limit = 2 * 1024 * 1024) => {
    const raw = await readRawBody(req, limit);
    if (!raw.length) return {};
    return JSON.parse(raw.toString("utf8"));
  };

  /** 空间内各目录的主题数：列表顶部的「目录」分档用，和数据一样来自 DB，不再扫盘。 */
  const folderStats = (svc, space) => {
    const map = new Map();
    for (const t of svc.store.listTopics({ space, status: undefined, limit: 1000 })) {
      if (t.status === "deleted" || !t.vault_path) continue;
      const p = String(t.vault_path);
      if (!p.includes("/")) continue;
      const dir = p.slice(0, p.lastIndexOf("/"));
      map.set(dir, (map.get(dir) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([dir, count]) => ({ dir, name: dir.split("/").pop(), count }))
      .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
  };

  const topicView = (topic) => ({
    ...topic,
    statusName: TOPIC_STATUS_NAME[topic.status] ?? topic.status,
    classificationName: CLASSIFICATION_NAME[topic.classification] ?? topic.classification,
    // 摘要来源：详情页标注「自动摘取 · 产品概述 · 第 3 页」
    summarySource: topic.summary_source ?? "",
    summaryAuto: Boolean(topic.summary_auto),
    // 目录：Vault 里实际所在的文件夹（`10-调研Wiki/02-主题汇编`）。
    // 同一类型可能落在几个目录（主题汇编 vs 主题页），列表按目录分档比按类型更贴近 Vault 真实结构。
    folder: String(topic.vault_path ?? "").includes("/")
      ? String(topic.vault_path).slice(0, String(topic.vault_path).lastIndexOf("/"))
      : "",
    citations: undefined,
  });

  // ---------------------------------------------------------------- 主分发
  return {
    service,
    boot,
    async handle(req, res, path, url) {
      const method = req.method;
      const params = url.searchParams;

      // ---------- 元信息
      if (method === "GET" && path === "/api/knowledge/bootstrap") {
        return json(res, 200, {
          ...service.describe(),
          stats: service.store.stats(),
          spaces: Object.values(SPACES).map((s) => ({
            ...s,
            types: TOPIC_TYPES[s.key],
            // Vault 里这个空间实际用到的目录（类型目录 + 主题汇编这类分册目录），列表按目录分档
            folders: folderStats(service, s.key),
          })),
          classifications: Object.entries(CLASSIFICATION_NAME).map(([key, name]) => ({ key, name, rule: CLOUD_RULE[key].note })),
        });
      }

      // ---------- 主题
      if (path === "/api/knowledge/repair-links" && method === "POST") {
        // 死链自愈也可手动触发：Vault 里批量重命名后，不必等下一轮同步
        const repaired = service.repairDeadLinks();
        return json(res, 200, { ...repaired, synced: service.syncVaultIntoDb() });
      }

      if (path === "/api/knowledge/topics" && method === "GET") {
        const space = params.get("space") || undefined;
        const status = params.get("status") || undefined;
        const folder = params.get("folder") || "";
        const items = service.store.listTopics({
          space, status,
          type: params.get("type") || undefined,
          classification: params.get("classification") || undefined,
          limit: Math.min(Number(params.get("limit")) || 100, 500),
        }).map(topicView).filter((t) => !folder || t.folder === folder);
        return json(res, 200, { items });
      }

      if (path === "/api/knowledge/topics" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const topic = service.store.createTopic(body);
          return json(res, 200, topicView(topic));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      let m = /^\/api\/knowledge\/topics\/([\w-]+)$/.exec(path);
      if (m && method === "GET") {
        const topic = service.store.getTopic(m[1]);
        if (!topic) return fail(res, 404, "主题不存在");
        return json(res, 200, {
          ...topicView(topic),
          citations: service.store.listCitations(m[1]),
          versions: service.store.db.prepare("SELECT version, note, author, created_at FROM topic_versions WHERE topic_id = ? ORDER BY version DESC").all(m[1]),
          conflict: topic.conflict ? JSON.parse(topic.conflict) : null,
        });
      }

      m = /^\/api\/knowledge\/topics\/([\w-]+)\/(\w+)$/.exec(path);
      if (m) {
        const [, id, action] = m;
        try {
          if (method === "PATCH" && action === "draft") {
            const body = await readJsonBody(req);
            return json(res, 200, topicView(service.store.updateTopic(id, body)));
          }
          if (method === "POST" && action === "submit") {
            // 提交审核：建一条人工审核记录（单级审核），主题进入待审核
            service.store.setTopicStatus(id, "pending");
            service.store.createReview({ kind: "topic", topicId: id, title: service.store.getTopic(id).title, createdBy: "local" });
            return json(res, 200, topicView(service.store.getTopic(id)));
          }
          if (method === "POST" && action === "publish") {
            return json(res, 200, topicView(service.publishTopic(id)));
          }
          if (method === "POST" && action === "archive") {
            return json(res, 200, topicView(service.store.setTopicStatus(id, "archived")));
          }
          if (method === "POST" && action === "move") {
            // 空间迁移：调研 ↔ 企划 ↔ 产品 ↔ 灵感（Vault 文件同步搬家）
            const body = await readJsonBody(req);
            const result = service.moveTopic(id, { space: body.space, type: body.type });
            return json(res, 200, { ...result, topic: topicView(result.topic) });
          }
          if (method === "POST" && action === "spawn") {
            // 灵感流转：在目标空间长出派生主题，灵感原件保留（与 move 的「搬家」是两回事）
            const body = await readJsonBody(req);
            const result = service.spawnFromIdea(id, { space: body.space, type: body.type, title: body.title });
            return json(res, 200, { ...result, idea: topicView(result.idea), topic: topicView(result.topic) });
          }
          if (method === "POST" && action === "summarize") {
            // 摘要自动摘取：预览 + 可写回（apply=true）
            const body = await readJsonBody(req);
            const result = service.summarizeTopic(id, { apply: body.apply === true });
            return json(res, 200, { ...result, topic: result.topic ? topicView(result.topic) : undefined });
          }
          if (method === "POST" && action === "rollback") {
            const body = await readJsonBody(req);
            return json(res, 200, topicView(service.store.rollbackTopic(id, Number(body.version))));
          }
          if (method === "DELETE" && action === "archive") {
            // 软删除（规格书 6.5）：默认归档语义，永久删除 P0 不开放界面
            return json(res, 200, topicView(service.store.setTopicStatus(id, "deleted")));
          }
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 批量操作（列表多选：ids 为空时按空间/类型/密级筛选）
      if (path === "/api/knowledge/topics/bulk-submit" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.bulkSubmit({
            ids: Array.isArray(body.ids) ? body.ids : undefined,
            space: body.space, type: body.type, classification: body.classification,
          }));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/topics/bulk-move" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.bulkMove({
            ids: Array.isArray(body.ids) ? body.ids : [],
            space: body.space, type: body.type,
          }));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/topics/bulk-delete" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.bulkDelete({ ids: Array.isArray(body.ids) ? body.ids : [] }));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/topics/bulk-export" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const file = service.bulkExport({ ids: Array.isArray(body.ids) ? body.ids : [] });
          res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "content-length": file.buffer.length,
            "cache-control": "no-store",
          });
          res.end(file.buffer);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
        // 自己写完响应，返回真值避免主分发二次写头
        return true;
      }

      if (path === "/api/knowledge/reviews/bulk-approve" && method === "POST") {
        try {
          return json(res, 200, service.bulkApprove());
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 摘要批量重算（自动摘取补齐历史数据）
      if (path === "/api/knowledge/summaries/recompute" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.recomputeSummaries({
            space: body.space || undefined,
            force: body.force === true,
            // 默认仍然回写 Vault；body.writeVault === false 时只补工作台这一层
            writeVault: body.writeVault !== false,
          }));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 知识图谱（规格书 11.2）
      if (path === "/api/knowledge/graph" && method === "GET") {
        const graph = service.store.buildGraph({ limit: Math.min(Number(params.get("limit")) || 150, 400) });
        return json(res, 200, graph);
      }

      // ---------- 受控词表（规格书 10）
      if (path === "/api/knowledge/vocab" && method === "GET") {
        return json(res, 200, { items: service.store.vocabStats() });
      }
      if (path === "/api/knowledge/vocab/rename" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.store.renameTag(body.from, body.to));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- AI 问答（带引用）
      if (path === "/api/knowledge/ask" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const question = String(body.question ?? "").trim();
          if (!question) throw new Error("先输入问题");
          const result = await service.ask(question);
          return json(res, 200, result);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 导出为 Markdown 交付文件（规格书 11.4）
      m = /^\/api\/knowledge\/topics\/([\w-]+)\/export$/.exec(path);
      if (m && method === "POST") {
        try {
          const file = service.exportTopic(m[1]);
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "cache-control": "no-store",
          });
          res.end(file.content);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
        // 已自己写完响应，必须返回真值，否则主分发会当「未处理」再写一次头
        return true;
      }

      // ---------- 搜索
      if (path === "/api/knowledge/search" && method === "GET") {
        const started = Date.now();
        const result = service.store.search(params.get("q") ?? "", {
          space: params.get("space") || undefined,
          status: params.get("status") || "published",
          // 双索引：all = 摘要层 + 正文层；summary 只搜摘要；body 只搜正文
          scope: ["summary", "body"].includes(params.get("scope")) ? params.get("scope") : "all",
          limit: Math.min(Number(params.get("limit")) || 20, 50),
        });
        return json(res, 200, { ...result, tookMs: Date.now() - started });
      }

      // ---------- 灵感随手记：附件与一步收下
      if (path === "/api/knowledge/attachments" && method === "POST") {
        try {
          const name = params.get("name") || "附件";
          const buffer = await readRawBody(req, 40 * 1024 * 1024);
          const row = service.saveAttachment(buffer, name);
          return json(res, 200, { ...row, url: `/api/knowledge/attachments/${row.id}` });
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      m = /^\/api\/knowledge\/attachments\/([\w-]+)$/.exec(path);
      if (m && method === "GET") {
        const row = service.store.getAttachment(m[1]);
        if (!row) return fail(res, 404, "附件不存在");
        const abs = join(service.vaultDir, row.path);
        if (!existsSync(abs)) return fail(res, 404, "附件文件已不在磁盘上（可能在 Obsidian 里被移动或删除）");
        const type = MIME[extname(row.name).toLowerCase()] ?? "application/octet-stream";
        const stat = statSync(abs);
        res.writeHead(200, {
          "content-type": type,
          "content-length": stat.size,
          "cache-control": "private, max-age=300",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        });
        res.end(readFileSync(abs));
        return true;
      }

      if (path === "/api/knowledge/inbox" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const result = service.captureInbox({
            text: body.text ?? "",
            title: body.title ?? "",
            attachments: Array.isArray(body.attachments) ? body.attachments : [],
            space: body.space,
            type: body.type,
          });
          return json(res, 200, result);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 导入
      if (path === "/api/knowledge/imports/files" && method === "POST") {
        try {
          const name = params.get("name") || "未命名文件";
          const buffer = await readRawBody(req);
          const result = service.importFiles(params.get("batch") || name, [{
            name,
            buffer,
            space: params.get("space") || undefined,
            topicType: params.get("type") || undefined,
            classification: params.get("classification") || "internal",
          }]);
          return json(res, 200, result);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/imports/text" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const result = service.importText(body.name || "粘贴文本", body.text ?? "", {
            space: body.space, topicType: body.type, classification: body.classification,
          });
          return json(res, 200, result);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/imports/url" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          if (!/^https?:\/\//.test(body.url ?? "")) throw new Error("请提供 http(s) 链接");
          const result = await service.importUrl(body.url, {
            space: body.space, topicType: body.type, classification: body.classification,
          });
          return json(res, 200, result);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      if (path === "/api/knowledge/imports" && method === "GET") {
        return json(res, 200, { items: service.store.listImports() });
      }

      // ---------- 来源
      m = /^\/api\/knowledge\/sources\/([\w-]+)$/.exec(path);
      if (m && method === "GET") {
        const source = service.store.db.prepare("SELECT * FROM sources WHERE id = ?").get(m[1]);
        if (!source) return fail(res, 404, "来源不存在");
        const missing = source.managed === 0 && source.path && !existsSync(source.path);
        if (missing && !source.missing) service.store.updateSource(source.id, { missing: 1 });
        return json(res, 200, { ...source, missing, fragments: service.store.listFragments(source.id) });
      }

      if (path === "/api/knowledge/sources" && method === "GET") {
        return json(res, 200, { items: service.store.listSources({ limit: 300 }) });
      }

      // ---------- 审核
      if (path === "/api/knowledge/reviews" && method === "GET") {
        return json(res, 200, { items: service.store.listReviews({ status: params.get("status") || "pending" }) });
      }

      m = /^\/api\/knowledge\/reviews\/([\w-]+)\/decide$/.exec(path);
      if (m && method === "POST") {
        try {
          const body = await readJsonBody(req);
          // 审核结论联动主题状态：通过 → 发布回写 Vault；退回/修改后通过 → 待修订
          const review = service.decideReview(m[1], body.status, body.comment);
          return json(res, 200, review);
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 健康检查
      if (path === "/api/knowledge/health" && method === "GET") {
        return json(res, 200, service.healthCheck());
      }
      if (path === "/api/knowledge/health" && method === "POST") {
        return json(res, 200, service.healthCheck());
      }

      // ---------- 备份
      if (path === "/api/knowledge/backups" && method === "GET") {
        return json(res, 200, service.backupStatus());
      }
      if (path === "/api/knowledge/backups/run" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          return json(res, 200, service.backup(body.kind === "full" ? "full" : "incremental"));
        } catch (error) { return fail(res, 500, error?.message || String(error)); }
      }
      if (path === "/api/knowledge/backups/restore" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          if (!body.confirm) throw new Error("恢复操作需要二次确认（confirm: true）");
          return json(res, 200, service.restore(String(body.name ?? "")));
        } catch (error) { return fail(res, 400, error?.message || String(error)); }
      }

      // ---------- 审计
      if (path === "/api/knowledge/audit" && method === "GET") {
        return json(res, 200, { items: service.store.listAudit({ limit: Math.min(Number(params.get("limit")) || 100, 500) }) });
      }

      // ---------- 运行记录（导入任务 + 健康检查历史）
      if (path === "/api/knowledge/ops" && method === "GET") {
        return json(res, 200, {
          imports: service.store.listImports(30),
          audit: service.store.listAudit({ limit: 30 }),
          health: service.healthCheck(),
        });
      }

      return false;
    },
  };
}
