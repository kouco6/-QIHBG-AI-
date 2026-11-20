/**
 * 协作 · 一级页面（左侧导航「协作」）。
 *
 * 两层结构：
 *   卡片墙（默认）—— 项目一张卡：名称/目标/AI 管理员/AI 员工数/产出计数
 *   项目窗     —— 项目头部（改名、换 AI 管理员）+ AI 员工栏（角色/职能/挂工作方法）+ 项目输出流
 * 「全部动态」保留跨项目的推送流。任务抽屉里的 cb-panel 仍负责单任务视角。
 */

import { cApi, onPush, esc, relTime, isImage, agentClass, initViewer, ROLES } from "./collab.js";

const roleLabel = (r) => ROLES[r] ?? ROLES.other;

const state = {
  page: "wall",            // wall | project | stream
  projectId: null,
  overview: null,          // 卡片墙 / 全部动态的聚合数据
  project: null,           // 当前项目窗数据 { project, agents, pushes }
  projectTab: "pushes",    // 项目窗内容页签：pushes 输出 | tasks 任务
  projectTasks: [],        // 当前项目归档的任务列表
  agentsPool: [],          // 网关 AI 员工池（/api/agents）
  skillsPool: [],          // 工作方法池（/api/skills）
  filters: { kind: "", member: "", agent: "" },
  bound: false,
};

const toastError = (message) =>
  import("./dialog.js").then(({ infoDialog }) =>
    infoDialog({ title: "操作未完成", bodyHtml: `<p class="cb-hint">${esc(message)}</p>`, okText: "知道了" }));

async function loadPools() {
  try {
    const [agents, skills, mine] = await Promise.all([
      cApi("/api/agents").catch(() => ({ items: [] })),
      cApi("/api/skills").catch(() => ({ items: [] })),
      cApi("/api/user-agents").catch(() => ({ items: [] })),
    ]);
    // 项目里的 AI 员工既可以是服务器全局员工，也可以是「我的员工」（个人配的，跑在自己电脑上）
    const personal = (mine.items || []).map((agent) => ({ ...agent, name: `${agent.name}（我的）` }));
    state.agentsPool = [...personal, ...(agents.items || [])];
    state.skillsPool = skills.items || [];
  } catch { /* 池子拉不到不阻塞页面 */ }
}

const agentName = (agentId) => state.agentsPool.find((a) => a.id === agentId)?.name || agentId || "未指定";

/** 当前登录用户是否管理人员（overview 返回 viewer，兜底查 /api/auth/me）。 */
const isAdmin = () => {
  if (state.overview?.viewer) return Boolean(state.overview.viewer.isAdmin);
  const role = state.viewerRole;
  return role === "admin" || role === undefined;
};

const viewerId = () => state.overview?.viewer?.id ?? null;

/** 能管这个项目的人：管理人员，或项目创建人。 */
const canManageProject = (p) =>
  isAdmin() || Boolean(p?.createdBy && viewerId() && p.createdBy === viewerId());

/* =========================================================================
   卡片墙
   ========================================================================= */

function projectCard(p) {
  const card = window.platformCreateRecordCard({
    title: p.name, description: p.goal || "还没写项目目标",
    tags: [{ label: p.adminAgent ? `管理 · ${agentName(p.adminAgent)}` : "未设 AI 管理员", variant: p.adminAgent ? "default" : "secondary" }],
    meta: `${p.pushCount} 输出 · ${p.agentCount} AI 员工 · ${p.lastAt ? relTime(p.lastAt) : "暂无动态"}`,
    onOpen: () => openProject(p.id),
  });
  card.dataset.id = p.id;
  return card;
}

function paintWall() {
  const host = document.querySelector("#collabPage");
  if (!host) return;
  const data = state.overview;
  const wall = host.querySelector("#cpWall");
  const grid = wall.querySelector("#pjGrid");
  if (!data) { grid.innerHTML = `<div class="cp-empty">正在拉取…</div>`; return; }
  const projects = data.projects || [];
  grid.replaceChildren(...(projects.length
    ? projects.map(projectCard)
    : [emptyWall()]));
}

