/**
 * 任务协作 · 存储与服务。
 *
 * 模型：成员（每人一个推送 Token）→ 向指定任务推送「产物 / 动态」两档内容。
 * 服务端只做事实记录：谁（成员）、用什么 AI（推送端声明）、什么时候、推了什么。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const KINDS = ["artifact", "note"];
export const KIND_NAME = { artifact: "产物", note: "动态" };

const hash = (v) => createHash("sha256").update(v).digest("hex");

export class CollabService {
  constructor({ stateDir } = {}) {
    this.stateDir = stateDir;
    this.filesDir = join(stateDir, "collab-files");
    this.db = null;
  }

  boot() {
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(join(this.stateDir, "collab.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_hint TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_pushes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        member_name TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        file_path TEXT,
        file_name TEXT,
        mime TEXT,
        size INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pushes_task ON collab_pushes(task_id, created_at);
    `);
    this.db.exec("DELETE FROM collab_members WHERE active = 0 AND id NOT IN (SELECT DISTINCT member_id FROM collab_pushes)");
  }

  shutdown() {
    try { this.db?.close(); } catch { /* 已关闭 */ }
  }

  // ---------- 成员 ----------

  createMember(name) {
    const clean = String(name ?? "").trim().slice(0, 24);
    if (!clean) throw new Error("成员名不能为空");
    const dup = this.db.prepare("SELECT id FROM collab_members WHERE name = ?").get(clean);
    if (dup) throw new Error(`成员「${clean}」已存在`);
    return this.issueMember(randomUUID(), clean);
  }

  /** 生成（或轮换）成员 Token。明文只在返回时出现一次，库里只存哈希。 */
  issueMember(id, name) {
    const token = `cb_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO collab_members (id, name, token_hash, token_hint, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash,
        token_hint = excluded.token_hint, active = 1
    `).run(id, name, hash(token), token.slice(0, 9) + "…", now);
    return { id, name, token };
  }

  listMembers() {
    return this.db.prepare(`
      SELECT m.id, m.name, m.token_hint, m.active, m.created_at,
        (SELECT COUNT(*) FROM collab_pushes p WHERE p.member_id = m.id) AS push_count
      FROM collab_members m ORDER BY m.created_at
    `).all();
  }

  removeMember(id) {
    this.db.prepare("UPDATE collab_members SET active = 0 WHERE id = ?").run(id);
  }

  /** Token → 成员。找不到或已停用返回 null。 */
  memberByToken(token) {
    if (!token) return null;
    const row = this.db.prepare(
      "SELECT id, name, active FROM collab_members WHERE token_hash = ?"
    ).get(hash(token));
    return row?.active ? { id: row.id, name: row.name } : null;
  }

  // ---------- 推送 ----------

  ingest({ token, taskId, agent, kind = "artifact", title = "", body = "", file } = {}) {
    const member = this.memberByToken(token);
    if (!member) throw new Error("无效的成员 Token");
    const cleanTask = String(taskId ?? "").trim();
    if (!cleanTask) throw new Error("缺少目标任务");
    const cleanKind = KINDS.includes(kind) ? kind : "artifact";
    const cleanAgent = String(agent ?? "").trim().slice(0, 40) || "未知AI";
    const cleanBody = String(body ?? "");
    if (!file && !cleanBody.trim()) throw new Error("推送内容为空：给一段文字，或带一个文件");
    const cleanTitle = String(title ?? "").trim().slice(0, 120)
      || cleanBody.split("\n")
        .map((l) => l.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, ""))
        .find(Boolean)?.slice(0, 80)
      || file?.name || "未命名";

    let stored = null;
    if (file) {
      const id = randomUUID();
      const safe = file.name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "file";
      const path = join(this.filesDir, `${id}-${safe}`);
      writeFileSync(path, file.data);
      stored = { id, filePath: path, fileName: safe, mime: file.mime || "", size: file.data.length };
    }

    const id = stored?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO collab_pushes (id, task_id, member_id, member_name, agent, kind, title, body,
        file_path, file_name, mime, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanTask, member.id, member.name, cleanAgent, cleanKind, cleanTitle,
      cleanBody, stored?.filePath ?? null, stored?.fileName ?? null,
      stored?.mime ?? null, stored?.size ?? null, now);
    return this.getPush(id);
  }

  getPush(id) {
    const row = this.db.prepare(`
      SELECT id, task_id AS taskId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes WHERE id = ?
    `).get(id);
    return row ?? null;
  }

  listPushes({ taskId, kind, limit = 100 } = {}) {
    if (!taskId) return [];
    const rows = this.db.prepare(`
      SELECT id, task_id AS taskId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes WHERE task_id = ? ${kind ? "AND kind = ?" : ""}
      ORDER BY created_at DESC LIMIT ?
    `).all(...(kind ? [taskId, kind] : [taskId]), Math.min(Number(limit) || 100, 500));
    return rows;
  }

  countByTask(taskId) {
    const row = this.db.prepare(
      "SELECT kind, COUNT(*) n FROM collab_pushes WHERE task_id = ? GROUP BY kind"
    ).all(taskId);
    return Object.fromEntries(row.map((r) => [r.kind, r.n]));
  }

  /** 跨任务的全量推送（协作总览页用）。 */
  listAllPushes({ memberId, agent, kind, since, limit = 300 } = {}) {
    const where = [];
    const args = [];
    if (memberId) { where.push("member_id = ?"); args.push(memberId); }
    if (agent) { where.push("agent = ?"); args.push(agent); }
    if (kind) { where.push("kind = ?"); args.push(kind); }
    if (since) { where.push("created_at >= ?"); args.push(since); }
    const rows = this.db.prepare(`
      SELECT id, task_id AS taskId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args, Math.min(Number(limit) || 300, 1000));
    return rows;
  }

  /** 协作总览：推送流 + 全局计数 + 成员/来源分布。筛选只影响 items，不影响统计口径。 */
  overview({ memberId, agent, kind, limit } = {}) {
    const items = this.listAllPushes({ memberId, agent, kind, limit });
    const totals = Object.fromEntries(
      this.db.prepare("SELECT kind, COUNT(*) n FROM collab_pushes GROUP BY kind").all()
        .map((r) => [r.kind, Number(r.n)])
    );
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = this.db.prepare(
      "SELECT COUNT(*) n FROM collab_pushes WHERE created_at >= ?"
    ).get(start.toISOString()).n;
    const agents = this.db.prepare(
      "SELECT agent, COUNT(*) n FROM collab_pushes GROUP BY agent ORDER BY n DESC"
    ).all().map((r) => ({ agent: r.agent, count: Number(r.n) }));
    const taskRows = this.db.prepare(
      "SELECT task_id AS taskId, COUNT(*) n, MAX(created_at) lastAt FROM collab_pushes GROUP BY task_id ORDER BY lastAt DESC"
    ).all().map((r) => ({ taskId: r.taskId, count: Number(r.n), lastAt: r.lastAt }));
    return {
      items,
      totals: { artifact: totals.artifact ?? 0, note: totals.note ?? 0, all: (totals.artifact ?? 0) + (totals.note ?? 0) },
      todayCount: Number(today),
      agents,
      tasks: taskRows,
      members: this.listMembers(),
    };
  }

  /** 推错了任务：管理员把它挪到别的任务窗。 */
  movePush(id, taskId) {
    const clean = String(taskId ?? "").trim();
    if (!clean) throw new Error("缺少目标任务");
    this.db.prepare("UPDATE collab_pushes SET task_id = ? WHERE id = ?").run(clean, id);
    return this.getPush(id);
  }

  deletePush(id) {
    const row = this.db.prepare("SELECT file_path FROM collab_pushes WHERE id = ?").get(id);
    if (row?.file_path && existsSync(row.file_path)) {
      try { unlinkSync(row.file_path); } catch { /* 留给下次清理 */ }
    }
    this.db.prepare("DELETE FROM collab_pushes WHERE id = ?").run(id);
  }

  /** 读推送附件（带 MIME 返回）。返回 null 表示无附件或已丢失。 */
  readFile(pushId) {
    const row = this.db.prepare("SELECT file_path, mime, file_name FROM collab_pushes WHERE id = ?").get(pushId);
    if (!row?.file_path || !existsSync(row.file_path)) return null;
    return { data: readFileSync(row.file_path), mime: row.mime, name: row.file_name };
  }

  /** 清理没有落任何推送的成员（演示/误建）。 */
  pruneEmptyMembers() {
    return this.db.prepare(`
      DELETE FROM collab_members
      WHERE id NOT IN (SELECT DISTINCT member_id FROM collab_pushes) AND created_at < ?
    `).run(new Date(Date.now() - 24 * 3600 * 1000).toISOString()).changes;
  }
}
