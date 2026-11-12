/**
 * 协作 · 一级页面（左侧导航「协作」）。
 *
 * 与任务窗里的 cb-panel 区别：这里是**全组汇总**——跨任务、跨成员、跨 AI 的推送流，
 * 点任务来源可以跳回原任务抽屉。任务窗里的面板仍然保留，用于单任务视角。
 */

import { cApi, onPush, esc, relTime, isImage, agentClass, openMemberAdmin } from "./collab.js";

const state = {
  items: [],
  meta: null,
  filters: { kind: "", member: "", agent: "" },
  loading: false,
  bound: false,
};

function statCard(label, value, hint, tone) {
  return `<div class="cp-stat${tone ? ` tone-${tone}` : ""}">
    <b>${esc(value)}</b>
    <span>${esc(label)}</span>
    ${hint ? `<small>${esc(hint)}</small>` : ""}
  </div>`;
}

function taskChip(p) {
  const label = p.taskLabel || `任务 ${String(p.taskId || "").slice(0, 8) || "未指定"}`;
  return `<button class="cp-task" data-task="${esc(p.taskId || "")}" title="打开这个任务的详情">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 16 16 8M16 8H9.5M16 8v6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>${esc(label)}</span>
  </button>`;
}

function pushCard(p) {
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
  // 动态的标题就是正文首行，两者相同时别重复贴一遍
  const firstLine = bodyText.split("\n")[0].trim().replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "");
  const showBody = bodyText && !(p.kind === "note" && (firstLine === title.trim() || bodyText === title.trim()));
  const body = showBody
    ? (p.kind === "artifact"
      ? `<pre class="cb-body">${esc(bodyText.length > 420 ? bodyText.slice(0, 420) + "…" : bodyText)}</pre>`
      : `<p class="cp-note">${esc(bodyText.length > 220 ? bodyText.slice(0, 220) + "…" : bodyText)}</p>`)
    : "";
  card.innerHTML = `
    <div class="cb-avatar" title="${esc(p.memberName)}">${esc(String(p.memberName || "?").slice(0, 1))}</div>
    <div class="cp-main">
      <header>
        <b>${esc(p.memberName)}</b>
        <span class="cb-agent ${agentClass(p.agent)}">${esc(p.agent)}</span>
        <span class="cb-kind">${p.kind === "note" ? "动态" : "产物"}</span>
        <time>${esc(relTime(p.createdAt))}</time>
        <button class="cp-del" title="删除这条推送">删除</button>
      </header>
      <h4>${esc(title)}</h4>
      ${body}
      ${fileChip}
      <div class="cp-foot">${taskChip(p)}</div>
    </div>`;

  card.querySelector(".cp-task").onclick = (e) => {
    const id = e.currentTarget.dataset.task;
    if (!id) return;
    document.dispatchEvent(new CustomEvent("wb-open-task", { detail: { id } }));
  };
  card.querySelector(".cp-del").onclick = async () => {
    const { confirmDialog } = await import("./dialog.js");
    if (!(await confirmDialog({ title: "删除这条推送", message: `「${p.title}」将从协作流中删除，不可恢复。`, tone: "danger" }))) return;
    try {
      await cApi(`/api/collab/pushes/${p.id}`, { method: "DELETE" });
      state.items = state.items.filter((x) => x.id !== p.id);
      paintList();
    } catch (err) { toastError(err.message); }
  };
  return card;
}

function toastError(message) {
  import("./dialog.js").then(({ infoDialog }) =>
    infoDialog({ title: "操作未完成", bodyHtml: `<p class="cb-hint">${esc(message)}</p>`, okText: "知道了" }));
}

function paintStats() {
  const box = document.querySelector("#cpStats");
  if (!box || !state.meta) return;
  const { totals, todayCount, members } = state.meta;
  box.innerHTML = [
    statCard("产物", totals.artifact, "可下载 / 可读", "art"),
    statCard("动态", totals.note, "过程里的零散进展", "note"),
    statCard("今日新增", todayCount, todayCount ? "今天有人推东西" : "今天还没人推"),
    statCard("参与成员", members.length, members.map((m) => m.name).slice(0, 3).join("、") || "还没有成员"),
  ].join("");
}