function emptyWall() {
  const box = document.createElement("div");
  box.className = "cp-empty";
  const admin = isAdmin();
  box.innerHTML = `
    <h4>${admin ? "还没有项目" : "还没有加入任何项目"}</h4>
    <p>${admin
      ? "项目是协作的顶层容器：成员和 AI 员工围绕一个目标工作，产物和动态都归到项目窗口里。"
      : "你可以自己建一个项目，也可以请同事或管理人员把你加进已有项目。"}</p>
    <p><button type="button" class="btn primary" data-act="new-project">建第一个项目</button></p>`;
  box.querySelector('[data-act="new-project"]').addEventListener("click", () => editProjectDialog(null));
  return box;
}

/* =========================================================================
   全部动态（跨项目推送流）
   ========================================================================= */

function taskChip(p) {
  if (!p.taskId || p.taskId === "-") return "";
  const label = p.taskLabel || `任务 ${String(p.taskId).slice(0, 8)}`;
  return `<button class="cp-task" data-task="${esc(p.taskId)}" title="打开这个任务的详情">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 16 16 8M16 8H9.5M16 8v6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>${esc(label)}</span>
  </button>`;
}

function pushCard(p, { projectMode = false } = {}) {
  const card = document.createElement("article");
  card.className = `cp-card kind-${p.kind}`;
  card.dataset.id = p.id;
  const fileChip = p.fileName
    ? (isImage(p)
      ? `<img class="cb-img" src="/api/collab/files/${p.id}" alt="${esc(p.fileName)}" loading="lazy">`
      : `<a class="cb-file" href="/api/collab/files/${p.id}" download="${esc(p.fileName)}"><span class="cb-file-icon"></span>${esc(p.fileName)}<small>${p.size ? Math.max(1, Math.round(p.size / 1024)) + " KB" : ""}</small></a>`)
    : "";
  const title = String(p.title || "");
  const bodyText = String(p.body || "").trim();
  const firstLine = bodyText.split("\n")[0].trim().replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "");
  // 标题常取正文首行：首行与标题重复时不再贴一遍（产物去掉首行，动态整段省掉）
  const sameHead = firstLine === title.trim();
  const displayBody = sameHead ? bodyText.split("\n").slice(1).join("\n").trim() : bodyText;
  const showBody = displayBody && !(p.kind === "note" && (!displayBody || displayBody === title.trim()));
  const body = showBody
    ? (p.kind === "artifact"
      ? `<pre class="cb-body">${esc(displayBody.length > 420 ? displayBody.slice(0, 420) + "…" : displayBody)}</pre>`
      : `<p class="cp-note">${esc(displayBody.length > 220 ? displayBody.slice(0, 220) + "…" : displayBody)}</p>`)
    : "";
  const memberRole = state.overview?.members?.find((m) => m.id === p.memberId)?.role;
  const admin = isAdmin();
  card.innerHTML = `
    <div class="cb-avatar" title="${esc(p.memberName)}${memberRole ? " · " + roleLabel(memberRole) : ""}">${esc(String(p.memberName || "?").slice(0, 1))}</div>
    <div class="cp-main">
      <header>
        <b>${esc(p.memberName)}</b>
        ${memberRole ? `<span class="cb-role">${esc(roleLabel(memberRole))}</span>` : ""}
        <span class="cb-agent ${agentClass(p.agent)}">${esc(p.agent)}</span>
        <span class="cb-kind">${p.kind === "note" ? "动态" : "产物"}</span>
        <time>${esc(relTime(p.createdAt))}</time>
        ${admin ? `<button class="cp-del danger" title="删除这条推送">删除</button>` : ""}
      </header>
      <h4>${esc(title)}</h4>
      ${body}
      ${fileChip}
      ${taskChip(p) ? `<div class="cp-foot">${taskChip(p)}</div>` : ""}
    </div>`;

  const taskBtn = card.querySelector(".cp-task");
  if (taskBtn) taskBtn.onclick = (e) => {
    const id = e.currentTarget.dataset.task;
    if (id) document.dispatchEvent(new CustomEvent("wb-open-task", { detail: { id } }));
  };
  const delBtn = card.querySelector(".cp-del");
  if (delBtn) delBtn.onclick = async () => {
    const { confirmDialog } = await import("./dialog.js");
    if (!(await confirmDialog({ title: "删除这条推送", message: `「${p.title}」将从协作流中删除，不可恢复。`, tone: "danger" }))) return;
    try {
      await cApi(`/api/collab/pushes/${p.id}`, { method: "DELETE" });
      state.overview && (state.overview.items = state.overview.items.filter((x) => x.id !== p.id));
      state.project && (state.project.pushes = state.project.pushes.filter((x) => x.id !== p.id));
      repaint();
    } catch (err) { toastError(err.message); }
  };
  return window.platformWrapCard(card);
}

