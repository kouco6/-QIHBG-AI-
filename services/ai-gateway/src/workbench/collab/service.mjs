/**
 * 任务协作 · 存储与服务。
 *
 * 模型：平台账号（每人一个推送 Token）→ 向指定任务/项目推送「产物 / 动态」两档内容。
 * 服务端只做事实记录：谁（账号）、用什么 AI（推送端声明）、什么时候、推了什么。
 * 身份与角色都在 accounts 服务里，这里只存 member_id/member_name 快照用于展示。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export { ROLES as MEMBER_ROLES, roleLabel, isRole } from "../accounts/service.mjs";
import { isRole } from "../accounts/service.mjs";

export const KINDS = ["artifact", "note"];
export const KIND_NAME = { artifact: "产物", note: "动态" };

export class CollabService {
  constructor({ stateDir, accounts } = {}) {
    this.stateDir = stateDir;
    this.accounts = accounts; // AccountsService：推送 Token 校验与身份来源
    this.filesDir = join(stateDir, "collab-files");
    this.db = null;
  }

  boot() {
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(join(this.stateDir, "collab.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_pushes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT,
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
      CREATE TABLE IF NOT EXISTS collab_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        admin_agent TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_project_agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        duty TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_project_members (
        project_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'other',
        created_at TEXT NOT NULL,
        UNIQUE(project_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pushes_task ON collab_pushes(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pagents_project ON collab_project_agents(project_id, created_at);
    `);
    // 旧库平滑升级：推送挂项目（索引必须在加列之后建，否则旧库启动即崩）
    const cols = (t) => this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (cols("collab_pushes").length && !cols("collab_pushes").includes("project_id")) {
      this.db.exec("ALTER TABLE collab_pushes ADD COLUMN project_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pushes_project ON collab_pushes(project_id, created_at)");
    // 旧库平滑升级：项目要记创建人（普通账号建的项目由他自己管）
    if (cols("collab_projects").length && !cols("collab_projects").includes("created_by")) {
      this.db.exec("ALTER TABLE collab_projects ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
    }
  }

  shutdown() {
    try { this.db?.close(); } catch { /* 已关闭 */ }
  }

  // ---------- 身份（委托 accounts 服务） ----------

  /** 旧版 collab_members 表残留数据（迁移到账号用）。表不存在返回空数组。 */
  legacyMembers() {
    try {
      return this.db.prepare("SELECT id, name, token_hash, token_hint, active, created_at FROM collab_members").all();
    } catch { return []; }
  }

  listMembers() {
    return (this.accounts?.listAccounts() ?? []).map(a => ({ ...a, active: a.active ? 1 : 0 }));
  }

  /** 推送 Token → 账号。 */
  memberByToken(token) {
    if (!token) return null;
    // 服务 Token（任务产物自动归档）：合法即放行，归档以「服务器」身份落库
    if (String(token).startsWith("svc_")) {
      return this.accounts?.accountByAnyToken?.(token) ? { id: "service", name: "服务器" } : null;
    }
    return this.accounts?.accountByPushToken(token) ?? null;
  }

  // ---------- 项目成员（账号可见性） ----------

  listProjectMembers(projectId) {
    return this.db.prepare(`
      SELECT account_id AS accountId, name, role, created_at AS createdAt
      FROM collab_project_members WHERE project_id = ? ORDER BY created_at
    `).all(projectId);
  }

  addProjectMember(projectId, account) {
    if (!this.getProject(projectId)) throw new Error("项目不存在");
    if (!account?.id) throw new Error("缺少账号");
    this.db.prepare(`
      INSERT INTO collab_project_members (project_id, account_id, name, role, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, account_id) DO UPDATE SET name = excluded.name, role = excluded.role
    `).run(projectId, account.id, account.name, isRole(account.role) ? account.role : "other",
      new Date().toISOString());
    return this.listProjectMembers(projectId);
  }

  removeProjectMember(projectId, accountId) {
    this.db.prepare("DELETE FROM collab_project_members WHERE project_id = ? AND account_id = ?")
      .run(projectId, accountId);
  }

  /** 账号可见的项目 ID 集合：管理员为 null（全部），普通账号为其参与的项目。 */
  visibleProjectIds(account) {
    if (!account || account.role === "admin") return null;
    return new Set(this.db.prepare(
      "SELECT project_id FROM collab_project_members WHERE account_id = ?"
    ).all(account.id).map((r) => r.project_id));
  }

  // ---------- 推送 ----------

  ingest({ token, taskId, projectId, agent, kind = "artifact", title = "", body = "", file } = {}) {
    const member = this.memberByToken(token);
    if (!member) throw new Error("无效的推送 Token");
    const cleanTask = String(taskId ?? "").trim();
    const cleanProject = String(projectId ?? "").trim();
    if (!cleanTask && !cleanProject) throw new Error("缺少目标任务或项目");
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
      INSERT INTO collab_pushes (id, task_id, project_id, member_id, member_name, agent, kind, title, body,
        file_path, file_name, mime, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanTask || "-", cleanProject || null, member.id, member.name, cleanAgent, cleanKind, cleanTitle,
      cleanBody, stored?.filePath ?? null, stored?.fileName ?? null,
      stored?.mime ?? null, stored?.size ?? null, now);
    return this.getPush(id);
  }

  getPush(id) {
    const row = this.db.prepare(`
      SELECT id, task_id AS taskId, project_id AS projectId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes WHERE id = ?
    `).get(id);
    return row ?? null;
  }

  listPushes({ taskId, projectId, kind, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (taskId) { where.push("task_id = ?"); args.push(taskId); }
    if (projectId) { where.push("project_id = ?"); args.push(projectId); }
    if (kind) { where.push("kind = ?"); args.push(kind); }
    if (!where.length) return [];
    const rows = this.db.prepare(`
      SELECT id, task_id AS taskId, project_id AS projectId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args, Math.min(Number(limit) || 100, 500));
    return rows;
  }

  countByTask(taskId) {
    const row = this.db.prepare(
      "SELECT kind, COUNT(*) n FROM collab_pushes WHERE task_id = ? GROUP BY kind"
    ).all(taskId);
    return Object.fromEntries(row.map((r) => [r.kind, r.n]));
  }

  /** 跨任务/跨项目的全量推送（协作总览页用）。visibleIds 限定时，项目推送只含可见项目。 */
  listAllPushes({ memberId, agent, kind, projectId, since, visibleIds, limit = 300 } = {}) {
    const where = [];
    const args = [];
    if (memberId) { where.push("member_id = ?"); args.push(memberId); }
    if (agent) { where.push("agent = ?"); args.push(agent); }
    if (kind) { where.push("kind = ?"); args.push(kind); }
    if (projectId) { where.push("project_id = ?"); args.push(projectId); }
    if (since) { where.push("created_at >= ?"); args.push(since); }
    if (visibleIds) {
      const ids = [...visibleIds];
      if (ids.length) {
        where.push("(project_id IS NULL OR project_id IN (" + ids.map(() => "?").join(",") + "))");
        args.push(...ids);
      } else {
        // 一个项目都没参与：只看得到任务推送
        where.push("project_id IS NULL");
      }
    }
    const rows = this.db.prepare(`
      SELECT id, task_id AS taskId, project_id AS projectId, member_id AS memberId, member_name AS memberName,
        agent, kind, title, body, file_name AS fileName, mime, size, created_at AS createdAt
      FROM collab_pushes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args, Math.min(Number(limit) || 300, 1000));
    return rows;
  }

  /** 协作总览：推送流 + 全局计数 + 成员/来源分布。筛选只影响 items，不影响统计口径。 */
  overview({ memberId, agent, kind, limit, visibleIds } = {}) {
    const items = this.listAllPushes({ memberId, agent, kind, limit, visibleIds });
    const scope = visibleIds ? { visibleIds } : {};
    const totals = Object.fromEntries(
      this.listAllPushes({ ...scope, limit: 1000 }).reduce((acc, p) => {
        acc.set(p.kind, (acc.get(p.kind) ?? 0) + 1); return acc;
      }, new Map())
    );
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = this.listAllPushes({ ...scope, since: start.toISOString(), limit: 1000 }).length;
    const agentsMap = new Map();
    for (const p of this.listAllPushes({ ...scope, limit: 1000 })) {
      agentsMap.set(p.agent, (agentsMap.get(p.agent) ?? 0) + 1);
    }
    const agents = [...agentsMap].map(([ag, n]) => ({ agent: ag, count: n })).sort((a, b) => b.count - a.count);
    const taskMap = new Map();
    for (const p of this.listAllPushes({ ...scope, limit: 1000 })) {
      const cur = taskMap.get(p.taskId) ?? { taskId: p.taskId, count: 0, lastAt: "" };
      cur.count += 1;
      if (p.createdAt > cur.lastAt) cur.lastAt = p.createdAt;
      taskMap.set(p.taskId, cur);
    }
    const taskRows = [...taskMap.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      return {
      items,
      totals: { artifact: totals.artifact ?? 0, note: totals.note ?? 0, all: (totals.artifact ?? 0) + (totals.note ?? 0) },
      todayCount: Number(today),
      agents,
      tasks: taskRows,
      members: this.accounts?.listAccounts() ?? [],
      projects: this.listProjects({ visibleIds }),
    };
  }

  // ---------- 项目（协作模块顶层容器） ----------

  listProjects({ visibleIds } = {}) {
    const filter = visibleIds
      ? (visibleIds.size
        ? `AND p.id IN (${[...visibleIds].map(() => "?").join(",")})`
        : "AND 0")
      : "";
    return this.db.prepare(`
      SELECT p.id, p.name, p.goal, p.admin_agent AS adminAgent, p.status, p.created_by AS createdBy, p.created_at AS createdAt,
        (SELECT COUNT(*) FROM collab_pushes x WHERE x.project_id = p.id) AS pushCount,
        (SELECT COUNT(*) FROM collab_project_agents a WHERE a.project_id = p.id) AS agentCount,
        (SELECT COUNT(*) FROM collab_project_members m WHERE m.project_id = p.id) AS memberCount,
        (SELECT MAX(x.created_at) FROM collab_pushes x WHERE x.project_id = p.id) AS lastAt
      FROM collab_projects p WHERE p.status != 'deleted' ${filter}
      ORDER BY p.created_at DESC
    `).all(...(visibleIds ? [...visibleIds] : []));
  }

  getProject(id) {
    return this.db.prepare(
      "SELECT id, name, goal, admin_agent AS adminAgent, status, created_by AS createdBy, created_at AS createdAt FROM collab_projects WHERE id = ? AND status != 'deleted'"
    ).get(id) ?? null;
  }

  createProject({ name, goal = "", adminAgent = "", creator } = {}) {
    const clean = String(name ?? "").trim().slice(0, 60);
    if (!clean) throw new Error("项目名不能为空");
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO collab_projects (id, name, goal, admin_agent, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, clean, String(goal ?? "").trim().slice(0, 500), String(adminAgent ?? "").trim(),
      creator?.id ?? "", new Date().toISOString());
    // 非管理员建的项目，建了就在里面（否则自己都看不见）
    if (creator?.id && creator.role !== "admin") {
      this.addProjectMember(id, creator);
    }
    return this.getProject(id);
  }

  /** 能管这个项目的人：管理人员，或项目创建人。 */
  isProjectManager(projectId, account) {
    if (!account?.id) return false;
    if (account.role === "admin") return true;
    const project = this.getProject(projectId);
    return Boolean(project && project.createdBy && project.createdBy === account.id);
  }

  updateProject(id, { name, goal, adminAgent, status } = {}) {
    const cur = this.getProject(id);
    if (!cur) throw new Error("项目不存在");
    this.db.prepare(`
      UPDATE collab_projects SET name = ?, goal = ?, admin_agent = ?, status = ? WHERE id = ?
    `).run(
      String(name ?? cur.name).trim().slice(0, 60) || cur.name,
      String(goal ?? cur.goal).trim().slice(0, 500),
      String(adminAgent ?? cur.adminAgent).trim(),
      status === "archived" ? "archived" : cur.status,
      id,
    );
    return this.getProject(id);
  }

  /** 删项目：软删；已推到项目里的输出保留，解绑为「无项目」。 */
  deleteProject(id) {
    this.db.prepare("UPDATE collab_projects SET status = 'deleted' WHERE id = ?").run(id);
    this.db.prepare("UPDATE collab_pushes SET project_id = NULL WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM collab_project_agents WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM collab_project_members WHERE project_id = ?").run(id);
  }

  // ---------- 项目内的 AI 员工 ----------

  listProjectAgents(projectId) {
    return this.db.prepare(`
      SELECT id, project_id AS projectId, agent_id AS agentId, name, role, duty, skills, created_at AS createdAt
      FROM collab_project_agents WHERE project_id = ? ORDER BY created_at
    `).all(projectId).map((row) => ({ ...row, skills: this.#parseSkills(row.skills) }));
  }

  #parseSkills(raw) {
    try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  addProjectAgent({ projectId, agentId = "", name, role = "", duty = "", skills = [] } = {}) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const cleanName = String(name ?? "").trim().slice(0, 40);
    if (!cleanName) throw new Error("AI 员工名称不能为空");
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO collab_project_agents (id, project_id, agent_id, name, role, duty, skills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, String(agentId ?? "").trim(), cleanName,
      String(role ?? "").trim().slice(0, 60), String(duty ?? "").trim().slice(0, 500),
      JSON.stringify(Array.isArray(skills) ? skills.map(String).slice(0, 20) : []),
      new Date().toISOString());
    return this.db.prepare("SELECT * FROM collab_project_agents WHERE id = ?").get(id);
  }

  updateProjectAgent(id, { agentId, name, role, duty, skills } = {}) {
    const cur = this.db.prepare("SELECT * FROM collab_project_agents WHERE id = ?").get(id);
    if (!cur) throw new Error("AI 员工不存在");
    this.db.prepare(`
      UPDATE collab_project_agents SET agent_id = ?, name = ?, role = ?, duty = ?, skills = ? WHERE id = ?
    `).run(
      String(agentId ?? cur.agent_id).trim(),
      String(name ?? cur.name).trim().slice(0, 40) || cur.name,
      String(role ?? cur.role).trim().slice(0, 60),
      String(duty ?? cur.duty).trim().slice(0, 500),
      skills === undefined ? cur.skills : JSON.stringify(Array.isArray(skills) ? skills.map(String).slice(0, 20) : []),
      id,
    );
    return this.db.prepare("SELECT * FROM collab_project_agents WHERE id = ?").get(id);
  }

  /** 某个项目 AI 员工属于哪个项目（改/删它时要按所属项目判权限）。 */
  projectIdOfAgent(id) {
    return this.db.prepare("SELECT project_id AS projectId FROM collab_project_agents WHERE id = ?")
      .get(id)?.projectId ?? null;
  }

  removeProjectAgent(id) {
    this.db.prepare("DELETE FROM collab_project_agents WHERE id = ?").run(id);  }

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
}