function paintFilters() {
  const box = document.querySelector("#cpFilters");
  if (!box || !state.meta) return;
  const agentOpts = state.meta.agents
    .map((a) => `<option value="${esc(a.agent)}"${state.filters.agent === a.agent ? " selected" : ""}>${esc(a.agent)} · ${a.count}</option>`)
    .join("");
  const memberOpts = state.meta.members
    .map((m) => `<option value="${esc(m.id)}"${state.filters.member === m.id ? " selected" : ""}>${esc(m.name)} · ${m.push_count}</option>`)
    .join("");
  box.innerHTML = `
    <div class="cp-seg" role="tablist">
      ${[["", "全部"], ["artifact", "产物"], ["note", "动态"]].map(([v, t]) =>
        `<button type="button" data-kind="${v}" class="${state.filters.kind === v ? "active" : ""}">${t}</button>`).join("")}
    </div>
    <select class="cp-select" data-role="member"><option value="">全部成员</option>${memberOpts}</select>
    <select class="cp-select" data-role="agent"><option value="">全部 AI</option>${agentOpts}</select>
    <span class="cp-live" title="新推送会实时出现在这里"><i></i>实时</span>
    <button type="button" class="cp-ghost" data-role="members">成员与 Token</button>`;

  box.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.onclick = () => { state.filters.kind = btn.dataset.kind; paintFilters(); load(); };
  });
  box.querySelector('[data-role="member"]').onchange = (e) => { state.filters.member = e.target.value; load(); };
  box.querySelector('[data-role="agent"]').onchange = (e) => { state.filters.agent = e.target.value; load(); };
  box.querySelector('[data-role="members"]').onclick = () => openMemberAdmin().then(load);
}

function paintList() {
  const list = document.querySelector("#cpList");
  if (!list) return;
  if (!state.items.length) {
    const filtered = state.filters.kind || state.filters.member || state.filters.agent;
    list.innerHTML = filtered
      ? `<div class="cp-empty">这个筛选下没有记录。换个条件看看。</div>`
      : `<div class="cp-empty">
          <h4>协作流还是空的</h4>
          <p>成员在他自己的电脑上，用任意智能体（WorkBuddy / Kimi / Claude …）跑完东西，一条命令推到这儿，就会出现在这个列表里。</p>
          <ol>
            <li>点右上「成员与 Token」，建成员，把 Token 发给他（只显示一次）</li>
            <li>他在本机任目录跑 <code>node push-agent.mjs init</code>，填工作台地址和 Token</li>
            <li>干活时用 <code>push-agent.mjs push "结论" --file 报告.docx</code>，这边立刻能看到</li>
          </ol>
        </div>`;
    return;
  }
  list.replaceChildren(...state.items.map(pushCard));
}

function bindOnce() {
  if (state.bound) return;
  state.bound = true;
  onPush((push) => {
    // 只在协作页即时重排；在别的页面时只点亮侧栏红点，不打扰
    const onPage = document.querySelector("#viewCollab")?.classList.contains("active");
    if (!onPage) {
      sessionStorage.setItem("wb.collab.latest", String(Date.now()));
      markBadge();
      return;
    }
    const f = state.filters;
    const match = (!f.kind || push.kind === f.kind)
      && (!f.member || push.memberId === f.member)
      && (!f.agent || push.agent === f.agent);
    if (match) {
      state.items = [push, ...state.items.filter((p) => p.id !== push.id)];
      paintList();
    }
    load({ quiet: true });
  });
}

/** 侧栏「协作」上的小红点：最近 24h 有新推送时亮，进入页面即清。 */
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

async function load({ quiet = false } = {}) {
  const list = document.querySelector("#cpList");
  if (!list) return;
  if (!quiet && !state.items.length) list.innerHTML = `<div class="cp-empty">正在拉取协作流…</div>`;
  const q = new URLSearchParams({ limit: "300" });
  if (state.filters.kind) q.set("kind", state.filters.kind);
  if (state.filters.member) q.set("member", state.filters.member);
  if (state.filters.agent) q.set("agent", state.filters.agent);
  try {
    const data = await cApi(`/api/collab/overview?${q}`);
    state.items = data.items || [];
    state.meta = data;
    paintStats();
    paintFilters();
    paintList();
    const latestTs = data.items?.[0]?.createdAt ? new Date(data.items[0].createdAt).getTime() : 0;
    if (latestTs) sessionStorage.setItem("wb.collab.latest", String(latestTs));
  } catch (err) {
    list.innerHTML = `<div class="cp-empty">加载失败：${esc(err.message)}</div>`;
  }
}

/** app.js 在 setView("collab") 时调用。 */
export function renderCollabPage() {
  const host = document.querySelector("#collabPage");
  if (!host) return;
  if (!host.dataset.built) {
    host.dataset.built = "1";
    host.innerHTML = `
      <div class="cp">
        <div class="cp-stats" id="cpStats"></div>
        <div class="cp-bar" id="cpFilters"></div>
        <div class="cp-list" id="cpList"></div>
      </div>`;
  }
  bindOnce();
  clearBadge();
  load();
}