function paintStream() {
  const host = document.querySelector("#collabPage");
  const box = host.querySelector("#cpStream");
  const list = box.querySelector("#cpList");
  const items = state.overview?.items || [];
  const filtered = state.filters.kind || state.filters.member || state.filters.agent;
  if (!items.length) {
    list.innerHTML = filtered
      ? `<div class="cp-empty">这个筛选下没有记录。换个条件看看。</div>`
      : `<div class="cp-empty"><h4>还没有推送</h4><p>成员在本机智能体里跑完东西，一条命令推到工作台，就会出现在这里。</p></div>`;
    return;
  }
  list.replaceChildren(...items.map((p) => pushCard(p)));
}

function paintFilters() {
  const host = document.querySelector("#collabPage");
  const box = host.querySelector("#cpFilters");
  if (!box || !state.overview) return;
  const agentOpts = (state.overview.agents || [])
    .map((a) => `<option value="${esc(a.agent)}"${state.filters.agent === a.agent ? " selected" : ""}>${esc(a.agent)} · ${a.count}</option>`)
    .join("");
  const memberOpts = (state.overview.members || [])
    .map((m) => `<option value="${esc(m.id)}"${state.filters.member === m.id ? " selected" : ""}>${esc(m.name)} · ${roleLabel(m.role)}</option>`)
    .join("");
  box.innerHTML = `
    <div id="cpKind"></div>
    <select class="cp-select" aria-label="筛选成员" data-role="member"><option value="">全部成员</option>${memberOpts}</select>
    <select class="cp-select" aria-label="筛选 AI" data-role="agent"><option value="">全部 AI</option>${agentOpts}</select>
    <span class="cp-live" title="新推送会实时出现在这里"><i></i>实时</span>`;

  window.platformRenderSegments(box.querySelector("#cpKind"), { label: "动态类型", value: state.filters.kind,
    items: [["", "全部"], ["artifact", "产物"], ["note", "动态"]].map(([value, label]) => ({ value, label })),
    onValueChange: value => { state.filters.kind = value; loadOverview({ quiet: true }); },
  });
  box.querySelector('[data-role="member"]').onchange = (e) => { state.filters.member = e.target.value; loadOverview({ quiet: true }); };
  box.querySelector('[data-role="agent"]').onchange = (e) => { state.filters.agent = e.target.value; loadOverview({ quiet: true }); };
}

/* =========================================================================
   项目窗
   ========================================================================= */

function agentPoolOptions(selected) {
  return state.agentsPool
    .map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)}</option>`)
    .join("");
}

/* ---------- 项目任务页签 ---------- */

const TASK_STATUS = {
  draft: ["草稿", "st-draft"],
  queued: ["待执行", "st-queued"],
  running: ["执行中", "st-running"],
  attention: ["需关注", "st-attention"],
  ready: ["已完成", "st-done"],
  completed: ["已完成", "st-done"],
  archived: ["已归档", "st-done"],
  failed: ["失败", "st-failed"],
  interrupted: ["中断", "st-failed"],
  cancelled: ["已取消", "st-muted"],
};

const taskStatusLabel = (t) => {
  // 平台把跑完的任务归档成 archived：卡片上仍按原结果叫法展示更直观
  if (t.status === "archived" && t.finalResponse != null) return ["已完成", "st-done"];
  if (t.status === "archived" && t.error) return ["失败", "st-failed"];
  return TASK_STATUS[t.status] || [t.status || "未知", "st-muted"];
};

function paintProjectTasks(box) {
  const host = box || document.querySelector("#collabPage");
  if (!host) return;
  const tasksBox = host.querySelector("#pjTasks");
  if (!tasksBox) return;
  const tasks = state.projectTasks || [];
  if (!tasks.length) {
    tasksBox.innerHTML = `<div class="cp-empty"><h4>这个项目还没有任务</h4>
      <p>在工作台派活时，把「归档到项目」选成这个项目，任务跑完的结论文和产物文件就会自动出现在这里。</p></div>`;
    return;
  }
  tasksBox.replaceChildren(...tasks.map(t => {
    const [statusText, statusClass] = taskStatusLabel(t);
    return window.platformCreateRecordCard({
      title: t.label || t.summary?.slice(0, 60) || "未命名任务",
      description: t.finalResponse ? String(t.finalResponse).slice(0, 80) : undefined,
      tags: [{ label: statusText, variant: statusClass === "st-failed" ? "destructive" : statusClass === "st-done" || statusClass === "st-running" ? "default" : "secondary" }],
      meta: `${agentName(t.agent)} · ${relTime(t.updatedAt || t.createdAt)} · ${(t.artifacts || []).length} 个产物`,
      onOpen: () => document.dispatchEvent(new CustomEvent("wb-open-task", { detail: { id: t.id } })),
    });
  }));
}

function paintProject() {
  const host = document.querySelector("#collabPage");
  const box = host.querySelector("#cpProject");
  const data = state.project;
  if (!data) { box.innerHTML = `<div class="cp-empty">正在打开项目…</div>`; return; }
  const p = data.project;
  const canManage = canManageProject(p);
  box.innerHTML = `
    <header class="pj-head">
      <button type="button" class="pj-back" data-act="back">‹ 返回项目列表</button>
      <div class="pj-head-main">
        <h2>${esc(p.name)}</h2>
        <p>${p.goal ? esc(p.goal) : "还没写项目目标"}</p>
      </div>
      ${canManage
        ? `<div class="pj-head-actions">
            <label class="pj-admin-pick">
              <span>AI 管理员</span>
              <select class="cp-select" aria-label="项目 AI 管理员" data-act="admin">
                <option value="">未指定</option>${agentPoolOptions(p.adminAgent)}
              </select>
            </label>
            <button type="button" class="cp-ghost" data-act="edit">编辑项目</button>
            <button type="button" class="cp-ghost danger" data-act="del">删除项目</button>
          </div>`
        : ""}
    </header>
    <section class="pj-agents-wrap">
      <header class="pj-agents-head">
        <h3>项目成员 <small>${(data.members || []).length} 人</small></h3>
        <span class="pj-agents-hint">只有项目成员（和管理人员）能打开这个项目窗。</span>
        ${canManage ? `<button type="button" class="cp-ghost pj-add-member" data-act="add-member">＋ 添加成员</button>` : ""}
      </header>
      <div class="pj-agents" id="pjMembers"></div>
    </section>
    <section class="pj-agents-wrap">
      <header class="pj-agents-head">
        <h3>AI 员工 <small>${data.agents.length} 人</small></h3>
        <span class="pj-agents-hint">给项目配 AI 员工：定角色、写职能、挂工作方法。二期起 AI 管理员按这里的配置派活。</span>
      </header>
      <div class="pj-agents" id="pjAgents"></div>
    </section>
    <section class="pj-stream">
      <header class="pj-agents-head">
        <div id="pjStreamTabs"></div>
        <span class="pj-agents-hint">${state.projectTab === "tasks" ? "派活时「归档到本项目」的任务都会在这里。" : ""}</span>
      </header>
      <div class="cp-list" id="pjPushes" ${state.projectTab === "pushes" ? "" : "hidden"}></div>
      <div class="cp-list" id="pjTasks" ${state.projectTab === "tasks" ? "" : "hidden"}></div>
    </section>`;

  // 项目成员卡
  const membersBox = box.querySelector("#pjMembers");
  const memberCards = (data.members || []).map((m) => {
    const el = document.createElement("article");
    el.className = "pj-agent-card";
    el.innerHTML = `
      <header><b>${esc(m.name)}</b></header>
      <span class="pj-agent-role">${esc(roleLabel(m.role))}</span>
      ${canManage ? `<div class="pj-agent-actions"><button type="button" class="danger" data-act="remove-member">移出</button></div>` : ""}`;
    if (canManage) {
      el.querySelector('[data-act="remove-member"]').onclick = async () => {
        const { confirmDialog } = await import("./dialog.js");
        if (!(await confirmDialog({ title: "移出成员", message: `把「${m.name}」移出「${p.name}」？他将看不到这个项目。`, tone: "danger" }))) return;
        try {
          await cApi(`/api/collab/projects/${p.id}/members?account=${encodeURIComponent(m.accountId)}`, { method: "DELETE" });
          loadProject(state.projectId, { quiet: true });
        } catch (err) { toastError(err.message); }
      };
    }
    return window.platformWrapCard(el);
  });
  membersBox.replaceChildren(...(memberCards.length
    ? memberCards
    : [Object.assign(document.createElement("p"), { className: "cb-hint", textContent: "还没有项目成员。管理人员可以在这里添加。" })]));

  // AI 员工卡
  const agentsBox = box.querySelector("#pjAgents");
  const cards = data.agents.map((a) => {
    const el = document.createElement("article");
    el.className = "pj-agent-card";
    const skills = (a.skills || []).map((s) => `<span class="pj-skill">${esc(s)}</span>`).join("");
    el.innerHTML = `
      <header>
        <b>${esc(a.name)}</b>
        ${a.agentId ? `<span class="cb-agent ${agentClass(agentName(a.agentId))}">${esc(agentName(a.agentId))}</span>` : ""}
      </header>
      ${a.role ? `<span class="pj-agent-role">${esc(a.role)}</span>` : ""}
      ${a.duty ? `<p>${esc(a.duty)}</p>` : `<p class="muted">还没写职能</p>`}
      ${skills ? `<div class="pj-skills">${skills}</div>` : ""}
      ${canManage ? `<div class="pj-agent-actions">
        <button type="button" data-act="edit">编辑</button>
        <button type="button" class="danger" data-act="del">移除</button>
      </div>` : ""}`;
    if (canManage) {
      el.querySelector('[data-act="edit"]').onclick = () => projectAgentDialog(a);
      el.querySelector('[data-act="del"]').onclick = async () => {
        const { confirmDialog } = await import("./dialog.js");
        if (!(await confirmDialog({ title: "移除 AI 员工", message: `把「${a.name}」移出项目「${p.name}」？`, tone: "danger" }))) return;
        await cApi(`/api/collab/project-agents/${a.id}`, { method: "DELETE" });
        loadProject(state.projectId, { quiet: true });
      };
    }
    return window.platformWrapCard(el);
  });
  if (canManage) {
    const addCard = document.createElement("button");
    addCard.type = "button";
    addCard.className = "pj-agent-add";
    addCard.dataset.nativeSize = "content";
    addCard.innerHTML = `<b>＋</b><span>添加 AI 员工</span>`;
    addCard.onclick = () => projectAgentDialog(null);
    agentsBox.replaceChildren(...cards, addCard);
  } else {
    agentsBox.replaceChildren(...(cards.length
      ? cards
      : [Object.assign(document.createElement("p"), { className: "cb-hint", textContent: "这个项目还没配 AI 员工。" })]));
  }

  // 输出流 + 任务页签
  const pushesBox = box.querySelector("#pjPushes");
  pushesBox.replaceChildren(...(data.pushes.length
    ? data.pushes.map((x) => pushCard(x, { projectMode: true }))
    : [Object.assign(document.createElement("div"), { className: "cp-empty", textContent: "这个项目还没有输出。成员推送时选这个项目，或用 push --project。" })]));
  paintProjectTasks(box);

  // 页签切换
  window.platformRenderSegments(box.querySelector("#pjStreamTabs"), { label: "项目内容", value: state.projectTab,
    items: [{ value: "pushes", label: "项目输出", count: data.pushes.length }, { value: "tasks", label: "任务", count: state.projectTasks.length }],
    onValueChange: value => { state.projectTab = value; paintProject(); },
  });

  // 头部动作
  box.querySelector('[data-act="back"]').onclick = () => { state.page = "wall"; state.projectId = null; repaint(); };
  if (canManage) {
    box.querySelector('[data-act="admin"]').onchange = async (e) => {
      try {
        await cApi(`/api/collab/projects/${p.id}`, { method: "PUT", body: { adminAgent: e.target.value } });
        state.project.project.adminAgent = e.target.value;
      } catch (err) { toastError(err.message); }
    };
    box.querySelector('[data-act="edit"]').onclick = () => editProjectDialog(p);
    box.querySelector('[data-act="del"]').onclick = async () => {
      const { confirmDialog } = await import("./dialog.js");
      if (!(await confirmDialog({
        title: "删除项目", tone: "danger", okText: "删除",
        message: `删除「${p.name}」？项目里的输出会保留，但不再归属任何项目。`,
      }))) return;
      await cApi(`/api/collab/projects/${p.id}`, { method: "DELETE" });
      state.page = "wall"; state.projectId = null;
      loadOverview({ quiet: true }); repaint();
    };
    box.querySelector('[data-act="add-member"]').onclick = () => addMemberDialog(p);
  }
}

/** 添加项目成员：从未入项目的账号里选。 */
async function addMemberDialog(project) {
  const { formDialog } = await import("./dialog.js");
  let accounts = [];
  try { accounts = (await cApi("/api/auth/accounts")).items.filter((a) => a.active); } catch { /* 非管理员进不来 */ }
  const inProject = new Set((state.project?.members || []).map((m) => m.accountId));
  const candidates = accounts.filter((a) => !inProject.has(a.id));
  if (!candidates.length) { toastError("没有可添加的账号：要么都已在项目里，要么先去「设置 → 人员与账号」新增人员。"); return; }
  const values = await formDialog({
    title: `给「${project.name}」添加成员`,
    width: 460,
    fields: [{
      key: "accountId", label: "选择账号", type: "select", required: true,
      options: candidates.map((a) => ({ value: a.id, label: `${a.name}（${roleLabel(a.role)}）` })),
    }],
    okText: "添加",
  });
  if (!values) return;
  try {
    await cApi(`/api/collab/projects/${project.id}/members`, { method: "POST", body: { accountId: values.accountId } });
    loadProject(project.id, { quiet: true });
  } catch (err) { toastError(err.message); }
}

/* =========================================================================
   弹窗：项目编辑 / AI 员工编辑
   ========================================================================= */

async function editProjectDialog(project) {
  const { formDialog } = await import("./dialog.js");
  const values = await formDialog({
    title: project ? "编辑项目" : "新建项目",
    width: 520,
    fields: [
      { key: "name", label: "项目名称", value: project?.name ?? "", placeholder: "如：凯越新品上市企划" },
      { key: "goal", label: "项目目标", type: "textarea", value: project?.goal ?? "", rows: 3, placeholder: "一句话说清这个项目要达成什么", required: false },
      { key: "adminAgent", label: "AI 管理员", type: "select", value: project?.adminAgent ?? "", required: false,
        options: [{ value: "", label: "暂不指定" }, ...state.agentsPool.map((a) => ({ value: a.id, label: a.name }))] },
    ],
    okText: project ? "保存" : "创建",
  });
  if (!values) return;
  try {
    if (project) {
      await cApi(`/api/collab/projects/${project.id}`, { method: "PUT", body: values });
      if (state.projectId === project.id) loadProject(project.id, { quiet: true });
    } else {
      const created = await cApi("/api/collab/projects", { method: "POST", body: values });
      await loadOverview({ quiet: true });
      openProject(created.id);
      return;
    }
    loadOverview({ quiet: true });
    repaint();
  } catch (err) { toastError(err.message); }
}

async function projectAgentDialog(agent) {
  const { openDialog } = await import("./dialog.js");
  const projectId = state.projectId;
  const selectedSkills = new Set(agent?.skills || []);
  const poolNames = new Set(state.skillsPool.map((s) => s.name));
  const missingSkills = [...selectedSkills].filter((n) => !poolNames.has(n));
  const pick = (name, installed = true) => `<label class="pj-skill-pick${selectedSkills.has(name) ? " on" : ""}${installed ? "" : " missing"}">
        <input type="checkbox" value="${esc(name)}"${selectedSkills.has(name) ? " checked" : ""}>
        <span>${esc(name)}${installed ? "" : "（本机未安装）"}</span></label>`;
  const skillList = [
    ...state.skillsPool.map((s) => pick(s.name)),
    ...missingSkills.map((n) => pick(n, false)),
  ].join("");

  const result = await new Promise((resolve) => {
    openDialog({
      title: agent ? `编辑 AI 员工 · ${agent.name}` : "添加 AI 员工",
      subtitle: "角色是他在这项目里的头衔，职能说清他干什么，工作方法决定他怎么干。",
      width: 560,
      body: `
        <div class="wb-dlg-form">
          <label class="wb-dlg-field"><span>底层 AI</span>
            <select class="wb-dlg-input" data-f="agentId">${agentPoolOptions(agent?.agentId)}</select></label>
          <label class="wb-dlg-field half"><span>名称</span>
            <input class="wb-dlg-input" data-f="name" value="${esc(agent?.name ?? "")}" placeholder="如：文案官"></label>
          <label class="wb-dlg-field half"><span>角色</span>
            <input class="wb-dlg-input" data-f="role" value="${esc(agent?.role ?? "")}" placeholder="如：主笔 / 审校 / 数据分析"></label>
          <label class="wb-dlg-field"><span>职能</span>
            <textarea class="wb-dlg-input" data-f="duty" rows="3" placeholder="他在项目里负责什么、产出什么">${esc(agent?.duty ?? "")}</textarea></label>
          <div class="wb-dlg-field"><span>挂载工作方法 <em class="pj-skill-count"></em></span>
            <div class="pj-skill-list">${skillList || '<p class="cb-hint">「工作方法」页还没有方法卡，先去那里添加。</p>'}</div></div>
        </div>`,
      footer: `
        <button type="button" class="btn ghost" data-dlg-cancel>取消</button>
        <button type="button" class="btn primary" data-dlg-ok>${agent ? "保存" : "添加"}</button>`,
      onMount({ panel, close }) {
        const countEl = panel.querySelector(".pj-skill-count");
        const sync = () => {
          const n = panel.querySelectorAll(".pj-skill-pick input:checked").length;
          if (countEl) countEl.textContent = n ? `已选 ${n} 个` : "";
        };
        panel.querySelectorAll(".pj-skill-pick input").forEach((cb) => {
          cb.addEventListener("change", () => { cb.closest(".pj-skill-pick").classList.toggle("on", cb.checked); sync(); });
        });
        sync();
        panel.querySelector("[data-dlg-ok]").addEventListener("click", () => {
          const get = (k) => panel.querySelector(`[data-f="${k}"]`)?.value.trim() ?? "";
          if (!get("name")) { toastError("AI 员工名称不能为空"); return; }
          close({
            agentId: get("agentId"), name: get("name"), role: get("role"), duty: get("duty"),
            skills: [...panel.querySelectorAll(".pj-skill-pick input:checked")].map((cb) => cb.value),
          });
        });
      },
    }).then(resolve);
  });
  if (!result) return;
  try {
    if (agent) await cApi(`/api/collab/project-agents/${agent.id}`, { method: "PUT", body: result });
    else await cApi(`/api/collab/projects/${projectId}/agents`, { method: "POST", body: result });
    loadProject(projectId, { quiet: true });
  } catch (err) { toastError(err.message); }
}

/* =========================================================================
   数据加载与总渲染
   ========================================================================= */

async function loadOverview({ quiet = false } = {}) {
  if (!quiet) paintShell();
  const q = new URLSearchParams({ limit: "300" });
  if (state.filters.kind) q.set("kind", state.filters.kind);
  if (state.filters.member) q.set("member", state.filters.member);
  if (state.filters.agent) q.set("agent", state.filters.agent);
  try {
    const data = await cApi(`/api/collab/overview?${q}`);
    state.overview = data;
    const latestTs = data.items?.[0]?.createdAt ? new Date(data.items[0].createdAt).getTime() : 0;
    if (latestTs) sessionStorage.setItem("wb.collab.latest", String(latestTs));
    repaint();
  } catch (err) {
    const list = document.querySelector("#cpList");
    if (list) list.innerHTML = `<div class="cp-empty">加载失败：${esc(err.message)}</div>`;
  }
}

async function loadProject(id, { quiet = false } = {}) {
  if (!quiet) paintShell();
  try {
    const data = await cApi(`/api/collab/projects/${id}`);
    state.project = { ...data, pushes: data.pushes || [] };
    state.projectId = id;
    repaint();
    // 任务页签数据：归档到本项目的任务（项目成员可见）。失败不阻塞输出流。
    try {
      const tasks = await cApi(`/api/tasks?projectId=${encodeURIComponent(id)}&archived=1`);
      if (state.projectId === id) {
        state.projectTasks = tasks.items || [];
        if (state.page === "project") paintProject(); // 重绘以刷新页签角标
      }
    } catch { state.projectTasks = []; }
  } catch (err) {
    toastError(err.message);
    state.page = "wall"; repaint();
  }
}

function openProject(id) {
  state.page = "project";
  state.projectTab = "pushes";
  state.projectTasks = [];
  loadProject(id);
}

/** 按当前 page 渲染对应区块的显隐与内容。 */
function repaint() {
  const host = document.querySelector("#collabPage");
  if (!host) return;
  const wall = host.querySelector("#cpWall");
  const stream = host.querySelector("#cpStream");
  const project = host.querySelector("#cpProject");
  wall.hidden = state.page !== "wall";
  stream.hidden = state.page !== "stream";
  project.hidden = state.page !== "project";

  window.platformRenderSegments(host.querySelector("#cpTabs"), { label: "协作视图", value: state.page === "project" ? "wall" : state.page,
    items: [{ value: "wall", label: "项目" }, { value: "stream", label: "全部动态" }],
    onValueChange: value => { state.page = value; repaint(); },
  });
  // 统计条只在墙和全部动态显示
  const stats = host.querySelector("#cpStats");
  const data = state.overview;
  if (data) {
    const { totals, todayCount, members, projects } = data;
    window.platformRenderMetrics(stats, [
      { label: "进行中项目", value: (projects || []).length, hint: projects?.[0]?.name || "还没有项目" },
      { label: "产物", value: totals.artifact, hint: "可下载 / 可读" },
      { label: "动态", value: totals.note, hint: "过程里的零散进展" },
      { label: "成员", value: members.length, hint: members.slice(0, 3).map(m => `${m.name}·${roleLabel(m.role)}`).join("、") || "还没有成员" },
    ]);
  }
  if (state.page === "wall") paintWall();
  if (state.page === "stream") { paintFilters(); paintStream(); }
  if (state.page === "project") paintProject();
}

function paintShell() {
  const host = document.querySelector("#collabPage");
  if (!host) return;
  if (host.dataset.built) return;
  host.dataset.built = "1";
  host.innerHTML = `
    <div class="cp">
      <div class="cp-stats" id="cpStats"></div>
      <div class="cp-toolbar">
        <div id="cpTabs"></div>
        <div class="cp-toolbar-actions">
          <button type="button" class="cp-ghost" data-act="new-project">＋ 新建项目</button>
        </div>
      </div>
      <section id="cpWall"><div class="pj-grid" id="pjGrid"></div></section>
      <section id="cpStream" hidden>
        <div class="cp-bar" id="cpFilters"></div>
        <div class="cp-list" id="cpList"></div>
      </section>
      <section id="cpProject" hidden></section>
    </div>`;

  host.querySelector('[data-act="new-project"]').onclick = () => editProjectDialog(null);
  syncToolbarForViewer(host);
}

/** 项目谁都能建：建完自己就在项目里，不需要等管理人员开通。 */
function syncToolbarForViewer(host) {
  initViewer().then((u) => {
    state.viewerRole = u?.role ?? "other";
    // 按钮始终可用；这里只负责把当前角色记下来，供页面内其他判断用
  });
}

/* =========================================================================
   实时与入口
   ========================================================================= */

function bindOnce() {
  if (state.bound) return;
  state.bound = true;
  loadPools();
  onPush((push) => {
    const onPage = document.querySelector("#viewCollab")?.classList.contains("active");
    if (!onPage) {
      sessionStorage.setItem("wb.collab.latest", String(Date.now()));
      markBadge();
      return;
    }
    if (state.page === "project" && push.projectId === state.projectId) {
      state.project && (state.project.pushes = [push, ...state.project.pushes.filter((x) => x.id !== push.id)]);
      repaint();
    }
    loadOverview({ quiet: true });
  });
}

/** 侧栏「协作」上的小红点：最近有新推送时亮，进入页面即清。 */
export function markBadge() {
  const badge = document.querySelector("#navCollab");
  if (!badge) return;
  const key = "wb.collab.seen";
  const seen = Number(sessionStorage.getItem(key) || 0);
  const latest = Number(sessionStorage.getItem("wb.collab.latest") || 0);
  const has = latest > seen;
  badge.hidden = !has;
  badge.textContent = has ? "新" : "";
}

export function clearBadge() {
  const latest = Number(sessionStorage.getItem("wb.collab.latest") || 0);
  sessionStorage.setItem("wb.collab.seen", String(latest));
  const badge = document.querySelector("#navCollab");
  if (badge) badge.hidden = true;
}

/** app.js 在 setView("collab") 时调用。 */
export function renderCollabPage() {
  const host = document.querySelector("#collabPage");
  if (!host) return;
  paintShell();
  bindOnce();
  clearBadge();
  loadOverview();
}