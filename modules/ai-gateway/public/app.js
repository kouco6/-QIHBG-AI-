/* =========================================================================
   工作台 · front end
   Vanilla ES modules, no build step. The gateway serves this folder with a
   strict CSP, so: no inline handlers, no inline styles from HTML.
   ========================================================================= */

import { renderKnowledge } from "./knowledge.js";
import { renderCollabPanel } from "./collab.js";
import { renderCollabPage } from "./collab-page.js";
import { confirmDialog, promptDialog } from "./dialog.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_TEXT = {
  draft: "草稿",
  queued: "排队中",
  running: "执行中",
  waiting_approval: "等确认",
  waiting_user: "等待处理",
  approval_required: "等待审批",
  quota_exhausted: "额度不足",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "被中断",
  archived: "已归档",
};

const OUTPUT_LABEL = { markdown: "Markdown", word: "Word", ppt: "PPT", excel: "Excel", html: "HTML", csv: "CSV" };

/** 产出库用的文件类型：中文名 + 缩写 + 配色档位。 */
const ARTIFACT_TYPE = {
  markdown: { label: "Markdown", code: "MD", tone: "t-doc" },
  word: { label: "Word", code: "DOC", tone: "t-doc" },
  ppt: { label: "PPT", code: "PPT", tone: "t-slide" },
  excel: { label: "Excel", code: "XLS", tone: "t-sheet" },
  csv: { label: "CSV", code: "CSV", tone: "t-sheet" },
  html: { label: "HTML", code: "HTM", tone: "t-web" },
  pdf: { label: "PDF", code: "PDF", tone: "t-doc" },
  image: { label: "图片", code: "IMG", tone: "t-img" },
  json: { label: "JSON", code: "JSON", tone: "t-code" },
  text: { label: "文本", code: "TXT", tone: "t-code" },
  file: { label: "其他", code: "FILE", tone: "t-misc" },
};
const artifactType = (type) => ARTIFACT_TYPE[type] ?? { label: String(type || "其他"), code: "FILE", tone: "t-misc" };

const DEFAULT_QUICK = [
  { id: "q-r", type: "action", label: "调研", domain: "research" },
  { id: "q-p", type: "action", label: "企划", domain: "planning" },
  { id: "q-d", type: "action", label: "产品设计", domain: "design" },
  { id: "q-a", type: "action", label: "临时任务", domain: "adhoc" },
  { id: "l-1", type: "link", label: "剑鱼标讯", url: "https://www.jianyu360.cn/" },
  { id: "l-2", type: "link", label: "政府采购网", url: "http://www.ccgp.gov.cn/" },
  { id: "l-3", type: "link", label: "海康", url: "https://www.hikvision.com/cn/" },
  { id: "l-4", type: "link", label: "大华", url: "https://www.dahuatech.com/" },
  { id: "l-5", type: "link", label: "音王", url: "https://www.soundking.com/" },
  { id: "l-6", type: "link", label: "专利检索", url: "https://pss-system.cponline.cnipa.gov.cn/" },
];

const LS = {
  token: "wb.token",
  quick: "wb.quick",
  draft: "wb.draft",
  params: "wb.params",
};

const load = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
};

const state = {
  token: sessionStorage.getItem(LS.token) || "",
  boot: null,
  tasks: [],
  counts: {},
  stats: null,
  view: "dashboard",
  // 任务页内部的页签：临时任务（adhoc）/ 流程编排（flows）
  worksiteTab: "adhoc",
  filters: { domain: "", range: "all", status: "", q: "" },
  libType: "",
  agentFilter: "all",
  flows: [],
  flowRuns: [],
  flowFilter: "all",
  // 启动台当前选中的流程；跑起来后变成执行详情当前标签
  launchFlowId: "",
  launchBusy: false,
  runTabId: null,
  runFilter: "active",
  // 大窗里的详情默认展开：进来就该看见步骤在跑，而不是一块空壳等人去点
  // （收起是留给「想多看几条记录」的人的主动操作，不是默认态）
  runOpen: true,
  selectedId: null,
  stream: null,
  events: [],
  lastSeq: 0,
  known: new Map(),
  composer: { skills: [] },
  quick: load(LS.quick, DEFAULT_QUICK),
  inlineRoute: null,
  health: null,
  service: null,
  serviceDraft: { mode: "", port: "" },
  serviceStopTimer: null,
  // 版本与更新：bootstrap.update 的镜像，检查/安装后就地更新，不用整页重取
  update: null,
  updateBusy: "",
  updateSrcDraft: "",
  // 工作方法库：本机已装技能来自网关，云端列表按需拉
  skills: [],
  hub: null,
  hubSkills: [],
  hubError: "",
  skillTab: "local",
  skillQuery: "",
  skillSort: "new",
  skillLoading: false,
  // 工作方法详情/编辑弹窗的当前上下文：name 为空表示只读的云端详情
  skillDialog: null,
};

// 内网部署：同事点带 ?token= 的链接进来，第一次自动落会话并清掉地址栏，之后免输。
(() => {
  const urlToken = new URLSearchParams(location.search).get("token");
  if (urlToken) {
    sessionStorage.setItem(LS.token, urlToken);
    state.token = urlToken;
    history.replaceState(null, "", location.pathname + location.hash);
  }
})();

/* =========================================================================
   utilities
   ========================================================================= */
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

function relTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function duration(task) {
  if (!task.startedAt) return "";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(task.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function secondsText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${total % 60}s`;
  return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60)}m`;
}

const DAY_BUCKETS = ["今天", "昨天", "本周", "更早"];

/** 按自然日归组，而不是按“多少小时前”估算。 */
function dayBucket(iso) {
  const time = new Date(iso || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return "更早";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (time >= start) return "今天";
  if (time >= start - 86400e3) return "昨天";
  if (time >= start - 7 * 86400e3) return "本周";
  return "更早";
}

/** 记录行的第二行：标签优先，其次结论摘要，最后退到需求原文。 */
function taskLine(task) {
  const text = (task.tags || []).join(" · ") || task.summary || task.prompt || "";
  return String(text).replace(/\s+/g, " ").trim();
}

/** 本机已装的工作方法（技能）。旧的内置模板已下线，统一走技能库。 */
const localSkills = () => state.skills ?? [];

const agentById = (id = "codex") => (state.boot?.agents ?? []).find((agent) => agent.id === id);
const agentNameOf = (id = "codex") => agentById(id)?.name ?? id;

/* =========================================================================
   API
   ========================================================================= */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    sessionStorage.removeItem(LS.token);
    state.token = "";
    if (!$("#tokenDialog").open) $("#tokenDialog").showModal();
    throw new Error("Token 无效");
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

/* =========================================================================
   bootstrap
   ========================================================================= */
async function bootstrap() {
  const boot = await api("/api/bootstrap");
  state.boot = boot;
  state.service = boot.service ?? null;
  state.tasks = boot.tasks;
  state.counts = boot.counts;
  state.stats = boot.stats;
  state.skills = boot.skills ?? [];
  state.hub = boot.hub ?? null;
  // 版本与更新：当前版本、有没有新版、上次检查结果
  state.update = boot.update ?? null;
  for (const task of boot.tasks) state.known.set(task.id, task.status);

  renderSelectOptions();
  // 切换监听回来后核对结果：期望值在 localStorage 里存着
  const svcWant = localStorage.getItem("wb.svcWant");
  if (svcWant) {
    localStorage.removeItem("wb.svcWant");
    try {
      const want = JSON.parse(svcWant);
      const now = boot.service ?? {};
      if (now.mode === want.mode && Number(now.port) === Number(want.port)) {
        toast(want.mode === "lan" ? "已对局域网开放" : "已切回仅本机");
      } else {
        toast("切换未生效（端口可能被占用），保持原监听");
      }
    } catch { /* 坏数据直接丢 */ }
  }
  renderBoard();
  renderQuickbar();
  renderSidebar();
  renderSkillLibrary();
  renderArtifacts();
  renderAgents();
  renderSettings();
  updateTitle();
  const live = currentTask();
  if (live) {
    state.selectedId = live.id;
    state.events = [];
    state.lastSeq = 0;
    openStream(live.id);
  }
}

async function refreshTasks({ quiet = true } = {}) {
  try {
    const data = await api("/api/tasks");
    const before = state.known;
    state.tasks = data.items;
    state.counts = data.counts;
    for (const task of data.items) {
      const previous = before.get(task.id);
      if (previous && previous !== task.status && ["completed", "failed"].includes(task.status)) {
        notify(task);
      }
      before.set(task.id, task.status);
    }
    renderBoard();
    renderSidebar();
    renderArtifacts();
    renderAgents();
    if (state.selectedId) {
      const fresh = state.tasks.find((task) => task.id === state.selectedId);
      if (fresh && $("#drawer").classList.contains("open")) renderDrawerMeta(fresh);
    }
    updateTitle();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

async function refreshStats() {
  try {
    state.stats = await api(`/api/stats?days=${dashDays}`);
    renderSidebar();
    if (state.view === "settings") renderSettings();
    if (state.view === "dashboard") renderDashboard();
  } catch { /* ignore */ }
}

/* =========================================================================
   notifications (P1-06)
   ========================================================================= */
function unreadCount() {
  return state.tasks.filter((task) => task.unread).length;
}

function updateTitle() {
  const unread = unreadCount();
  document.title = unread ? `(${unread}) 工作台 · 多智能体` : "工作台 · 多智能体";
}

function notify(task) {
  const label = task.label || "任务";
  if (task.status === "completed") {
    toast(`「${label}」已完成`);
    if ("Notification" in window && Notification.permission === "granted") {
      const note = new Notification(`${agentNameOf(task.agent)} 任务完成`, { body: label, tag: task.id });
      note.onclick = () => { window.focus(); openDrawer(task.id); };
    }
  } else if (task.status === "failed") {
    toast(`「${label}」失败`);
  }
}

async function ensureNotifyPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignored */ }
  }
}

/* =========================================================================
   sidebar
   ========================================================================= */
function renderSidebar() {
  const artifacts = state.tasks.reduce((sum, task) => sum + (task.artifacts?.length ?? 0), 0);
  $("#countArtifacts").textContent = artifacts ? String(artifacts) : "";
  renderUpdateBadge();
  const today = new Date().toDateString();
  const todayTasks = state.tasks.filter((task) => new Date(task.finishedAt || 0).toDateString() === today);
  $("#todayDone").textContent = String(todayTasks.filter((task) => task.status === "completed").length);
  $("#todayFailed").textContent = String(todayTasks.filter((task) => ["failed", "interrupted"].includes(task.status)).length);
}

/** 侧栏「设置」上的小圆点：有新版或装了没重启时才亮，不打扰人。 */
function renderUpdateBadge() {
  const badge = $("#navUpdate");
  if (!badge) return;
  const upd = state.update;
  const available = Boolean(upd?.lastCheck?.available);
  const pending = Boolean(upd?.applied?.pendingRestart);
  badge.hidden = !(available || pending);
  badge.title = pending ? "更新已安装，重启后生效" : available ? `可更新到 v${upd.lastCheck.latest}` : "";
  badge.classList.toggle("pending", pending);
}

function setView(view) {
  state.view = view;
  $(".app").dataset.view = view;
  // 流程编辑页在视觉上属于「任务」，导航高亮归到任务位
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === (view === "flowEdit" ? "worksite" : view)));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view${view[0].toUpperCase()}${view.slice(1)}`));
  // 顶部员工栏常驻所有页面，切页时也要刷一遍（R-B：临时任务顶部 AI 员工栏保持不变）
  renderEmployeeStrip();
  const titles = {
    worksite: ["任务", "临时派活与流程编排，一个入口两个页签"],
    dashboard: ["数据看板", "平台跑得怎么样，一眼看清"],
    flowEdit: ["流程编排", "整页编排，右侧配置每一步"],
    artifacts: ["产出库", "按文件取件，并定位到来源任务"],
    collab: ["协作", "成员本机智能体推来的产物与动态，全组汇总"],
    knowledge: ["产品中枢", "调研、企划、产品、灵感四个知识空间的工作台"],
    templates: ["工作方法", "卡片管理本机与云端的工作方法"],
    settings: ["设置", "AI 员工、网关、快捷入口与本机偏好"],
  };
  $("#viewTitle").textContent = titles[view]?.[0] ?? "工作台";
  $("#viewSub").textContent = titles[view]?.[1] ?? "";
  if (view === "worksite") {
    renderBoard();
    applyWorksiteTab();
    // 流程页签要接着推详情，不然得手动点一下标签才更新
    if (state.worksiteTab === "flows") {
      renderFlows();
      loadFlows({ quiet: false });
      if (state.runTabId) openRunStream(state.runTabId);
    }
  }
  if (view === "dashboard") loadDashboard();
  if (view === "artifacts") renderArtifacts();
  if (view === "collab") renderCollabPage();
  if (view === "knowledge") renderKnowledge();
  if (view === "templates") renderSkillLibrary();
  if (view !== "worksite" || state.worksiteTab !== "flows") {
    // 离开流程页签就断流，别在后台空转
    if (runDetailId) {
      closeRunStream();
      clearInterval(runTicker);
      runTicker = null;
    }
  }
  if (view === "settings") {
    // 设置页展示的是实时事实，切过来先按当前状态渲染，再用最新健康检查结果刷新一次。
    renderSettings();
    checkHealth().then(() => { if (state.view === "settings") renderSettings(); });
  }
}

/* 任务页内部页签：临时任务 / 流程编排共用一个导航位 */
function applyWorksiteTab() {
  const tab = state.worksiteTab ?? "adhoc";
  $$("#wsTabs .lib-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  const adhocPane = $("#wsPaneAdhoc");
  const flowsPane = $("#wsPaneFlows");
  if (adhocPane) adhocPane.hidden = tab !== "adhoc";
  if (flowsPane) flowsPane.hidden = tab !== "flows";
}

function gotoWorksiteTab(tab) {
  state.worksiteTab = tab;
  if (state.view !== "worksite") setView("worksite");
  else {
    applyWorksiteTab();
    if (tab === "flows") {
      renderFlows();
      loadFlows({ quiet: false });
      if (state.runTabId) openRunStream(state.runTabId);
    } else {
      renderAdhoc();
    }
  }
}

/* =========================================================================
   quick bar (P1-04)
   ========================================================================= */
function renderQuickbar() {
  const links = state.quick.filter((item) => item.type === "link");
  const linkBox = $("#quickLinks");
  if (!linkBox) return;
  linkBox.replaceChildren(...links.map((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-link";
    btn.innerHTML = `${esc(item.label)} <span aria-hidden="true">↗</span>`;
    btn.addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
    return btn;
  }));
}

/* =========================================================================
   filters
   ========================================================================= */
function renderSelectOptions() {
  const select = $("#taskAgent");
  if (select) {
    const automatic = new Option("自动匹配", "");
    const options = (state.boot?.agents ?? []).map((agent) => {
      const option = new Option(`${agent.name}${agent.available ? "" : "（未配置）"}`, agent.id);
      option.disabled = !agent.available;
      return option;
    });
    select.replaceChildren(automatic, ...options);
  }
}

/* =========================================================================
   board (P0-01 / P0-06)
   ========================================================================= */
function renderBoard() {
  renderEmployeeStrip();
  renderAdhoc();
}

/* =========================================================================
   临时任务（原「任务中枢」）

   为什么改：中枢那一屏是给「盯一条正在跑的任务」准备的，但日常最常用的动作
   其实是「随手派一件事」。所以这页只留三样东西：写要做什么、选谁来干、
   看最近跑过什么。复杂的执行详情仍然在抽屉里。
   ========================================================================= */

let adhocAgentId = null;

function renderAdhoc() {
  const box = $("#adhocAgents");
  if (!box) return;
  renderAdhocHero();
  renderAdhocAgents();
  renderAdhocRecent();
  const cwd = $("#adhocCwd");
  if (cwd && !cwd.options.length) {
    cwd.replaceChildren(...(state.boot?.allowedRoots ?? []).map((root) => new Option(root, root)));
    if (state.boot?.defaultRoot) cwd.value = state.boot.defaultRoot;
  }
}

function renderAdhocHero() {
  const box = $("#adhocHero");
  if (!box) return;
  const list = state.tasks ?? [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = list.filter((task) => new Date(task.createdAt || 0).getTime() >= todayStart.getTime());
  const done = today.filter((task) => task.status === "completed").length;
  const busy = list.filter((task) => ["running", "queued"].includes(task.status)).length;
  const agents = state.boot?.agents ?? [];
  const online = agents.filter((agent) => agent.available).length;
  box.innerHTML = `
    <div class="hero-cell"><span>今天派活</span><b class="mono">${today.length}<small> 件</small></b><em>${done} 件已完成</em></div>
    <div class="hero-cell"><span>正在忙</span><b class="mono ${busy ? "ok" : ""}">${busy}<small> 件</small></b><em>${busy ? "排队 + 执行中" : "全部空闲"}</em></div>
    <div class="hero-cell"><span>能接活的员工</span><b class="mono">${online}<small> / ${agents.length}</small></b><em>${agents.length - online ? "还有员工没配密钥" : "全部就绪"}</em></div>
    <div class="hero-cell"><span>这页适合</span><b class="mono">一次性</b><em>不进流程、不用配置</em></div>`;
}

function renderAdhocAgents() {
  const box = $("#adhocAgents");
  if (!box) return;
  const cards = [];

  const auto = document.createElement("button");
  auto.type = "button";
  auto.className = `adhoc-agent${adhocAgentId ? "" : " on"}`;
  auto.innerHTML = '<span class="adhoc-auto">✦</span><strong>自动挑一个</strong><em>按任务内容匹配</em>';
  auto.addEventListener("click", () => {
    adhocAgentId = null;
    renderAdhocAgents();
  });
  cards.push(auto);

  for (const agent of state.boot?.agents ?? []) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `adhoc-agent${adhocAgentId === agent.id ? " on" : ""}${agent.available ? "" : " off"}`;
    // 卡片窄，模型名普遍超长，放到 title 里，面上只说状态。
    const foot = agent.available ? "可接活" : "还没配密钥";
    card.innerHTML = `${agentAvatar(agent)}<strong>${esc(agent.name)}</strong><em>${esc(foot)}</em>`;
    card.title = agent.available ? (agent.summary || agent.model || agent.name) : `${agent.name} 还没配置密钥`;
    card.addEventListener("click", () => {
      if (!agent.available) {
        toast(`${agent.name} 还没配置密钥，去「AI 员工」里补上`);
        return;
      }
      adhocAgentId = agent.id;
      renderAdhocAgents();
    });
    cards.push(card);
  }

  box.replaceChildren(...cards);
  renderAdhocHint();
}

function renderAdhocHint() {
  const hint = $("#adhocHint");
  if (!hint) return;
  const agent = adhocAgentId ? agentById(adhocAgentId) : null;
  hint.textContent = agent
    ? `由 ${agent.name} 执行，跑完在右侧抽屉里看结论和产出。`
    : "不指定员工时，平台按任务内容自动挑一个。";
}

function adhocTitle(task) {
  const raw = String(task.title || task.label || task.prompt || "").split("\n")[0].trim();
  return raw.length > 42 ? `${raw.slice(0, 42)}…` : raw || "无标题任务";
}

function renderAdhocRecent() {
  const box = $("#adhocRecent");
  if (!box) return;
  const rows = (state.tasks ?? []).filter((task) => task.status !== "draft").slice(0, 8);
  const count = $("#adhocRecentCount");
  if (count) count.textContent = rows.length ? `最近 ${rows.length} 条` : "";
  if (!rows.length) {
    box.innerHTML = '<div class="mini-empty">还没有临时任务。上面写一句话，选个员工就能开始。</div>';
    return;
  }
  box.replaceChildren(...rows.map((task) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "adhoc-row";
    row.innerHTML = `
      <i class="adhoc-dot ${esc(task.status)}"></i>
      <span class="adhoc-row-main"><strong>${esc(adhocTitle(task))}</strong><em>${esc(agentNameOf(task.agent))} · ${esc(relTime(task.updatedAt || task.createdAt))}</em></span>
      <span class="adhoc-row-end"><b class="adhoc-state ${esc(task.status)}">${esc(STATUS_TEXT[task.status] ?? task.status)}</b><span class="adhoc-dur">${esc(task.status === "running" ? duration(task) : "")}</span></span>`;
    row.addEventListener("click", () => openDrawer(task.id));
    return row;
  }));
}

async function submitAdhoc({ draft = false } = {}) {
  const prompt = $("#adhocPrompt")?.value.trim() ?? "";
  if (!prompt) {
    toast("先写一句要做什么");
    $("#adhocPrompt")?.focus();
    return;
  }
  const button = draft ? $("#adhocDraft") : $("#adhocRun");
  if (button) button.disabled = true;
  try {
    const task = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        domain: "adhoc",
        agent: adhocAgentId || undefined,
        outputTypes: [$("#adhocOutput")?.value || "markdown"],
        cwd: $("#adhocCwd")?.value || state.boot?.defaultRoot,
        mode: "workspace-write",
        draft,
      }),
    });
    $("#adhocPrompt").value = "";
    await refreshTasks();
    renderAdhoc();
    toast(draft ? "已存为草稿" : `已交给 ${agentNameOf(task.agent)}，正在跑`);
    if (!draft) openDrawer(task.id);
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function currentTask() {
  return state.tasks.find((task) => ["running", "waiting_user", "approval_required", "quota_exhausted"].includes(task.status))
    || state.tasks.find((task) => task.status === "queued")
    || null;
}

function activeTasks() {
  const rank = { waiting_user: 0, approval_required: 0, quota_exhausted: 0, running: 1, queued: 2 };
  return state.tasks
    .filter((task) => Object.hasOwn(rank, task.status))
    .sort((a, b) => (rank[a.status] - rank[b.status]) || (new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)));
}

function latestTask() {
  return state.tasks.find((task) => !["draft", "archived"].includes(task.status)) || null;
}

function domainLabel(id) {
  return state.boot?.domains?.find((domain) => domain.id === id)?.name ?? id ?? "临时工作";
}

function actionEvents() {
  return state.events.filter((event) => {
    if (event.type === "gateway") return ["queued", "running", "completed", "failed", "cancelled"].includes(event.data?.status);
    if (!["codex", "agent"].includes(event.type)) return false;
    const type = event.data?.type || "";
    return type.startsWith("item.") || ["turn.started", "turn.completed", "thread.started"].includes(type);
  });
}

function humanAction(event) {
  const data = event.data || {};
  if (event.type === "gateway") return ({ queued: "任务已进入队列", running: "AI 员工已接手任务", completed: "任务已完成", failed: "任务执行失败", cancelled: "任务已取消" })[data.status] || "状态已更新";
  const item = data.item || {};
  const raw = String(item.text || item.command || item.name || item.type || data.type || "动作已完成").trim();
  const kind = String(item.type || data.type || "");
  if (/command|exec|shell/i.test(kind)) return `执行了 ${raw}`;
  if (/file|read/i.test(kind)) return `读取了 ${raw}`;
  if (/write|edit|patch/i.test(kind)) return `写入了 ${raw}`;
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}

function lastActionText() {
  const last = actionEvents().at(-1);
  return last ? humanAction(last) : "暂无动作记录";
}

function actionAge() {
  const at = actionEvents().at(-1)?.at;
  if (!at) return "暂无动作";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return `最后动作 ${seconds} 秒前`;
  return `最后动作 ${Math.floor(seconds / 60)} 分钟前`;
}

/* 静默告警：网关只上报「多久没输出」，从不推断原因，也从不动进程 */
function silenceAlerts() {
  return state.events.filter((event) => event.type === "silence");
}

function silenceText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function lastSilence() {
  return silenceAlerts().at(-1)?.data || null;
}

/** 员工当前在跑的那件事：先看执行中，再看排队。 */
function agentLiveTask(agentId) {
  const own = state.tasks.filter((item) => item.agent === agentId);
  return own.find((item) => item.status === "running") || own.find((item) => item.status === "queued") || null;
}

function employeeState(agent, task) {
  if (!agent.available) return { text: "未配置", tone: "off" };
  if (task?.status === "running") return { text: "执行中", tone: "run" };
  if (task?.status === "queued") return { text: "排队中", tone: "wait" };
  return { text: "空闲", tone: "idle" };
}

/** 卡带布局常量：卡宽 / 间距，与 styles.css 保持一致（more 卡 64px 也按此实测，无需单独常量）。 */
const TEAM_CARD_W = 172;
const TEAM_GAP = 8;

/**
 * 顶部员工带。横排完整员工卡，张数不设上限：按容器实际宽度自动适配，
 * 能放几张放几张，放不下的收进末尾「+N 更多」卡，点开下拉看全。
 * 输入指令框和派发按钮已按需求撤掉：派活走员工卡（点空闲卡直接点名）与面板底部的「派发任务」。
 */
function renderEmployeeStrip() {
  const box = $("#teamCards");
  if (!box) return;
  const agents = state.boot?.agents ?? [];
  const rows = agents.map((agent) => ({ agent, task: agentLiveTask(agent.id) }));

  // 日志流式刷新会反复走到这里，数据没变别重建，否则整排卡会闪
  const sig = rows.map(({ agent, task }) => `${agent.id}:${agent.available ? 1 : 0}:${task?.id ?? ""}:${task?.status ?? ""}`).join("|");
  if (box.dataset.sig === sig) { syncTeamMore(); return; }
  box.dataset.sig = sig;

  box.replaceChildren(...rows.map(({ agent, task }) => {
    const st = employeeState(agent, task);
    const detail = task
      ? (task.label || "未命名任务")
      : (agent.available
        ? (agent.model || (agent.provider === "local" ? "本机 CLI" : (agent.vendor || "可立即派活")))
        : "点开配置密钥");
    const card = document.createElement("button");
    card.type = "button";
    card.className = `emp-card${task ? " active" : ""}`;
    card.title = task ? `打开任务：${detail}` : `${agent.name} · ${st.text}`;
    card.innerHTML = `${agentAvatar(agent)}
      <span class="emp-main"><strong>${esc(agent.name)}</strong><span class="emp-foot">${esc(detail)}</span></span>
      <span class="emp-state ${st.tone}" title="${esc(st.text)}"><i></i><em>${esc(st.text)}</em></span>`;
    card.addEventListener("click", () => {
      // 顶栏本身就是面板的定位容器，点卡不算「点外面」，得自己收
      closeTeamMenu();
      if (task) openDrawer(task.id);
      else if (agent.available) openComposerFor(agent.id);
      else setView("settings");
    });
    return card;
  }));
  if (!rows.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "emp-card emp-add";
    empty.innerHTML = `<span class="emp-plus">+</span><span class="emp-main"><strong>添加 AI 员工</strong><span class="emp-foot">本机 CLI 或云端模型</span></span>`;
    empty.addEventListener("click", () => setView("settings"));
    box.append(empty);
  }
  syncTeamMore();
  if ($("#teamMenu") && !$("#teamMenu").hidden) renderTeamMenu();
}

/**
 * 按实测宽度决定可见张数并直接控制 display：卡宽固定不压缩，溢出前就藏掉多余的。
 * 「+N」卡和卡片带是 flex 兄弟，它显不显示会改变卡带的实测宽度，所以小步收敛：
 * 先按当前占位算一遍，若结论是「根本不需要 more」，隐藏后还回宽度再校一遍。
 */
function syncTeamMore() {
  const more = $("#teamMore");
  const box = $("#teamCards");
  if (!more || !box) return;
  const cards = [...box.children].filter((card) => !card.classList.contains("emp-add"));
  const total = cards.length;
  if (!total) { more.hidden = true; cards.forEach((card) => { card.style.display = ""; }); return; }
  const unit = TEAM_CARD_W + TEAM_GAP;
  let fit = 0;
  for (let round = 0; round < 3; round++) {
    more.hidden = fit >= total; // 本轮先按上轮结论决定 more 是否占位
    const avail = box.clientWidth;
    if (!avail) return; // 布局未就绪（首帧/隐藏态），等 resize 或下次刷新再算
    const next = Math.max(1, Math.min(total, Math.floor((avail + TEAM_GAP) / unit)));
    if (next === fit) break;
    fit = next;
  }
  more.hidden = fit >= total;
  cards.forEach((card, index) => { card.style.display = index < fit ? "" : "none"; });
  const rest = Math.max(0, total - fit);
  if (rest > 0) {
    more.innerHTML = `<b>+${rest}</b><span>更多</span>`;
    more.title = `还有 ${rest} 位员工 · 点开看全部`;
  }
}

// 窗口尺寸变化会改变能容纳的张数，「+N」和可见数得跟着重算
addEventListener("resize", () => {
  clearTimeout(syncTeamMore._timer);
  syncTeamMore._timer = setTimeout(syncTeamMore, 120);
});

function renderTeamMenu() {
  const box = $("#teamMenu");
  if (!box) return;
  const agents = state.boot?.agents ?? [];
  const rows = agents.map((agent) => ({ agent, task: agentLiveTask(agent.id) }));
  const busy = rows.filter((row) => row.task).length;

  // 日志流式刷新时 paintLogs 会反复调到这里，数据没变就别重建，否则菜单会闪
  const sig = rows.map(({ agent, task }) => `${agent.id}:${agent.available ? 1 : 0}:${task?.id ?? ""}:${task?.status ?? ""}`).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;

  const head = document.createElement("div");
  head.className = "team-menu-head";
  head.innerHTML = `<span>AI 员工</span><span class="team-menu-stats">${busy ? `${busy} 位在忙 · ` : ""}共 ${agents.length} 位</span>`;

  const list = document.createElement("div");
  list.className = "team-list";
  list.append(...rows.map(({ agent, task }) => {
    const st = employeeState(agent, task);
    // 本机 CLI 员工没有模型名，写「本机 CLI」比写「可立即派活」更能说明它是什么
    const detail = task
      ? (task.label || "未命名任务")
      : (agent.available
        ? (agent.model || (agent.provider === "local" ? "本机 CLI" : (agent.vendor || "可立即派活")))
        : "点开配置密钥");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "team-row";
    row.title = task ? `打开任务：${task.label || "未命名任务"}` : detail;
    row.innerHTML = `<span class="team-face${task ? " busy" : ""}${agent.available ? "" : " off"}">${agentAvatar(agent)}</span>
      <span class="team-row-main"><strong>${esc(agent.name)}</strong><span>${esc(detail)}</span></span>
      <span class="team-row-state ${st.tone}"><i></i>${esc(st.text)}</span>`;
    row.addEventListener("click", () => {
      closeTeamMenu();
      if (task) openDrawer(task.id);
      else if (agent.available) openComposerFor(agent.id);
      else setView("settings");
    });
    return row;
  }));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "team-empty";
    empty.textContent = "还没有员工。去设置里添加一个，或接一个本机 CLI。";
    list.append(empty);
  }

  const foot = document.createElement("div");
  foot.className = "team-menu-foot";
  const dispatch = document.createElement("button");
  dispatch.type = "button";
  dispatch.className = "team-link primary-link";
  dispatch.textContent = "派发任务";
  dispatch.addEventListener("click", () => { closeTeamMenu(); openComposer(); });
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "team-link";
  manage.textContent = "管理员工";
  manage.addEventListener("click", () => { closeTeamMenu(); setView("settings"); });
  foot.append(dispatch, manage);

  box.replaceChildren(head, list, foot);
}

function openTeamMenu() {
  renderTeamMenu();
  const menu = $("#teamMenu");
  if (!menu) return;
  menu.hidden = false;
  $("#teamWrap")?.classList.add("open");
  $("#teamMore")?.setAttribute("aria-expanded", "true");
}

function closeTeamMenu() {
  const menu = $("#teamMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("#teamWrap")?.classList.remove("open");
  $("#teamMore")?.setAttribute("aria-expanded", "false");
}

/** 指定员工派活：开派活面板并把执行员工选中，用户仍可改回自动匹配。 */
function openComposerFor(agentId) {
  openComposer();
  const select = $("#taskAgent");
  if (!select) return;
  if (![...select.options].some((option) => option.value === agentId)) {
    select.append(new Option(agentNameOf(agentId), agentId));
  }
  select.value = agentId;
  $("#composerHint").textContent = `已指定 ${agentNameOf(agentId)} 执行，也可以改回自动匹配。`;
}

function renderWorksite() {
  const box = $("#workMain");
  if (!box) return;
  const live = currentTask();
  let task = live;
  if (live && state.selectedId !== live.id) {
    state.selectedId = live.id;
    state.events = [];
    state.lastSeq = 0;
    openStream(live.id);
  }
  if (!task) task = state.tasks.find((item) => item.id === state.selectedId) || latestTask();
  box.replaceChildren();
  if (task) {
    box.append(renderMissionHeader(task), renderMissionMatrix(task));
  } else {
    const empty = document.createElement("div");
    empty.className = "mission-empty";
    empty.innerHTML = '<span>READY</span><h3>任务中枢待命</h3><p>当前没有执行中的任务。通过顶部指令栏或底部派发栏启动新的工作。</p>';
    box.append(empty);
  }

  renderOpsOverview();
  renderExecutionInspector(task);
  renderLiveActionRail(task);
  const dock = $("#dispatchDock");
  if (dock) dock.replaceChildren(renderInlineAssign());
  const open = $("#openCurrentTask");
  if (open) {
    open.disabled = !task;
    open.onclick = () => { if (task) openDrawer(task.id); };
  }
}

function renderOpsOverview() {
  const box = $("#opsOverview");
  if (!box) return;
  const today = new Date().toDateString();
  const online = (state.boot?.agents || []).filter((agent) => agent.available).length;
  const running = state.tasks.filter((task) => task.status === "running").length;
  const queued = state.tasks.filter((task) => task.status === "queued").length;
  const doneToday = state.tasks.filter((task) => task.status === "completed" && new Date(task.finishedAt || 0).toDateString() === today).length;
  const cells = [
    ["AI 员工", online, "agent"],
    ["运行中任务", running, "running"],
    ["排队任务", queued, "queued"],
    ["今日完成", doneToday, "done"],
  ];
  const gatewayText = state.health === true ? "网关在线" : state.health === false ? "网关离线" : "连接中";
  const gatewayClass = state.health === false ? " offline" : "";
  box.innerHTML = `
    <div class="overview-title"><span>系统态势</span><b class="${gatewayClass.trim()}"><i></i>${gatewayText}</b></div>
    ${cells.map(([label, value, cls]) => `<div class="overview-cell ${cls}"><span class="overview-icon"></span><strong>${value}</strong><small>${label}</small></div>`).join("")}`;
}

function renderMissionHeader(task) {
  const head = document.createElement("header");
  head.className = "mission-head";
  const agentName = (state.boot?.agents || []).find((agent) => agent.id === (task.agent || "codex"))?.name || "Codex";
  head.innerHTML = `
    <div class="mission-symbol" aria-hidden="true"><span></span></div>
    <div class="mission-copy"><div><h3>${esc(task.label || "未命名任务")}</h3><span class="mission-status ${esc(task.status)}">${esc(STATUS_TEXT[task.status] || task.status)}</span></div><p>${esc(domainLabel(task.domain))} · ${esc(agentName)} · ${esc(relTime(task.createdAt))}</p></div>
    <div class="mission-meta"><span>已执行</span><strong>${esc(duration(task) || "等待中")}</strong></div>`;
  return head;
}

function renderMissionMatrix(task) {
  const matrix = document.createElement("div");
  matrix.className = "mission-matrix";
  const index = stageIndexOf(state.events, task);
  const complete = ["completed", "archived"].includes(task.status);
  const broken = ["failed", "interrupted"].includes(task.status);
  const actions = actionEvents().slice(-4);
  const employeeName = agentNameOf(task.agent || "codex");
  const descriptions = [
    "任务进入网关队列",
    "创建线程与执行环境",
    "执行指令并处理工作区",
    "整理结论与产出物",
    "回收结果并记录状态",
  ];

  STAGES.forEach((stage, i) => {
    const done = complete || i < index;
    const current = !complete && i === index;
    const failed = current && broken;
    const row = document.createElement("section");
    row.className = `mission-stage${done ? " done" : ""}${current ? " current" : ""}${failed ? " failed" : ""}`;
    const stateText = done ? "已完成" : failed ? "需处理" : current ? (task.status === "queued" ? "排队中" : "执行中") : "待执行";
    const dependency = i === 0 ? "网关接收" : `依赖 ${String(i).padStart(2, "0")} 完成`;
    row.innerHTML = `
      <div class="stage-node"><i></i><span>${String(i + 1).padStart(2, "0")}</span></div>
      <div class="stage-copy"><strong>${esc(stage.name)}</strong><small>${esc(current && i === 2 ? lastActionText() : descriptions[i])}</small></div>
      <div class="stage-agent"><span>${i === 0 ? "网关" : esc(employeeName)}</span></div>
      <div class="stage-state"><i></i>${stateText}</div>
      <div class="stage-dependency">${dependency}</div>`;
    matrix.append(row);

    if (current && i === 2 && actions.length) {
      const sub = document.createElement("div");
      sub.className = "mission-actions";
      sub.append(...actions.map((event) => {
        const item = document.createElement("div");
        item.innerHTML = `<time>${esc(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time><span>${esc(humanAction(event))}</span>`;
        return item;
      }));
      matrix.append(sub);
    }
  });
  return matrix;
}

function renderExecutionInspector(task) {
  const box = $("#execInspector");
  const status = $("#execStatus");
  if (!box || !status) return;
  if (!task) {
    status.textContent = "待命";
    box.innerHTML = '<div class="inspector-empty"><span></span><strong>AI 员工待命</strong><p>等待新的任务指令</p></div>';
    return;
  }
  const agent = agentById(task.agent || "codex") || { id: task.agent || "codex", name: task.agent || "Codex", provider: "unknown" };
  const index = stageIndexOf(state.events, task);
  const stage = STAGES[Math.min(index, STAGES.length - 1)];
  status.innerHTML = `<i class="status-dot ${esc(task.status)}"></i>${esc(STATUS_TEXT[task.status] || task.status)}`;
  box.innerHTML = `
    <div class="agent-chip">${agentAvatar(agent)}<div><span>当前 AI 员工</span><strong>${esc(agent.name)}</strong><small>${esc(agent.provider === "local" ? "本地执行 · 文件工作" : `云端模型 · ${agent.model || "默认模型"}`)}</small></div></div>
    <div class="inspector-section"><span>当前阶段</span><strong>${esc(stage.name)}</strong><p>${esc(lastActionText())}</p></div>
    <dl class="inspector-facts">
      <div><dt>最后动作</dt><dd>${esc(actionAge())}</dd></div>
      <div><dt>已运行</dt><dd>${esc(duration(task) || "等待中")}</dd></div>
      <div><dt>工作目录</dt><dd title="${esc(task.cwd || "")}">${esc((task.cwd || "默认目录").split(/[\\/]/).pop())}</dd></div>
      <div><dt>运行模式</dt><dd>${task.mode === "workspace-write" ? "安全可写" : "只读"}</dd></div>
    </dl>`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inspector-open";
  button.textContent = "打开完整任务";
  button.addEventListener("click", () => openDrawer(task.id));
  box.append(button);
}

function renderLiveActionRail(task) {
  const box = $("#liveActionRail");
  const count = $("#actionCount");
  if (!box || !count) return;
  const actions = task ? actionEvents().slice(-8).reverse() : [];
  count.textContent = actions.length ? `${actionEvents().length} 条` : "实时";
  if (!actions.length) {
    box.innerHTML = '<div class="rail-empty">任务开始后，真实动作会出现在这里。</div>';
    return;
  }
  box.replaceChildren(...actions.map((event, index) => {
    const row = document.createElement("div");
    row.className = `rail-event${index === 0 ? " latest" : ""}`;
    row.innerHTML = `<i></i><time>${esc(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time><p>${esc(humanAction(event))}</p>`;
    return row;
  }));
}

function renderAttentionQueue() {
  const box = $("#attentionQueue");
  const count = $("#attentionCount");
  if (!box || !count) return;
  const items = state.tasks.filter((task) => ["waiting_user", "approval_required", "quota_exhausted", "failed", "interrupted"].includes(task.status)).slice(0, 4);
  count.textContent = items.length ? String(items.length) : "0";
  if (!items.length) {
    box.innerHTML = '<div class="dock-empty"><i></i><span>无需介入，系统会在后台继续工作</span></div>';
    return;
  }
  box.replaceChildren(...items.map((task) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "attention-row";
    row.innerHTML = `<i></i><div><strong>${esc(task.label || "未命名任务")}</strong><small>${esc(STATUS_TEXT[task.status] || task.status)} · ${esc(relTime(task.finishedAt || task.updatedAt))}</small></div><span>查看</span>`;
    row.addEventListener("click", () => openDrawer(task.id));
    return row;
  }));
}

function renderWorkHeader(task) {
  const head = document.createElement("div");
  head.className = "task-head";
  head.append(renderStateHead(task), renderStages(task));
  return head;
}

function renderLiveContent(task) {
  const wrap = document.createElement("div");
  wrap.append(renderExecCard(task));

  const block = document.createElement("div");
  block.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = `<h3>实时动作流</h3><span>${esc(STATUS_TEXT[task.status] || task.status)}</span>`;
  const feed = document.createElement("div");
  feed.className = "action-feed";
  const actions = actionEvents();
  if (!actions.length) feed.innerHTML = '<div class="empty-actions">任务已连接，等待第一条动作记录。</div>';
  else feed.append(...actions.slice(-80).map((event) => {
    const row = document.createElement("div");
    row.className = "action-item";
    row.innerHTML = `<time>${esc(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time><i></i><p>${esc(humanAction(event))}</p>`;
    return row;
  }));
  block.append(head, feed, renderTechnicalLogs());
  wrap.append(block, renderBlockerPanel(task));
  return wrap;
}

function renderIdleContent(task) {
  const wrap = document.createElement("div");
  if (!task) {
    wrap.append(renderStateHead(null));
    wrap.append(renderIdleHatch());
  }
  wrap.append(renderQuickAssign());
  wrap.append(renderAttentionPanel());
  if (task) wrap.append(renderRecentScene(task));
  return wrap;
}

function renderActionFeedOnly(task) {
  const feed = document.createElement("div");
  feed.className = "action-feed";
  const actions = actionEvents();
  if (!actions.length) feed.innerHTML = '<div class="empty-actions">没有动作记录。</div>';
  else feed.append(...actions.slice(-80).map((event) => {
    const row = document.createElement("div");
    row.className = "action-item";
    row.innerHTML = `<time>${esc(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time><i></i><p>${esc(humanAction(event))}</p>`;
    return row;
  }));
  return feed;
}

function renderResultContent(task, compact = false) {
  const wrap = document.createElement("div");
  if (!compact) wrap.append(renderResultMetrics(task));
  if (task.error) {
    const error = document.createElement("div");
    error.className = "result-section risk";
    error.innerHTML = `<h3>执行结果</h3><pre class="plain-answer">${esc(task.error)}</pre>`;
    wrap.append(error);
  } else if (task.conclusions?.length) {
    wrap.append(resultSection("结论", task.conclusions, ""));
    if (!compact && task.risks?.length) wrap.append(resultSection("风险与不确定", task.risks, "risk"));
    if (!compact && task.nextActions?.length) wrap.append(resultSection("建议下一步", task.nextActions, "next"));
  } else if (task.finalResponse) {
    const result = document.createElement("div");
    result.className = "result-section";
    result.innerHTML = `<h3>结论</h3><pre class="plain-answer">${esc(compact ? task.finalResponse.slice(0, 900) : task.finalResponse)}</pre>`;
    wrap.append(result);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-actions";
    empty.textContent = task.status === "queued" ? "任务正在排队。" : "这次任务没有返回文字结论。";
    wrap.append(empty);
  }
  if (!compact && task.artifacts?.length) {
    const block = document.createElement("div");
    block.className = "result-section";
    block.innerHTML = `<h3>产出物 · ${task.artifacts.length}</h3>`;
    block.append(...task.artifacts.map((artifact) => renderArtifact(task, artifact)));
    wrap.append(block);
  }
  if (!compact) {
    const replay = renderReplay(task);
    if (replay) wrap.append(replay);
    wrap.append(renderReviewPanel(task));
    if (state.events.length) {
      const details = document.createElement("details");
      details.className = "details-logs";
      details.innerHTML = `<summary>查看完整动作流 · ${actionEvents().length} 个动作</summary>`;
      details.append(renderActionFeedOnly(task));
      wrap.append(details);
    }
  }
  return wrap;
}

function resultSection(title, items, cls) {
  const block = document.createElement("section");
  block.className = `result-section ${cls}`.trim();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.append(...items.map((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));
  block.append(heading, list);
  return block;
}

function renderTechnicalLogs() {
  const details = document.createElement("details");
  details.className = "details-logs";
  details.innerHTML = `<summary>技术日志 · ${state.events.length} 条</summary><div class="log-body"></div>`;
  const body = details.querySelector(".log-body");
  body.append(...state.events.slice(-200).map((event) => {
    const { key, text } = eventLine(event);
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `<span class="t">${esc(relTime(event.at))}</span><span class="k">${esc(key)}</span><span class="v"></span>`;
    row.querySelector(".v").textContent = text;
    return row;
  }));
  return details;
}

function renderInlineAssign() {
  const box = document.createElement("div");
  box.className = "assign-box";
  box.innerHTML = `<div class="assign-row"><input id="inlinePrompt" placeholder="写一句话，自动匹配 AI 员工"><button class="primary" id="inlineDispatch">派发</button></div><div class="assign-hint" id="inlineHint">需求优先：系统会按任务能力自动匹配员工。</div>`;
  const input = box.querySelector("#inlinePrompt");
  input.addEventListener("input", () => previewInlineRoute(input.value));
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") dispatchInline(input.value); });
  box.querySelector("#inlineDispatch").addEventListener("click", () => dispatchInline(input.value));
  return box;
}

let inlineRouteTimer = null;
function previewInlineRoute(prompt) {
  clearTimeout(inlineRouteTimer);
  const hint = $("#inlineHint");
  if (!prompt.trim()) { if (hint) hint.textContent = "需求优先：系统会按任务能力自动匹配员工。"; return; }
  inlineRouteTimer = setTimeout(async () => {
    try {
      const route = await api("/api/route", { method: "POST", body: JSON.stringify({ prompt: prompt.trim(), domain: "adhoc", outputTypes: ["markdown"] }) });
      state.inlineRoute = route;
      if (hint) {
        hint.classList.add("ready");
        hint.textContent = `推荐 ${agentNameOf(route.recommendedAgent)} · ${route.reasons?.[0] || "按当前能力配置自动匹配"}`;
      }
    } catch { /* route hint is optional */ }
  }, 260);
}

async function dispatchInline(raw) {
  let prompt = String(raw || "").trim();
  if (!prompt) { toast("先写一句要做什么"); return; }
  // 「@员工名 要做什么」：点名就派给谁；名字对不上就当普通文字交给自动路由
  let picked = null;
  const mention = prompt.match(/^@(\S+)\s*([\s\S]*)$/);
  if (mention) {
    const agent = (state.boot?.agents ?? []).find((item) => item.id === mention[1] || item.name === mention[1]);
    if (agent) {
      picked = agent;
      prompt = mention[2].trim();
    }
  }
  if (!prompt) { toast("@ 了员工，还要写一句要做什么"); return; }
  const button = $("#inlineDispatch");
  if (button) button.disabled = true;
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify({ prompt, agent: picked?.id, domain: "adhoc", outputTypes: ["markdown"], cwd: state.boot?.defaultRoot, mode: "workspace-write" }) });
    state.selectedId = task.id;
    state.events = [];
    state.lastSeq = 0;
    openStream(task.id);
    await refreshTasks();
    toast(picked ? `已点名 ${picked.name}，正在跑` : `已派发给 ${agentNameOf(task.agent)}`);
  } catch (error) { toast(error.message); }
  finally { if (button) button.disabled = false; }
}

function renderRecentArtifacts() {
  const box = $("#recentArtifacts");
  const items = state.tasks.flatMap((task) => (task.artifacts || []).map((artifact) => ({ task, artifact }))).slice(0, 3);
  if (!items.length) { box.innerHTML = '<div class="mini-empty">完成任务后，文件会出现在这里</div>'; return; }
  box.replaceChildren(...items.map(({ task, artifact }) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mini-file text-btn";
    row.innerHTML = `<span class="file-icon">${esc(String(artifact.type || "FILE").slice(0, 4).toUpperCase())}</span><div><strong>${esc(artifact.name)}</strong><small>${esc(task.label || "来源任务")} · ${esc(formatSize(artifact.size))}</small></div>`;
    row.addEventListener("click", () => copyPath(artifact.path));
    return row;
  }));
}

function renderAgentQueue() {
  const box = $("#agentQueue");
  const queue = state.tasks.filter((task) => task.status === "queued");
  $("#queueCount").textContent = queue.length ? `还有 ${queue.length} 件排队` : "";
  if (!queue.length) { box.innerHTML = '<div class="mini-empty">队列为空</div>'; return; }
  box.replaceChildren(...queue.slice(0, 3).map((task, index) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    row.innerHTML = `<span class="queue-pos">${index + 1}</span><div><strong>${esc(task.label || "未命名任务")}</strong><small>${esc(agentNameOf(task.agent))} · ${esc(domainLabel(task.domain))} · ${esc(relTime(task.createdAt))}</small></div>`;
    return row;
  }));
}

function formatSize(bytes) {
  if (!Number.isFinite(Number(bytes))) return "大小未知";
  const n = Number(bytes);
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function copyPath(path) {
  try { await navigator.clipboard.writeText(path || ""); toast("路径已复制，可在文件管理器中粘贴定位"); }
  catch { toast("复制失败，请在产出库查看路径"); }
}

/* =========================================================================
   composer (P0-02)
   ========================================================================= */




let routeTimer = null;
function previewRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(async () => {
    const prompt = $("#taskPrompt").value.trim();
    if (!prompt) { $("#routeBox").replaceChildren(); return; }
    try {
      const route = await api("/api/route", {
        method: "POST",
        body: JSON.stringify({
          domain: $("#taskDomain").value,
          prompt,
          outputTypes: selectedOutputs(),
        }),
      });
      renderRoute(route);
    } catch { /* ignore */ }
  }, 260);
}

function renderRoute(route) {
  const box = $("#routeBox");
  const manualId = $("#taskAgent")?.value;
  const agent = agentById(manualId || route.recommendedAgent);
  const confidenceText = { high: "高置信", medium: "中等", low: "低", none: "不可用" }[route.confidence] ?? route.confidence;
  box.innerHTML = `
    <div class="route-head">
      <span>${manualId ? "手动指定" : "路由建议"}</span>
      <strong>${esc(agent?.name ?? route.recommendedAgent)}</strong>
      <span class="conf ${esc(route.confidence)}">${esc(confidenceText)}</span>
    </div>
    <ul>${route.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>`;
}

function selectedOutputs() {
  return $$("#outputTypes input:checked").map((input) => input.value);
}

function renderOutputTypes(preselect = ["markdown"]) {
  const box = $("#outputTypes");
  box.replaceChildren(...Object.entries(OUTPUT_LABEL).map(([id, name]) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = id;
    input.checked = preselect.includes(id);
    input.addEventListener("change", () => { previewRoute(); persistDraft(); });
    label.append(input, document.createTextNode(name));
    return label;
  }));
}

/**
 * 打开派活面板。
 * @param {string|null} preselectSkill 要预选的工作方法名（技能），从工作方法库点「派活」进来时传入
 */
function openComposer(preselectSkill = null) {
  // 技能勾选不清空：连续派几个活通常想沿用同一套方法；
  // 但从库里点「派活」进来时，以点中的那个为准。已删的技能在 renderSkillPicker 里滤掉。
  if (preselectSkill && state.skills.some((item) => item.name === preselectSkill)) {
    state.composer.skills = [preselectSkill];
  }
  renderSelectOptions();
  $("#taskAgent").value = "";
  $("#taskPrompt").value = "";
  $("#taskDomain").replaceChildren(...(state.boot?.domains ?? []).map((domain) => new Option(domain.name, domain.id)));
  $("#taskDomain").value = "adhoc";
  $("#taskPriority").value = "normal";
  $("#taskCwd").replaceChildren(...(state.boot?.allowedRoots ?? []).map((root) => new Option(root, root)));
  $("#taskModel").value = "";
  $("#allowWrite").checked = true;
  renderOutputTypes(["markdown"]);

  const saved = load(LS.draft, null);
  if (saved && !preselectSkill) {
    $("#taskPrompt").value = saved.prompt ?? "";
    if (saved.domain) $("#taskDomain").value = saved.domain;
    if (saved.agent && agentById(saved.agent)?.available) $("#taskAgent").value = saved.agent;
  }

  renderSkillPicker();
  $("#routeBox").replaceChildren();
  if (preselectSkill) previewRoute();
  $("#composerHint").textContent = "自动匹配会选择最适合且已配置的员工，也可手动指定。";

  $("#composer").classList.add("open");
  $("#composer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("show");
  setTimeout(() => $("#taskPrompt").focus(), 220);
}

function closeComposer() {
  $("#composer").classList.remove("open");
  $("#composer").setAttribute("aria-hidden", "true");
  if (!$("#drawer").classList.contains("open")) $("#scrim").classList.remove("show");
}

function persistDraft() {
  save(LS.draft, {
    prompt: $("#taskPrompt").value,
    domain: $("#taskDomain").value,
    agent: $("#taskAgent").value,
    outputs: selectedOutputs(),
  });
}

async function submitTask({ draft = false } = {}) {
  const prompt = $("#taskPrompt").value.trim();
  if (!prompt) {
    toast("先写一句要做什么");
    $("#taskPrompt").focus();
    return;
  }
  const body = {
    prompt,
    title: "",
    domain: $("#taskDomain").value,
    priority: $("#taskPriority").value,
    agent: $("#taskAgent").value || undefined,
    outputTypes: selectedOutputs(),
    cwd: $("#taskCwd").value,
    mode: $("#allowWrite").checked ? "workspace-write" : "read-only",
    model: $("#taskModel").value.trim() || undefined,
    // 勾了技能就显式带上；没勾则由网关按任务描述自动匹配（不再前端猜）
    skills: (state.composer.skills ?? []).length ? state.composer.skills : undefined,
    draft,
  };
  const buttons = [$("#dispatchTask"), $("#saveDraft")];
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    localStorage.removeItem(LS.draft);
    save(LS.params, { cwd: body.cwd, mode: body.mode });
    closeComposer();
    toast(draft ? "已存为草稿" : `已派发给 ${agentNameOf(task.agent)}`);
    await refreshTasks();
    if (!draft) {
      setView("worksite");
      state.selectedId = task.id;
      state.events = [];
      state.lastSeq = 0;
      openStream(task.id);
      renderBoard();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

/* =========================================================================
   drawer (P0-02 result-first, P0-03 staged progress, P1-01 actions)
   ========================================================================= */
async function openDrawer(id) {
  state.selectedId = id;
  state.events = [];
  state.lastSeq = 0;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("show");
  $("#drawerBody").replaceChildren();
  renderBoard();

  try {
    const task = await api(`/api/tasks/${id}`);
    renderDrawer(task);
    if (task.unread) {
      await api(`/api/tasks/${id}/read`, { method: "POST", body: JSON.stringify({ read: true }) });
      const local = state.tasks.find((item) => item.id === id);
      if (local) local.unread = false;
      renderBoard();
      updateTitle();
    }
    openStream(id);
  } catch (error) {
    toast(error.message);
  }
}

function closeDrawer() {
  closeStream();
  state.selectedId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("show");
  renderBoard();
}

/** 状态 → 语气：只决定颜色，不改文案 */
const TASK_TONE = {
  draft: "off",
  queued: "wait",
  running: "run",
  waiting_approval: "wait",
  waiting_user: "wait",
  approval_required: "wait",
  quota_exhausted: "bad",
  completed: "ok",
  failed: "bad",
  cancelled: "off",
  interrupted: "bad",
  archived: "ok",
};

/**
 * 头部两行：第一行标题，第二行状态与属性。
 * 事实区用「标签 + 值」两列网格，不再拼成一句话——窄窗口里一句话会折成三行，
 * 一眼要读的信息反而被埋在最下面。
 */
function renderDrawerMeta(task) {
  const domainName = state.boot?.domains?.find((domain) => domain.id === task.domain)?.name ?? task.domain;
  const sub = [
    `<span class="state-pill ${TASK_TONE[task.status] ?? "off"}">${esc(STATUS_TEXT[task.status] ?? task.status)}</span>`,
    domainName ? `<span class="sub-item">${esc(domainName)}</span>` : "",
    task.mode ? `<span class="sub-item">${task.mode === "read-only" ? "只读" : "可写"}</span>` : "",
  ].filter(Boolean);
  $("#drawerDomain").innerHTML = sub.join("");

  const usage = task.usage ?? null;
  const cost = usage ? costOfUsage(usage, pricingOfAgent(task.agent)) : null;
  const facts = [
    ["创建", esc(relTime(task.createdAt)), new Date(task.createdAt || Date.now()).toLocaleString("zh-CN")],
    task.startedAt ? ["耗时", esc(duration(task)), ""] : null,
    usage ? ["用量", `${esc(fmtTokens(usage.totalTokens))} tokens${cost != null ? ` · 约 ${esc(fmtMoney(cost))}` : ""}`, ""] : null,
    task.cwd ? ["目录", esc(task.cwd.split(/[\\/]/).pop()), task.cwd] : null,
  ].filter(Boolean);
  $("#drawerMeta").innerHTML = facts
    .map(([key, value, title]) =>
      `<div class="fact"><span class="k">${key}</span><span class="v"${title ? ` title="${esc(title)}"` : ""}>${value}</span></div>`)
    .join("");
}

function renderDrawer(task) {
  $("#drawerTitle").textContent = task.label || "未命名任务";
  renderDrawerMeta(task);
  renderActions(task);
  renderBody(task);
}

/**
 * 操作分两层：
 *   外面只放「这次要干什么」——最多三个按钮，主操作在前；
 *   重命名、标签、归档这类管理动作收进「更多」，别和主操作抢注意力。
 */
function renderActions(task) {
  const box = $("#drawerActions");
  const main = [];
  const menu = [];
  const make = (label, cls, handler) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn ${cls}`.trim();
    btn.textContent = label;
    btn.addEventListener("click", handler);
    return btn;
  };
  const primary = (label, cls, handler) => main.push(make(label, cls, handler));
  const more = (label, handler) => menu.push(make(label, "menu-item", handler));

  if (task.status === "draft") {
    primary("派发", "primary", () => act(task.id, "dispatch", "已派发"));
    more("丢弃", () => act(task.id, "cancel", "已丢弃"));
  }
  if (["queued", "running"].includes(task.status)) {
    primary("停止", "danger", () => act(task.id, "cancel", "已发送停止"));
  }
  if (["failed", "interrupted", "cancelled"].includes(task.status)) {
    primary("原样重跑", "primary", () => act(task.id, "rerun", "已重跑", { resume: false }));
    primary("续原线程", "", () => act(task.id, "rerun", "已续接原线程", { resume: true }));
  }
  if (task.status === "completed") {
    primary("再跑一次", "", () => act(task.id, "rerun", "已重跑", { resume: false }));
  }
  if (task.finalResponse) {
    primary("复制结果", "", async () => {
      try { await navigator.clipboard.writeText(task.finalResponse); toast("结果已复制"); }
      catch { toast("复制失败，请手动选择"); }
    });
    more("下载 Markdown", () => downloadMarkdown(task));
  }
  if (task.status === "archived") more("恢复到看板", () => act(task.id, "restore", "已恢复"));
  else if (task.status === "completed") more("归档", () => act(task.id, "archive", "已归档"));
  more("重命名", () => renameTask(task));
  more("标签", () => editTags(task));

  const nodes = [...main];
  if (menu.length) nodes.push(moreMenu(menu));
  box.replaceChildren(...nodes);
}

/** 「更多」下拉：点外面、按 Esc、选完都收起来。 */
function moreMenu(items) {
  const wrap = document.createElement("div");
  wrap.className = "more-wrap";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "btn more-btn";
  trigger.innerHTML = '更多 <span class="more-caret">⌄</span>';
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "more-menu";
  panel.setAttribute("role", "menu");
  panel.hidden = true;
  panel.append(...items);

  const onKey = (event) => { if (event.key === "Escape") close(); };
  const outside = (event) => { if (!wrap.contains(event.target)) close(); };
  const close = () => {
    panel.hidden = true;
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", onKey);
  };
  trigger.addEventListener("click", () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", onKey);
  });
  // 菜单项自己的点击也要收：先冒泡到下面的 close，再执行 handler
  panel.addEventListener("click", () => setTimeout(close, 0));
  wrap.append(trigger, panel);
  return wrap;
}

async function renameTask(task) {
  const title = await promptDialog({
    title: "重命名任务",
    label: "任务名称",
    value: task.label || "",
    placeholder: "例如：DS-65PL0010 招标信息整理",
    okText: "保存",
  });
  if (title === null || !title) return;
  try {
    const updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    renderDrawer(updated);
    await refreshTasks();
    toast("已重命名");
  } catch (error) { toast(error.message); }
}

async function act(id, action, message, body = {}) {
  try {
    const result = await api(`/api/tasks/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    toast(message);
    await refreshTasks();
    renderDrawer(result);
    if (["dispatch", "rerun"].includes(action)) openStream(id);
  } catch (error) {
    toast(error.message);
  }
}

async function editTags(task) {
  const current = (task.tags ?? []).join("、");
  const input = await promptDialog({
    title: "编辑标签",
    label: "标签",
    value: current,
    placeholder: "招标、DS-65PL0010",
    hint: "用顿号或逗号分隔，标签会出现在任务卡片和筛选里",
    required: false,
    okText: "保存",
  });
  if (input === null) return;
  const tags = input.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean);
  try {
    const updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ tags }) });
    renderDrawer(updated);
    await refreshTasks();
  } catch (error) {
    toast(error.message);
  }
}

function downloadMarkdown(task) {
  const header = `# ${task.label}\n\n> ${new Date(task.createdAt || Date.now()).toLocaleString("zh-CN")} · ${task.agent || "codex"}\n\n`;
  const blob = new Blob([header + (task.finalResponse || "")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(task.label || "task").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================================================================
   临时任务详情
   -------------------------------------------------------------------------
   口径与流程步骤一致：结论优先、产物其次，过程只留一句「正在做什么」。
   技术日志、动作流、任务信息一律默认收起——它们是排障用的，不是日常要看的东西。
   ========================================================================= */

/** 执行中的一句话：从最近一条生命周期事件里取，不看 token 流。 */
function liveProgress(task) {
  if (!["running", "waiting_user", "approval_required", "quota_exhausted", "queued"].includes(task.status)) return null;
  if (task.status === "queued") return { text: "排队中，还没轮到它", at: task.queuedAt || task.createdAt };
  if (task.status === "approval_required") return { text: "等你批准一个操作", at: task.lastOutputAt };
  if (task.status === "quota_exhausted") return { text: "额度用完了，等你处理", at: task.lastOutputAt };
  const events = state.events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event.data || {};
    const type = data.type || "";
    // 只认这些能说明「在干什么」的事件，delta 与 tool.* 按口径不进界面
    if (event.type === "runtime" && data.phase) {
      const label = { connecting: "正在连接模型", streaming: "模型正在生成", fallback: "切换备用通道", ready: "连接就绪" }[data.phase];
      if (label) return { text: label, at: event.at };
    }
    if (event.type === "silence") {
      return { text: `已 ${silenceText(data.silentSeconds)} 没有新输出，进程还在`, at: event.at, warn: true };
    }
    if (["codex", "agent"].includes(event.type) && type === "turn.started") {
      return { text: "AI 员工正在处理这一轮", at: event.at };
    }
  }
  return { text: "已接手，正在执行", at: task.startedAt || task.createdAt };
}

function renderLiveStrip(task) {
  const live = liveProgress(task);
  if (!live) return null;
  const strip = document.createElement("div");
  strip.className = `live-strip${live.warn ? " warn" : ""}`;
  strip.innerHTML = `<i></i><span class="live-text">${esc(live.text)}</span><span class="live-time">${relTime(live.at)}</span>`;
  return strip;
}

/**
 * 结论：有结构化结论就分段列，没有就把正文按文档结构渲染。
 * 不再用等宽文本框装整篇回答——那是日志的样子，不是结论的样子。
 */
function renderConclusionBlock(task) {
  const block = section("结论", null);
  if (task.conclusions?.length) {
    block.append(bullets(task.conclusions, "concl"));
    if (task.risks?.length) block.append(section("风险与不确定", bullets(task.risks, "concl risks")));
    if (task.nextActions?.length) block.append(section("建议下一步", bullets(task.nextActions, "concl next")));
    return block;
  }
  if (!task.finalResponse) return null;
  const box = document.createElement("div");
  box.className = "run-step-conclusion";
  block.append(box);
  hydrateRunConclusion(box, task.finalResponse);
  return block;
}

function renderBody(task) {
  const body = $("#drawerBody");
  body.replaceChildren();

  // 1. 正在做什么（只有跑着的时候才有）
  const live = renderLiveStrip(task);
  if (live) body.append(live);

  // 2. 结论：详情里唯一的正文，单独一张卡，不和折叠行挤在一起
  if (task.status === "completed" || task.finalResponse || task.conclusions?.length) {
    const conclusion = renderConclusionBlock(task);
    if (conclusion) {
      conclusion.classList.add("detail-card");
      body.append(conclusion);
    }
  }
  if (task.status === "completed" && !task.finalResponse && !task.conclusions?.length) {
    const empty = section("结论", null);
    empty.classList.add("detail-card");
    const note = document.createElement("p");
    note.className = "empty-actions";
    note.textContent = "这次任务没有返回文字结论。";
    empty.append(note);
    body.append(empty);
  }

  if (task.error) {
    // 取消不是失败：别用红卡把「人叫停的」说成「出错」
    const cancelled = task.status === "cancelled";
    const block = section(cancelled ? "已取消" : "执行失败", null);
    block.classList.add("detail-card", cancelled ? "detail-muted" : "detail-bad");
    const pre = document.createElement("pre");
    pre.className = "plain-answer";
    pre.textContent = cancelled && /^task cancelled$/i.test(String(task.error).trim())
      ? "这一轮被取消了，没有拿到产出。"
      : task.error;
    block.append(pre);
    body.append(block);
  }

  // 3. 产物：图片直接显示，文本直接读
  if (task.artifacts?.length) {
    const block = section(`产出物 · ${task.artifacts.length}`, null);
    block.classList.add("detail-card");
    block.append(...task.artifacts.map((artifact) => renderArtifact(task, artifact)));
    body.append(block);
  }

  // 3.5 成员协作：别人本机智能体推进来的产物与动态（实时）
  body.append(renderCollabPanel(task));

  // 4. 过程与诊断：三件事合成一组，标题在左、计数在右，收起时只占三行
  const folds = document.createElement("div");
  folds.className = "detail-folds";

  const progress = detailFold("执行进度", `${STAGES.length} 个阶段`);
  progress.querySelector(".fold-body").append(renderStages(task));

  const logs = detailFold("技术日志", '<span data-log-count>0</span> 条');
  const logBody = document.createElement("div");
  logBody.className = "log-body";
  logBody.id = "logBody";
  logs.querySelector(".fold-body").append(logBody);

  // 注意：这里不能用日志的 .log-row（三列网格），两列内容会把值挤进 56px 的中列；
  // 指令是多行文本，用 .info-item 且保留换行。
  const infoRows = [
    ["完整指令", esc(task.prompt)],
    // 员工被删掉后只剩内部 ID（custom-xxxx），对读的人没意义，统一说成「自定义员工」
    ["执行员工", !task.agent ? "—" : (agentNameOf(task.agent) === task.agent ? "自定义员工" : esc(agentNameOf(task.agent)))],
    ["目录", esc(task.cwd)],
    ["权限", task.mode === "read-only" ? "只读分析" : "允许修改文件"],
    ["模型", esc(task.model || "默认")],
    ["线程", esc(task.threadId || "无")],
    ["产出格式", (task.outputTypes ?? []).map((type) => OUTPUT_LABEL[type] ?? type).join("、") || "未指定"],
    ["执行轮次", `${task.runs?.length ?? 0} 次`],
  ];
  const info = detailFold("任务信息", `${infoRows.length} 项`);
  info.querySelector(".fold-body").innerHTML = `<div class="info-list">${infoRows
    .map(([key, value]) => `<div class="info-item"><span class="k">${key}</span><span class="v">${value || "—"}</span></div>`)
    .join("")}</div>`;

  folds.append(progress, logs, info);
  body.append(folds);
  paintLogs();
}

/** 折叠行：标题在左、计数在右，展开的内容挂在 .fold-body 里。 */
function detailFold(title, countHtml) {
  const row = document.createElement("details");
  row.className = "fold-row";
  row.innerHTML = `<summary><span class="fold-title">${title}</span><span class="fold-count">${countHtml}</span><span class="fold-caret" aria-hidden="true">⌄</span></summary><div class="fold-body"></div>`;
  // 展开后把这一行带进视野：正文区会滚，停在原来的位置会看见半截内容
  row.addEventListener("toggle", () => {
    if (row.open) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  return row;
}

function section(title, content) {
  const block = document.createElement("div");
  block.className = "result-block";
  const h = document.createElement("h3");
  h.className = "block-head-title";
  h.textContent = title;
  block.append(h);
  if (content) block.append(content);
  return block;
}

function bullets(items, cls) {
  const ul = document.createElement("ul");
  ul.className = cls;
  ul.append(...items.map((text, index) => {
    const li = document.createElement("li");
    const mark = document.createElement("b");
    mark.textContent = String(index + 1).padStart(2, "0");
    const span = document.createElement("span");
    span.textContent = text;
    li.append(mark, span);
    return li;
  }));
  return ul;
}

function renderArtifact(task, artifact) {
  const row = document.createElement("div");
  row.className = `artifact-row inline${artifact.exists === false ? " missing" : ""}`;
  const info = document.createElement("div");
  info.innerHTML = `<div class="name">${esc(artifact.name)}</div><div class="path">${esc(artifact.relativePath || artifact.path)}</div>`;
  const act = document.createElement("div");
  act.className = "act";

  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "btn";
  preview.textContent = "放大查看";
  preview.addEventListener("click", () => openArtifactPreview(task, artifact));
  act.append(preview);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn";
  copy.textContent = "复制路径";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(artifact.path); toast("路径已复制"); }
    catch { toast("复制失败"); }
  });
  act.append(copy);

  row.append(info, act);

  // 直接呈现：图片内联成图，文本类直接铺文字，不用再点一次预览
  const stage = document.createElement("div");
  stage.className = "artifact-inline";
  stage.innerHTML = `<div class="artifact-inline-loading">正在加载内容…</div>`;
  row.append(stage);
  hydrateInlineArtifact(stage, task, artifact);
  return row;
}

async function hydrateInlineArtifact(stage, task, artifact) {
  const ext = extOf(artifact.name);
  const path = `/api/artifacts/${encodeURIComponent(task.id)}/content/${encodeURIComponent(artifact.id)}`;
  try {
    if (PREVIEW_IMAGE_EXT.has(ext)) {
      const blob = await fetchArtifactBlob(`${path}?raw=1`);
      const url = URL.createObjectURL(blob);
      stage.innerHTML = "";
      const img = document.createElement("img");
      img.className = "artifact-thumb";
      img.src = url;
      img.alt = artifact.name;
      img.title = "点击放大查看";
      img.addEventListener("click", () => openArtifactPreview(task, artifact));
      img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      stage.append(img);
      return;
    }
    if (isPreviewText(artifact, ext)) {
      const data = await api(path);
      stage.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "plain-answer artifact-pre";
      pre.textContent = data.content;
      stage.append(pre);
      return;
    }
    stage.innerHTML = `<div class="artifact-inline-note">这个文件不支持内联展示，点「放大查看」或到产出库取件。</div>`;
  } catch (error) {
    stage.innerHTML = `<div class="artifact-inline-note bad">${esc(error.message)}</div>`;
  }
}

/* =========================================================================
   产出物预览弹窗（任务详情与产出库共用）
   - 图片 / PDF / HTML：?raw=1 拿原始字节，走 blob URL 内联呈现
   - Markdown / 文本 / JSON / CSV：拿文本直接展示
   - 其他类型：给出下载入口
   ========================================================================= */
const PREVIEW_IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const PREVIEW_TEXT_TYPES = new Set(["markdown", "text", "json", "csv"]);
const PREVIEW_HTML_EXT = new Set(["html", "htm"]);
// 有些文件登记成 file 类型，其实是纯文本：按扩展名兜住，照样直接显示
const PREVIEW_TEXT_EXT = new Set([
  "md", "markdown", "txt", "log", "json", "csv", "tsv",
  "js", "cjs", "mjs", "ts", "css", "scss", "html", "htm", "xml", "yml", "yaml",
  "py", "sh", "ps1", "bat", "sql", "toml", "ini", "conf",
]);
const isPreviewText = (artifact, ext) => PREVIEW_TEXT_TYPES.has(artifact.type) || PREVIEW_TEXT_EXT.has(ext);
let previewBlobUrl = null;
let previewTarget = null; // 当前弹窗展示的 { task, artifact }，下载/复制用

const extOf = (name) => String(name || "").split(".").pop()?.toLowerCase() ?? "";

async function fetchArtifactBlob(path) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
  if (!response.ok) {
    let message = `加载失败（${response.status}）`;
    try { message = (await response.json()).error ?? message; } catch { /* 非 JSON 响应就保留默认文案 */ }
    throw new Error(message);
  }
  return response.blob();
}

function releasePreviewBlob() {
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }
}

async function openArtifactPreview(task, artifact) {
  previewTarget = { task, artifact };
  const dialog = $("#artifactPreview");
  const body = $("#apreviewBody");
  const meta = artifactType(artifact.type);
  $("#apreviewName").textContent = artifact.name || "未命名文件";
  $("#apreviewMeta").textContent = `${meta.label} · ${formatSize(artifact.size)} · ${artifact.relativePath || artifact.path}`;
  const icon = $("#apreviewIcon");
  icon.className = `lib-ico ${meta.tone}`;
  icon.textContent = meta.code;
  $("#apreviewDownload").hidden = false;
  body.innerHTML = `<div class="apreview-note">正在打开…</div>`;
  if (!dialog.open) dialog.showModal();

  releasePreviewBlob();
  const ext = extOf(artifact.name);
  const path = `/api/artifacts/${encodeURIComponent(task.id)}/content/${encodeURIComponent(artifact.id)}`;
  try {
    if (PREVIEW_IMAGE_EXT.has(ext)) {
      const blob = await fetchArtifactBlob(`${path}?raw=1`);
      previewBlobUrl = URL.createObjectURL(blob);
      body.innerHTML = `<div class="apreview-image"><img src="${previewBlobUrl}" alt="${esc(artifact.name)}"></div>`;
      return;
    }
    if (ext === "pdf") {
      const blob = await fetchArtifactBlob(`${path}?raw=1`);
      previewBlobUrl = URL.createObjectURL(blob);
      body.innerHTML = `<iframe class="apreview-frame" src="${previewBlobUrl}" title="${esc(artifact.name)}"></iframe>`;
      return;
    }
    if (PREVIEW_HTML_EXT.has(ext) || artifact.type === "html") {
      const blob = await fetchArtifactBlob(`${path}?raw=1`);
      previewBlobUrl = URL.createObjectURL(new Blob([await blob.text()], { type: "text/html; charset=utf-8" }));
      body.innerHTML = `<iframe class="apreview-frame" sandbox="allow-same-origin" src="${previewBlobUrl}" title="${esc(artifact.name)}"></iframe>`;
      return;
    }
    if (isPreviewText(artifact, ext)) {
      const data = await api(path);
      body.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "plain-answer apreview-text";
      pre.textContent = data.content;
      body.append(pre);
      return;
    }
    body.innerHTML = `<div class="apreview-note">这类文件（${esc(meta.label)}）浏览器里放不出来，点「下载」拿走原文件。</div>`;
  } catch (error) {
    body.innerHTML = `<div class="apreview-note bad">${esc(error.message)}</div>`;
  }
}

async function downloadArtifact(task, artifact) {
  try {
    const blob = await fetchArtifactBlob(`/api/artifacts/${encodeURIComponent(task.id)}/content/${encodeURIComponent(artifact.id)}?raw=1`);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name || "artifact";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("已开始下载");
  } catch (error) {
    toast(error.message);
  }
}

// 弹窗按钮是一次性绑定；task/artifact 存在按钮上下文里
$("#apreviewClose")?.addEventListener("click", () => {
  releasePreviewBlob();
  $("#artifactPreview").close();
});
$("#artifactPreview")?.addEventListener("close", releasePreviewBlob);
$("#apreviewCopy")?.addEventListener("click", () => {
  const artifact = previewTarget?.artifact;
  if (artifact) copyPath(artifact.path);
});
$("#apreviewDownload")?.addEventListener("click", () => {
  if (previewTarget) downloadArtifact(previewTarget.task, previewTarget.artifact);
});

/* =========================================================================
   stages + logs (P0-03)
   ========================================================================= */
const STAGES = [
  { id: "queue", name: "排队" },
  { id: "start", name: "启动" },
  { id: "work", name: "执行中" },
  { id: "write", name: "回复" },
  { id: "done", name: "结束" },
];

function stageIndexOf(events, task) {
  let index = 0;
  for (const event of events) {
    const data = event.data || {};
    if (event.type === "gateway") {
      if (data.status === "queued" || data.status === "draft") index = Math.max(index, 0);
      if (data.status === "running") index = Math.max(index, 1);
      if (["completed", "failed", "cancelled", "interrupted"].includes(data.status)) index = Math.max(index, 3);
    }
    if (["codex", "agent"].includes(event.type)) {
      if (data.type === "thread.started" || data.type === "turn.started") index = Math.max(index, 2);
      if (data.type === "turn.completed") index = Math.max(index, 3);
      if (data.type === "item.completed" || data.type?.startsWith("item.")) index = Math.max(index, 2);
    }
    if (event.type === "stdout" || event.type === "stderr") index = Math.max(index, 2);
  }
  if (["completed", "failed", "cancelled", "interrupted", "archived"].includes(task.status)) index = Math.max(index, 4);
  return index;
}

function renderStages(task) {
  const index = stageIndexOf(state.events, task);
  const complete = ["completed", "archived"].includes(task.status);
  const broken = ["failed", "interrupted"].includes(task.status);
  const list = document.createElement("div");
  list.className = "stage-list";
  // 流光只铺到当前节点：位置由真实阶段索引决定，不表达百分比
  const ratio = complete ? 100 : (index / Math.max(1, STAGES.length - 1)) * 100;
  list.style.setProperty("--stage-progress", `${ratio}%`);
  STAGES.forEach((stage, i) => {
    const row = document.createElement("div");
    const cls = ["stage"];
    if (complete || i < index) cls.push("done");
    if (!complete && i === index) cls.push(broken ? "bad" : "current");
    row.className = cls.join(" ");
    row.innerHTML = `<i>${String(i + 1).padStart(2, "0")}</i><span>${esc(stage.name)}</span>`;
    list.append(row);
  });
  return list;
}

/* 空闲态的空舱门：五段全部空心，明确说明不代表完成比例 */
function renderIdleHatch() {
  const box = document.createElement("div");
  box.className = "block";
  const list = document.createElement("div");
  list.className = "stage-list";
  list.style.setProperty("--stage-progress", "0%");
  STAGES.forEach((stage, i) => {
    const row = document.createElement("div");
    row.className = "stage";
    row.innerHTML = `<i>${String(i + 1).padStart(2, "0")}</i><span>${esc(stage.name)}</span>`;
    list.append(row);
  });
  const note = document.createElement("p");
  note.className = "assign-hint";
  note.textContent = "任务进入后自动生成执行路径 · 五段是固定阶段，不表示完成比例";
  box.append(list, note);
  return box;
}

function renderStateHead(task) {
  const head = document.createElement("div");
  head.className = "state-head";
  if (task) {
    const agentName = (state.boot?.agents || []).find((agent) => agent.id === (task.agent || "codex"))?.name || "Codex";
    head.innerHTML = `
      <div class="sh-main">
        <strong>${esc(task.label || "未命名任务")}</strong>
        <small>${esc(domainLabel(task.domain))} · ${esc(STATUS_TEXT[task.status] || task.status)} · ${esc(duration(task) || "刚刚开始")}</small>
      </div>
      <div class="sh-facts">
        <div><b>${esc(agentName)}</b><span>执行员工</span></div>
        <div><b>${task.mode === "workspace-write" ? "可写" : "只读"}</b><span>文件权限</span></div>
      </div>`;
    if (["completed", "archived"].includes(task.status)) head.classList.add("ok");
    if (["failed", "interrupted"].includes(task.status)) head.classList.add("bad");
    return head;
  }
  const today = new Date().toDateString();
  const todayTasks = state.tasks.filter((item) => item.finishedAt && new Date(item.finishedAt).toDateString() === today);
  const doneToday = todayTasks.filter((item) => item.status === "completed").length;
  const online = (state.boot?.agents || []).filter((agent) => agent.available).length;
  head.innerHTML = `
    <div class="sh-main"><strong>等待任务</strong><small>${online} 名 AI 员工在线 · 写一句话就能派活</small></div>
    <div class="sh-facts">
      <div><b>${online}</b><span>在线员工</span></div>
      <div><b>${doneToday}</b><span>今日完成</span></div>
      <div><b>${state.tasks.length}</b><span>累计任务</span></div>
    </div>`;
  return head;
}

/* 空闲态：快速派活 + 需要注意 + 最近现场，三块共同撑起主区 */
function renderQuickAssign() {
  const block = document.createElement("div");
  block.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = "<h3>快速派活</h3><span>选一个工作方法直接开单</span>";
  const grid = document.createElement("div");
  grid.className = "quick-assign-grid";
  const picks = localSkills().slice(0, 3);
  picks.forEach((skill) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "qa-card";
    card.innerHTML = `<strong>${esc(skill.title || skill.name)}</strong><small>${esc(skill.summary || "")}</small><div class="qa-meta"><span>${esc(skill.category || "工作方法")}</span><span>${esc(skill.name)}</span></div>`;
    card.addEventListener("click", () => openComposer(skill.name));
    grid.append(card);
  });
  const fresh = document.createElement("button");
  fresh.type = "button";
  fresh.className = "qa-card";
  fresh.innerHTML = '<strong>＋ 新建任务</strong><small>写一句话说明你要的结果</small><div class="qa-meta"><span>自由输入</span><span>自动推荐员工</span></div>';
  fresh.addEventListener("click", () => openComposer(null));
  grid.append(fresh);
  block.append(head, grid);
  return block;
}

function renderAttentionPanel() {
  const block = document.createElement("div");
  block.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  const attention = state.tasks.filter((task) => ["failed", "interrupted"].includes(task.status));
  head.innerHTML = `<h3>需要注意 · 可用员工</h3><span>${attention.length} 条异常</span>`;
  const cols = document.createElement("div");
  cols.className = "two-col";

  const left = document.createElement("div");
  left.className = "mini-list";
  if (!attention.length) {
    const row = document.createElement("div");
    row.className = "ml-row";
    row.innerHTML = '<span class="status-dot completed"></span><span>没有需要处理的异常</span>';
    left.append(row);
  } else {
    attention.slice(0, 4).forEach((task) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ml-row";
      row.style.background = "none";
      row.style.border = "0";
      row.style.borderBottom = "1px solid var(--border-subtle)";
      row.style.textAlign = "left";
      row.innerHTML = `<span class="status-dot ${esc(task.status)}"></span><span>${esc((task.label || "未命名").slice(0, 20))}</span><b>${esc(relTime(task.finishedAt || task.updatedAt))}</b>`;
      row.addEventListener("click", () => openDrawer(task.id));
      left.append(row);
    });
  }

  const right = document.createElement("div");
  right.className = "mini-list";
  (state.boot?.agents || []).forEach((agent) => {
    const row = document.createElement("div");
    row.className = "ml-row";
    row.innerHTML = `<span class="status-dot ${agent.available ? "completed" : "cancelled"}"></span><span>${esc(agent.name)}</span><b>${agent.available ? "可派活" : "未接入"}</b>`;
    right.append(row);
  });

  cols.append(left, right);
  block.append(head, cols);
  return block;
}

function renderRecentScene(task) {
  const block = document.createElement("div");
  block.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = `<h3>最近现场</h3><span>最近 ${Math.min(3, state.tasks.length)} 次任务</span>`;
  const list = document.createElement("div");
  list.className = "mini-list";
  state.tasks.slice(0, 3).forEach((item) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ml-row";
    row.style.background = "none";
    row.style.border = "0";
    row.style.borderBottom = "1px solid var(--border-subtle)";
    row.style.textAlign = "left";
    row.innerHTML = `<span class="status-dot ${esc(item.status)}"></span><span>${esc((item.label || "未命名").slice(0, 26))}</span><b>${esc(duration(item) || "")}${item.finishedAt ? ` · ${esc(relTime(item.finishedAt))}` : ""}</b>`;
    row.addEventListener("click", () => openDrawer(item.id));
    list.append(row);
  });
  block.append(head, list);
  return block;
}

/* 运行中：四个事实格，没有进度百分比，没有预计剩余时间 */
function renderExecCard(task) {
  const events = actionEvents();
  const silence = lastSilence();
  const silent = Boolean(silence) && Number(silence.silentSeconds) >= Number(silence.thresholdSeconds || 300);
  const card = document.createElement("div");
  card.className = "exec-card";
  card.innerHTML = `
    <div class="exec-cell"><span>已执行动作</span><b>${events.length}</b></div>
    <div class="exec-cell"><span>已耗时</span><b>${esc(duration(task) || "刚刚开始")}</b></div>
    <div class="exec-cell"><span>当前动作</span><b title="${esc(lastActionText())}">${esc(lastActionText())}</b></div>
    <div class="exec-cell${silent ? " warn" : ""}"><span>最后动作</span><b>${esc(actionAge())}</b></div>`;
  return card;
}

function renderBlockerPanel(task) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  const alerts = state.events.filter((event) => {
    const data = event.data || {};
    if (event.type === "stderr") return Boolean(String(data.text || "").trim());
    if (event.type === "gateway") return Boolean(data.error);
    if (["codex", "agent"].includes(event.type) && data.type === "error") return true;
    return false;
  });
  const silences = silenceAlerts();
  if (!alerts.length && !silences.length) {
    head.innerHTML = '<h3>阻塞与告警</h3><span>链路正常</span>';
    const panel = document.createElement("div");
    panel.className = "blocker-panel clean";
    panel.innerHTML = "<p>没有阻塞。所有动作都在正常返回，下方动作流持续更新。</p>";
    wrap.append(head, panel);
    return wrap;
  }
  const silence = lastSilence();
  head.innerHTML = alerts.length
    ? `<h3>阻塞与告警</h3><span>${alerts.length} 条异常输出</span>`
    : `<h3>阻塞与告警</h3><span>已静默 ${esc(silenceText(silence?.silentSeconds))}</span>`;
  const panel = document.createElement("div");
  panel.className = "blocker-panel";
  const texts = alerts.slice(-2).map((event) => {
    const data = event.data || {};
    return String(data.text || data.error || data.message || "").trim().slice(0, 180);
  }).filter(Boolean);
  const rows = texts.map((text) => `<p>${esc(text)}</p>`);
  if (silence) {
    // Facts only: how long it has been quiet, and that the process is untouched.
    rows.push(
      `<p class="silence-note">已连续 ${esc(silenceText(silence.silentSeconds))} 没有任何输出。网关没有中断它，进程仍在运行——长时间推理本来就不产生输出，你可以继续等，也可以手动取消。</p>`
    );
  }
  panel.innerHTML = rows.length ? rows.join("") : "<p>检测到异常输出，详见技术日志。</p>";
  wrap.append(head, panel);
  return wrap;
}

/* 已完成：四格量化结果 */
function renderResultMetrics(task) {
  const box = document.createElement("div");
  box.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = `<h3>结果摘要</h3><span>${esc(STATUS_TEXT[task.status] || task.status)}</span>`;
  const grid = document.createElement("div");
  grid.className = "result-metrics";
  const artifacts = task.artifacts?.length || 0;
  const actions = actionEvents().length;
  const errors = task.error ? 1 : 0;
  grid.innerHTML = `
    <div class="metric-cell${artifacts ? " ok" : ""}"><span>产出物</span><b>${artifacts}</b></div>
    <div class="metric-cell"><span>总耗时</span><b>${esc(duration(task) || "—")}</b></div>
    <div class="metric-cell"><span>动作数</span><b>${actions}</b></div>
    <div class="metric-cell${errors ? " bad" : ""}"><span>异常</span><b>${errors}</b></div>`;
  box.append(head, grid);
  return box;
}

/* 执行回放：每段阶段第一次出现的事件时间 */
function stageTimeline(events, task) {
  const first = new Map();
  let index = 0;
  for (const event of events) {
    const data = event.data || {};
    if (event.type === "gateway") {
      if (data.status === "queued" || data.status === "draft") index = Math.max(index, 0);
      if (data.status === "running") index = Math.max(index, 1);
      if (["completed", "failed", "cancelled", "interrupted"].includes(data.status)) index = Math.max(index, 3);
    }
    if (["codex", "agent"].includes(event.type)) {
      if (data.type === "turn.started" || data.type === "thread.started") index = Math.max(index, 2);
      if (data.type === "turn.completed") index = Math.max(index, 3);
      if (String(data.type || "").startsWith("item.")) index = Math.max(index, 2);
    }
    if (event.type === "stdout" || event.type === "stderr") index = Math.max(index, 2);
    if (!first.has(index)) first.set(index, event.at);
  }
  return [...first.entries()].sort((a, b) => a[0] - b[0]);
}

function renderReplay(task) {
  const rows = stageTimeline(state.events, task);
  if (rows.length < 2) return null;
  const box = document.createElement("div");
  box.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = '<h3>执行回放</h3><span>按真实事件时间还原</span>';
  const list = document.createElement("div");
  list.className = "replay";
  let prevAt = null;
  rows.forEach(([index, at]) => {
    const time = new Date(at).getTime();
    const span = prevAt == null ? null : Math.max(0, Math.round((time - prevAt) / 1000));
    prevAt = time;
    const row = document.createElement("div");
    row.className = "replay-row";
    row.innerHTML = `<span>${esc(STAGES[index]?.name || "—")}</span><p>${esc(new Date(at).toLocaleTimeString("zh-CN", { hour12: false }))}</p><b>${span == null ? "起点" : `+${span}s`}</b>`;
    list.append(row);
  });
  box.append(head, list);
  return box;
}

function renderReviewPanel(task) {
  const box = document.createElement("div");
  box.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  head.innerHTML = '<h3>复盘与后续</h3><span>基于本次记录</span>';
  const list = document.createElement("div");
  list.className = "mini-list";
  const rows = [];
  if (task.threadId) rows.push(["线程", `${task.threadId.slice(0, 20)}…`]);
  rows.push(["目录", (task.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "默认目录"]);
  rows.push(["权限", task.mode === "workspace-write" ? "允许改文件" : "只读"]);
  if (task.artifacts?.length) rows.push(["产出", `${task.artifacts.length} 个文件已登记`]);
  if (task.error) rows.push(["异常", task.error.slice(0, 60)]);
  rows.forEach(([key, value]) => {
    const row = document.createElement("div");
    row.className = "ml-row";
    row.innerHTML = `<span>${esc(key)}</span><b title="${esc(value)}">${esc(value)}</b>`;
    list.append(row);
  });
  const again = document.createElement("button");
  again.type = "button";
  again.className = "btn block-action";
  again.textContent = "按本次配置再次派活";
  again.addEventListener("click", () => act(task.id, "rerun", "已重跑", { resume: false }));
  box.append(head, list, again);
  return box;
}

/* 失败态：故障摘要 / 诊断证据 / 恢复方案 */
function renderFailureContent(task) {
  const wrap = document.createElement("div");

  const summary = document.createElement("div");
  summary.className = "block";
  summary.innerHTML = `<div class="block-head"><h3>故障摘要</h3><span>${esc(STATUS_TEXT[task.status] || task.status)}</span></div>`;
  const panel = document.createElement("div");
  panel.className = "fault-panel";
  const rows = [
    ["错误类型", task.status === "interrupted" ? "执行中断（进程被回收或超时）" : "执行失败"],
    ["发生时间", task.finishedAt ? new Date(task.finishedAt).toLocaleString("zh-CN") : "—"],
    ["已执行", `${actionEvents().length} 个动作`],
    ["详情", task.error || "无更多信息"],
  ];
  panel.innerHTML = rows.map(([key, value]) => `<div class="fp-row"><span>${esc(key)}</span><p>${esc(value)}</p></div>`).join("");
  summary.append(panel);
  wrap.append(summary);

  const diag = document.createElement("div");
  diag.className = "block";
  diag.innerHTML = '<div class="block-head"><h3>诊断证据</h3><span>最后几条动作</span></div>';
  const feed = document.createElement("div");
  feed.className = "action-feed";
  const actions = actionEvents().slice(-8);
  if (!actions.length) feed.innerHTML = '<div class="empty-actions">该任务没有留下动作记录。</div>';
  else feed.append(...actions.map((event) => {
    const row = document.createElement("div");
    row.className = "action-item";
    row.innerHTML = `<time>${esc(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time><i></i><p>${esc(humanAction(event))}</p>`;
    return row;
  }));
  diag.append(feed, renderTechnicalLogs());
  wrap.append(diag);

  const recovery = document.createElement("div");
  recovery.className = "block";
  recovery.innerHTML = '<div class="block-head"><h3>恢复方案</h3><span>按推荐顺序</span></div>';
  const list = document.createElement("div");
  list.className = "recovery-list";
  const options = [
    ["1", task.threadId ? "续原线程" : "原样重跑", task.threadId ? "保留上下文，从断点继续" : "用相同配置再跑一次", () => act(task.id, "rerun", "已重跑", { resume: Boolean(task.threadId) })],
    ["2", "复制诊断", "把错误详情复制到剪贴板", () => {
      const text = [task.label, task.status, task.error, `${actionEvents().length} 个动作`].filter(Boolean).join("\n");
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast("诊断已复制"), () => toast("复制失败，请手动选择"));
      else toast("当前浏览器不支持剪贴板");
    }],
    ["3", "改后重跑", "打开派活面板，改完参数再派", () => openComposer(null)],
  ];
  options.forEach(([num, title, hint, handler]) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recovery-item";
    item.innerHTML = `<span class="ri-num">${num}</span><div><b>${esc(title)}</b><br><small>${esc(hint)}</small></div>`;
    item.addEventListener("click", handler);
    list.append(item);
  });
  recovery.append(list);
  wrap.append(recovery);
  return wrap;
}

function eventLine(event) {
  const data = event.data || {};
  let key = event.type;
  let text = "";
  if (event.type === "gateway") {
    text = data.error ? `${data.status} · ${data.error}` : String(data.status ?? "");
  } else if (event.type === "stdout" || event.type === "stderr") {
    text = String(data.text ?? "").trim();
  } else if (event.type === "process") {
    text = `PID ${data.pid ?? "?"} · ${data.command ?? ""}`;
  } else if (event.type === "silence") {
    text = `已静默 ${silenceText(data.silentSeconds)} · 没有收到任何输出（进程未中断）`;
  } else if (["codex", "agent"].includes(event.type)) {
    key = data.type ?? event.type;
    const item = data.item || {};
    text = item.text || item.command || item.name || (data.error?.message ?? "") || item.type || "";
  } else {
    text = JSON.stringify(data);
  }
  if (typeof text === "string" && text.length > 400) text = `${text.slice(0, 400)}…`;
  return { key, text };
}

function paintLogs() {
  const box = $("#logBody");
  if (!box) {
    if (state.view === "worksite") renderAdhoc();
    renderEmployeeStrip();
    return;
  }
  const count = $("[data-log-count]");
  if (count) count.textContent = String(state.events.length);
  const rows = state.events.slice(-200).map((event) => {
    const { key, text } = eventLine(event);
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `<span class="t">${relTime(event.at)}</span><span class="k">${esc(key)}</span><span class="v"></span>`;
    row.querySelector(".v").textContent = text;
    return row;
  });
  box.replaceChildren(...rows);
  box.scrollTop = box.scrollHeight;
  if (state.view === "worksite") {
    renderAdhoc();
  }
  // 员工栏常驻：任务状态变了，任何页面顶部的卡片都要跟着亮/灭
  renderEmployeeStrip();
}

/* =========================================================================
   SSE (P0-04)
   ========================================================================= */
function closeStream() {
  state.stream?.ctrl.abort();
  state.stream = null;
}

function openStream(id) {
  closeStream();
  const ctrl = new AbortController();
  state.stream = { id, ctrl, lastSeq: 0 };
  pump(id, ctrl);
}

async function pump(id, ctrl) {
  try {
    const response = await fetch(`/api/tasks/${id}/events`, {
      headers: {
        authorization: `Bearer ${state.token}`,
        "last-event-id": String(state.stream?.lastSeq ?? 0),
      },
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error(`事件流 ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const { events, tail } = parseSse(buffer);
      buffer = tail;
      for (const event of events) handleStreamEvent(id, event);
    }
    // Server closed the stream: reconnect from the last sequence we rendered.
    if (state.stream?.id === id && !ctrl.signal.aborted) {
      setTimeout(() => { if (state.stream?.id === id) pump(id, ctrl); }, 800);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (state.stream?.id === id) {
      setTimeout(() => { if (state.stream?.id === id) pump(id, ctrl); }, 2000);
    }
  }
}

function parseSse(buffer) {
  const blocks = buffer.split("\n\n");
  const tail = blocks.pop();
  const events = [];
  for (const block of blocks) {
    let id = null;
    let name = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    if (!dataLines.length) continue;
    let data = null;
    try { data = JSON.parse(dataLines.join("\n")); } catch { data = null; }
    events.push({ id, name, data });
  }
  return { events, tail };
}

function handleStreamEvent(id, event) {
  if (event.name === "reset") {
    // The server's buffer rolled past us: drop what we have and re-read the task.
    state.events = [];
    state.lastSeq = event.id ?? 0;
    paintLogs();
    api(`/api/tasks/${id}`).then((task) => {
      renderDrawer(task);
    }).catch(() => {});
    return;
  }
  if (event.name === "message" || !event.data) return;
  const payload = event.data;
  if (typeof event.id === "number" && Number.isFinite(event.id)) {
    if (payload.sequence && payload.sequence <= state.lastSeq) return; // dedupe
    state.lastSeq = Math.max(state.lastSeq, payload.sequence ?? event.id);
    if (state.stream) state.stream.lastSeq = state.lastSeq;
  }
  state.events.push(payload);
  paintLogs();

  const status = payload.type === "gateway" ? payload.data?.status : null;
  if (status && ["completed", "failed", "cancelled"].includes(status)) {
    api(`/api/tasks/${id}`).then((task) => {
      if (state.selectedId !== id) return;
      renderDrawer(task);
    }).catch(() => {});
    refreshTasks();
  } else if (payload.type === "gateway") {
    refreshTasks();
  } else if (state.selectedId === id) {
    // Update the progress strip without re-rendering the whole drawer.
    const strip = $("#drawerBody .stage-list");
    const task = state.tasks.find((item) => item.id === id);
    if (strip && task) strip.replaceWith(renderStages(task));
  }
}

/* =========================================================================
   follow up (P0-07: new thread + summary)
   ========================================================================= */
async function sendFollowUp() {
  const text = $("#followUp").value.trim();
  if (!text) return;
  const task = state.tasks.find((item) => item.id === state.selectedId);
  if (!task) return;
  const summary = task.conclusions?.length
    ? task.conclusions.map((item, i) => `${i + 1}. ${item}`).join("\n")
    : (task.finalResponse || "").slice(0, 1200);

  const prompt = `上一轮任务：${task.label}

上一轮结论：
${summary}

本轮要求：${text}`;

  try {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        title: `${task.label}（续）`,
        domain: task.domain,
        taskType: task.taskType,
        priority: task.priority,
        outputTypes: task.outputTypes,
        tags: task.tags,
        cwd: task.cwd,
        mode: task.mode,
        agent: task.agent,
      }),
    });
    $("#followUp").value = "";
    toast("已新建续接任务（新线程 + 结论摘要）");
    await refreshTasks();
    openDrawer(created.id);
  } catch (error) {
    toast(error.message);
  }
}







/* =========================================================================
   工作方法库（AI 能力平台技能）
   -------------------------------------------------------------------------
   两个来源：本机已装（网关读盘）与云端广场（实时登录平台抓）。
   不缓存云端结果到 localStorage：技能版本会变，缓存只会让「有新版」这件事看不见。
   ========================================================================= */
const skillNameOf = (name) => state.skills.find((item) => item.name === name)?.title || name;
const hubConfigured = () => Boolean(state.hub?.configured);

function renderSkillLibrary() {
  const hubCount = $("#skillHubCount");
  const localCount = $("#skillLocalCount");
  if (hubCount) hubCount.textContent = String(state.hubSkills.length);
  if (localCount) localCount.textContent = String(state.skills.length);
  renderSkillHubState();
  renderSkillList();
  renderSkillPicker();
}

function renderSkillHubState() {
  const el = $("#skillHubState");
  if (!el) return;
  el.className = "lib-hub-state";
  if (!hubConfigured()) {
    el.textContent = "未连接平台";
    el.classList.add("warn");
    return;
  }
  if (state.skillLoading) {
    el.textContent = "云端同步中…";
    return;
  }
  if (state.hubError) {
    el.textContent = `连不上：${state.hubError.slice(0, 24)}`;
    el.classList.add("bad");
    return;
  }
  const host = String(state.hub?.baseUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  el.textContent = `${host} · ${state.hub?.username ?? ""}`;
  el.classList.add("ok");
}

const filteredHubSkills = () => {
  const query = state.skillQuery.trim().toLowerCase();
  if (!query) return state.hubSkills;
  return state.hubSkills.filter((item) =>
    [item.name, item.title, item.summary, item.category, ...(item.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)));
};

/** 搜索过滤。 */
const filteredLocalSkills = () => {
  const query = state.skillQuery.trim().toLowerCase();
  if (!query) return state.skills;
  return state.skills.filter((item) =>
    [item.name, item.title, item.summary, item.category, ...(item.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)));
};

function renderSkillList() {
  const box = $("#skillList");
  if (!box) return;
  for (const tab of $$("[data-skill-tab]")) tab.classList.toggle("active", tab.dataset.skillTab === state.skillTab);

  const toolbar = $("#skillToolbar");
  const pullAll = $("#skillPullAll");
  const sort = $("#skillSort");
  const isHub = state.skillTab === "hub";
  if (toolbar) toolbar.hidden = false;
  if (sort) sort.hidden = isHub;
  if (pullAll) {
    const upgradable = state.hubSkills.filter((item) => item.upgradable).length;
    pullAll.hidden = !isHub || !upgradable;
    pullAll.textContent = `全部更新（${upgradable}）`;
  }

  if (isHub) return renderHubSkills(box);
  return renderLocalSkills(box);
}

/** 云端列表：卡片平铺，不分组的（云端分类是平台方定的，分组会太碎）。 */
function renderHubSkills(box) {
  if (!hubConfigured()) {
    box.innerHTML = `<div class="empty-state"><b>还没连接 AI 能力平台</b>点右上角「平台连接」，填平台地址和账号，就能把云端的工作方法拉到本机</div>`;
    return;
  }
  if (state.skillLoading && !state.hubSkills.length) {
    box.innerHTML = `<div class="empty-state">正在从 ${esc(state.hub?.baseUrl ?? "")} 读列表…</div>`;
    return;
  }
  if (state.hubError && !state.hubSkills.length) {
    box.innerHTML = `<div class="empty-state"><b>云端没读下来</b>${esc(state.hubError)}<br>地址或账号可能变了，可点「平台连接」重填。</div>`;
    return;
  }
  const items = filteredHubSkills();
  if (!items.length) {
    box.innerHTML = `<div class="empty-state">${state.hubSkills.length ? "没有匹配的工作方法" : "平台上还没有已发布的工作方法"}</div>`;
    return;
  }
  box.replaceChildren(...items.map((item) => skillCard({
    name: item.name,
    title: item.title || item.name,
    summary: item.summary,
    category: item.category,
    tags: item.tags,
    version: item.version,
    downloads: item.downloads,
    flags: [
      item.upgradable ? `<span class="sk-flag up">可升级 ${esc(item.localVersion || "")}→${esc(item.version || "")}</span>` : "",
      item.installed && !item.upgradable ? '<span class="sk-flag">已装</span>' : "",
    ].join(""),
    actions: `
      <button type="button" class="sk-btn" data-skill-view="${esc(item.name)}">详情</button>
      <button type="button" class="sk-btn primary" data-skill-pull="${esc(item.name)}">${item.installed ? (item.upgradable ? "升级" : "重装") : "拉到本机"}</button>`,
  })));
}

function skillCardHtml(item, index) {
  const size = item.bytes > 1048576 ? `${(item.bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(item.bytes / 1024))}KB`;
  return skillCard({
    name: item.name,
    title: item.title || item.name,
    summary: item.summary,
    category: item.category,
    tags: item.tags,
    version: item.version,
    index,
    flags: item.hub?.version && item.hub.version !== item.version
      ? `<span class="sk-flag up">平台有 v${esc(item.hub.version)}</span>`
      : "",
    meta: `${item.files} 个文件 · ${size} · ${esc(relTime(item.updatedAt || item.installedAt))}`,
    actions: `
      <button type="button" class="sk-btn primary" data-skill-edit="${esc(item.name)}">编辑</button>
      <button type="button" class="sk-btn" data-skill-read="${esc(item.name)}">看内容</button>
      <button type="button" class="sk-btn" data-skill-use="${esc(item.name)}">派活</button>
      <button type="button" class="sk-btn danger" data-skill-remove="${esc(item.name)}">删除</button>`,
  });
}

function renderLocalSkills(box) {
  if (!state.skills.length) {
    box.innerHTML = `<div class="empty-state"><b>本机还没有工作方法</b>切到「云端工作方法」，拉一个下来就会出现在这里，派活和流程编排时都能挂上</div>`;
    return;
  }
  const items = filteredLocalSkills();
  if (!items.length) {
    box.innerHTML = `<div class="empty-state">没有匹配的工作方法</div>`;
    return;
  }
  box.replaceChildren(...items.map((item, index) => skillCardHtml(item, index)));
}

/** 一张工作方法卡片：图标 + 标题 + 说明 + 标签 + 底部动作。 */
function skillCard({ name, title, summary, category, tags = [], version, downloads, flags = "", meta = "", actions = "", index = 0 }) {
  const card = document.createElement("article");
  card.className = "sk-card";
  card.style.setProperty("--i", String(Math.min(index, 12)));
  const initial = (title || name || "?").trim().slice(0, 1);
  card.innerHTML = `
    <div class="sk-top">
      <span class="sk-ico">${esc(initial)}</span>
      <div class="sk-head">
        <h3 class="sk-title" title="${esc(title)}">${esc(title)}</h3>
        <code class="sk-name">${esc(name)}</code>
      </div>
      ${flags}
    </div>
    <p class="sk-sum">${esc(summary || "没有写说明")}</p>
    <div class="sk-tags">
      ${category ? `<span class="sk-tag cat">${esc(category)}</span>` : ""}
      ${version ? `<span class="sk-tag">v${esc(version)}</span>` : ""}
      ${(tags ?? []).slice(0, 3).map((tag) => `<span class="sk-tag">${esc(tag)}</span>`).join("")}
      ${downloads ? `<span class="sk-tag dim">↓${downloads}</span>` : ""}
      ${(tags ?? []).length > 3 ? `<span class="sk-tag dim">+${tags.length - 3}</span>` : ""}
    </div>
    ${meta ? `<span class="sk-meta" title="${esc(meta)}">${meta}</span>` : ""}
    <div class="sk-foot">
      <div class="sk-acts">${actions}</div>
    </div>`;
  return card;
}



/** 派活面板里的技能勾选：只列本机已装的，没装就提示去拉。 */
function renderSkillPicker() {
  const box = $("#taskSkills");
  if (!box) return;
  if (!state.skills.length) {
    box.innerHTML = `<span class="skill-picker-empty">本机还没装技能，去「工作方法 → 工作方法库」拉一个</span>`;
    return;
  }
  const active = new Set(state.composer.skills ?? []);
  // 已装技能可能被删了，勾选状态要跟着清，否则会拿一个不存在的名字去派活
  state.composer.skills = [...active].filter((name) => state.skills.some((item) => item.name === name));
  box.replaceChildren(...state.skills.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = active.has(item.name) ? "active" : "";
    button.dataset.skill = item.name;
    button.textContent = item.title || item.name;
    button.title = item.summary || item.name;
    button.addEventListener("click", () => {
      const next = new Set(state.composer.skills ?? []);
      if (next.has(item.name)) next.delete(item.name);
      else next.add(item.name);
      state.composer.skills = [...next];
      renderSkillPicker();
    });
    return button;
  }));
}

async function refreshLocalSkills() {
  const data = await api("/api/skills");
  state.skills = data.items ?? [];
  state.hub = data.hub ?? state.hub;
  renderSkillLibrary();
}

async function loadHubSkills() {
  if (!hubConfigured()) return;
  state.skillLoading = true;
  state.hubError = "";
  renderSkillHubState();
  renderSkillList();
  try {
    const params = new URLSearchParams({ sort: state.skillSort, type: "skill" });
    if (state.skillQuery.trim()) params.set("q", state.skillQuery.trim());
    const data = await api(`/api/skills/hub?${params.toString()}`);
    state.hubSkills = data.items ?? [];
    if (data.hub) state.hub = data.hub;
  } catch (error) {
    state.hubError = error.message;
    state.hubSkills = [];
  } finally {
    state.skillLoading = false;
    renderSkillLibrary();
  }
}

async function pullSkills(names) {
  if (!names.length) return;
  const label = names.length === 1 ? names[0] : `${names.length} 个技能`;
  toast(`正在拉取 ${label}…`);
  try {
    const result = await api("/api/skills/pull", { method: "POST", body: JSON.stringify({ names }) });
    state.skills = result.items ?? state.skills;
    const failed = (result.results ?? []).filter((item) => !item.ok);
    if (failed.length) {
      toast(`${failed[0].name} 没拉成：${failed[0].error}`);
    } else {
      const first = result.results?.[0];
      toast(`已装好 ${label}${first?.version ? ` v${first.version}` : ""}，共 ${first?.files ?? 0} 个文件`);
    }
    renderSkillLibrary();
    // 云端列表里「已安装/可升级」标记要重算，但不能每次拉完都全量重抓——用返回值就地改
    const done = new Set((result.results ?? []).filter((item) => item.ok).map((item) => item.name));
    state.hubSkills = state.hubSkills.map((item) => done.has(item.name)
      ? { ...item, installed: true, localVersion: (result.results.find((r) => r.name === item.name)?.version) || item.version, upgradable: false }
      : item);
    renderSkillList();
  } catch (error) {
    toast(error.message);
  }
}

async function removeSkill(name) {
  const ok = await confirmDialog({
    title: "删除本机技能",
    message: `删除本机技能「${skillNameOf(name)}」？`,
    detail: "云端那份还在，随时能再拉下来。",
    okText: "删除",
    tone: "danger",
  });
  if (!ok) return;
  try {
    const result = await api(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.skills = result.items ?? [];
    state.hubSkills = state.hubSkills.map((item) => item.name === name ? { ...item, installed: false, upgradable: false, localVersion: "" } : item);
    renderSkillLibrary();
    toast("已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function viewLocalSkill(name) {
  try {
    const data = await api(`/api/skills/${encodeURIComponent(name)}`);
    openSkillDialog({
      title: data.meta.display_name || data.meta.name || name,
      meta: [name, data.meta.version ? `v${data.meta.version}` : "", data.meta.category || ""].filter(Boolean).join(" · "),
      body: data.body,
    });
  } catch (error) {
    toast(error.message);
  }
}

async function viewHubSkill(name) {
  const known = state.hubSkills.find((item) => item.name === name);
  openSkillDialog({
    title: known?.title || name,
    meta: [name, known?.version ? `v${known.version}` : "", known?.category || ""].filter(Boolean).join(" · "),
    body: "正在从平台读详情…",
  });
  try {
    const data = await api(`/api/skills/hub/detail?name=${encodeURIComponent(name)}`);
    $("#skillDlgTitle").textContent = data.title || name;
    $("#skillDlgMeta").textContent = [data.name, data.version ? `v${data.version}` : "", data.category || "", data.author ? `作者 ${data.author}` : ""].filter(Boolean).join(" · ");
    $("#skillDlgBody").innerHTML = `<pre>${esc(data.description || data.summary || "平台没有写说明")}</pre>`;
  } catch (error) {
    $("#skillDlgBody").innerHTML = `<pre>${esc(error.message)}</pre>`;
  }
}

function openSkillDialog({ title, meta, body, editable = false, name = "" }) {
  state.skillDialog = { name, editable, mode: "read" };
  $("#skillDlgTitle").textContent = title;
  $("#skillDlgMeta").textContent = meta;
  $("#skillDlgBody").innerHTML = `<pre>${esc(body)}</pre>`;
  setSkillDialogMode("read");
  $("#skillDialog").showModal();
}

/** 查看 / 编辑两种形态：本机技能才能切到编辑，云端那份是只读的。 */
function setSkillDialogMode(mode) {
  const dialog = state.skillDialog ?? {};
  const editing = mode === "edit" && dialog.editable;
  state.skillDialog = { ...dialog, mode: editing ? "edit" : "read" };
  $("#skillDlgBody").hidden = editing;
  $("#skillEditForm").hidden = !editing;
  $("#skillDlgEdit").hidden = !dialog.editable || editing;
  $("#skillDlgCancelEdit").hidden = !editing;
  $("#skillDlgSave").hidden = !editing;
  $("#skillDlgHint").textContent = editing
    ? "只改这个工作方法的入口文件，包里的脚本和参考文件不动"
    : dialog.editable ? "本机副本，可直接改" : "";
  if (editing) {
    $("#skillEditBody").value = dialog.body ?? "";
    setTimeout(() => $("#skillEditTitle").focus(), 60);
  }
}

async function openSkillEditor(name) {
  try {
    const data = await api(`/api/skills/${encodeURIComponent(name)}`);
    const meta = data.meta ?? {};
    const body = data.body ?? "";
    // tags 在没写过标签时是 undefined，直接 toString 会存成字面量 "undefined"
    const tagText = Array.isArray(meta.tags)
      ? meta.tags.filter(Boolean).join(", ")
      : String(meta.tags ?? "").trim();
    state.skillDialog = {
      name,
      editable: true,
      mode: "read",
      body,
      original: {
        title: meta.display_name || meta.name || name,
        summary: meta.summary || meta.description || "",
        version: meta.version || "",
        category: meta.category || "",
        tags: tagText,
      },
    };
    $("#skillDlgTitle").textContent = meta.display_name || meta.name || name;
    $("#skillDlgMeta").textContent = [name, meta.version ? `v${meta.version}` : "", meta.category || ""].filter(Boolean).join(" · ");
    $("#skillDlgBody").innerHTML = `<pre>${esc(body)}</pre>`;
    $("#skillEditTitle").value = state.skillDialog.original.title;
    $("#skillEditVersion").value = state.skillDialog.original.version;
    $("#skillEditCategory").value = state.skillDialog.original.category;
    $("#skillEditSummary").value = state.skillDialog.original.summary;
    $("#skillEditTags").value = state.skillDialog.original.tags;
    $("#skillEditBody").value = body;
    $("#skillEditNote").textContent = "";
    setSkillDialogMode("edit");
    $("#skillDialog").showModal();
  } catch (error) {
    toast(error.message);
  }
}

async function saveSkillEdit() {
  const dialog = state.skillDialog ?? {};
  if (!dialog.name) return;
  const payload = {
    title: $("#skillEditTitle").value.trim(),
    version: $("#skillEditVersion").value.trim(),
    category: $("#skillEditCategory").value.trim(),
    summary: $("#skillEditSummary").value.trim(),
    tags: $("#skillEditTags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    body: $("#skillEditBody").value,
  };
  const save = $("#skillDlgSave");
  save.disabled = true;
  $("#skillEditNote").textContent = "保存中…";
  try {
    const saved = await api(`/api/skills/${encodeURIComponent(dialog.name)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    state.skills = saved.items ?? state.skills;
    state.hubSkills = state.hubSkills.map((item) => item.name === dialog.name
      ? { ...item, upgradable: false }
      : item);
    $("#skillDlgTitle").textContent = saved.title || dialog.name;
    $("#skillDlgMeta").textContent = [dialog.name, saved.version ? `v${saved.version}` : "", saved.category || ""].filter(Boolean).join(" · ");
    $("#skillDlgBody").innerHTML = `<pre>${esc(saved.body ?? payload.body)}</pre>`;
    state.skillDialog = { ...dialog, body: saved.body ?? payload.body };
    setSkillDialogMode("read");
    renderSkillLibrary();
    toast("已保存");
  } catch (error) {
    $("#skillEditNote").textContent = error.message;
  } finally {
    save.disabled = false;
  }
}

function openHubDialog() {
  const hub = state.hub ?? {};
  $("#hubBaseUrl").value = hub.baseUrl || "http://8.138.91.205/hub/";
  $("#hubUser").value = hub.username || "";
  $("#hubPass").value = "";
  $("#hubPass").placeholder = hub.configured ? `已保存 ${hub.passwordMasked || ""}，留空不改` : "平台登录密码";
  $("#hubTestResult").textContent = "";
  $("#hubTestResult").className = "hub-test";
  $("#hubDialog").showModal();
}

async function testHub() {
  const out = $("#hubTestResult");
  out.className = "hub-test";
  out.textContent = "连接中…";
  try {
    const result = await api("/api/hub/test", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: $("#hubBaseUrl").value.trim(),
        username: $("#hubUser").value.trim(),
        password: $("#hubPass").value,
      }),
    });
    if (result.ok) {
      out.className = "hub-test ok";
      out.textContent = `连上了，平台上有 ${result.count} 个技能${result.sample?.length ? `（如 ${result.sample.join("、")}）` : ""}`;
    } else {
      out.className = "hub-test bad";
      out.textContent = result.error;
    }
  } catch (error) {
    out.className = "hub-test bad";
    out.textContent = error.message;
  }
}

async function saveHub() {
  const body = {
    baseUrl: $("#hubBaseUrl").value.trim(),
    username: $("#hubUser").value.trim(),
  };
  if ($("#hubPass").value.trim()) body.password = $("#hubPass").value.trim();
  try {
    state.hub = await api("/api/hub/settings", { method: "PATCH", body: JSON.stringify(body) });
    $("#hubDialog").close();
    toast("平台连接已保存");
    await loadHubSkills();
    await refreshLocalSkills();
  } catch (error) {
    toast(error.message);
  }
}

function bindSkillLibrary() {
  $$("[data-skill-tab]").forEach((tab) => tab.addEventListener("click", () => {
    state.skillTab = tab.dataset.skillTab;
    renderSkillList();
  }));

  let timer = null;
  $("#skillQuery")?.addEventListener("input", (event) => {
    state.skillQuery = event.target.value;
    renderSkillList();
    clearTimeout(timer);
    // 云端搜索要打平台，停顿一下再发，别按键按键都抓一次
    if (state.skillTab === "hub") timer = setTimeout(() => { loadHubSkills(); }, 500);
  });

  $("#skillSort")?.addEventListener("change", (event) => {
    state.skillSort = event.target.value;
    loadHubSkills();
  });

  $("#skillRefresh")?.addEventListener("click", () => {
    if (!hubConfigured()) return openHubDialog();
    loadHubSkills();
  });
  $("#skillHubConfig")?.addEventListener("click", openHubDialog);
  $("#skillPullAll")?.addEventListener("click", () => {
    pullSkills(state.hubSkills.filter((item) => item.upgradable).map((item) => item.name));
  });

  $("#hubCancel")?.addEventListener("click", () => $("#hubDialog").close());
  $("#hubTest")?.addEventListener("click", testHub);
  $("#hubSave")?.addEventListener("click", saveHub);
  $("#hubDialog")?.addEventListener("click", (event) => {
    if (event.target === $("#hubDialog")) $("#hubDialog").close();
  });
  $("#skillDlgClose")?.addEventListener("click", () => $("#skillDialog").close());
  $("#skillDlgEdit")?.addEventListener("click", () => setSkillDialogMode("edit"));
  $("#skillDlgCancelEdit")?.addEventListener("click", () => setSkillDialogMode("read"));
  $("#skillDlgSave")?.addEventListener("click", saveSkillEdit);
  $("#skillDialog")?.addEventListener("click", (event) => {
    if (event.target === $("#skillDialog")) $("#skillDialog").close();
  });

  // 列表里的动作走委托：列表是整块重渲染的，逐个绑事件在几十条时会越来越慢
  $("#skillList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const { skillPull, skillView, skillRead, skillEdit, skillUse, skillRemove } = button.dataset;
    if (skillPull) return pullSkills([skillPull]);
    if (skillView) return viewHubSkill(skillView);
    if (skillRead) return viewLocalSkill(skillRead);
    if (skillEdit) return openSkillEditor(skillEdit);
    if (skillRemove) return removeSkill(skillRemove);
    if (skillUse) {
      state.composer.skills = [skillUse];
      openComposer();
    }
  });
}




function artifactRows() {
  const rows = [];
  for (const task of state.tasks) {
    for (const artifact of task.artifacts ?? []) rows.push({ task, artifact });
  }
  return rows;
}

function renderArtifacts() {
  const box = $("#artifactList");
  if (!box) return;
  renderArtifactHero();

  const rows = artifactRows();
  const counter = $("#artifactCount");
  const tabBox = $("#artifactTabs");

  // 类型筛选条只列出真实出现过的类型，数量降序，避免一排永远为 0 的入口
  const counts = new Map();
  for (const { artifact } of rows) {
    const key = artifact.type || "file";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const types = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (tabBox) {
    tabBox.replaceChildren(...[
      { key: "", label: "全部", n: rows.length },
      ...types.map((key) => ({ key, label: artifactType(key).label, n: counts.get(key) })),
    ].map((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lib-tab${state.libType === item.key ? " active" : ""}`;
      btn.innerHTML = `${esc(item.label)}<i>${item.n}</i>`;
      btn.addEventListener("click", () => { state.libType = item.key; renderArtifacts(); });
      return btn;
    }));
  }

  const shown = state.libType ? rows.filter(({ artifact }) => (artifact.type || "file") === state.libType) : rows;
  if (counter) counter.textContent = `显示 ${shown.length} / ${rows.length} 个文件`;

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = rows.length ? "这个类型下还没有文件。" : "还没有产出物。任务生成文件后会自动登记在这里。";
    box.replaceChildren(empty);
    return;
  }

  // 以来源任务为单位分组：先找到任务，再取件，符合“按文件取件 + 定位来源”的用法
  const byTask = new Map();
  for (const row of shown) {
    if (!byTask.has(row.task.id)) byTask.set(row.task.id, { task: row.task, items: [] });
    byTask.get(row.task.id).items.push(row.artifact);
  }
  const groups = [...byTask.values()].sort((a, b) => new Date(b.task.updatedAt || b.task.createdAt || 0) - new Date(a.task.updatedAt || a.task.createdAt || 0));

  box.replaceChildren(...groups.map(({ task, items }) => {
    const section = document.createElement("section");
    section.className = "lib-group";

    const head = document.createElement("header");
    head.className = "lib-group-head";
    head.innerHTML = `<b>${esc(task.label || "未命名任务")}</b><small>${esc(relTime(task.updatedAt || task.createdAt))}</small><span>${items.length} 个文件</span><button type="button" class="lib-jump">定位任务</button>`;
    head.querySelector(".lib-jump").addEventListener("click", () => openDrawer(task.id));

    const list = document.createElement("div");
    list.className = "lib-rows";
    list.append(...items.map((artifact) => renderLibraryRow(task, artifact)));
    section.append(head, list);
    return section;
  }));
}

function renderArtifactHero() {
  const box = $("#artifactHero");
  if (!box) return;
  const rows = artifactRows();
  const taskCount = new Set(rows.map((row) => row.task.id)).size;
  const bytes = rows.reduce((sum, row) => sum + (Number(row.artifact.size) || 0), 0);
  const missing = rows.filter((row) => row.artifact.exists === false).length;
  const inline = rows.filter((row) => ["markdown", "text", "json", "csv"].includes(row.artifact.type)).length;

  box.innerHTML = `
    <div class="hero-cell">
      <span>产出文件</span>
      <b class="mono">${rows.length}<small> 个</small></b>
      <em>来自 ${taskCount} 个任务</em>
    </div>
    <div class="hero-cell">
      <span>合计体积</span>
      <b class="mono">${rows.length ? esc(formatSize(bytes)) : "—"}</b>
      <em>按登记的文件大小相加</em>
    </div>
    <div class="hero-cell">
      <span>可内联预览</span>
      <b class="mono">${inline}<small> 个</small></b>
      <em>Markdown / 文本 / JSON / CSV</em>
    </div>
    <div class="hero-cell">
      <span>路径失效</span>
      <b class="mono ${missing ? "bad" : "ok"}">${missing}<small> 个</small></b>
      <em>${missing ? "文件被移动或删除，行会标灰" : "所有登记路径都还在"}</em>
    </div>`;
}

function renderLibraryRow(task, artifact) {
  const type = artifactType(artifact.type);
  const row = document.createElement("div");
  row.className = `lib-row${artifact.exists === false ? " missing" : ""}`;
  row.tabIndex = 0;
  row.innerHTML = `
    <span class="lib-ico ${type.tone}">${esc(type.code)}</span>
    <div class="lib-main">
      <b>${esc(artifact.name)}</b>
      <small title="${esc(artifact.path)}">${esc(artifact.relativePath || artifact.path)}</small>
    </div>
    <span class="lib-size">${esc(formatSize(artifact.size))}</span>
    <span class="lib-time">${esc(relTime(artifact.createdAt))}</span>
    <div class="lib-acts"></div>`;

  const acts = row.querySelector(".lib-acts");
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "lib-act";
  preview.textContent = "预览";
  preview.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (artifact.exists === false) { toast("文件已被移动或删除，先到来源任务里重新生成"); return; }
    await openArtifactPreview(task, artifact);
  });
  const download = document.createElement("button");
  download.type = "button";
  download.className = "lib-act";
  download.textContent = "下载";
  download.addEventListener("click", (event) => { event.stopPropagation(); downloadArtifact(task, artifact); });
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "lib-act";
  copy.textContent = "路径";
  copy.addEventListener("click", (event) => { event.stopPropagation(); copyPath(artifact.path); });
  acts.append(preview, download, copy);

  const open = () => openArtifactPreview(task, artifact);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  return row;
}

/* =========================================================================
   agents view (P1-03)
   ========================================================================= */
const CAP_LABEL = {
  code: "代码执行",
  files: "本地文件",
  shell: "命令行",
  "office-files": "Office 文件",
  web: "联网检索",
  longform: "长文写作",
  doc: "文档理解",
  summarize: "归纳摘要",
  "long-context": "超长上下文",
  "chinese-writing": "中文写作",
};

const AGENT_BUCKET = {
  ready: { label: "已就绪", text: "就绪" },
  pending: { label: "待配置", text: "待配置" },
  off: { label: "已停用", text: "已停用" },
};

function agentBucket(agent) {
  if (agent.available) return "ready";
  return agent.availabilityReason === "disabled" ? "off" : "pending";
}

/**
 * 员工头像：服务端已经把「用户选的 → 内置默认」解析成一个 key，
 * 这里只管拼路径；连 key 都没有（从没选过的新员工）才退回首字圆形。
 */
function agentAvatar(agent) {
  const key = agent?.avatar;
  if (key) return `<img src="/assets/avatars/${esc(key)}.svg" alt="">`;
  return `<span class="agent-avatar" aria-hidden="true">${esc((agent?.name || "?").trim().slice(0, 1))}</span>`;
}

function renderAgents() {
  const list = state.boot?.agents ?? [];
  renderAgentHero(list);
  renderAgentTabs(list);
  const box = $("#agentList");
  if (!box) return;
  const bucket = state.agentFilter ?? "all";
  const shown = bucket === "all" ? list : list.filter((agent) => agentBucket(agent) === bucket);
  if (!shown.length) {
    box.innerHTML = `<p class="empty-state">这个分组还没有员工。点右上角「新增员工」加一个。</p>`;
    return;
  }
  box.replaceChildren(...shown.map((agent) => renderAgentCard(agent)));
}

function renderAgentHero(list) {
  const box = $("#agentHero");
  if (!box) return;
  const ready = list.filter((agent) => agent.available);
  const pending = list.filter((agent) => agentBucket(agent) === "pending");
  const custom = list.filter((agent) => agent.custom);
  const caps = new Set(ready.flatMap((agent) => agent.capabilities ?? []));
  const capText = [...caps].map((cap) => CAP_LABEL[cap] ?? cap).join(" · ");
  // 「待配置」有两种完全不同的原因：云端缺 Key、本机 CLI 缺登录。混在一起写会让人去翻密钥设置。
  const pendingLocal = pending.some((agent) => agent.provider === "local");
  const pendingCloud = pending.some((agent) => agent.provider !== "local");
  const pendingHint = pendingLocal && pendingCloud
    ? "云端缺 API Key，本机员工缺登录"
    : pendingLocal
      ? "本机 CLI 未登录或未安装，点卡片按钮检查"
      : "缺 API Key，补上即可用";

  box.innerHTML = `
    <div class="hero-cell">
      <span>员工总数</span>
      <b class="mono">${list.length}<small> 位</small></b>
      <em>内置 ${list.length - custom.length} 位 · 自定义 ${custom.length} 位</em>
    </div>
    <div class="hero-cell">
      <span>已就绪</span>
      <b class="mono ${ready.length ? "ok" : "bad"}">${ready.length}<small> 位</small></b>
      <em>${ready.length ? "可以立即派活" : "还没有能接活的员工"}</em>
    </div>
    <div class="hero-cell">
      <span>待配置</span>
      <b class="mono ${pending.length ? "bad" : "ok"}">${pending.length}<small> 位</small></b>
      <em>${pending.length ? pendingHint : "每位员工都已配好"}</em>
    </div>
    <div class="hero-cell">
      <span>能力覆盖</span>
      <b class="mono">${caps.size}<small> 项</small></b>
      <em>${esc(capText || "—")}</em>
    </div>`;
}

function renderAgentTabs(list) {
  const box = $("#agentTabs");
  if (!box) return;
  const active = state.agentFilter ?? "all";
  box.replaceChildren(...["all", "ready", "pending", "off"].map((key) => {
    const count = key === "all" ? list.length : list.filter((agent) => agentBucket(agent) === key).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `lib-tab${active === key ? " active" : ""}`;
    button.innerHTML = `${key === "all" ? "全部" : AGENT_BUCKET[key].label}<i>${count}</i>`;
    button.addEventListener("click", () => {
      state.agentFilter = key;
      renderAgents();
    });
    return button;
  }));
}

/** 卡片只保留身份信息，其余全部收进标签行——一屏能看全，不用滚动读四行元数据。 */
function renderAgentCard(agent) {
  const conf = agent.config ?? null;
  const local = agent.provider === "local";
  const bucket = agentBucket(agent);
  const editable = Boolean(conf && conf.editable !== false);
  const model = conf?.model || agent.model || (local ? "本机 CLI" : "");
  const caps = agent.capabilities ?? [];
  const head = caps.slice(0, 5);
  const rest = caps.length - head.length;
  const endpoint = conf?.baseUrl || (local ? "gateway · 本机进程" : "");

  const tags = [
    `<span class="tag state ${bucket}">${esc(AGENT_BUCKET[bucket].text)}</span>`,
    ...head.map((cap) => `<span class="tag cap">${esc(CAP_LABEL[cap] ?? cap)}</span>`),
    rest > 0 ? `<span class="tag quiet">+${rest}</span>` : "",
    model ? `<span class="tag quiet mono" title="${esc(endpoint)}">${esc(model)}</span>` : "",
    local
      ? ""
      : `<span class="tag quiet ${conf?.configured ? "ok" : "bad"}">${conf?.configured ? esc(conf.apiKeyMasked) : "未配置密钥"}</span>`,
    agent.custom ? `<span class="tag quiet">自定义</span>` : "",
  ].filter(Boolean).join("");

  const card = document.createElement("article");
  card.className = `agent-card bucket-${bucket}`;
  card.innerHTML = `
    <header class="agent-card-head">
      ${agentAvatar(agent)}
      <div class="agent-ident">
        <h3>${esc(agent.name)}</h3>
        <p>${esc(agent.summary || (local ? "本机执行与文件处理" : "还没有写概述"))}</p>
      </div>
    </header>
    <div class="agent-tags">${tags}</div>`;

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "agent-edit";
  if (editable) {
    // 本机员工不可用时不是「缺 Key」，是「本机没装」
    edit.textContent = agent.available ? "配置" : (agent.provider === "local" ? "未安装" : "填 API");
    edit.addEventListener("click", () => openAgentDialog(agent));
  } else if (agent.id === "codex") {
    edit.textContent = "运行设置";
    edit.addEventListener("click", () => setView("settings"));
  } else {
    edit.textContent = "只读";
    edit.disabled = true;
  }
  card.querySelector(".agent-card-head").append(edit);
  return card;
}

let editingAgentId = null; // null = 新增模式
let agentClearKeyPending = false;
let agentDeleteArmed = false;
let agentDeleteTimer = null;
let activePresetId = null;
// 记录「上一次由预设自动填进去的名称/概述」，用户一旦手改过就不再自动覆盖
let presetFilled = { name: "", summary: "" };

// 当前弹窗里选中的头像 key；"" = 用默认（内置图 / 名字首字）
let selectedAvatar = "";
const avatarPresets = () => state.boot?.avatars ?? [];

/**
 * 头像选择器：第一格是「默认」，后面是 10 个可选头像。
 * 默认格跟着员工走——内置员工回落到自己的固定头像，自定义员工回落首字。
 */
function renderAvatarPicker(selected = "", defaultKey = null) {
  const box = $("#agentAvatars");
  if (!box) return;
  // 先落状态：即使没有可选列表，也不要让上一次弹窗的选择串到这一单
  selectedAvatar = selected;
  const presets = avatarPresets();
  if (!presets.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const letter = ($("#agentName").value.trim() || "A").slice(0, 1);
  const chips = [{
    key: "",
    label: "默认",
    html: defaultKey
      ? `<img src="/assets/avatars/${esc(defaultKey)}.svg" alt="">`
      : `<span class="avatar-letter">${esc(letter)}</span>`,
  }, ...presets.map((preset) => ({
    key: preset.key,
    label: preset.label,
    html: `<img src="/assets/avatars/${esc(preset.key)}.svg" alt="">`,
  }))];

  box.replaceChildren(...chips.map((chip) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `avatar-pick${chip.key === selected ? " on" : ""}`;
    button.dataset.key = chip.key;
    button.title = chip.key ? `用「${chip.label}」这个头像` : "用默认头像";
    button.innerHTML = `<span class="avatar-frame">${chip.html}</span><em>${esc(chip.label)}</em>`;
    button.addEventListener("click", () => {
      selectedAvatar = chip.key;
      box.querySelectorAll(".avatar-pick").forEach((item) => item.classList.toggle("on", item.dataset.key === chip.key));
    });
    return button;
  }));
}

function agentCapsSelected() {
  return [...$("#agentCaps").querySelectorAll("input[type=checkbox]")]
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function renderAgentCaps(selected = []) {  const box = $("#agentCaps");
  if (!box) return;
  const caps = state.boot?.capabilities ?? [];
  if (!caps.length) {
    box.textContent = "网关没有返回能力标签，刷新页面后再试";
    return;
  }
  box.replaceChildren(...caps.map((cap) => {
    const label = document.createElement("label");
    label.className = "cap-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = cap.id;
    input.checked = selected.includes(cap.id);
    const text = document.createElement("span");
    text.textContent = cap.label;
    label.append(input, text);
    return label;
  }));
}

function resetDeleteArm() {
  agentDeleteArmed = false;
  clearTimeout(agentDeleteTimer);
  const button = $("#agentDelete");
  if (!button) return;
  button.textContent = "删除员工";
  button.classList.remove("armed");
}

const agentPresets = () => state.boot?.agentPresets ?? [];

function clearAgentTestResult() {
  const out = $("#agentTest");
  if (!out) return;
  out.className = "agent-test";
  out.textContent = "";
  out.title = "";
}

/** 预设自带的名称可能和已有员工撞名，这里先让开，省得保存时才被拒。 */
function suggestAgentName(label) {
  const taken = new Set((state.boot?.agents ?? []).map((agent) => agent.name));
  const suffix = /[\u4e00-\u9fa5]/.test(label) ? "助手" : " 助手";
  const candidates = [label, `${label}${suffix}`, ...Array.from({ length: 30 }, (_, i) => `${label} ${i + 2}`)];
  return (candidates.find((name) => !taken.has(name)) ?? label).slice(0, 20);
}

function fillModelOptions(preset) {
  const list = $("#agentModelList");
  if (!list) return;
  list.replaceChildren(...(preset?.models ?? []).map((model) => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  }));
}

/** 高级设置的摘要行直接告诉用户现在接的是哪家的哪个模型。 */
function updateAdvHint() {
  const hint = $("#agentAdvHint");
  if (!hint) return;
  const model = $("#agentModel").value.trim();
  const preset = agentPresets().find((item) => item.id === activePresetId);
  hint.textContent = model ? `${preset?.label ?? "自定义"} · ${model}` : "模型、地址、tokens、能力标签";
}

function renderAgentPresets(activeId) {
  const grid = $("#agentPresetGrid");
  if (!grid) return;
  const presets = agentPresets();
  if (!presets.length) {
    grid.textContent = "网关没有返回模型预设，刷新页面后再试";
    return;
  }
  grid.replaceChildren(...presets.map((preset) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "preset-chip";
    chip.dataset.preset = preset.id;
    const localOk = preset.local ? preset.installed !== false : null;
    if (preset.local) {
      // 本机磁贴：建之前先告诉用户装没装，免得建完才发现派不了活
      chip.title = `${preset.vendor} · ${localOk ? "已检测到，可以直接用" : "未检测到，装好后再来"}`;
      chip.classList.toggle("cli-missing", !localOk);
    } else {
      chip.title = `${preset.vendor} · ${preset.baseUrl}`;
    }
    chip.setAttribute("aria-pressed", preset.id === activeId ? "true" : "false");
    if (preset.id === activeId) chip.classList.add("active");
    const name = document.createElement("strong");
    name.textContent = preset.label;
    const vendor = document.createElement("small");
    vendor.textContent = preset.local ? `${preset.vendor} · ${localOk ? "已安装" : "未检测到"}` : preset.vendor;
    chip.append(name, vendor);
    chip.addEventListener("click", () => applyPreset(preset));
    return chip;
  }));
}

/** 选完厂商就把磁贴收成一行，把高度让给下面的字段。 */
function setPresetCollapsed(collapsed) {
  const block = $("#agentPresetBlock");
  if (!block) return;
  const preset = agentPresets().find((item) => item.id === activePresetId);
  const shrink = collapsed && Boolean(preset);
  block.classList.toggle("collapsed", shrink);
  $("#presetSwitch").hidden = !shrink;
  if (shrink && preset.local) {
    $("#presetHeadLabel").textContent = `接入 ${preset.label}`;
    $("#presetHeadHint").textContent = preset.installed === false
      ? "本机执行 · 未检测到，装好后才能派活"
      : "本机执行 · 不需要 API Key";
    return;
  }
  $("#presetHeadLabel").textContent = shrink ? `接入 ${preset.label}` : "接入哪个模型";
  $("#presetHeadHint").textContent = shrink
    ? `${preset.vendor} · 地址与模型已填好`
    : "地址与默认模型已备好，选完只差 Key";
}

/** 选中厂商：把地址、默认模型、能力标签、默认名称与概述一次填好。 */
function applyPreset(preset) {
  if (!preset) return;
  activePresetId = preset.id;
  for (const chip of $("#agentPresetGrid").children) {
    const on = chip.dataset?.preset === preset.id;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  }

  const nameInput = $("#agentName");
  const summaryInput = $("#agentSummary");
  const name = nameInput.value.trim();
  const summary = summaryInput.value.trim();
  // 只覆盖「还是上一次预设填进去的」内容，用户手写过的名字不碰
  if (!name || name === presetFilled.name) nameInput.value = suggestAgentName(preset.label);
  if (!summary || summary === presetFilled.summary) summaryInput.value = preset.summary;
  presetFilled = { name: nameInput.value.trim(), summary: summaryInput.value.trim() };
  // 预设会顺手把名字填上，默认头像格里的首字要跟着变；用户已选具体头像就不动
  if (!selectedAvatar) renderAvatarPicker("", null);

  if (preset.local) {
    // 本机 CLI：没有 Key / 地址 / 模型可填，整块藏起来比留着更诚实
    $("#agentModel").value = "";
    $("#agentBaseUrl").value = "";
    fillModelOptions(null);
    renderAgentCaps(preset.capabilities ?? []);
    $("#agentApiKey").closest("label").hidden = true;
    $("#agentKeyState").parentElement.hidden = true;
    const localHint = $("#agentLocalHint");
    localHint.hidden = false;
    localHint.classList.toggle("warn", preset.installed === false);
    localHint.textContent = preset.installed === false
      ? "本机没有检测到这个 CLI 命令：现在建也能建，但派活会失败；装好后刷新页面即可。"
      : "本机 CLI 员工，不需要密钥；能不能用只看本机装没装这个命令。";
    $("#agentTestBtn").hidden = true;
    updateAdvHint();
    // updateAdvHint 只认模型名，本机模式在这里覆写成自己的摘要
    $("#agentAdvHint").textContent = "单价、能力标签";
    setPresetCollapsed(true);
    clearAgentTestResult();
    syncPriceFetchButton();
    return;
  }

  // 从本机磁贴切回云端厂商时，把被藏起来的字段还回来
  $("#agentApiKey").closest("label").hidden = false;
  $("#agentKeyState").parentElement.hidden = false;
  $("#agentLocalHint").hidden = true;
  $("#agentLocalHint").classList.remove("warn");
  $("#agentTestBtn").hidden = false;

  $("#agentModel").value = preset.models[0] ?? "";
  $("#agentBaseUrl").value = preset.baseUrl;
  fillModelOptions(preset);
  renderAgentCaps(preset.capabilities);
  updateAdvHint();

  const help = $("#agentKeyHelp");
  help.hidden = false;
  help.replaceChildren();
  const tip = document.createElement("span");
  tip.textContent = preset.keyHint;
  help.append(tip);
  if (preset.keyUrl) {
    const link = document.createElement("a");
    link.href = preset.keyUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开控制台";
    help.append(link);
  }
  setPresetCollapsed(true);
  clearAgentTestResult();
  syncPriceFetchButton();
}

/** @param {object|null} agent null 表示新增 */
function openAgentDialog(agent) {
  const creating = !agent;
  const conf = agent?.config ?? null;
  if (!creating && !conf) return;
  // Codex 是本机执行器，没有云端配置可改，直接带去设置页
  if (!creating && conf.editable === false) {
    setView("settings");
    return;
  }

  editingAgentId = creating ? null : agent.id;
  // 本机 CLI 员工（Claude）没有 Key/地址可填，界面就别问：
  // 问了会让人以为「没填 Key 所以不可用」，其实它只看本机装没装
  const isLocal = !creating && conf.local === true;
  agentClearKeyPending = false;
  activePresetId = null;
  presetFilled = { name: "", summary: "" };
  resetDeleteArm();

  $("#agentDialogTitle").textContent = creating ? "新增员工" : `配置 ${agent.name}`;
  $("#agentDialogSub").textContent = creating
    ? "选本机 CLI 或云端厂商：本机不用填 Key，云端补上 Key 即可"
    : "名称、模型与地址写入网关配置；密钥单独存放，不回传浏览器";

  // 新增时展示厂商磁贴；改配置时这些值已经在字段里了，不再占位置
  $("#agentPresetBlock").hidden = !creating;
  if (creating) {
    renderAgentPresets(null);
    setPresetCollapsed(false);
  } else {
    $("#agentPresetGrid").replaceChildren();
  }

  $("#agentName").value = creating ? "" : (conf.name || agent.name || "");
  $("#agentSummary").value = creating ? "" : (conf.summary || agent.summary || "");
  // 头像：没选过就是空串（默认格），内置员工默认格显示它自己的固定头像
  renderAvatarPicker(creating ? "" : (conf.avatar || ""), agent?.avatar ?? null);
  renderAgentCaps(creating ? [] : (conf.capabilities ?? agent.capabilities ?? []));  $("#agentEnabled").checked = creating ? true : conf.enabled;

  $("#agentModel").value = creating ? "" : (conf.model || "");
  $("#agentBaseUrl").value = creating ? "" : (conf.baseUrl || "");
  $("#agentMaxTokens").value = creating ? 16384 : (conf.maxOutputTokens || 16384);
  // 单价留空 = 不估算成本（不是 0 元）；已有值回填，方便改价
  $("#agentPriceIn").value = creating ? "" : (conf.pricing?.input ?? "");
  $("#agentPriceOut").value = creating ? "" : (conf.pricing?.output ?? "");
  // 新增走默认 16384，不用为 tokens 分心；改配置时才露出来。
  // 本机 CLI 不吃这个参数（Claude 的上下文由它自己管），隐藏比留着更诚实
  $("#agentTokensField").hidden = creating || isLocal;
  fillModelOptions(null);
  updateAdvHint();

  $("#agentApiKey").value = "";
  $("#agentApiKey").placeholder = creating
    ? "粘贴厂商控制台里的 Key"
    : (conf.configured ? `留空不修改（当前 ${conf.apiKeyMasked}）` : "留空表示暂不配置");

  // 本机 CLI 员工的这些字段整块不显示
  $("#agentApiKey").closest("label").hidden = isLocal;
  $("#agentKeyState").parentElement.hidden = isLocal;
  $("#agentKeyHelp").hidden = true;
  $("#agentLocalHint").hidden = !isLocal;
  $("#agentModel").closest("label").hidden = isLocal;
  $("#agentBaseUrl").closest("label").hidden = isLocal;
  $("#agentTestBtn").hidden = isLocal;
  if (isLocal) {
    $("#agentDialogSub").textContent = "本机 CLI 员工：改名称、概述、头像与能力标签";
    $("#agentAdv").open = false;
    $("#agentAdvHint").textContent = "单价、能力标签";
  }
  syncPriceFetchButton();

  const keyState = $("#agentKeyState");
  keyState.className = creating ? "warn" : (conf.configured ? "ok" : "warn");
  keyState.textContent = creating
    ? "填好可以先测一次，通过再保存"
    : (conf.configured ? `当前密钥 ${conf.apiKeyMasked}` : "尚未配置密钥，填好保存后即可派活");
  $("#agentClearKey").hidden = creating || !conf.configured;
  $("#agentKeyHelp").hidden = true;

  const del = $("#agentDelete");
  del.hidden = creating || conf.deletable === false;

  // 新建也能测：走 draft 探针，用表单里的值直接验证 Key
  const testBtn = $("#agentTestBtn");
  // 本机 CLI 没有 Key 可测，按钮留着只会点出一句「缺 Key」
  testBtn.hidden = isLocal;
  testBtn.disabled = false;
  testBtn.textContent = "测试连接";
  clearAgentTestResult();

  // 新增时技术字段先折叠，改配置时摊开
  $("#agentAdv").open = !creating;

  $("#agentNote").textContent = "";
  $("#agentDialog").showModal();

  if (creating) {
    const presets = agentPresets();
    if (presets.length) applyPreset(presets[0]);
    // 默认磁贴是本机 CLI 时没有 Key 可填，光标直接落到名称
    const firstIsLocal = presets[0]?.local === true;
    setTimeout(() => (presets.length && !firstIsLocal ? $("#agentApiKey") : $("#agentName")).focus(), 60);
  } else {
    setTimeout(() => $("#agentName").focus(), 60);
  }
}

/** 用弹窗里现在填的值打一次最小请求，验证地址 / 模型 / 密钥这三件事是否配套。 */
async function testAgentConnection() {
  const creating = editingAgentId === null;
  const button = $("#agentTestBtn");
  const out = $("#agentTest");
  const payload = {
    model: $("#agentModel").value.trim(),
    baseUrl: $("#agentBaseUrl").value.trim(),
  };
  const key = $("#agentApiKey").value.trim();
  if (key) payload.apiKey = key;

  // 新建时没有已保存的 Key 可回落，必须先填
  if (creating && !key) {
    out.className = "agent-test bad";
    out.textContent = "先填 API Key 才能测试";
    $("#agentApiKey").focus();
    return;
  }
  if (!payload.model || !payload.baseUrl) {
    out.className = "agent-test bad";
    out.textContent = "模型和 Base URL 都要有值";
    return;
  }

  button.disabled = true;
  button.textContent = "测试中…";
  out.className = "agent-test";
  out.textContent = "正在请求…";

  try {
    const result = await api(creating ? "/api/agents/test" : `/api/agents/${editingAgentId}/test`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (result.ok) {
      out.className = "agent-test ok";
      out.textContent = `连接正常 · ${result.latencyMs}ms`;
      out.title = [result.model, result.sample ? `返回「${result.sample}」` : ""].filter(Boolean).join(" · ");
    } else {
      out.className = "agent-test bad";
      out.textContent = result.error;
      out.title = result.error;
    }
  } catch (error) {
    out.className = "agent-test bad";
    out.textContent = error.message;
    out.title = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
}

/* ---- AI 查价：派能联网的员工查最新公开价，查到只填表单，保存才生效 ---- */

let priceFetchAbort = null; // 关弹窗时把还在跑的轮询停掉

function setPriceFetchState(text, tone = "") {
  const state = $("#agentPriceFetchState");
  if (!state) return;
  state.hidden = !text;
  state.textContent = text;
  state.className = `agent-price-hint${tone ? ` ${tone}` : ""}`;
}

async function startPriceFetch() {
  const button = $("#agentPriceFetch");
  const model = $("#agentModel").value.trim();
  const name = $("#agentName").value.trim();
  if (!model) {
    setPriceFetchState("先填模型名，员工才知道查谁的价", "warn");
    $("#agentModel").focus();
    return;
  }
  // 上一次还没查完又点了一次：先停旧轮询，再发新的
  priceFetchAbort?.abort();
  const controller = new AbortController();
  priceFetchAbort = controller;

  button.disabled = true;
  button.textContent = "查价中…";
  setPriceFetchState(`已派出员工（优先 Claude Code），正在联网查询「${model}」的最新价格…`);

  try {
    const start = await api("/api/agents/pricing/refresh", {
      method: "POST",
      body: JSON.stringify({ model, name }),
    });
    const jobId = start.job.id;
    // 查价走真实联网抓取，慢是正常的：服务端封顶 8 分钟，这里跟到 8.5 分钟
    for (let i = 0; i < 255; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (controller.signal.aborted) return;
      const { job } = await api(`/api/agents/pricing/jobs/${jobId}`);
      if (job.status === "running") continue;
      if (job.status === "completed") {
        $("#agentPriceIn").value = job.pricing.input;
        $("#agentPriceOut").value = job.pricing.output;
        // 正文只留结论，note（汇率/时段/日期）与来源放悬停，别把提示撑成三行
        setPriceFetchState(
          `已查到并填入：输入 ${job.pricing.input} / 输出 ${job.pricing.output} 元/百万 tokens，保存后生效`,
          "ok",
        );
        $("#agentPriceFetchState").title = [job.note, job.source].filter(Boolean).join(" · ");
      } else {
        setPriceFetchState(`查价失败：${job.error ?? "未知原因"}`, "warn");
        $("#agentPriceFetchState").title = job.rawReply ?? "";
      }
      return;
    }
    setPriceFetchState("查价超时（8 分钟），稍后再试", "warn");
  } catch (error) {
    if (!controller.signal.aborted) setPriceFetchState(`查价失败：${error.message}`, "warn");
  } finally {
    if (!controller.signal.aborted) {
      button.disabled = false;
      button.textContent = "AI 查价";
    }
  }
}

/** 查价按钮只在「有模型名可查」时出现；本机 CLI 不填模型，藏起来 */
function syncPriceFetchButton() {
  const button = $("#agentPriceFetch");
  if (!button) return;
  const hasModel = Boolean($("#agentModel").value.trim());
  button.hidden = !hasModel || $("#agentModel").closest("label").hidden;
}

async function saveAgentConfig() {
  const creating = editingAgentId === null;
  const button = $("#agentSave");
  const note = $("#agentNote");
  button.disabled = true;
  note.textContent = "";

  const payload = {
    name: $("#agentName").value.trim(),
    summary: $("#agentSummary").value.trim(),
    capabilities: agentCapsSelected(),
    enabled: $("#agentEnabled").checked,
    model: $("#agentModel").value.trim(),
    maxOutputTokens: Number($("#agentMaxTokens").value) || 16384,
    // 空串 = 回到默认头像；后端只认白名单里的 key
    avatar: selectedAvatar,
  };
  // 本机 CLI 员工不写模型/地址/Key：它用的是自己的配置，塞进去只会误导下一个人
  const editingLocal = !creating
    && (state.boot?.agents?.find((item) => item.id === editingAgentId)?.provider === "local");
  // 新建时选中的磁贴是本机 CLI，同样不提交这些字段
  const creatingLocal = creating
    && (agentPresets().find((item) => item.id === activePresetId)?.local === true);
  if (editingLocal || creatingLocal) {
    delete payload.model;
    delete payload.maxOutputTokens;
  }
  if (creatingLocal) {
    payload.provider = "local";
    payload.cli = agentPresets().find((item) => item.id === activePresetId)?.cli || "claude";
  }
  // 留空时不提交 baseUrl，避免把现有地址清成非法值
  const baseUrl = $("#agentBaseUrl").value.trim();
  if (baseUrl && !editingLocal && !creatingLocal) payload.baseUrl = baseUrl;

  // 单价：两个都留空 = 清掉成本估算；只改价时保留现有的缓存命中价，不悄悄丢掉
  const priceIn = $("#agentPriceIn").value.trim();
  const priceOut = $("#agentPriceOut").value.trim();
  payload.pricing = { input: priceIn, output: priceOut };
  const currentPricing = state.boot?.agents?.find((item) => item.id === editingAgentId)?.config?.pricing;
  if (currentPricing?.cachedInput != null && (priceIn || priceOut)) {
    payload.pricing.cachedInput = currentPricing.cachedInput;
  }

  const key = $("#agentApiKey").value.trim();
  if (key && !editingLocal && !creatingLocal) payload.apiKey = key;
  else if (agentClearKeyPending && !creatingLocal) payload.clearApiKey = true;

  try {
    const data = await api(creating ? "/api/agents" : `/api/agents/${editingAgentId}`, {
      method: creating ? "POST" : "PATCH",
      body: JSON.stringify(payload),
    });
    if (state.boot) state.boot.agents = data.agents;
    $("#agentDialog").close();
    renderAgents();
    renderSelectOptions();
    checkHealth();
    toast(creating ? `已新增「${data.agent?.name ?? payload.name}」` : "配置已保存，立即生效");
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/** 两段式删除：第一下只是上膛，五秒内再点一次才真的删。 */
async function removeAgent() {
  if (!editingAgentId) return;
  const button = $("#agentDelete");
  const note = $("#agentNote");

  if (!agentDeleteArmed) {
    agentDeleteArmed = true;
    button.textContent = "确认删除";
    button.classList.add("armed");
    note.textContent = "删除会同时移除配置文件里的记录与密钥，无法撤销。";
    agentDeleteTimer = setTimeout(resetDeleteArm, 5000);
    return;
  }

  resetDeleteArm();
  button.disabled = true;
  const id = editingAgentId;
  try {
    const data = await api(`/api/agents/${id}`, { method: "DELETE" });
    if (state.boot) state.boot.agents = data.agents;
    $("#agentDialog").close();
    editingAgentId = null;
    renderAgents();
    renderSelectOptions();
    checkHealth();
    toast("员工已删除");
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/* =========================================================================
   flows view（阶段一：线性串行编排）
   ========================================================================= */
const RUN_STATUS = {
  running: { label: "执行中", cls: "run" },
  checking: { label: "检查中", cls: "run" },
  waiting: { label: "等待确认", cls: "wait" },
  paused: { label: "已暂停", cls: "warn" },
  success: { label: "已完成", cls: "ok" },
  failed: { label: "失败", cls: "bad" },
  cancelled: { label: "已取消", cls: "off" },
};

// 「还在推进」的运行：只有这些值得占标签栏一行，已结束的收进「全部」
const RUN_LIVE_STATUS = new Set(["running", "checking", "waiting", "paused"]);

const STEP_STATUS = {
  pending: { label: "待执行", cls: "off" },
  running: { label: "执行中", cls: "run" },
  checking: { label: "检查中", cls: "run" },
  waiting: { label: "等确认", cls: "wait" },
  success: { label: "完成", cls: "ok" },
  skipped: { label: "已跳过", cls: "off" },
  failed: { label: "失败", cls: "bad" },
  cancelled: { label: "已取消", cls: "off" },
};

const FLOW_OUTPUT_LABEL = { markdown: "文档", code: "代码", document: "正式文档", json: "结构化", text: "纯文本" };
const CHECK_VERDICT = {
  pass: { label: "检查通过", cls: "ok" },
  fail: { label: "检查不通过", cls: "bad" },
  unknown: { label: "没给明确结论", cls: "quiet" },
};

let editingFlowId = null;
let flowDraft = { variables: [], steps: [], edges: [] };
let runDetailId = null;
let runDetailSig = "";
let flowPollTimer = null;
let flowDeleteArmed = false;
let flowDeleteTimer = null;
let dragPayload = null;
// 画布上被点选中的连线（下标指向 flowDraft.edges）；-1 = 没选中
let selectedEdgeIndex = -1;

/** 检查点兼容：老流程只有 approval，新流程用 checkpoint。 */
function checkpointOf(step) {
  const cp = step?.checkpoint;
  if (cp && typeof cp === "object") {
    return { enabled: cp.enabled === true, agentId: cp.agentId ?? "", criteria: cp.criteria ?? "" };
  }
  return { enabled: step?.approval === "manual", agentId: "", criteria: "" };
}

const flowHasCheck = (step) => checkpointOf(step).enabled;

const currentFlows = () => state.flows ?? [];
const flowById = (id) => currentFlows().find((flow) => flow.id === id);

async function loadFlows({ quiet = true } = {}) {
  try {
    const data = await api("/api/flows");
    state.flows = data.items ?? [];
    state.flowRuns = data.runs ?? [];
    const badge = $("#countFlows");
    if (badge) badge.textContent = state.flows.length ? String(state.flows.length) : "";
    if (state.view === "worksite" && state.worksiteTab === "flows") renderFlows();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

function renderFlows() {
  const list = currentFlows();
  const runs = state.flowRuns ?? [];
  renderFlowTabs(list);

  const filter = state.flowFilter ?? "all";
  const shown = filter === "all" ? list : list.filter((flow) => (filter === "active" ? flow.status === "active" : flow.status === "disabled"));
  const box = $("#flowList");
  // 内容整批换掉（换筛选 / 新建流程）：回到开头。
  // 停在中间会让人一进来就看见半张卡，还以为是布局坏了。
  const signature = shown.map((flow) => flow.id).join(",");
  const refill = box.dataset.signature !== signature;
  if (refill) box.dataset.signature = signature;
  if (!shown.length) {
    box.innerHTML = `<div class="empty-state flow-rail-empty"><b>${list.length ? "这个筛选下没有流程" : "还没有流程"}</b><span>${list.length ? "切回「全部」看看" : "新建一条，把员工串成流水线"}</span></div>`;
  } else {
    box.replaceChildren(...shown.map(renderFlowCard));
  }
  if (refill) box.scrollLeft = 0;
  syncRailEdge(box);
  renderLaunch(list);
  renderRunTabs(runs);
  ensureFlowPolling();
}

/**
 * 滑轨的右侧渐隐：没滑到底就保留，滑到底就撤掉。
 * 不这么做的话，最后一张卡永远像被页面裁了一半。
 */
function syncRailEdge(box) {
  if (!box) return;
  const overflow = box.scrollWidth - box.clientWidth;
  box.classList.toggle("no-scroll", overflow <= 2);
  box.classList.toggle("at-end", overflow > 2 && box.scrollLeft >= overflow - 2);
}

/**
 * 启动台：把「填一句话 → 选流程 → 开始」压成一个动作。
 * 原来这一步要先点流程卡上的「运行」，再在弹窗里填一遍——同一件事做了两遍。
 */
function renderLaunch(list) {
  const select = $("#flowLaunchSelect");
  if (!select) return;
  const usable = list.filter((flow) => flow.status !== "disabled");
  // 重绘时保住当前选择：否则每次轮询刷新都会跳回第一条
  const keep = select.value || state.launchFlowId || "";
  const changed = select.dataset.signature !== usable.map((flow) => `${flow.id}:${flow.version}`).join(",");
  if (changed) {
    select.replaceChildren(...usable.map((flow) => new Option(`${flow.name} · ${flow.steps?.length ?? 0} 步`, flow.id)));
    select.dataset.signature = usable.map((flow) => `${flow.id}:${flow.version}`).join(",");
  }
  if (keep && usable.some((flow) => flow.id === keep)) select.value = keep;
  state.launchFlowId = select.value || "";

  const go = $("#flowLaunchGo");
  if (go) {
    go.disabled = !usable.length;
    go.textContent = state.launchBusy ? "启动中…" : "开始";
  }
  if (!usable.length) {
    select.replaceChildren(new Option("还没有可运行的流程", ""));
  }
  renderLaunchVars();
}

/** 选中流程的必填项：只在这一块里出现，不去弹窗里再填一次。 */
function renderLaunchVars() {
  const box = $("#flowLaunchVars");
  if (!box) return;
  const flow = currentFlows().find((item) => item.id === $("#flowLaunchSelect")?.value);
  const variables = flow?.variables ?? [];
  if (!variables.length) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  // 保留已经填过的值：切换流程才重建，同一流程重绘不清空
  const filled = Object.fromEntries($$("#flowLaunchVars .flow-run-var").map((input) => [input.dataset.name, input.value]));
  box.replaceChildren(...variables.map((variable) => {
    const label = document.createElement("label");
    label.className = "field";
    const shown = variable.label || variable.description || variable.name;
    const hint = variable.description && variable.description !== shown ? variable.description : "";
    const value = filled[variable.name] ?? variable.defaultValue ?? "";
    label.innerHTML = `<span>${esc(shown)}${variable.required ? " *" : ""}${hint ? `<em class="flow-tip">${esc(hint)}</em>` : ""}</span>
      <input class="flow-run-var" data-name="${esc(variable.name)}" value="${esc(value)}" autocomplete="off">`;
    return label;
  }));
}

async function submitLaunch(event) {
  event.preventDefault();
  const note = $("#flowLaunchNote");
  const flowId = $("#flowLaunchSelect")?.value;
  const input = $("#flowLaunchInput")?.value.trim() ?? "";
  const flow = currentFlows().find((item) => item.id === flowId);
  note.hidden = true;
  if (!flowId || !flow) {
    note.hidden = false;
    note.textContent = "先选一条要跑的流程";
    return;
  }
  if (!input) {
    note.hidden = false;
    note.textContent = "先说一下这次要做什么";
    $("#flowLaunchInput")?.focus();
    return;
  }
  // 必填项没填就别发请求，省一次往返
  const variables = {};
  const missing = [];
  for (const item of flow.variables ?? []) {
    const box = $(`#flowLaunchVars .flow-run-var[data-name="${item.name}"]`);
    const value = box?.value.trim() ?? item.defaultValue ?? "";
    variables[item.name] = value;
    if (item.required && !value) missing.push(item.label || item.description || item.name);
  }
  if (missing.length) {
    note.hidden = false;
    note.textContent = `还差一项：${missing.join("、")}`;
    return;
  }

  state.launchBusy = true;
  renderLaunch(currentFlows());
  try {
    const run = await api(`/api/flows/${flowId}/run`, {
      method: "POST",
      // 默认最安全的运行方式：复制一份再干，源目录不动
      body: JSON.stringify({ input, variables, cwd: state.boot?.defaultRoot ?? null, mode: "isolated" }),
    });
    $("#flowLaunchInput").value = "";
    state.launchBusy = false;
    // 刚点了「开始」，确保大窗是展开的：人按完按钮总得看到第一步在跑
    state.runOpen = true;
    await loadFlows();
    await openRunDetail(run.id);
    toast(`已启动「${flow.name}」，正在副本里跑第一步`);
  } catch (error) {
    note.hidden = false;
    note.textContent = error.message;
  } finally {
    state.launchBusy = false;
    renderLaunch(currentFlows());
  }
}

function renderFlowTabs(list) {
  const box = $("#flowTabs");
  if (!box) return;
  const active = state.flowFilter ?? "all";
  box.replaceChildren(...["all", "active", "disabled"].map((key) => {
    const count = key === "all" ? list.length : list.filter((flow) => (key === "active" ? flow.status === "active" : flow.status === "disabled")).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `lib-tab${active === key ? " active" : ""}`;
    button.innerHTML = `${key === "all" ? "全部" : key === "active" ? "已启用" : "已停用"}<i>${count}</i>`;
    button.addEventListener("click", () => {
      state.flowFilter = key;
      renderFlows();
    });
    return button;
  }));
}

function renderFlowCard(flow) {
  const steps = flow.steps ?? [];
  const card = document.createElement("article");
  card.className = `flow-card${flow.status === "disabled" ? " off" : ""}`;
  const chain = steps.map((step, index) => {
    const isCondition = step.kind === "condition";
    const name = isCondition ? `${agentNameOf(step.agentId)} 来判断` : step.agentMode === "auto" ? "自动路由" : agentNameOf(step.agentId);
    const check = !isCondition && flowHasCheck(step)
      ? `<u class="flow-node-cp" title="这一步做完会停下来，确认后才继续">检查点</u>`
      : "";
    return `<span class="flow-node${isCondition ? " is-cond" : ""}${check ? " has-cp" : ""}"><i>${isCondition ? "◇" : index + 1}</i><b>${esc(step.name)}</b><em>${esc(name)}</em>${check}</span>`;
  }).join('<span class="flow-arrow">→</span>');

  card.innerHTML = `
    <header class="flow-card-head">
      <div>
        <h3>${esc(flow.name)}</h3>
        <p>${esc(flow.description || "还没有写说明")}</p>
      </div>
      <span class="tag quiet">v${flow.version}</span>
    </header>
    <div class="flow-chain">${chain}</div>
    <div class="flow-tags">
      <span class="tag quiet">${steps.length} 步</span>
      ${(flow.variables ?? []).length ? `<span class="tag quiet">${flow.variables.length} 个变量</span>` : ""}
      ${steps.filter(flowHasCheck).length ? `<span class="tag cap">${steps.filter(flowHasCheck).length} 个检查点</span>` : ""}
      ${flow.status === "disabled" ? `<span class="tag quiet bad">已停用</span>` : ""}
      <span class="tag quiet">${relTime(flow.updatedAt)}更新</span>
    </div>`;

  const foot = document.createElement("footer");
  foot.className = "flow-card-foot";
  // 卡片不再承担「运行」：启动台已经是唯一入口。
  // 点卡片 = 把它选进上面的启动台，一步到位。
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "primary";
  pick.textContent = "用它跑";
  pick.disabled = flow.status === "disabled";
  pick.addEventListener("click", (event) => {
    event.stopPropagation();
    pickForLaunch(flow, true);
    toast(`已选「${flow.name}」，说一句要做什么就能开始`);
  });

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "agent-edit";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openFlowDialog(flow));

  foot.append(pick, edit);
  card.append(foot);
  // 卡片整块可点：选进启动台，比让人去下拉框里再找一遍顺
  if (flow.status !== "disabled") card.addEventListener("click", () => pickForLaunch(flow, false));
  return card;
}

/** 把某条流程选进启动台：下拉跟着变、变量区按新流程重建。 */
function pickForLaunch(flow, focusInput) {
  state.launchFlowId = flow.id;
  const select = $("#flowLaunchSelect");
  if (select) select.value = flow.id;
  $("#flowLaunchVars").replaceChildren();
  renderLaunchVars();
  if (focusInput) $("#flowLaunchInput")?.focus();
}

/**
 * 执行详情用标签页：一次开了好几个运行时，它们并排等着你切。
 * 标签本身承担原来「运行记录」一行的信息量：流程名、进度、状态、时间。
 *//**
 * 执行详情的筛选：默认只看「进行中」。
 * 跑久了会攒下几十条已结束的运行，全铺在标签栏里反而找不到正在跑的那条。
 */
function renderRunFilters(runs) {
  const box = $("#flowRunFilters");
  if (!box) return;
  const live = runs.filter((run) => RUN_LIVE_STATUS.has(run.status)).length;
  if (!runs.length) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const current = state.runFilter ?? "active";
  // 没有进行中的运行就别给「进行中」这个空选项，直接落在「全部」上
  const options = live
    ? [["active", `进行中 ${live}`], ["all", `全部 ${runs.length}`]]
    : [["all", `全部 ${runs.length}`]];
  if (!options.some(([key]) => key === current)) state.runFilter = options[0][0];
  box.replaceChildren(...options.map(([key, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `run-filter${(state.runFilter ?? "active") === key ? " active" : ""}`;
    button.textContent = text;
    button.addEventListener("click", () => {
      state.runFilter = key;
      renderRunTabs(state.flowRuns ?? []);
    });
    return button;
  }));
}

function renderRunTabs(runs) {
  const box = $("#flowRunTabs");
  const panel = $("#flowRunPanel");
  const empty = $("#runPanelEmpty");
  const inner = $("#runPanelInner");
  const boardHead = $("#runBoardToggle");
  if (!box || !panel) return;
  const count = $("#flowRunCount");
  renderRunFilters(runs);

  // 小框一行放不下十几条：默认只列进行中的，切到「全部」才铺开
  const filter = state.runFilter ?? "active";
  const activeRuns = runs.filter((run) => RUN_LIVE_STATUS.has(run.status));
  const pool = filter === "active" && activeRuns.length ? activeRuns : runs;
  if (count) {
    count.textContent = pool.length
      ? filter === "active" && activeRuns.length
        ? `${activeRuns.length} 进行中${runs.length > activeRuns.length ? ` / ${runs.length}` : ""}`
        : `${runs.length} 条`
      : "";
  }

  if (!pool.length) {
    box.hidden = true;
    box.replaceChildren();
    if (boardHead) boardHead.hidden = true;
    if (empty) empty.hidden = false;
    if (inner) inner.hidden = true;
    $("#flowRunEmpty") && ($("#flowRunEmpty").hidden = !runs.length);
    state.runTabId = null;
    applyRunCollapse();
    return;
  }
  $("#flowRunEmpty") && ($("#flowRunEmpty").hidden = true);

  // 当前这条失效（被删了/第一次进/被筛选挡掉）就落到第一条，绝不留空白面板
  const alive = pool.some((run) => run.id === state.runTabId);
  if (!alive) state.runTabId = pool[0].id;
  // 小框自己会滚，不必再截断条数；只限制单条渲染成本没有意义，全列出来反正好找
  const shown = pool;

  // 面板是空的（刚进页面 / 运行被清空过）：把选中的那条填进去。
  // 判断依据是「面板里有没有步骤」，不是「标过记号」——记号在请求发出前就先打上，
  // 请求还没回来时轮询再进来一次，就会误以为已经填好而跳过，留下一个空面板。
  const panelFilled = inner?.querySelector(".run-step") || inner?.dataset.filled === state.runTabId;
  if (!panelFilled) {
    if (empty) empty.hidden = true;
    if (inner) inner.hidden = false;
    openRunDetail(state.runTabId).catch(() => {});
  }

  box.hidden = false;
  box.replaceChildren(...shown.map((run) => {
    const total = run.stepStates?.length ?? 0;
    const done = (run.stepStates ?? []).filter((step) => ["success", "skipped"].includes(step.status)).length;
    const status = RUN_STATUS[run.status] ?? RUN_STATUS.running;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `run-tab ${status.cls}${run.id === state.runTabId ? " active" : ""}`;
    button.dataset.run = run.id;
    // 同一个流程会跑很多次：记录里必须能分辨是哪一次，否则一堆同名条目没法点
    const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(run.createdAt || Date.now()));
    button.title = [run.input, run.error || run.note, `${done}/${total} 步`].filter(Boolean).join("\n");
    button.innerHTML = `
      <span class="run-dot ${status.cls}"></span>
      <span class="run-tab-main">
        <b>${esc(run.flowName)}</b>
        <span class="run-tab-meta mono"><span class="run-tab-when">${esc(clock)}</span><span class="run-tab-progress">${done}/${total}</span></span>
      </span>
      <span class="run-status ${status.cls}">${status.label}</span>`;
    button.addEventListener("click", () => selectRunTab(run.id));
    return button;
  }));

  if (boardHead) boardHead.hidden = !state.runTabId;
  if (empty) empty.hidden = Boolean(state.runTabId);
  if (inner) inner.hidden = !state.runTabId;
  applyRunCollapse();
}

/** 折叠/展开大窗：只改一个类，不重绘面板，展开时保留里面已滚到的位置 */
function applyRunCollapse() {
  const panel = $("#flowRunPanel");
  const toggle = $("#runBoardToggle");
  if (!panel) return;
  const open = state.runOpen === true;
  panel.classList.toggle("collapsed", !open);
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  // 折叠时占位提示只在「确实有一条运行」时出现，否则会和空状态打架
  const hint = $("#runCollapsedHint");
  if (hint) hint.hidden = open || !state.runTabId;
}

function toggleRunOpen() {
  if (!state.runTabId) return;
  state.runOpen = !state.runOpen;
  applyRunCollapse();
}

/**
 * 大窗顶部那条状态纪要：折叠时它就是详情区的全部内容，
 * 所以流程名、状态、走到第几步、耗时都必须在这里说清楚。
 */
function renderRunBoardHead(run) {
  const toggle = $("#runBoardToggle");
  if (!toggle) return;
  const status = RUN_STATUS[run.status] ?? RUN_STATUS.running;
  const total = run.stepStates?.length ?? 0;
  const done = (run.stepStates ?? []).filter((step) => ["success", "skipped"].includes(step.status)).length;
  toggle.hidden = false;
  toggle.classList.toggle("active", RUN_LIVE_STATUS.has(run.status));
  const dot = $("#runBoardDot");
  if (dot) dot.className = `run-dot ${status.cls}`;
  const name = $("#runBoardName");
  if (name) name.textContent = run.flowName ?? "运行";
  const meta = $("#runBoardMeta");
  if (meta) {
    const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(run.createdAt || Date.now()));
    meta.textContent = [status.label, `${done}/${total} 步`, clock, run.input ? `「${run.input}」` : ""]
      .filter(Boolean)
      .join(" · ");
    meta.title = [run.input, run.error || run.note].filter(Boolean).join("\n");
  }
}

/** 切记录：面板重绘 + 事件流跟着切过去，旧连接必须断掉 */
async function selectRunTab(runId) {
  if (state.runTabId === runId) return;
  state.runTabId = runId;
  runDetailSig = "";
  renderRunTabs(state.flowRuns ?? []);
  await openRunDetail(runId);
}

/* ------------------------------------------------------------ flow editor */
function defaultFlowSteps() {
  const cloud = (state.boot?.agents ?? []).find((agent) => agent.available && agent.id !== "codex");
  return [
    {
      key: "design",
      name: "出方案",
      agentMode: "fixed",
      agentId: "codex",
      promptTemplate: "针对下面这件事，先给结论再给依据，做一份能直接照着做的方案：\n{{input}}",
      outputType: "markdown",
      outputFiles: "auto",
      tools: "auto",
      checkpoint: { enabled: false, agentId: "", criteria: "" },
    },
    {
      key: "build",
      name: "做出来",
      agentMode: "fixed",
      agentId: cloud?.id ?? "codex",
      promptTemplate: "照着上面的方案把东西做出来。每个文件用 ```语言 file:相对路径 的代码块给出，最后用「## 产出文件」列出清单。\n\n方案：\n{{previous.output}}",
      outputType: "code",
      outputFiles: "auto",
      tools: "auto",
      // 默认给最后交付加个检查点：做完先停下来，人看过再算交付。
      checkpoint: { enabled: true, agentId: "", criteria: "" },
    },
  ];
}

/** 条件节点出线选项的展示配色：满足=绿、不满足=红、其他=蓝。 */
const conditionOptionClass = (option) => (option === "满足" ? "yes" : option === "不满足" ? "no" : "mid");

/**
 * 老流程升级：条件节点补 options（没存过就给「满足/不满足」）；
 * 出线上遗留的 yes/no 标记映射成等价选项文案，画布和引擎统一只认选项文案。
 */
function normalizeConditionDraft(draft) {
  const optionsByKey = new Map();
  for (const step of draft.steps) {
    if (step.kind !== "condition") continue;
    let options = (Array.isArray(step.options) ? step.options : [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    options = [...new Set(options)];
    if (options.length < 2) options = ["满足", "不满足"];
    step.options = options.slice(0, 5);
    optionsByKey.set(step.key, step.options);
  }
  draft.edges = (draft.edges ?? []).map((edge) => {
    const options = optionsByKey.get(edge.from);
    if (!options || options.includes(edge.branch)) return edge;
    if (edge.branch === "yes") return { ...edge, branch: options.includes("满足") ? "满足" : options[0] };
    if (edge.branch === "no") return { ...edge, branch: options.includes("不满足") ? "不满足" : options[options.length - 1] };
    return { ...edge, branch: options[0] };
  });
}

function openFlowDialog(flow = null) {
  editingFlowId = flow?.id ?? null;
  flowDeleteArmed = false;
  clearTimeout(flowDeleteTimer);
  const steps = (flow?.steps ?? defaultFlowSteps()).map((step) => ({ ...step }));
  // 老流程没存连线：按数组顺序接成一条链，画布上看到的和实际执行的一致
  const edges = flow?.edges?.length
    ? flow.edges.map((edge) => ({ ...edge }))
    : steps.slice(1).map((step, index) => ({ from: steps[index].key, to: step.key, branch: "" }));
  flowDraft = {
    variables: (flow?.variables ?? []).map((variable) => ({ ...variable })),
    steps,
    edges,
    // 流程级技能：所有步骤都会带上，步骤自己挂的会叠在上面
    skills: [...(flow?.skills ?? [])],
  };
  normalizeConditionDraft(flowDraft);
  $("#flowDialogTitle").textContent = flow ? `编辑 ${flow.name}` : "新建流程";
  $("#flowName").value = flow?.name ?? "";
  $("#flowDescription").value = flow?.description ?? "";
  $("#flowDelete").hidden = !flow;
  $("#flowDelete").textContent = "删除流程";
  $("#flowDelete").classList.remove("armed");
  $("#flowNote").textContent = "";
  if ((flow?.variables ?? []).length) $("#flowVarBox").open = true;
  selectedStepIndex = flowDraft.steps.length ? 0 : -1;
  selectedEdgeIndex = -1;
  renderFlowSteps();
  renderFlowVars();
  // 整页编排：切到独立视图，布局完成后再铺画布和连线
  setView("flowEdit");
  requestAnimationFrame(() => {
    fitFlowCanvas();
    drawFlowEdges();
  });
  // 打开后把画布滚到最左，从第一步看起
  $("#flowCanvasWrap")?.scrollTo({ left: 0, top: 0 });
}

/** 从编排页回到流程列表。 */
function closeFlowEditor() {
  editingFlowId = null;
  flowDraft = null;
  gotoWorksiteTab("flows");
}

function agentOptionsHtml(selectedId) {
  const agents = state.boot?.agents ?? [];
  const options = agents.map((agent) => {
    const label = `${agent.name}${agent.available ? "" : "（未配置）"}`;
    return `<option value="${esc(agent.id)}"${agent.id === selectedId ? " selected" : ""}>${esc(label)}</option>`;
  });
  return `<option value="__auto"${!selectedId ? " selected" : ""}>自动路由（按能力标签）</option>${options.join("")}`;
}

const agentLabel = (agent) => `${agent.name}${agent.available ? "" : "（未配置）"}`;

function nextVarName() {
  const used = new Set(flowDraft.variables.map((variable) => variable.name));
  let index = flowDraft.variables.length + 1;
  while (used.has(`var${index}`)) index += 1;
  return `var${index}`;
}

/** 占位符按钮：不让用户手打 {{...}}，点一下就插进光标处。图语义：previous = 连进来的线，steps = 任何连得上游的节点。 */
function promptChipsHtml(index) {
  const step = flowDraft.steps[index];
  const hasIncoming = (flowDraft.edges ?? []).some((edge) => edge.to === step?.key);
  const chips = [{ token: "{{input}}", label: "这次的任务" }];
  if (hasIncoming) {
    chips.push({ token: "{{previous.output}}", label: "上一步（连进来的线）的产出" });
    chips.push({ token: "{{previous.files}}", label: "上一步的文件清单" });
    chips.push({ token: "{{previous.summary}}", label: "上一步的一句话结论" });
  }
  flowDraft.steps.forEach((other, otherIndex) => {
    if (!other?.key || otherIndex === index) return;
    chips.push({ token: `{{steps.${other.key}.output}}`, label: `「${other.name || "未命名"}」的产出` });
  });
  for (const variable of flowDraft.variables) {
    if (!variable.name) continue;
    chips.push({ token: `{{${variable.name}}}`, label: `填写项：${variable.label || variable.description || variable.name}` });
  }
  return chips
    .map((chip) => `<button type="button" class="flow-chip" data-token="${esc(chip.token)}">${esc(chip.label)}</button>`)
    .join("");
}

/** 填空项或步骤名改过之后，插入按钮要跟着变；只重画按钮，不重画整步，光标不丢。 */
function refreshPromptChips() {
  readFlowVarsFromDom();
  const box = $("#flowInspector .flow-ph-chips");
  if (box && selectedStepIndex >= 0) box.innerHTML = promptChipsHtml(selectedStepIndex);
}

function renderFlowPalette() {
  const box = $("#flowPalette");
  if (!box) return;
  const agents = state.boot?.agents ?? [];
  // 条件节点固定排在最前面：它不干活，只判断走哪条线
  const gate = document.createElement("button");
  gate.type = "button";
  gate.className = "flow-agent-chip is-condition";
  gate.draggable = true;
  gate.title = "点一下加一个判断节点；拖到画布空白处也能加";
  gate.innerHTML = `<b>◇ 条件判断</b><em>判断后按选项走不同的线</em>`;
  gate.addEventListener("click", () => appendConditionNode());
  gate.addEventListener("dragstart", (event) => {
    dragPayload = { kind: "condition" };
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", "condition");
    gate.classList.add("dragging");
  });
  gate.addEventListener("dragend", () => {
    gate.classList.remove("dragging");
    clearDropMarks();
    dragPayload = null;
  });
  const chips = agents.map((agent) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `flow-agent-chip${agent.available ? "" : " off"}`;
    chip.draggable = true;
    chip.dataset.agent = agent.id;
    chip.title = "点一下加一步；拖到画布空白处也能加，拖到节点上 = 这一步换它来做";
    chip.innerHTML = `<b>${esc(agent.name)}</b><em>${esc(agent.summary || (agent.id === "codex" ? "能读写文件、跑命令" : "云端对话"))}</em>`;
    chip.addEventListener("click", () => appendStepWithAgent(agent.id));
    chip.addEventListener("dragstart", (event) => {
      dragPayload = { kind: "agent", agentId: agent.id };
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", `agent:${agent.id}`);
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging");
      clearDropMarks();
      dragPayload = null;
    });
    return chip;
  });
  box.replaceChildren(gate, ...chips);
}

/** 节点默认摆位：从左到右一列排开，隔一个错半层，像流程图而不是清单。 */
function defaultNodePos(index) {
  return { x: 36 + index * 248, y: 64 + (index % 2) * 96 };
}

function nodePos(step, index) {
  return step.ui ?? defaultNodePos(index);
}

function appendStepWithAgent(agentId, pos = null) {
  readFlowStepsFromDom();
  const index = flowDraft.steps.length + 1;
  const used = new Set(flowDraft.steps.map((step) => step.key));
  let n = index;
  while (used.has(`step${n}`)) n += 1;
  const step = {
    key: `step${n}`,
    name: `第 ${index} 步`,
    kind: "task",
    agentMode: "fixed",
    agentId: agentId || "codex",
    promptTemplate: index === 1 ? "{{input}}" : "{{previous.output}}",
    outputType: "markdown",
    outputFiles: "auto",
    tools: "auto",
    checkpoint: { enabled: false, agentId: "", criteria: "" },
    ui: pos ?? defaultNodePos(flowDraft.steps.length),
  };
  flowDraft.steps.push(step);
  selectedStepIndex = flowDraft.steps.length - 1;
  selectedEdgeIndex = -1;
  renderFlowSteps();
  $(`#flowCanvas .flow-node-card[data-index="${selectedStepIndex}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const nameInput = $("#flowInspector .flow-step-name");
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

/** 加一个条件节点：默认不连任何线，等用户从端口拖线。 */
function appendConditionNode(pos = null) {
  readFlowStepsFromDom();
  const index = flowDraft.steps.length + 1;
  const used = new Set(flowDraft.steps.map((step) => step.key));
  let n = index;
  while (used.has(`step${n}`)) n += 1;
  const agents = (state.boot?.agents ?? []).filter((agent) => agent.available);
  const step = {
    key: `step${n}`,
    name: `条件判断 ${flowDraft.steps.filter((item) => item.kind === "condition").length + 1}`,
    kind: "condition",
    agentMode: "fixed",
    agentId: agents[0]?.id ?? "codex",
    question: "看上面的产出，判断：{{previous.output}}",
    options: ["满足", "不满足"],
    ui: pos ?? defaultNodePos(flowDraft.steps.length),
  };
  flowDraft.steps.push(step);
  selectedStepIndex = flowDraft.steps.length - 1;
  selectedEdgeIndex = -1;
  renderFlowSteps();
  const questionInput = $("#flowInspector .flow-step-question");
  if (questionInput) { questionInput.focus(); questionInput.select(); }
}

function clearDropMarks() {
  for (const card of $$("#flowCanvas .flow-node-card")) {
    card.classList.remove("drop-before", "drop-after", "drop-target", "dragging");
  }
  $("#flowCanvasWrap .flow-canvas-ghost")?.remove();
}

/* ------------------------------------------------------------------
   画布编排器：节点 = 步骤，连线 = 执行顺序；配置统一放右侧检查器
   ------------------------------------------------------------------ */

let selectedStepIndex = -1;

function renderFlowSteps() {
  const canvas = $("#flowCanvas");
  if (!canvas) return;
  const nodes = flowDraft.steps.map((step, index) => {
    const isCondition = step.kind === "condition";
    const cp = isCondition ? { enabled: false } : checkpointOf(step);
    const pos = nodePos(step, index);
    const card = document.createElement("div");
    card.className = `flow-node-card${isCondition ? " is-condition" : ""}${cp.enabled ? " has-check" : ""}${index === selectedStepIndex ? " selected" : ""}`;
    card.dataset.index = String(index);
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    card.innerHTML = isCondition
      ? `
      <div class="flow-node-head">
        <span class="flow-step-no">◇</span>
        <b class="flow-node-name" title="${esc(step.name)}">${esc(step.name || "条件判断")}</b>
        <button type="button" data-act="del" title="删除这一步">✕</button>
      </div>
      <div class="flow-node-agent" title="谁来判断">${esc(agentNameOf(step.agentId))} 来判断</div>
      <div class="flow-node-meta"><span class="flow-node-q" title="${esc(step.question || "")}">${esc(step.question || "还没写判断问题")}</span></div>
      ${flowNodeSkillsHtml(step)}
      <span class="flow-port in" title="接收上游产出"></span>
      ${(step.options ?? ["满足", "不满足"]).map((option, portIndex) => {
        const cls = conditionOptionClass(option);
        return `<span class="flow-port-label ${cls}" data-port="${portIndex}">${esc(option)}</span>` +
          `<span class="flow-port out ${cls}" data-port="${portIndex}" data-branch="${esc(option)}" title="${esc(option)} → 从这根线出去"></span>`;
      }).join("")}`
      : `
      <div class="flow-node-head">
        <span class="flow-step-no">${index + 1}</span>
        <b class="flow-node-name" title="${esc(step.name)}">${esc(step.name || "未命名")}</b>
        <button type="button" data-act="del" title="删除这一步">✕</button>
      </div>
      <div class="flow-node-agent" title="谁来做">${esc(step.agentMode === "auto" ? "自动路由" : agentNameOf(step.agentId))}</div>
      <div class="flow-node-meta">
        <span>${esc(FLOW_OUTPUT_LABEL[step.outputType] ?? step.outputType)}${step.outputFiles === "none" ? " · 只传文字" : " · 存档"}</span>
        ${cp.enabled ? `<u class="flow-node-cp" title="做完会停下来等确认">检查点</u>` : ""}
      </div>
      ${flowNodeSkillsHtml(step)}
      <span class="flow-port in" title="接收上游的产出"></span>
      <span class="flow-port out" title="按住拖到下一个节点，拉一条执行线"></span>`;
    return card;
  });
  canvas.replaceChildren(...nodes);
  nodes.forEach(makeNodeDraggable);
  positionConditionPorts();
  fitFlowCanvas();
  drawFlowEdges();
  renderFlowInspector();
  renderFlowPalette();
}

/** 节点卡片上标出这一步挂了哪些工作方法（只显前两个，多了折叠成 +N）。 */
function flowNodeSkillsHtml(step) {
  const own = Array.isArray(step.skills) ? step.skills : [];
  const flowLevel = Array.isArray(flowDraft.skills) ? flowDraft.skills : [];
  const all = [...new Set([...own, ...flowLevel])];
  if (!all.length) return "";
  const titleOf = (name) => state.skills?.find((item) => item.name === name)?.title || name;
  const shown = all.slice(0, 2).map((name) => `<u class="flow-node-skill" title="这步会按「${esc(titleOf(name))}」的方法做">${esc(titleOf(name))}</u>`).join("");
  const more = all.length > 2 ? `<u class="flow-node-skill more" title="${esc(all.slice(2).map(titleOf).join("、"))}">+${all.length - 2}</u>` : "";
  return `<div class="flow-node-skills">${shown}${more}</div>`;
}

/** 条件节点的出线口按选项数量均分排布（CSS 只管颜色，位置在这里算，2~5 个都立得住）。 */
function positionConditionPorts() {
  for (const card of $$("#flowCanvas .flow-node-card.is-condition")) {
    const ports = [...card.querySelectorAll(".flow-port.out")];
    ports.forEach((port, index) => {
      const percent = ((index + 1) / (ports.length + 1) * 100).toFixed(1);
      port.style.top = `${percent}%`;
      const label = card.querySelector(`.flow-port-label[data-port="${port.dataset.port ?? index}"]`);
      if (label) label.style.top = `calc(${percent}% - 6px)`;
    });
  }
}

/** 画布铺到能装下所有节点，滚动交给外层 wrap。 */
function fitFlowCanvas() {
  const canvas = $("#flowCanvas");
  if (!canvas) return;
  // 宽度留一条右边界给「+」和连线标签；高度按最下方节点算，不给空白凑数
  let maxW = 720;
  let maxH = 0;
  for (const node of $$("#flowCanvas .flow-node-card")) {
    maxW = Math.max(maxW, node.offsetLeft + node.offsetWidth + 220);
    maxH = Math.max(maxH, node.offsetTop + node.offsetHeight);
  }
  // 120 是拖拽落点与端口的余量，够放下节点下方的分支标签
  canvas.style.width = `${maxW}px`;
  canvas.style.height = `${Math.max(maxH + 120, 220)}px`;
}

/** 节点端口在画布上的坐标：优先量真实端口元素（多选项排布也准），量不到再按比例兜底。 */
function portAnchor(card, kind, branch = "") {
  const canvas = $("#flowCanvas");
  const rect = card.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  const x = (kind === "out" ? rect.right : rect.left) - box.left;
  const port = kind === "out"
    ? ([...card.querySelectorAll(".flow-port.out")].find((item) => (item.dataset.branch || "") === branch)
      ?? card.querySelector(".flow-port.out"))
    : card.querySelector(".flow-port.in");
  if (port) {
    const portRect = port.getBoundingClientRect();
    return { x, y: portRect.top + portRect.height / 2 - box.top };
  }
  return { x, y: rect.top - box.top + rect.height * 0.5 };
}

/** 依 flowDraft.edges 画连线（三次贝塞尔 + 箭头 + 条件分支标签），支持拖线中的临时线。 */
function drawFlowEdges(tempEdge = null) {
  const svg = $("#flowEdges");
  const canvas = $("#flowCanvas");
  if (!svg || !canvas) return;
  // 弹窗还没打开时量不到尺寸，等下一帧由 openFlowDialog 再调一次
  if (!canvas.offsetWidth) return;
  const cards = $$("#flowCanvas .flow-node-card");
  const cardOf = (key) => {
    const index = flowDraft.steps.findIndex((step) => step.key === key);
    return index >= 0 ? cards[index] : null;
  };
  const paths = [];
  flowDraft.edges.forEach((edge, edgeIndex) => {
    const fromCard = cardOf(edge.from);
    const toCard = cardOf(edge.to);
    if (!fromCard || !toCard) return;
    const from = portAnchor(fromCard, "out", edge.branch);
    const to = portAnchor(toCard, "in");
    const bend = Math.max(48, Math.abs(to.x - from.x) / 2);
    const selected = edgeIndex === selectedEdgeIndex;
    // 条件出线按选项配色：满足=绿、不满足=红、其他选项=蓝；普通连线不带色
    const branchCls = edge.branch ? ` branch-${conditionOptionClass(edge.branch)}` : "";
    paths.push(
      `<path class="flow-edge${selected ? " selected" : ""}${branchCls}" data-edge="${edgeIndex}" d="M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x - 8} ${to.y}"></path>` +
      `<path class="flow-edge-head${selected ? " selected" : ""}${branchCls}" d="M ${to.x - 9} ${to.y - 4} L ${to.x - 1} ${to.y} L ${to.x - 9} ${to.y + 4}"></path>`,
    );
    if (edge.branch) {
      // 标签贴着出线口放，压在中点上会和回流线打架、也容易被节点盖住
      const labelX = from.x + 34;
      const labelY = from.y - 8;
      paths.push(
        `<text class="flow-edge-label ${conditionOptionClass(edge.branch)}" x="${labelX}" y="${labelY}" text-anchor="start">${esc(edge.branch)}</text>`,
      );
    }
  });
  if (tempEdge) {
    const bend = Math.max(48, Math.abs(tempEdge.to.x - tempEdge.from.x) / 2);
    paths.push(
      `<path class="flow-edge temp" d="M ${tempEdge.from.x} ${tempEdge.from.y} C ${tempEdge.from.x + bend} ${tempEdge.from.y}, ${tempEdge.to.x - bend} ${tempEdge.to.y}, ${tempEdge.to.x} ${tempEdge.to.y}"></path>`,
    );
  }
  svg.innerHTML = paths.join("");
  // SVG 必须和画布同尺寸：用 100% + viewBox 会把坐标按可视区缩放，连线就跑到别处去了
  svg.setAttribute("width", String(canvas.offsetWidth));
  svg.setAttribute("height", String(canvas.offsetHeight));
  svg.removeAttribute("viewBox");
}

function renderFlowInspector() {
  const panel = $("#flowInspector");
  if (!panel) return;

  // 选中的是连线：显示两端和删除按钮
  const edge = flowDraft.edges[selectedEdgeIndex];
  if (edge) {
    const fromStep = flowDraft.steps.find((step) => step.key === edge.from);
    const toStep = flowDraft.steps.find((step) => step.key === edge.to);
    const branchLabel = edge.branch || "";
    panel.innerHTML = `
      <div class="flow-edge-panel">
        <b>一条连线</b>
        <p class="flow-edge-route">${esc(fromStep?.name ?? edge.from)} <span class="flow-arrow">→</span> ${esc(toStep?.name ?? edge.to)}${branchLabel ? ` <em class="flow-edge-branch ${conditionOptionClass(branchLabel)}">${esc(branchLabel)}</em>` : ""}</p>
        <p class="flow-edge-hint">${branchLabel ? "这是条件节点的分支线，只有判断结果选中这个选项时才会执行。" : "执行时会等这条线的起点完成，再把产出交给终点。"}</p>
        <div class="flow-edge-btns">
          <button type="button" class="danger" data-act="deledge">删除这条连线</button>
          <button type="button" class="ghost" data-act="canceledge">返回节点</button>
        </div>
      </div>`;
    return;
  }

  const step = flowDraft.steps[selectedStepIndex];
  if (!step) {
    panel.innerHTML = `<p class="flow-inspector-empty">点画布上的节点，在这里改这一步的配置。</p>`;
    return;
  }
  const index = selectedStepIndex;
  const isCondition = step.kind === "condition";
  const cp = isCondition ? { enabled: false } : checkpointOf(step);
  const inspectorOptions = [
    `<option value=""${cp.agentId ? "" : " selected"}>我自己看（只停一下）</option>`,
    ...(state.boot?.agents ?? []).map((agent) => `<option value="${esc(agent.id)}"${cp.agentId === agent.id ? " selected" : ""}>${esc(agentLabel(agent))}</option>`),
  ].join("");

  if (isCondition) {
    const options = Array.isArray(step.options) && step.options.length >= 2 ? step.options : ["满足", "不满足"];
    panel.innerHTML = `
      <div class="flow-step is-condition" data-index="${index}">
        <div class="flow-step-head">
          <b class="flow-step-no">◇ 判断</b>
          <input class="flow-step-name" maxlength="20" value="${esc(step.name)}" placeholder="这个判断叫什么（例：有没有报价）" autocomplete="off">
          <div class="flow-step-btns">
            <button type="button" data-act="del" title="删除这一步">✕</button>
          </div>
        </div>
        <label class="flow-mini wide"><span>谁来判断</span><select class="flow-step-agent">${agentOptionsHtml(step.agentId)}</select></label>
        <div class="flow-cond-options">
          <span class="flow-cond-opt-head">出线选项（2~5 个）<em>改完文案，连出去的线会自动跟着改名</em></span>
          ${options.map((option, optIndex) => `
            <div class="flow-cond-opt-row">
              <input class="flow-cond-option" data-opt-index="${optIndex}" maxlength="20" value="${esc(option)}" autocomplete="off">
              <button type="button" data-act="deloption" data-opt-index="${optIndex}" title="删除这个选项，连出去的线一并拆除"${options.length <= 2 ? " disabled" : ""}>✕</button>
            </div>`).join("")}
          <button type="button" class="ghost flow-cond-add" data-act="addoption"${options.length >= 5 ? " disabled" : ""}>＋ 加一个选项</button>
        </div>
        <p class="flow-condition-hint">员工从选项里挑一个，只有匹配的出线会执行，其余整条跳过。建议把兜底选项（如「不满足」「其他」）放在最后——判断不清时按最后一项处理。</p>
        <div class="flow-prompt">
          <div class="flow-ph-chips">${promptChipsHtml(index)}</div>
          <textarea class="flow-step-question" rows="4" spellcheck="false" placeholder="问一句能从选项里挑出答案的话，例：这份方案属于哪种情况？">${esc(step.question ?? "")}</textarea>
        </div>
        ${flowSkillPickerHtml(step.skills ?? [], index)}
        <details class="flow-step-adv">
          <summary>高级：给这个判断起个引用名（给懂的人用）</summary>
          <input class="flow-step-key mono" maxlength="24" value="${esc(step.key)}" placeholder="step${index + 1}" spellcheck="false">
        </details>
      </div>`;
    return;
  }

  panel.innerHTML = `
    <div class="flow-step" data-index="${index}">
      <div class="flow-step-head">
        <b class="flow-step-no">第 ${index + 1} 步</b>
        <input class="flow-step-name" maxlength="20" value="${esc(step.name)}" placeholder="这一步做什么（例：出方案）" autocomplete="off">
        <div class="flow-step-btns">
          <button type="button" data-act="del" title="删除这一步">✕</button>
        </div>
      </div>
      <div class="flow-step-row">
        <label class="flow-mini"><span>谁来做</span><select class="flow-step-agent">${agentOptionsHtml(step.agentMode === "auto" ? null : step.agentId)}</select></label>
        <label class="flow-mini"><span>产出成</span><select class="flow-step-output">${Object.entries(FLOW_OUTPUT_LABEL).map(([value, label]) => `<option value="${value}"${step.outputType === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <label class="flow-mini"><span>存档</span><select class="flow-step-files" title="落成文件后，下一步可以按需读取，不用整段文字搬来搬去">
          <option value="auto"${step.outputFiles !== "none" ? " selected" : ""}>存成文件</option>
          <option value="none"${step.outputFiles === "none" ? " selected" : ""}>只传文字</option>
        </select></label>
        <label class="flow-mini"><span>能做什么</span><select class="flow-step-tools" title="云端员工默认只会说话，这里决定要不要给它读写文件和执行命令的能力；codex 本身就会，不受影响">
          <option value="auto"${step.tools !== "files" && step.tools !== "none" ? " selected" : ""}>读写+跑命令</option>
          <option value="files"${step.tools === "files" ? " selected" : ""}>只能读写文件</option>
          <option value="none"${step.tools === "none" ? " selected" : ""}>只能聊天</option>
        </select></label>
      </div>
      <label class="flow-cp-toggle">
        <input type="checkbox" class="flow-step-cp"${cp.enabled ? " checked" : ""}>
        <span>做完先停一下，我确认了才继续</span>
        <em>检查点</em>
      </label>
      <div class="flow-cp-body"${cp.enabled ? "" : " hidden"}>
        <label class="flow-mini wide"><span>谁来检查</span><select class="flow-step-cp-agent">${inspectorOptions}</select></label>
        <textarea class="flow-step-cp-criteria" rows="2" spellcheck="false" placeholder="查什么？留空就按默认三条：有没有跑题、有没有缺漏、下一步能不能直接用">${esc(cp.criteria)}</textarea>
      </div>
      <div class="flow-prompt">
        <div class="flow-ph-chips">${promptChipsHtml(index)}</div>
        <textarea class="flow-step-prompt" rows="5" spellcheck="false" placeholder="告诉它这一步要怎么干。点上面的按钮插入「上一步的产出」这类内容，不用记符号。">${esc(step.promptTemplate)}</textarea>
      </div>
      ${flowSkillPickerHtml(step.skills ?? [], index)}
      <details class="flow-step-adv">
        <summary>高级：给这一步起个引用名（给懂的人用）</summary>
        <input class="flow-step-key mono" maxlength="24" value="${esc(step.key)}" placeholder="step${index + 1}" spellcheck="false">
      </details>
    </div>`;
}

/**
 * 步骤级的「工作方法」选择器。
 * 装了的技能直接点选；流程级技能是全局兜底，这里标出来免得用户以为没生效。
 */
function flowSkillPickerHtml(selected, index) {
  const installed = state.skills ?? [];
  const picked = Array.isArray(selected) ? selected : [];
  const flowSkills = new Set(flowDraft.skills ?? []);
  const chips = installed.map((item) => {
    const on = picked.includes(item.name);
    const shared = flowSkills.has(item.name);
    const title = [item.summary || item.name, shared ? "流程级已挂，这一步自动带上" : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="flow-skill-chip${on ? " active" : ""}${shared ? " shared" : ""}" data-act="toggleSkill" data-skill="${esc(item.name)}" title="${esc(title)}">${esc(item.title || item.name)}${shared && !on ? " ·全局" : ""}</button>`;
  }).join("");
  return `
    <div class="flow-step-skills">
      <div class="flow-skills-head">
        <span>这一步用什么工作方法</span>
        <em>${picked.length ? `已选 ${picked.length} 个` : "不选就只靠提示词"}</em>
      </div>
      ${installed.length
        ? `<div class="flow-skill-chips">${chips}</div>`
        : `<p class="flow-skill-empty">本机还没装技能，先去「工作方法 → 工作方法库」拉一个</p>`}
      <p class="flow-skill-hint">勾上的技能会把完整步骤说明塞进这一步的提示词，让它按这套方法做。</p>
    </div>`;
}

/** 检查器里改的字段直接写回 draft；节点上同步刷名字，不用整块重画。 */
function syncInspectorToDraft() {
  if (selectedStepIndex < 0) return;
  const step = flowDraft.steps[selectedStepIndex];
  const panel = $("#flowInspector");
  const nameInput = panel?.querySelector(".flow-step-name");
  if (!step || !panel || !nameInput) return;
  const node = $(`#flowCanvas .flow-node-card[data-index="${selectedStepIndex}"]`);
  const isCondition = step.kind === "condition";
  // 这一步勾的工作方法：两种节点都要收，收完统一去重（后端还会再收敛一次）
  const pickedSkills = [...panel.querySelectorAll(".flow-skill-chip.active")]
    .map((chip) => chip.dataset.skill)
    .filter(Boolean)
    .slice(0, 8);
  if (pickedSkills.length) step.skills = pickedSkills;
  else delete step.skills;
  if (isCondition) {
    step.name = nameInput.value.trim() || step.name;
    step.agentId = panel.querySelector(".flow-step-agent").value;
    step.question = panel.querySelector(".flow-step-question").value;
    // 选项文案：改名要同步到从该节点出去的连线，不然线会指到一个已不存在的选项上
    const optionInputs = [...panel.querySelectorAll(".flow-cond-option")];
    if (optionInputs.length) {
      const previous = Array.isArray(step.options) ? [...step.options] : [];
      const next = optionInputs.map((input) => input.value.trim().slice(0, 20));
      for (let optIndex = 0; optIndex < next.length; optIndex += 1) {
        const old = previous[optIndex];
        if (old && next[optIndex] && old !== next[optIndex]) {
          for (const edge of flowDraft.edges) {
            if (edge.from === step.key && edge.branch === old) edge.branch = next[optIndex];
          }
        }
      }
      step.options = next;
    }
    const keyInput = panel.querySelector(".flow-step-key");
    if (keyInput) step.key = keyInput.value.trim();
    if (node) {
      node.querySelector(".flow-node-name").textContent = step.name || "条件判断";
      node.querySelector(".flow-node-agent").textContent = `${agentNameOf(step.agentId)} 来判断`;
      const question = node.querySelector(".flow-node-q");
      if (question) {
        question.textContent = step.question || "还没写判断问题";
        question.title = step.question || "";
      }
    }
    return;
  }
  const agent = panel.querySelector(".flow-step-agent").value;
  step.name = nameInput.value.trim() || step.name;
  step.agentMode = agent === "__auto" ? "auto" : "fixed";
  step.agentId = agent === "__auto" ? "" : agent;
  step.promptTemplate = panel.querySelector(".flow-step-prompt").value;
  step.outputType = panel.querySelector(".flow-step-output").value;
  step.outputFiles = panel.querySelector(".flow-step-files").value;
  step.tools = panel.querySelector(".flow-step-tools").value;
  step.checkpoint = {
    enabled: panel.querySelector(".flow-step-cp").checked,
    agentId: panel.querySelector(".flow-step-cp-agent").value,
    criteria: panel.querySelector(".flow-step-cp-criteria").value.trim(),
  };
  const keyInput = panel.querySelector(".flow-step-key");
  if (keyInput) step.key = keyInput.value.trim();
  // 名字等展示字段刷到节点上
  if (node) {
    node.querySelector(".flow-node-name").textContent = step.name || "未命名";
    node.querySelector(".flow-node-agent").textContent = step.agentMode === "auto" ? "自动路由" : agentNameOf(step.agentId);
    node.classList.toggle("has-check", step.checkpoint.enabled);
    const meta = node.querySelector(".flow-node-meta");
    const cpBadge = meta.querySelector(".flow-node-cp");
    if (step.checkpoint.enabled && !cpBadge) meta.insertAdjacentHTML("beforeend", `<u class="flow-node-cp" title="做完会停下来等确认">检查点</u>`);
    if (!step.checkpoint.enabled && cpBadge) cpBadge.remove();
  }
}

function readFlowStepsFromDom() {
  syncInspectorToDraft();
  const usedKeys = new Set();
  const keyMap = new Map();
  flowDraft.steps.forEach((step, index) => {
    // 引用名留空也能用：自动补一个不重复的，占位符按钮就有东西可插。
    let key = String(step.key ?? "").trim();
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(key) || usedKeys.has(key)) {
      let n = index + 1;
      while (usedKeys.has(`step${n}`)) n += 1;
      key = `step${n}`;
    }
    usedKeys.add(key);
    if (key !== step.key) keyMap.set(step.key, key);
    step.key = key;
  });
  // 引用名变了，连线跟着重映射，不然线会指到不存在的节点上
  if (keyMap.size) {
    flowDraft.edges = (flowDraft.edges ?? []).map((edge) => ({
      ...edge,
      from: keyMap.get(edge.from) ?? edge.from,
      to: keyMap.get(edge.to) ?? edge.to,
    }));
  }
}

function deleteFlowStep(index) {
  readFlowStepsFromDom();
  if (flowDraft.steps.length <= 2) { $("#flowNote").textContent = "流程至少保留 2 个节点"; return; }
  const removed = flowDraft.steps.splice(index, 1)[0];
  // 节点没了，连进连出的线一起拆掉
  flowDraft.edges = (flowDraft.edges ?? []).filter((edge) => edge.from !== removed.key && edge.to !== removed.key);
  if (selectedEdgeIndex >= flowDraft.edges.length) selectedEdgeIndex = -1;
  if (selectedStepIndex >= flowDraft.steps.length) selectedStepIndex = flowDraft.steps.length - 1;
  renderFlowSteps();
}

/** 按住节点拖摆放位置：pointer 拖动，只更新自身坐标 + 重画连线。端口上按下是拉线，不挪节点。 */
function makeNodeDraggable(card) {
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, select, textarea, .flow-port")) return;
    event.preventDefault();
    const index = Number(card.dataset.index);
    const step = flowDraft.steps[index];
    if (!step) return;
    const origin = nodePos(step, index);
    const startX = event.clientX;
    const startY = event.clientY;
    card.setPointerCapture(event.pointerId);
    card.classList.add("dragging");
    const onMove = (moveEvent) => {
      const next = {
        x: Math.max(8, origin.x + moveEvent.clientX - startX),
        y: Math.max(8, origin.y + moveEvent.clientY - startY),
      };
      step.ui = next;
      card.style.left = `${next.x}px`;
      card.style.top = `${next.y}px`;
      fitFlowCanvas();
      drawFlowEdges();
    };
    const onUp = () => {
      card.classList.remove("dragging");
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  });
}

function renderFlowVars() {
  const box = $("#flowVars");
  if (!box) return;
  if (!flowDraft.variables.length) {
    box.innerHTML = `<p class="flow-var-empty">不需要额外填东西时，每次运行只要写一句「这次要做什么」</p>`;
    return;
  }
  const head = document.createElement("div");
  head.className = "flow-var-head";
  head.innerHTML = "<span>要填什么</span><span>提示一句（可空）</span><span>默认值</span><span></span><span></span>";
  box.replaceChildren(head, ...flowDraft.variables.map((variable, index) => {
    const row = document.createElement("div");
    row.className = "flow-var";
    row.dataset.index = String(index);
    row.dataset.name = variable.name ?? "";
    row.innerHTML = `
      <input class="flow-var-label" maxlength="20" value="${esc(variable.label || variable.description || variable.name || "")}" placeholder="要填什么（例：项目名称）" autocomplete="off">
      <input class="flow-var-desc" maxlength="60" value="${esc(variable.description || "")}" placeholder="提示一句（可空）" autocomplete="off">
      <input class="flow-var-default" value="${esc(variable.defaultValue || "")}" placeholder="默认值" autocomplete="off">
      <label class="flow-var-required"><input type="checkbox"${variable.required ? " checked" : ""}><span>必填</span></label>
      <button type="button" data-act="del" title="删除这一项">✕</button>`;
    return row;
  }));
}

function readFlowVarsFromDom() {
  const rows = $$("#flowVars .flow-var");
  flowDraft.variables = rows.map((row, index) => ({
    // name 是内部标识（占位符用），界面只让用户填看得懂的 label。
    name: row.dataset.name || `var${index + 1}`,
    label: row.querySelector(".flow-var-label").value.trim().slice(0, 20),
    description: row.querySelector(".flow-var-desc").value.trim(),
    defaultValue: row.querySelector(".flow-var-default").value.trim(),
    required: row.querySelector(".flow-var-required input").checked,
  }));
}

async function saveFlow() {
  readFlowStepsFromDom();
  readFlowVarsFromDom();
  const note = $("#flowNote");
  const button = $("#flowSave");
  note.textContent = "";
  button.disabled = true;
  const payload = {
    name: $("#flowName").value.trim(),
    description: $("#flowDescription").value.trim(),
    steps: flowDraft.steps,
    edges: flowDraft.edges,
    variables: flowDraft.variables,
    skills: flowDraft.skills ?? [],
  };
  try {
    const data = editingFlowId
      ? await api(`/api/flows/${editingFlowId}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/flows", { method: "POST", body: JSON.stringify(payload) });
    state.flows = data.items ?? state.flows;
    editingFlowId = null;
    closeFlowEditor();
    toast("流程已保存");
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deleteFlowFromDialog() {
  if (!editingFlowId) return;
  const button = $("#flowDelete");
  if (!flowDeleteArmed) {
    flowDeleteArmed = true;
    button.textContent = "再点一次确认删除";
    button.classList.add("armed");
    clearTimeout(flowDeleteTimer);
    flowDeleteTimer = setTimeout(() => {
      flowDeleteArmed = false;
      button.textContent = "删除流程";
      button.classList.remove("armed");
    }, 5000);
    return;
  }
  clearTimeout(flowDeleteTimer);
  try {
    const data = await api(`/api/flows/${editingFlowId}`, { method: "DELETE" });
    state.flows = data.items ?? [];
    editingFlowId = null;
    closeFlowEditor();
    toast("流程已删除");
  } catch (error) {
    $("#flowNote").textContent = error.message;
  }
}

/* ------------------------------------------------------------ run detail */
async function openRunDetail(runId) {
  // 换了一条运行就一定要重画：两条运行的签名完全可能一样，
  // 光看签名会把上一次的步骤留在面板里，张冠李戴。
  const switched = runDetailId !== runId;
  if (switched) runDetailSig = "";
  runDetailId = runId;
  try {
    const run = await api(`/api/flows/runs/${runId}`);
    // 详情长在流程页里，不再弹窗：切到这个视图就能看到
    if (state.view !== "worksite" || state.worksiteTab !== "flows") gotoWorksiteTab("flows");
    state.runTabId = runId;
    $("#runPanelEmpty") && ($("#runPanelEmpty").hidden = true);
    const inner = $("#runPanelInner");
    if (inner) inner.hidden = false;

    // 只有状态真的变了才重绘，否则会把你正在展开看的产出收起来。
    // 但「显示面板」这件事不能跟着被跳过——否则点标签会得到一个空面板。
    const sig = runSignature(run);
    if (switched || runDetailSig !== sig) {
      runDetailSig = sig;
      renderRunDetail(run);
      // 真正渲染出内容之后再打标：提前打标会让并发进来的那次以为已经填好
      if (inner) inner.dataset.filled = runId;
      // 标签栏上的状态跟着走，但不要在这里重排整页
      renderRunTabs(state.flowRuns ?? []);
    }
    // 打开详情即接入事件流：状态变化靠推送，轮询退化为断流兜底
    openRunStream(runId);
    // 注意：这里不要 scrollIntoView。单页执行台里详情就在下方，
    // 每次轮询重绘都把整页滚到底部，等于把启动台和滑轨挤出视野。
  } catch (error) {
    toast(error.message);
  }
}

/**
 * 重绘签名。状态是第一位的，但「跑完的步骤多了产物」也必须算变化——
 * 否则产物缩略图要等下一次状态跳变才冒出来。
 */
function runSignature(run) {
  const steps = (run.stepStates ?? [])
    .map((step) => `${step.status}:${(step.files ?? []).length}`)
    .join(",");
  return `${run.status}|${steps}`;
}

/* -------------------------------------------------------------------------
   流程运行事件流（SSE）
   只推步骤状态与产物清单，不推正文增量。断线从 Last-Event-ID 续传；
   服务端窗口过期会给 reset，届时重新拉一次完整快照即可。
   ------------------------------------------------------------------------- */
let runStream = null; // { runId, ctrl, lastSeq, retry }

function closeRunStream() {
  runStream?.ctrl.abort();
  clearTimeout(runStream?.retry);
  runStream = null;
}

function openRunStream(runId) {
  if (runStream?.runId === runId) return; // 同一个运行已经在订阅，不重复开连接
  closeRunStream();
  const ctrl = new AbortController();
  runStream = { runId, ctrl, lastSeq: 0, retry: null };
  pumpRun(runId, ctrl);
}

/** 步骤跑完了没必要继续占着连接，关掉等下次打开再续。 */
function maybeCloseRunStream(run) {
  if (!runStream) return;
  if (!["running", "waiting", "paused"].includes(run.status)) closeRunStream();
}

async function pumpRun(runId, ctrl) {
  const current = runStream;
  if (!current || current.runId !== runId) return;
  try {
    const response = await fetch(`/api/flows/runs/${runId}/events`, {
      headers: {
        authorization: `Bearer ${state.token}`,
        "last-event-id": String(current.lastSeq ?? 0),
      },
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error(`流程事件流 ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const { events, tail } = parseSse(buffer);
      buffer = tail;
      for (const event of events) handleRunEvent(runId, event);
    }
    // 服务端主动断开（运行结束或超时）：短暂等待后按 cursor 续上
    if (!ctrl.signal.aborted && runStream?.runId === runId) {
      runStream.retry = setTimeout(() => {
        if (runStream?.runId === runId) pumpRun(runId, ctrl);
      }, 800);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (runStream?.runId === runId) {
      runStream.retry = setTimeout(() => {
        if (runStream?.runId === runId) pumpRun(runId, ctrl);
      }, 2000);
    }
  }
}

function handleRunEvent(runId, event) {
  if (!runStream || runStream.runId !== runId) return;
  if (event.id != null && event.id > (runStream.lastSeq ?? 0)) runStream.lastSeq = event.id;

  if (event.name === "reset") {
    // 窗口滚掉了：丢掉增量，重新拉一次完整快照
    openRunDetail(runId).catch(() => {});
    return;
  }
  if (event.name === "message" || !event.data) return;

  // 事件只说明「该重画了」，具体内容仍取快照：避免事件体与快照两头对不齐。
  // 但快照请求要合并，并行步骤可能同一瞬间来好几条事件。
  scheduleRunDetailRefresh(runId);
}

let runDetailRefreshTimer = null;

/**
 * 合并短时间内的多次刷新请求。并行流程一步开跑会连出好几条事件，
 * 每条都拉一次快照既浪费也会让弹窗闪。
 */
function scheduleRunDetailRefresh(runId) {
  if (runDetailRefreshTimer) return;
  runDetailRefreshTimer = setTimeout(() => {
    runDetailRefreshTimer = null;
    if (!runDetailId || runDetailId !== runId) return;
    // 面板在页面里，不用判断弹窗是否打开；离开「流程编排」页签才停
    if (state.view !== "worksite" || state.worksiteTab !== "flows") return;
    api(`/api/flows/runs/${runId}`)
      .then((run) => {
        const sig = runSignature(run);
        if (runDetailSig !== sig) {
          runDetailSig = sig;
          renderRunDetail(run);
        }
        maybeCloseRunStream(run);
      })
      .catch(() => {});
    // 列表里的状态徽标也要跟着变，但不必每次都全量拉
    loadFlows({ quiet: true });
  }, 80);
}

let currentRun = null; // 最近一次渲染的运行，计时器按它走字
let runTicker = null;

/**
 * 标题下的一句话：状态 · 第几步/共几步 · 已运行多久。
 * 这是「看到在执行」的全部信息量，不展开任何折叠也能读到。
 */
function renderRunSub(run, status, done, total) {
  const box = $("#runSub");
  if (!box) return;
  const active = ["running", "waiting", "paused"].includes(run.status);
  const elapsed = active ? liveDuration(run.startedAt) : elapsedBetween(run.startedAt, run.finishedAt);
  const activeNames = activeStepNames(run);
  // 并行时可能同时在跑好几个：多于一个就明说「并行 N 项」，不做假精确
  const nowText = active && activeNames.length
    ? ` · 正在做：${activeNames.join(" / ")}${activeNames.length > 1 ? `（并行 ${activeNames.length} 项）` : ""}`
    : "";
  box.innerHTML = `<span class="run-status ${status.cls}">${status.label}</span> · 第 ${done}/${total} 步${nowText} · 已运行 <b data-run-elapsed>${esc(elapsed || "刚刚开始")}</b> · v${run.flowVersion} · ${relTime(run.createdAt)}发起`;
}

/**
 * 正在执行的步骤名。
 * 优先用后端的 activeStepKeys（并行时是权威值，能同时列出多个），
 * 老数据没有这个字段时退回按 step.status 判断。
 */
function activeStepNames(run) {
  const steps = run.stepStates ?? [];
  const keys = Array.isArray(run.activeStepKeys) ? run.activeStepKeys : [];
  if (keys.length) {
    return keys
      .map((key) => steps.find((step) => step.key === key))
      .filter(Boolean)
      .map((step) => step.name);
  }
  return steps.filter((step) => ["running", "checking"].includes(step.status)).map((step) => step.name);
}

const secondsBetween = (from, to) => {
  if (!from) return null;
  const end = to ? new Date(to).getTime() : Date.now();
  const ms = end - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
};

/** 秒级耗时的口语化写法。任务侧 duration() 用的是 12s / 3m05s，这里读起来更像人话。 */
function liveDuration(startedAt) {
  const seconds = secondsBetween(startedAt);
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(Math.floor(seconds % 60)).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/** 已结束的运行：给出固定的总耗时。 */
function elapsedBetween(startedAt, finishedAt) {
  const seconds = secondsBetween(startedAt, finishedAt);
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(Math.floor(seconds % 60)).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/**
 * 运行中每秒刷新一次耗时文字。只改一个 <b> 的文本，不重绘步骤、不发请求，
 * 所以不会打断用户正在展开看的东西。
 */
function ensureRunTicker(run) {
  const active = ["running", "waiting", "paused"].includes(run.status);
  if (!active) {
    clearInterval(runTicker);
    runTicker = null;
    return;
  }
  if (runTicker) return;
  runTicker = setInterval(() => {
    const node = $("[data-run-elapsed]");
    if (!node || !currentRun || !["running", "waiting", "paused"].includes(currentRun.status)) {
      clearInterval(runTicker);
      runTicker = null;
      return;
    }
    node.textContent = liveDuration(currentRun.startedAt) || "刚刚开始";
  }, 1000);
}

/**
 * 这一步能不能单步重跑。
 * 和后端保持同一套规则：流程停下就能重跑（含已成功结束的——「跑完了但某一步不满意」最常见），
 * 只有运行中不给，因为那时 #advance 还在跑，复位会和它抢同一份步骤状态。
 */
function canRetryStep(run, step) {
  if (["running", "checking"].includes(run.status)) return false;
  return ["failed", "success", "skipped", "cancelled", "waiting"].includes(step.status);
}

function renderRunDetail(run) {
  const status = RUN_STATUS[run.status] ?? RUN_STATUS.running;
  // 终态的运行里不该还有「在跑」的步骤。老版本取消时漏收口会在磁盘上留下这种数据，
  // 显示层按运行结局兜一层：否则面板永远是「执行中 + 正在生成结果」，看着像没停下来。
  const runEnded = ["success", "failed", "cancelled"].includes(run.status);
  const steps = (run.stepStates ?? []).map((step) => {
    if (!runEnded) return step;
    // 取消连带判成的失败也归零：不是步骤出错，是人叫停的
    if (run.status === "cancelled" && step.status === "failed" && /取消/.test(step.error ?? "")) {
      return { ...step, status: "cancelled", error: null };
    }
    if (!["pending", "waiting", "running", "checking"].includes(step.status)) return step;
    return {
      ...step,
      status: "cancelled",
      progress: null,
      check: step.check?.status === "running" ? { ...step.check, status: "cancelled" } : step.check,
    };
  });
  const total = steps.length;
  // 跳过的步骤也算「有了结果」，不算没跑完，进度才不会卡在 2/3
  const done = steps.filter((step) => ["success", "skipped"].includes(step.status)).length;
  currentRun = run;
  // 折叠状态下大窗只剩这条纪要，任何一次推送都要把它刷新
  renderRunBoardHead(run);
  renderRunSub(run, status, done, total);
  // 运行中的耗时要自己走字，不能等下一次推送才跳动
  ensureRunTicker(run);

  // 重绘不该把用户正展开看的步骤收起来，先记住哪些是开着的
  const openedBefore = new Set($$("#runSteps .run-step[open]").map((item) => Number(item.dataset.index)));
  // 同时在跑的步骤：只有两个以上才叫并行，单独一个不算
  const activeKeys = Array.isArray(run.activeStepKeys) && run.activeStepKeys.length
    ? run.activeStepKeys
    : steps.filter((step) => ["running", "checking"].includes(step.status)).map((step) => step.key);
  const parallelKeys = new Set(activeKeys.length > 1 ? activeKeys : []);
  $("#runSteps").replaceChildren(...steps.map((step, index) => {
    const definition = run.stepsSnapshot?.[index] ?? {};
    const state = STEP_STATUS[step.status] ?? STEP_STATUS.pending;
    const files = (step.files ?? []).filter((file) => file.source !== "missing");
    const checkBadge = renderCheckBadge(step.check);
    const isCondition = definition.kind === "condition";
    // 新运行 branchResult 直接存选项文案；老运行存 pass/fail，展示时翻译回文案
    const condOptions = Array.isArray(definition.options) && definition.options.length >= 2 ? definition.options : null;
    const branchLabel = isCondition && step.branchResult
      ? (condOptions ? String(step.branchResult) : step.branchResult === "pass" ? "满足" : "不满足")
      : "";
    const branchCls = branchLabel ? conditionOptionClass(branchLabel) : "";
    const branchBadge = branchLabel ? `<span class="run-step-branch ${branchCls}">◇ 走「${esc(branchLabel)}」线</span>` : "";
    const instruction = isCondition ? (definition.question ?? "") : (definition.promptTemplate ?? "");
    const item = document.createElement("details");
    item.className = `run-step ${state.cls}`;
    item.dataset.index = String(index);
    // 默认全部收起：一屏能同时看全所有步骤的状态，想看哪一步再点开。
    // 只有「等在这儿」的步骤自动展开（等人确认 / 失败 / 检查没过）——
    // 那种情况内容本身就是待处理事项，藏起来等于让人多点一次才看见问题。
    const needsAttention = ["waiting", "failed"].includes(step.status) || step.check?.status === "failed";
    item.open = needsAttention || openedBefore.has(index);
    // 收起时留一行「结论第一句」：不展开也能判断值不值得点开。
    // 顺手把 markdown 记号洗掉，否则预览里全是 ## 和 ** 这种噪音
    const peek = step.output
      ? String(step.output)
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*`_~]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
      : "";
    const imageCount = files.filter((file) => file.kind === "image").length;
    // 并行标记：这一步和别的步骤同时在跑时，标题上要能看出来
    const parallel = parallelKeys.has(step.key) ? '<span class="run-step-parallel" title="与其它步骤并行执行">⇉ 并行</span>' : "";
    // 单步重跑：流程停住时，每一步自己带一个入口。
    // 下游成功产出不动，用旧产出继续——这是「只想把这一步做好」的场景，和整体重试分工不同。
    const canRetryThis = canRetryStep(run, step);
    const attemptBadge = (step.attempt ?? 1) > 1 ? `<span class="run-step-attempt" title="已重做">第 ${step.attempt} 次</span>` : "";
    item.innerHTML = `
      <summary>
        <div class="run-step-line">
          <b class="run-step-no">${index + 1}</b>
          <span class="run-step-name">${esc(step.name)}${isCondition ? " <i class=\"run-cond-mark\">◇判断</i>" : ""}</span>
          ${parallel}
          <span class="run-step-agent">${esc(step.agentId ? agentNameOf(step.agentId) : definition.agentMode === "auto" ? "自动路由" : "—")}</span>
          ${branchBadge}
          ${checkBadge}
          ${imageCount ? `<span class="run-step-files art">${imageCount} 图</span>` : ""}
          ${files.length - imageCount ? `<span class="run-step-files">${files.length - imageCount} 文件</span>` : ""}
          ${step.status === "running" || step.status === "checking" ? `<span class="run-step-live"><i></i>${esc(step.progress || state.label)}</span>` : ""}
          ${attemptBadge}
          <span class="run-step-state ${state.cls}">${state.label}</span>
          <span class="run-step-caret" aria-hidden="true">⌄</span>
        </div>
        ${peek ? `<p class="run-step-peek">${esc(peek)}</p>` : ""}
      </summary>
      <div class="run-step-body">
        ${step.error ? `<p class="run-step-error">${esc(step.error)}</p>` : ""}
        ${step.status === "skipped" ? `<p class="run-step-warn">连进来的分支没有被条件选中（或上游被跳过），这一步整体跳过，没有消耗任务。</p>` : ""}
        ${renderCheckBlock(step.check)}
        ${step.output ? `<div class="run-step-section run-step-result"><p class="run-step-label">这一步的结论${step.artifactCount ? ` · 任务侧 ${step.artifactCount} 个文件` : ""}</p><div class="run-step-conclusion"></div></div>` : ""}
        ${files.length ? '<div class="run-step-section run-step-produce"><p class="run-step-label">这一步的产出 · 待渲染</p></div>' : ""}
        <div class="run-step-section run-step-howto">
          <p class="run-step-label">${isCondition ? "判断问题" : "这一步的指令"}</p>
          <pre class="run-step-pre">${esc(instruction)}</pre>
          ${(step.artifactWarnings ?? []).length ? `<p class="run-step-warn">${esc(step.artifactWarnings.join("；"))}</p>` : ""}
          <div class="run-step-acts">
            ${step.taskId ? `<button type="button" class="text-btn run-open-task" data-task="${esc(step.taskId)}">查看这步的任务详情</button>` : ""}
            ${canRetryThis ? `<button type="button" class="text-btn run-retry-step" data-step="${esc(step.key)}" data-name="${esc(step.name)}">${step.status === "success" ? "重跑这一步（下游仍用旧产出）" : "只重跑这一步"}</button>` : ""}
          </div>
        </div>
      </div>`;
    // 结论与产物是活的：挂真实 DOM，避免被 innerHTML 转义掉结构
    const body = item.querySelector(".run-step-body");
    const resultBox = body.querySelector(".run-step-result");
    if (resultBox && step.output) hydrateRunConclusion(resultBox.querySelector(".run-step-conclusion"), String(step.output));
    const produceBox = body.querySelector(".run-step-produce");
    if (produceBox) {
      const label = produceBox.querySelector(".run-step-label");
      label.textContent = `这一步的产出 · ${files.length} 个`;
      produceBox.append(renderStepArtifacts(run, step, files));
    }
    // 展开状态不另存状态：重绘前会先读一遍 DOM 里哪些 <details> 是 open 的（openedBefore）
    return item;
  }));

  const dirLine = $("#runDirLine");
  if (dirLine) {
    dirLine.hidden = !run.runDir;
    if (run.runDir) {
      const label = dirLine.querySelector("span");
      const isolated = run.workspace?.mode === "isolated";
      const base = run.workspace?.path;
      // 副本模式下两条路径前缀完全一样，只显示副本内的相对部分，否则看起来像重复了一遍
      const shown = isolated && base && run.runDir.startsWith(base)
        ? run.runDir.slice(base.length).replace(/^[\\/]+/, "")
        : run.runDir;
      if (label) label.textContent = isolated ? "工件归档（在副本里）" : "运行目录";
      $("#runDirPath").textContent = shown;
      $("#runDirPath").title = run.runDir;
    }
  }

  renderRunWorkspace(run);

  const note = $("#runNote");
  // 同一句话，语气不一样：出错是红，等确认是黄，正常说明是灰
  // 取消不是失败：老数据把「流程已取消」写进了 error，面板不该一直红着
  const runError = run.status === "cancelled" ? "" : run.error;
  note.textContent = runError || run.note || "";
  note.className = `agent-note${runError || run.status === "failed" ? "" : run.status === "waiting" || run.status === "paused" ? " warn" : " info"}`;
  const canContinue = run.status === "waiting";
  const canRetry = run.status === "paused";
  const canCancel = ["running", "checking", "waiting", "paused"].includes(run.status);
  const gate = steps.find((step) => step.status === "waiting");
  // 等确认时同时给出「通过」和「打回」，别让人只能硬着头皮往下走。
  $("#runContinueBtn").hidden = !canContinue;
  $("#runContinueBtn").textContent = gate?.check ? "确认通过，继续下一步" : "确认并继续";
  $("#runRejectBtn").hidden = !canContinue;
  $("#runRejectBtn").textContent = "打回重做";
  $("#runRejectBtn").classList.remove("armed");
  runRejectArmed = false;
  clearTimeout(runRejectTimer);
  $("#runRetryBtn").hidden = !canRetry;
  $("#runIgnoreBtn").hidden = !canRetry;
  $("#runCancelBtn").hidden = !canCancel;
}

/** 折叠状态下也要能看见这一步的结论，不然检查点等于白设。 */
function renderCheckBadge(check) {
  if (!check || check.status === "manual") return "";
  if (check.status === "running") return `<span class="run-step-check run">检查中</span>`;
  if (check.status === "failed") return `<span class="run-step-check bad">检查没跑成</span>`;
  if (!check.verdict) return "";
  const verdict = CHECK_VERDICT[check.verdict];
  if (!verdict) return "";
  return `<span class="run-step-check ${verdict.cls}">${verdict.label}</span>`;
}

/** 检查点结论：谁查的、什么结论、要改哪几条，一眼看完。 */
function renderCheckBlock(check) {
  if (!check) return "";
  const verdict = CHECK_VERDICT[check.verdict] ?? null;
  const who = check.agentId ? `${esc(check.agentName || agentNameOf(check.agentId))} 检查` : "人工确认";
  const statusText = check.status === "running" ? "检查中…" : check.status === "failed" ? "检查没跑成" : who;
  const issues = Array.isArray(check.issues) ? check.issues : [];
  return `
    <div class="run-check${verdict ? ` ${verdict.cls}` : ""}">
      <div class="run-check-head">
        <b>检查点</b>
        <span class="run-check-who">${esc(statusText)}</span>
        ${verdict ? `<span class="run-check-verdict ${verdict.cls}">${verdict.label}</span>` : ""}
      </div>
      ${check.summary ? `<p class="run-check-summary">${esc(check.summary)}</p>` : ""}
      ${issues.length ? `<ol class="run-check-issues">${issues.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>` : ""}
      ${check.status === "failed" ? `<p class="run-check-hint">检查本身没跑通，但这一步的产出还在，你可以自己看过之后决定放行或打回。</p>` : ""}
      ${check.output ? `<details class="run-check-raw"><summary>看检查原文</summary><pre>${esc(check.output)}</pre></details>` : ""}
    </div>`;
}

/** 副本路径、改动摘要、回写/清理按钮：都只在副本模式下有意义。 */
function renderRunWorkspace(run) {
  const workspace = run.workspace;
  const isolated = workspace?.mode === "isolated";
  const alive = isolated && !workspace.cleanedAt;

  const line = $("#runWsLine");
  if (line) {
    line.hidden = !alive;
    if (alive) {
      $("#runWsPath").textContent = workspace.path;
      $("#runWsPath").title = `源目录：${workspace.source}`;
    }
  }

  const box = $("#runChanges");
  const pending = (run.changes?.files ?? []).filter((file) => file.status === "added" || file.status === "modified");
  const applied = run.appliedFiles ?? [];
  if (box) {
    if (!isolated) {
      box.hidden = true;
    } else if (pending.length) {
      const names = pending.slice(0, 3).map((file) => `${file.status === "added" ? "+" : "~"} ${file.path}`).join("　");
      box.hidden = false;
      box.innerHTML = `<b>${pending.length} 个文件待回写</b>（新增 ${run.changes.added} · 修改 ${run.changes.modified}）<span class="run-changes-list mono">${esc(names)}${pending.length > 3 ? " …" : ""}</span>`;
    } else if (workspace.cleanedAt) {
      const appliedText = applied.length ? `已回写 ${applied.length} 个文件 · ` : "";
      box.hidden = false;
      box.innerHTML = `<b>${appliedText}副本已清理</b><span class="run-changes-list">改动摘要仍保留在运行记录里</span>`;
    } else if (applied.length) {
      box.hidden = false;
      box.innerHTML = `<b>已回写 ${applied.length} 个文件到原目录</b><span class="run-changes-list">原文件备份在工件目录 backup/ 下</span>`;
    } else if (workspace.cleanedAt) {
      box.hidden = false;
      box.innerHTML = `<b>副本已清理</b><span class="run-changes-list">改动摘要仍保留在运行记录里</span>`;
    } else {
      box.hidden = true;
    }
  }

  const settled = ["success", "paused"].includes(run.status);
  armRunApply(false);
  armRunDrop(false);
  $("#runApplyBtn").hidden = !(alive && settled && pending.length > 0);
  $("#runDropBtn").hidden = !(alive && !["running", "waiting"].includes(run.status));
}

/* --------------------------------------------------------- 步骤结论渲染
   结论是一段人话，不是一块等宽文本。按 Markdown 的常见结构拆成
   标题 / 段落 / 列表 / 引用 / 代码，读起来像文档，不像终端输出。 */

const CONCLUSION_LIMIT = 3200;

/** 极简 Markdown → DOM。只认最常用的几种结构，不引第三方库。 */
function renderRichText(markdown) {
  const box = document.createElement("div");
  box.className = "run-conclusion";
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let list = null;

  const flushList = () => { if (list) { box.append(list); list = null; } };

  while (index < lines.length) {
    const line = lines[index];
    // 代码块整段吃进去，内部不再解析
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushList();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const pre = document.createElement("pre");
      pre.className = "run-conclusion-code";
      pre.textContent = body.join("\n");
      box.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(4, heading[1].length + 2);
      const h = document.createElement(`h${level}`);
      h.className = "run-conclusion-head";
      h.textContent = heading[2].trim();
      box.append(h);
      index += 1;
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (!list) list = document.createElement("ul");
      const li = document.createElement("li");
      li.textContent = bullet[1].trim();
      list.append(li);
      index += 1;
      continue;
    }
    flushList();
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const p = document.createElement("p");
      p.className = "run-conclusion-quote";
      p.textContent = quote[1];
      box.append(p);
      index += 1;
      continue;
    }
    if (line.trim()) {
      const p = document.createElement("p");
      p.textContent = line.trim();
      box.append(p);
    }
    index += 1;
  }
  flushList();
  return box;
}

/** 结论区：默认给可读的前半段，超长时给「展开全文」，不静默截断。 */
function hydrateRunConclusion(box, text) {
  const long = text.length > CONCLUSION_LIMIT;
  box.append(renderRichText(long ? text.slice(0, CONCLUSION_LIMIT) : text));
  if (!long) return;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "text-btn run-conclusion-more";
  more.textContent = `展开完整结论（共 ${text.length.toLocaleString("zh-CN")} 字）`;
  more.addEventListener("click", () => {
    box.replaceChildren(renderRichText(text));
  });
  box.append(more);
}

/** 点文件名就地展开预览，再点一次收起；路径校验在服务端做。 */
async function toggleRunFile(button) {
  const body = button.closest(".run-step-body");
  const pre = body?.querySelector(".run-file-pre");
  if (!pre) return;
  const path = button.dataset.path;
  if (pre.dataset.for === path && !pre.hidden) {
    pre.hidden = true;
    return;
  }
  pre.hidden = false;
  pre.dataset.for = path;
  pre.textContent = "读取中…";
  try {
    const file = await api(`/api/flows/runs/${encodeURIComponent(button.dataset.run)}/files?path=${encodeURIComponent(path)}`);
    pre.textContent = file.truncated ? `文件 ${file.size} 字节，超过预览上限（512KB），请到运行目录里查看` : file.content;
  } catch (error) {
    pre.textContent = `读取失败：${error.message}`;
  }
}

/* --------------------------------------------------------- 步骤产物渲染
   产物是结论的实体：图片直接显示、文字直接读、表格给可读视图。
   判定一律用后端给的 kind，前端不再按扩展名二次猜测。 */

const FILE_KIND_LABEL = { image: "图片", markdown: "文档", text: "文本", table: "表格", binary: "文件" };
// 一步里图太多就别铺满屏：先显示前 4 张，其余收进「还有 N 张」。
const INLINE_IMAGE_LIMIT = 4;
const INLINE_TEXT_LIMIT = 2400;

const runFileUrl = (runId, path, raw = false) =>
  `/api/flows/runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(path)}${raw ? "&raw=1" : ""}`;

// 步骤产物里的图片 objectURL 缓存：重绘一次不该再下一次同样的图。
const runImageCache = new Map();

const humanBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

/** 图片：直接内联成图，点击放大。走带鉴权的 blob 取件，<img src> 带不上 Bearer。 */
function renderRunImage(run, file, index) {
  const shown = file.source === "tool" ? file.path : (file.path.split("/").slice(1).join("/") || file.path);
  const figure = document.createElement("figure");
  figure.className = "run-image";
  figure.innerHTML = `
    <img alt="${esc(shown)}" title="点击放大">
    <figcaption><span class="mono">${esc(shown)}</span><span>${esc(humanBytes(file.bytes))}</span></figcaption>`;
  const img = figure.querySelector("img");
  figure.dataset.index = String(index);
  loadRunImage(run, file, img).then((url) => {
    if (!url) return;
    img.addEventListener("click", () => openRunImage(url, shown));
    img.classList.add("ready");
  }).catch((error) => {
    figure.classList.add("bad");
    figure.innerHTML = `<span class="run-image-note">这张图读不出来：${esc(error.message)}<b class="mono">${esc(shown)}</b></span>`;
  });
  return figure;
}

/** 取回图片原始字节并转成 objectURL；同一张图在弹窗里复用时不再重复下载。 */
async function loadRunImage(run, file, img) {
  const cacheKey = `${run.id}:${file.path}`;
  const cached = runImageCache.get(cacheKey);
  if (cached) {
    img.src = cached;
    return cached;
  }
  const blob = await fetchArtifactBlob(runFileUrl(run.id, file.path, true));
  const url = URL.createObjectURL(blob);
  runImageCache.set(cacheKey, url);
  img.src = url;
  return url;
}

/** 图片放大：不进新页面，也不和产物列表抢 DOM。 */
function openRunImage(url, shown) {
  let box = $("#runImageBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "runImageBox";
    box.className = "run-image-box";
    box.innerHTML = `<button type="button" class="run-image-close" aria-label="关闭">×</button><img alt=""><p class="mono"></p>`;
    box.querySelector(".run-image-close").addEventListener("click", () => box.remove());
    box.addEventListener("click", (event) => { if (event.target === box) box.remove(); });
    document.body.append(box);
  }
  box.querySelector("img").src = url;
  box.querySelector("p").textContent = shown;
}

/** 文本 / 文档 / 表格：铺开可读内容，超长先给前半段，点「展开全文」再取完整。 */
async function hydrateRunText(stage, runId, file) {
  const path = file.path;
  try {
    const data = await api(runFileUrl(runId, path));
    if (data.truncated) {
      stage.innerHTML = `<p class="run-file-note">文件 ${humanBytes(data.size)}，超过 512KB 预览上限，请到运行目录里打开。</p>`;
      return;
    }
    const text = String(data.content ?? "");
    const long = text.length > INLINE_TEXT_LIMIT;
    stage.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = `run-step-pre out run-artifact-pre kind-${esc(file.kind ?? "text")}`;
    pre.textContent = long ? `${text.slice(0, INLINE_TEXT_LIMIT)}` : text;
    stage.append(pre);
    if (long) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "text-btn run-file-more";
      more.textContent = `展开全文（共 ${text.length.toLocaleString("zh-CN")} 字）`;
      more.addEventListener("click", () => {
        pre.textContent = text;
        pre.classList.add("full");
        more.remove();
      });
      stage.append(more);
    }
  } catch (error) {
    stage.innerHTML = `<p class="run-file-note bad">读取失败：${esc(error.message)}</p>`;
  }
}

/** 二进制：只给身份，不假装能预览。 */
const renderRunOpaque = (run, file) => {
  const shown = file.source === "tool" ? file.path : (file.path.split("/").slice(1).join("/") || file.path);
  const row = document.createElement("div");
  row.className = "run-file-opaque";
  row.innerHTML = `<span class="run-file-kind">${esc(FILE_KIND_LABEL[file.kind] ?? "文件")}</span><span class="mono run-file-path">${esc(shown)}</span><span class="run-file-meta">${esc(humanBytes(file.bytes))}</span>`;
  return row;
};

/** 一步的全部产物：图片铺图，文本铺字，其余列清单。 */
function renderStepArtifacts(run, step, files) {
  const box = document.createElement("div");
  box.className = "run-artifacts";
  const images = files.filter((file) => file.kind === "image");
  const texts = files.filter((file) => ["markdown", "table", "text"].includes(file.kind));
  const others = files.filter((file) => !images.includes(file) && !texts.includes(file));

  images.slice(0, INLINE_IMAGE_LIMIT).forEach((file, index) => box.append(renderRunImage(run, file, index)));
  if (images.length > INLINE_IMAGE_LIMIT) {
    const rest = document.createElement("button");
    rest.type = "button";
    rest.className = "text-btn run-image-more";
    rest.textContent = `还有 ${images.length - INLINE_IMAGE_LIMIT} 张图，展开查看`;
    rest.addEventListener("click", () => {
      const frag = document.createDocumentFragment();
      images.slice(INLINE_IMAGE_LIMIT).forEach((file, index) => frag.append(renderRunImage(run, file, index)));
      rest.replaceWith(frag);
    });
    box.append(rest);
  }

  texts.forEach((file) => {
    const shown = file.source === "tool" ? file.path : (file.path.split("/").slice(1).join("/") || file.path);
    // 只有一个文档、且它就是这一步的结论时，不必再重复一遍文件名
    const heading = texts.length === 1 && images.length === 0 && others.length === 0 ? "" : shown;
    if (heading) {
      const label = document.createElement("p");
      label.className = "run-step-label run-artifact-name";
      label.innerHTML = `<span class="mono">${esc(heading)}</span><span>${esc(humanBytes(file.bytes))}</span>`;
      box.append(label);
    }
    const stage = document.createElement("div");
    stage.className = "run-artifact-stage";
    stage.dataset.path = file.path;
    box.append(stage);
    hydrateRunText(stage, run.id, file);
  });

  if (others.length) {
    const list = document.createElement("div");
    list.className = "run-files";
    others.forEach((file) => list.append(renderRunOpaque(run, file)));
    box.append(list);
  }
  return box;
}

async function actRun(runId, action) {
  try {
    const run = await api(`/api/flows/runs/${runId}/${action}`, { method: "POST", body: "{}" });
    if (runDetailId === runId) renderRunDetail(run);
    await loadFlows();
    const labels = { continue: "已放行，继续下一步", retry: "已从失败步骤重试", ignore: "已忽略失败节点，继续运行", cancel: "运行已取消", reject: "已打回，这一步在重做" };
    toast(labels[action] ?? "已处理");
  } catch (error) {
    toast(error.message);
  }
}

/* ------------------------------------------------- 副本回写与清理 */

let runRejectArmed = false;
// 单步重跑的两段式确认也用同一个计时器思路：4 秒内没点第二下就退回原样
let retryStepTimer = null;
let runRejectTimer = null;
let runApplyArmed = false;
let runApplyTimer = null;
let runDropArmed = false;
let runDropTimer = null;

/** 两段式确认：第一下上膛，五秒内再点一次才真的执行。 */
function armRunApply(on) {
  runApplyArmed = on;
  clearTimeout(runApplyTimer);
  const button = $("#runApplyBtn");
  if (!button) return;
  button.textContent = on ? "确认覆盖原文件" : "应用到原目录";
  button.classList.toggle("armed", on);
  if (on) runApplyTimer = setTimeout(() => armRunApply(false), 5000);
}

function armRunDrop(on) {
  runDropArmed = on;
  clearTimeout(runDropTimer);
  const button = $("#runDropBtn");
  if (!button) return;
  button.textContent = on ? "确认删除副本" : "清理副本";
  button.classList.toggle("armed", on);
  if (on) runDropTimer = setTimeout(() => armRunDrop(false), 5000);
}

/** 把副本里的改动写回源目录；只写登记过的文件，覆盖前有备份。 */
async function applyRunChanges() {
  if (!runDetailId) return;
  if (!runApplyArmed) {
    armRunApply(true);
    toast("会把副本内容覆盖到原目录同名文件，覆盖前先备份；再点一次确认");
    return;
  }
  armRunApply(false);
  const button = $("#runApplyBtn");
  button.disabled = true;
  try {
    const data = await api(`/api/flows/runs/${runDetailId}/apply`, { method: "POST", body: "{}" });
    if (data.run) renderRunDetail(data.run);
    await loadFlows();
    toast(data.applied?.length ? `已回写 ${data.applied.length} 个文件，原文件备份在工件目录 backup/ 下` : "源目录已经是最新，无需回写");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/** 删掉副本作业目录，副本里的工件也会一起消失。 */
async function dropRunWorkspace() {
  if (!runDetailId) return;
  if (!runDropArmed) {
    armRunDrop(true);
    toast("副本和里面的工件会一起删除，源目录不受影响；再点一次确认");
    return;
  }
  armRunDrop(false);
  const button = $("#runDropBtn");
  button.disabled = true;
  try {
    const data = await api(`/api/flows/runs/${runDetailId}/workspace`, { method: "DELETE" });
    if (data.run) renderRunDetail(data.run);
    await loadFlows();
    toast(data.removed ? "副本已清理" : "副本已不在磁盘上");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/**
 * 流程页刷新策略：
 *   - 状态变化靠运行事件流推送（毫秒级），不再每 3 秒全量拉一次；
 *   - 这里的定时器只做「断流兜底」：事件流异常时仍能在 15 秒内自愈；
 *   - 详情弹窗开着时不在这里重复拉，事件流自己会处理。
 */
function ensureFlowPolling() {
  if (flowPollTimer) return;
  flowPollTimer = setInterval(() => {
    if (state.view !== "worksite" || state.worksiteTab !== "flows") return;
    loadFlows({ quiet: true });
  }, 15_000);
}

/* =========================================================================
   dashboard view (R1 总览 + R2 趋势)
   ========================================================================= */
let dashDays = 7;
let dashTrend = []; // 最近一次画图用的数据，悬停时按它定位
let dashResizeObserver = null;

const DASH_CARDS = [
  { key: "total", label: "任务总数", cls: "" },
  { key: "completed", label: "已完成", cls: "ok" },
  { key: "failed", label: "失败", cls: "bad" },
  { key: "running", label: "运行中", cls: "run" },
  { key: "queued", label: "排队中", cls: "wait" },
  { key: "artifactFiles", label: "产出文件", cls: "" },
];

function renderDashboardMetrics(totals) {
  const box = $("#dashMetrics");
  if (!box) return;
  box.replaceChildren(...DASH_CARDS.map((card) => {
    const item = document.createElement("div");
    item.className = `dash-card ${card.cls}`;
    item.innerHTML = `<b>${Number(totals?.[card.key]) || 0}</b><span>${card.label}</span>`;
    return item;
  }));
}

function dashEmpty(trend) {
  return trend.every((day) => day.total === 0);
}

/**
 * R3 状态分布：一条横向占比条 + 可点击图例。
 * 状态分布条目：纯展示，看板不再跳工作记录（模块已移除）。
 * 宽度只能用 el.style 设（CSSOM），CSP 禁止 innerHTML 里的内联 style。
 */
function renderDashDistribution(distribution) {
  const box = $("#dashDist");
  if (!box) return;
  const items = Array.isArray(distribution) ? distribution : [];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "dash-empty";
    empty.style.margin = "26px 0";
    empty.textContent = "还没有派出去的活，先去「临时任务」派一单。";
    box.replaceChildren(empty);
    return;
  }
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const bar = document.createElement("div");
  bar.className = "dash-dist-bar";
  bar.replaceChildren(...items.map((item) => {
    const pct = (item.count / total) * 100;
    const seg = document.createElement("span");
    seg.className = `dash-dist-seg ${item.status}`;
    // 至少给 4px 宽，否则占比很小的状态在条上根本看不见
    seg.style.width = `${pct}%`;
    seg.title = `${item.label} ${item.count} 个（${pct.toFixed(1)}%）`;
    return seg;
  }));
  const legend = document.createElement("div");
  legend.className = "dash-dist-legend";
  legend.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dash-dist-item";
    button.dataset.status = item.status;
    button.title = `「${item.label}」当前 ${item.count} 条`;
    button.innerHTML = `<i class="dot ${esc(item.status)}"></i>${esc(item.label)}<b>${item.count}</b>`;
    // 统计卡不再当跳转按钮用（工作记录模块已移除），去掉手型光标与悬停反馈
    button.classList.add("static");
    return button;
  }));
  box.replaceChildren(bar, legend);
}

/** token 数 → 人话：四位数以上换成 k / M，表格里不占宽。 */
function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * 金额 → 人话。单次调用常常不到一分钱，四舍五入到分就全看不见了，
 * 所以小数额多留几位；null 一律显示「—」（表示算不出来，不是 0 元）。
 */
function fmtMoney(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  if (n < 1000) return `¥${n.toFixed(2)}`;
  return `¥${Math.round(n).toLocaleString("zh-CN")}`;
}

/** 员工单价（元/百万 tokens）；没填或全 0 返回 null，表示「算不出钱」。 */
function pricingOfAgent(agentId) {
  if (!agentId) return null;
  const agent = state.boot?.agents?.find((item) => item.id === agentId);
  const pricing = agent?.config?.pricing;
  if (!pricing) return null;
  const input = Number(pricing.input) || 0;
  const output = Number(pricing.output) || 0;
  const cached = pricing.cachedInput != null ? Number(pricing.cachedInput) || 0 : input;
  return input || output || cached ? pricing : null;
}

/** 与后端 costOf 同一套口径：缓存命中单独计价，没填就按输入价算（宁可算高）。 */
function costOfUsage(usage, pricing) {
  if (!usage || !pricing) return null;
  const prompt = Number(usage.promptTokens) || 0;
  const cached = Math.min(Number(usage.cachedTokens) || 0, prompt);
  const output = Number(usage.completionTokens) || 0;
  const inputRate = Number(pricing.input) || 0;
  const outputRate = Number(pricing.output) || 0;
  const cachedRate = pricing.cachedInput != null ? Number(pricing.cachedInput) || 0 : inputRate;
  if (!inputRate && !outputRate && !cachedRate) return null;
  return ((prompt - cached) * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
}

/** 秒数 → 人话：60 秒内说「秒」，一小时内说「X 分 Y 秒」，再往上说「X 小时 Y 分」。 */
function fmtDuration(seconds) {
  if (seconds == null) return "—";
  if (seconds === 0) return "不到 1 秒"; // 「0 秒」看着像没算出来，其实是真的瞬间开跑
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`;
}

/**
 * R5 运行效率：排队 vs 实际干，中位数各一格 + 双段横向条看占比。
 * 能一眼看出瓶颈在「派出去没人接」还是「接了但干得慢」。
 * 分段宽度走 CSSOM（el.style.width），CSP 禁止 innerHTML 里的内联 style。
 */
function renderDashEfficiency(efficiency) {
  const box = $("#dashEff");
  if (!box) return;
  const data = efficiency ?? { sample: 0, wait: { median: null, sample: 0 }, run: { median: null, sample: 0 } };
  if (!data.sample) {
    const empty = document.createElement("p");
    empty.className = "dash-empty";
    empty.style.margin = "26px 0";
    empty.textContent = "还没有任务真正跑起来过，跑几个任务后这里就有数据。";
    box.replaceChildren(empty);
    return;
  }
  const waitMedian = data.wait.median;
  const runMedian = data.run.median;
  // 双段条按两个中位数的比例分；某一边没数据就整条给另一边
  const total = (waitMedian ?? 0) + (runMedian ?? 0);
  const waitPct = total > 0 ? ((waitMedian ?? 0) / total) * 100 : 0;
  const runPct = total > 0 ? ((runMedian ?? 0) / total) * 100 : 0;

  const bar = document.createElement("div");
  bar.className = "dash-dist-bar";
  const segs = [];
  if (waitMedian != null) {
    const seg = document.createElement("span");
    seg.className = "dash-eff-seg wait";
    seg.style.width = `${waitPct}%`;
    seg.title = `排队中位 ${fmtDuration(waitMedian)}（${waitPct.toFixed(1)}%）`;
    segs.push(seg);
  }
  if (runMedian != null) {
    const seg = document.createElement("span");
    seg.className = "dash-eff-seg run";
    seg.style.width = `${runPct}%`;
    seg.title = `执行中位 ${fmtDuration(runMedian)}（${runPct.toFixed(1)}%）`;
    segs.push(seg);
  }
  bar.replaceChildren(...segs);

  const stats = document.createElement("div");
  stats.className = "dash-eff-stats";
  const waitEl = document.createElement("div");
  waitEl.className = "dash-eff-stat wait";
  waitEl.innerHTML = `<i></i><span>排队中位</span><b>${fmtDuration(waitMedian)}</b><em>${data.wait.sample ?? 0} 单有排队记录</em>`;
  const runEl = document.createElement("div");
  runEl.className = "dash-eff-stat run";
  runEl.innerHTML = `<i></i><span>执行中位</span><b>${fmtDuration(runMedian)}</b><em>${data.run.sample ?? 0} 单已跑完</em>`;
  stats.replaceChildren(waitEl, runEl);

  const note = document.createElement("p");
  note.className = "dash-eff-note";
  note.textContent = `基于最近 ${data.sample} 个跑起来的任务。排队 = 派单到开跑，执行 = 开跑到结束。`;

  box.replaceChildren(bar, stats, note);
}

/**
 * R9 成本观测：token 是事实，钱是按单价算出来的估算。
 * 左边给总量与 token 结构（输入 / 缓存命中 / 输出），右边给最贵的几单——
 * 省钱的抓手通常在「哪一单最贵」，光看总数看不出来。
 */
function renderDashCost(cost) {
  const box = $("#dashCost");
  if (!box) return;
  const data = cost ?? null;
  const nameOf = (id) => state.boot?.agents?.find((agent) => agent.id === id)?.name ?? id;
  if (!data || !data.tasksWithUsage) {
    const empty = document.createElement("p");
    empty.className = "dash-empty";
    empty.style.margin = "26px 0";
    empty.textContent = "还没有云端员工交回过用量：本机 Codex 不计费，豆包 / Kimi 这类 API 员工跑完一单，这里就会长出来。";
    box.replaceChildren(empty);
    return;
  }

  const totals = data.totals ?? {};
  const cached = Number(totals.cachedTokens) || 0;
  const prompt = Number(totals.promptTokens) || 0;
  const fresh = Math.max(prompt - cached, 0);
  const output = Number(totals.completionTokens) || 0;

  const chips = document.createElement("div");
  chips.className = "dash-backlog-chips";
  chips.replaceChildren(...[
    { label: "总花费", value: totals.costKnown ? fmtMoney(totals.cost) : "未填单价", cls: totals.costKnown ? "" : "muted" },
    { label: "输入 tokens", value: fmtTokens(prompt) },
    { label: "输出 tokens", value: fmtTokens(output) },
    { label: "有用量", value: `${data.tasksWithUsage} 单` },
  ].map((chip) => {
    const el = document.createElement("span");
    el.className = `dash-backlog-chip ${chip.cls ?? ""}`.trim();
    el.innerHTML = `<em>${chip.label}</em><b>${esc(chip.value)}</b>`;
    return el;
  }));

  const bar = document.createElement("div");
  bar.className = "dash-dist-bar";
  bar.style.marginTop = "14px";
  const segs = [
    { key: "input", label: "输入（未命中缓存）", value: fresh },
    { key: "cached", label: "缓存命中", value: cached },
    { key: "output", label: "输出", value: output },
  ].filter((item) => item.value > 0);
  const totalTokens = segs.reduce((sum, item) => sum + item.value, 0) || 1;
  bar.replaceChildren(...segs.map((item) => {
    const pct = (item.value / totalTokens) * 100;
    const seg = document.createElement("span");
    seg.className = `dash-cost-seg ${item.key}`;
    seg.style.width = `${pct}%`;
    seg.title = `${item.label} ${item.value.toLocaleString("zh-CN")} tokens（${pct.toFixed(1)}%）`;
    return seg;
  }));

  const legend = document.createElement("div");
  legend.className = "dash-dist-legend";
  legend.replaceChildren(...segs.map((item) => {
    const el = document.createElement("span");
    el.className = "dash-dist-item";
    el.innerHTML = `<i class="dot ${item.key}"></i>${esc(item.label)}<b>${fmtTokens(item.value)}</b>`;
    return el;
  }));

  const main = document.createElement("div");
  main.className = "dash-cost-main";
  main.replaceChildren(chips, bar, legend);

  // 没填单价的员工要单独点名：否则「总花费」看起来像全量，其实是半本账
  const hints = [];
  if (!totals.costKnown) {
    hints.push("还没有员工填单价，所以只统计了 token。到员工页「填 API → 高级设置」补上输入/输出单价，这里就能折成钱。");
  } else if (data.unpricedTasks) {
    const names = (data.unpricedAgents ?? []).map(nameOf).join("、");
    hints.push(`另有 ${data.unpricedTasks} 单没填单价，未计入金额${names ? `（${names}）` : ""}。`);
  }
  const side = document.createElement("div");
  side.className = "dash-cost-side";
  const sideParts = [];
  if (hints.length) {
    const note = document.createElement("p");
    note.className = "dash-cost-note";
    note.textContent = hints.join(" ");
    sideParts.push(note);
  }
  if ((data.top ?? []).length) {
    const title = document.createElement("p");
    title.className = "dash-prod-recent-title";
    title.textContent = "最贵的几单";
    const list = document.createElement("ul");
    list.className = "dash-backlog-list";
    list.replaceChildren(...data.top.map((item) => {
      const li = document.createElement("li");
      li.className = "dash-backlog-item";
      li.title = "点开看这一单的详情";
      li.innerHTML = `
        <span class="dash-backlog-title">${esc(item.title)}</span>
        <span class="dash-backlog-agent">${esc(item.agent ? nameOf(item.agent) : "未指定员工")}</span>
        <b class="dash-cost-money">${esc(fmtMoney(item.cost))}</b>`;
      li.addEventListener("click", () => { if (item.id) openDrawer(item.id); });
      return li;
    }));
    sideParts.push(title, list);
  }
  side.replaceChildren(...sideParts);

  box.replaceChildren(main, side);
}

/**
 * R6 队列积压：此刻还没开跑的活等了多久。
 * 一行汇总（积压几单 / 最长等多久 / 超 10 分钟几单）+ 等得最久的前 5 条。
 * 点条目直接开任务抽屉，看到堵住了就马上去处理。
 */
function renderDashBacklog(backlog) {
  const box = $("#dashBacklog");
  if (!box) return;
  const data = backlog ?? { count: 0, longestSeconds: 0, over10m: 0, top: [] };
  const nameOf = (id) => state.boot?.agents?.find((agent) => agent.id === id)?.name ?? id;
  if (!data.count) {
    const empty = document.createElement("p");
    empty.className = "dash-empty";
    empty.style.margin = "26px 0";
    empty.textContent = "当前没有积压，派出去的活都在正常跑。";
    box.replaceChildren(empty);
    return;
  }

  const chips = document.createElement("div");
  chips.className = "dash-backlog-chips";
  const chipData = [
    { label: "积压", value: `${data.count} 单`, cls: "" },
    { label: "最长等待", value: fmtDuration(data.longestSeconds), cls: "" },
    { label: "超 10 分钟", value: `${data.over10m} 单`, cls: data.over10m ? "hot" : "" },
  ];
  chips.replaceChildren(...chipData.map((chip) => {
    const el = document.createElement("span");
    el.className = `dash-backlog-chip ${chip.cls}`;
    el.innerHTML = `<em>${chip.label}</em><b>${chip.value}</b>`;
    return el;
  }));

  const list = document.createElement("ul");
  list.className = "dash-backlog-list";
  list.replaceChildren(...(data.top ?? []).map((item) => {
    const li = document.createElement("li");
    li.className = "dash-backlog-item";
    li.title = "点开看这个任务的详情";
    li.innerHTML = `
      <i class="dot ${esc(item.status)}"></i>
      <span class="dash-backlog-title">${esc(item.title)}</span>
      <span class="dash-backlog-agent">${esc(item.agent ? nameOf(item.agent) : "未指定员工")}</span>
      <b class="dash-backlog-wait ${item.waitSeconds >= 600 ? "hot" : ""}">${fmtDuration(item.waitSeconds)}</b>`;
    li.addEventListener("click", () => openDrawer(item.id));
    return li;
  }));
  if (data.count > (data.top?.length ?? 0)) {
    const more = document.createElement("li");
    more.className = "dash-backlog-more";
    more.textContent = `还有 ${data.count - (data.top?.length ?? 0)} 单也在等`;
    list.appendChild(more);
  }

  box.replaceChildren(chips, list);
}

/** 员工表现表的排序状态：默认按接单数从多到少。 */
let dashAgentSort = { key: "total", dir: "desc" };
const DASH_AGENT_COLUMNS = [
  { key: "total", label: "接单", numeric: true },
  { key: "completed", label: "干成", numeric: true },
  { key: "failed", label: "砸了", numeric: true },
  { key: "successRate", label: "成功率", numeric: true },
  { key: "avgSeconds", label: "平均耗时", numeric: true },
  { key: "promptTokens", label: "输入 tokens", numeric: true },
  { key: "completionTokens", label: "输出 tokens", numeric: true },
  { key: "cost", label: "花费", numeric: true },
];

function renderDashAgents(agents) {
  const table = $("#dashAgents");
  if (!table) return;
  const rows = Array.isArray(agents) ? agents : [];
  const nameOf = (id) => state.boot?.agents?.find((agent) => agent.id === id)?.name ?? id;

  const head = table.querySelector("thead");
  const body = table.querySelector("tbody");
  if (!rows.length) {
    head.replaceChildren();
    const empty = document.createElement("tr");
    empty.innerHTML = `<td class="dash-agents-empty">还没有员工接过活。</td>`;
    body.replaceChildren(empty);
    return;
  }

  const dirOf = (key) => (dashAgentSort.key === key ? dashAgentSort.dir : "");
  head.innerHTML = `<tr>
    <th class="sortable${dirOf("agent") ? ` ${dirOf("agent")}` : ""}" data-key="agent">员工</th>
    ${DASH_AGENT_COLUMNS.map((column) => `<th class="sortable num${dirOf(column.key) ? ` ${dirOf(column.key)}` : ""}" data-key="${column.key}">${column.label}</th>`).join("")}
  </tr>`;
  head.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (dashAgentSort.key === key) {
        dashAgentSort.dir = dashAgentSort.dir === "desc" ? "asc" : "desc";
      } else {
        // 数字列第一次点习惯看「最多的在前」，文字列看字母序
        dashAgentSort = { key, dir: key === "agent" ? "asc" : "desc" };
      }
      renderDashAgents(state.stats?.agents);
    });
  });

  const sorted = rows.slice().sort((a, b) => {
    const dir = dashAgentSort.dir === "asc" ? 1 : -1;
    const key = dashAgentSort.key;
    const av = a[key];
    const bv = b[key];
    // 没数据的排最后，不管升降序
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  body.replaceChildren(...sorted.map((row) => {
    const tr = document.createElement("tr");
    const rate = row.successRate;
    const rateHtml = rate == null
      ? '<td class="num muted">—</td>'
      : `<td class="num"><span class="dash-rate ${rate >= 80 ? "good" : rate >= 50 ? "mid" : "bad"}">${rate}%</span></td>`;
    const avg = row.avgSeconds;
    const avgText = fmtDuration(avg);
    // token 为 0 多半是本机执行器（不上报用量），显示「—」比显示 0 更诚实
    const tokensCell = (value) => (value ? `<td class="num">${fmtTokens(value)}</td>` : '<td class="num muted">—</td>');
    const costCell = row.cost == null
      ? '<td class="num muted" title="这位员工还没填单价">—</td>'
      : `<td class="num">${esc(fmtMoney(row.cost))}</td>`;
    tr.innerHTML = `
      <td>${esc(nameOf(row.agent))}</td>
      <td class="num">${row.total}</td>
      <td class="num ${row.completed ? "ok" : ""}">${row.completed}</td>
      <td class="num ${row.failed ? "bad" : "muted"}">${row.failed}</td>
      ${rateHtml}
      <td class="num">${avgText}</td>
      ${tokensCell(row.promptTokens)}
      ${tokensCell(row.completionTokens)}
      ${costCell}`;
    return tr;
  }));
}

/** 折线图：纯 canvas 手绘，悬停显示当天数字。 */
function drawDashTrend(canvas, trend) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  // 高度写死 240：不能从 attribute 读，否则缓冲区变化会反过来改元素高度，
  // ResizeObserver 再触发重绘，一路翻倍直到把内存吃光。
  const height = 240;
  const nextW = Math.round(width * dpr);
  const nextH = Math.round(height * dpr);
  if (canvas.width !== nextW) canvas.width = nextW;
  if (canvas.height !== nextH) canvas.height = nextH;
  const ctx = canvas.getContext("2d");
  // setTransform 而不是 scale：重绘时不能让上一次的缩放累加，否则坐标会被放大到画布外
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 38, right: 14, top: 14, bottom: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const n = trend.length;
  const max = Math.max(1, ...trend.map((day) => Math.max(day.total, day.succeeded, day.failed)));
  // 刻度要落在整数上：把上限抬到 4 的倍数，四等分后不会出现 7.5 这种刻度
  const niceMax = Math.max(4, Math.ceil(max / 4) * 4);
  const yOf = (value) => pad.top + plotH * (1 - value / niceMax);
  const xOf = (index) => (n <= 1 ? pad.left + plotW / 2 : pad.left + (plotW * index) / (n - 1));

  // 网格与纵轴刻度
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (niceMax * tick) / 4;
    const y = yOf(value);
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(215,225,240,.45)";
    ctx.fillText(String(value), pad.left - 7, y);
  }

  // 横轴日期：7 天全标，30 天每隔 5 天标一个
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelEvery = n > 10 ? 5 : 1;
  for (let i = 0; i < n; i += 1) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    const [m, d] = trend[i].date.split("-").slice(1);
    ctx.fillStyle = "rgba(215,225,240,.45)";
    ctx.fillText(`${Number(m)}/${Number(d)}`, xOf(i), pad.top + plotH + 6);
  }

  const series = [
    { key: "total", color: "rgba(122,169,255,.55)", dash: [4, 4] },
    { key: "succeeded", color: "#55C69A", dash: [] },
    { key: "failed", color: "#EF6B73", dash: [] },
  ];
  for (const { key, color, dash } of series) {
    ctx.beginPath();
    ctx.setLineDash(dash);
    trend.forEach((day, i) => {
      const x = xOf(i);
      const y = yOf(day[key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = key === "total" ? 1 : 1.8;
    ctx.stroke();
    ctx.setLineDash([]);
    if (n <= 31) {
      trend.forEach((day, i) => {
        ctx.beginPath();
        ctx.arc(xOf(i), yOf(day[key]), key === "total" ? 1.6 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }
  }
  return { xOf, yOf, pad, width, height };
}

function showDashTip(index, geometry) {
  const tip = $("#dashTip");
  const wrap = tip?.parentElement;
  const canvas = $("#dashTrend");
  if (!tip || !wrap || !geometry) return;
  const day = dashTrend[index];
  if (!day) return;
  const [m, d] = day.date.split("-").slice(1);
  // 用量是跑完才结算的，所以 token / 花费按完成时间落在当天，跟「派单」不一定是同一批任务
  const costLine = day.tokens
    ? `<span>${fmtTokens(day.tokens)} tokens · ${day.cost != null ? fmtMoney(day.cost) : "未填单价"}</span>`
    : "";
  tip.innerHTML = `<b>${Number(m)}月${Number(d)}日</b><span>派单 ${day.total} · 干成 ${day.succeeded} · 砸了 ${day.failed}</span>${costLine}`;
  tip.hidden = false;
  const x = geometry.xOf(index);
  const left = Math.min(Math.max(x - tip.offsetWidth / 2, 4), wrap.clientWidth - tip.offsetWidth - 4);
  // 用 CSSOM 定位，绕开内联样式的 CSP 限制
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = "6px";
  // 悬停参考线：直接叠一条 1px 竖线画在 canvas 上太频繁，改成重画一帧
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.beginPath();
  ctx.moveTo(x, geometry.pad.top);
  ctx.lineTo(x, geometry.height - geometry.pad.bottom);
  ctx.stroke();
  ctx.restore();
}

/** 流程表现表的排序状态：默认按运行次数从多到少。 */
let dashFlowSort = { key: "total", dir: "desc" };
const DASH_FLOW_COLUMNS = [
  { key: "total", label: "运行" },
  { key: "success", label: "跑成" },
  { key: "stuck", label: "卡住" },
  { key: "cancelled", label: "取消" },
  { key: "inFlight", label: "在跑" },
  { key: "successRate", label: "成功率" },
  { key: "avgSeconds", label: "平均耗时" },
];

/**
 * R7 流程表现：一条流程一行，跟员工表现表同款交互（点表头排序、点行跳运行记录）。
 * 「卡住」= 某步失败或网关重启中断后停在 paused，需要人处理的那种。
 */
function renderDashFlows(flows) {
  const table = $("#dashFlows");
  if (!table) return;
  const rows = Array.isArray(flows) ? flows : [];
  const head = table.querySelector("thead");
  const body = table.querySelector("tbody");
  if (!rows.length) {
    head.replaceChildren();
    const empty = document.createElement("tr");
    empty.innerHTML = `<td class="dash-agents-empty">还没有跑过流程。去「流程编排」建一条，跑起来这里就有数据。</td>`;
    body.replaceChildren(empty);
    return;
  }

  const dirOf = (key) => (dashFlowSort.key === key ? dashFlowSort.dir : "");
  head.innerHTML = `<tr>
    <th class="sortable${dirOf("name") ? ` ${dirOf("name")}` : ""}" data-key="name">流程</th>
    ${DASH_FLOW_COLUMNS.map((column) => `<th class="sortable num${dirOf(column.key) ? ` ${dirOf(column.key)}` : ""}" data-key="${column.key}">${column.label}</th>`).join("")}
  </tr>`;
  head.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (dashFlowSort.key === key) {
        dashFlowSort.dir = dashFlowSort.dir === "desc" ? "asc" : "desc";
      } else {
        dashFlowSort = { key, dir: key === "name" ? "asc" : "desc" };
      }
      renderDashFlows(state.stats?.flows);
    });
  });

  const sorted = rows.slice().sort((a, b) => {
    const dir = dashFlowSort.dir === "asc" ? 1 : -1;
    const key = dashFlowSort.key;
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 没数据的恒排最后
    if (bv == null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  // 不同流程可能叫同一个名字（复制/重建都会），撞名时补一段 id 尾巴才分得清
  const nameCount = new Map();
  for (const row of rows) nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);
  const labelOf = (row) => (nameCount.get(row.name) > 1 ? `${row.name} · ${String(row.flowId ?? "").slice(-4)}` : row.name);

  body.replaceChildren(...sorted.map((row) => {
    const tr = document.createElement("tr");
    tr.className = "row-link";
    tr.title = "到流程编排看这条流程的运行记录";
    const rate = row.successRate;
    const rateHtml = rate == null
      ? '<td class="num muted">—</td>'
      : `<td class="num"><span class="dash-rate ${rate >= 80 ? "good" : rate >= 50 ? "mid" : "bad"}">${rate}%</span></td>`;
    tr.innerHTML = `
      <td>${esc(labelOf(row))}</td>
      <td class="num">${row.total}</td>
      <td class="num ${row.success ? "ok" : "muted"}">${row.success}</td>
      <td class="num ${row.stuck ? "bad" : "muted"}">${row.stuck}</td>
      <td class="num ${row.cancelled ? "" : "muted"}">${row.cancelled}</td>
      <td class="num ${row.inFlight ? "ok" : "muted"}">${row.inFlight}</td>
      ${rateHtml}
      <td class="num">${fmtDuration(row.avgSeconds)}</td>`;
    tr.addEventListener("click", () => {
      gotoWorksiteTab("flows");
      toast(`已到流程编排，看「${labelOf(row)}」的运行记录`);
    });
    return tr;
  }));
}

/**
 * R8 产出统计：类型占比条（可点图例跳产出库）+ 三个数字 + 最近交出来的几件。
 * 文件类型的中文名和配色统一走 ARTIFACT_TYPE，和产出库保持一致。
 */
function renderDashProd(production) {
  const box = $("#dashProd");
  if (!box) return;
  const data = production ?? { total: 0, taskCount: 0, withArtifacts: 0, rate: null, perTask: null, types: [], domains: [], recent: [] };
  if (!data.total) {
    const empty = document.createElement("p");
    empty.className = "dash-empty";
    empty.style.margin = "26px 0";
    empty.textContent = "还没有任务交出过文件。跑个要产出的任务，这里就会长出来。";
    box.replaceChildren(empty);
    return;
  }

  const chips = document.createElement("div");
  chips.className = "dash-backlog-chips";
  chips.replaceChildren(...[
    { label: "产出文件", value: `${data.total} 个` },
    { label: "有产出的任务", value: `${data.withArtifacts} / ${data.taskCount} 单${data.rate == null ? "" : `（${data.rate}%）`}` },
    { label: "平均每单", value: `${data.perTask ?? 0} 个` },
  ].map((chip) => {
    const el = document.createElement("span");
    el.className = "dash-backlog-chip";
    el.innerHTML = `<em>${chip.label}</em><b>${esc(chip.value)}</b>`;
    return el;
  }));

  // 工作域分布：产出都落在哪类活上（流程步骤 / 临时任务 / 调研…）
  const domainLine = document.createElement("p");
  domainLine.className = "dash-prod-domains";
  const domainName = (id) => state.boot?.domains?.find((item) => item.id === id)?.name ?? id;
  domainLine.textContent = (data.domains ?? []).length
    ? `产出分布：${data.domains.map((item) => `${domainName(item.domain)} ${item.count}`).join(" · ")}`
    : "";

  const bar = document.createElement("div");
  bar.className = "dash-dist-bar";
  bar.style.marginTop = "14px";
  bar.replaceChildren(...(data.types ?? []).map((item) => {
    const pct = (item.count / data.total) * 100;
    const seg = document.createElement("span");
    seg.className = `dash-prod-seg ${esc(item.type)}`;
    seg.style.width = `${pct}%`;
    seg.title = `${artifactType(item.type).label} ${item.count} 个（${pct.toFixed(1)}%）`;
    return seg;
  }));

  const legend = document.createElement("div");
  legend.className = "dash-dist-legend";
  legend.replaceChildren(...(data.types ?? []).map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dash-dist-item";
    button.title = `到产出库筛出「${artifactType(item.type).label}」`;
    button.innerHTML = `<i class="dot ${esc(item.type)}"></i>${esc(artifactType(item.type).label)}<b>${item.count}</b>`;
    button.addEventListener("click", () => {
      state.libType = item.type;
      setView("artifacts");
      toast(`已到产出库筛出「${artifactType(item.type).label}」`);
    });
    return button;
  }));

  const recentWrap = document.createElement("div");
  recentWrap.className = "dash-prod-recent";
  if ((data.recent ?? []).length) {
    const title = document.createElement("p");
    title.className = "dash-prod-recent-title";
    title.textContent = "最近交出来的";
    const list = document.createElement("ul");
    list.className = "dash-backlog-list";
    list.replaceChildren(...data.recent.map((item) => {
      const li = document.createElement("li");
      li.className = "dash-backlog-item";
      li.title = item.taskTitle ? `来自任务：${item.taskTitle}` : "点开任务详情";
      li.innerHTML = `
        <i class="dot ${esc(item.type)}"></i>
        <span class="dash-backlog-title">${esc(item.name)}</span>
        <span class="dash-backlog-agent">${esc(artifactType(item.type).label)}</span>
        <b class="dash-prod-from">${esc(item.taskTitle || "—")}</b>`;
      li.addEventListener("click", () => { if (item.taskId) openDrawer(item.taskId); });
      return li;
    }));
    recentWrap.replaceChildren(title, list);
  }

  // 左栏放总量和类型条，右栏放最近产出：整行卡片才不会被拉得又空又长
  const main = document.createElement("div");
  main.className = "dash-prod-main";
  main.replaceChildren(chips, domainLine, bar, legend);

  box.replaceChildren(main, recentWrap);
}

function renderDashboard() {
  const stats = state.stats ?? {};
  renderDashboardMetrics(stats.totals);
  renderDashDistribution(stats.distribution);
  renderDashEfficiency(stats.efficiency);
  renderDashCost(stats.cost);
  renderDashBacklog(stats.backlog);
  renderDashAgents(stats.agents);
  renderDashFlows(stats.flows);
  renderDashProd(stats.production);
  const trend = Array.isArray(stats.trend) ? stats.trend : [];
  dashTrend = trend;
  const canvas = $("#dashTrend");
  const empty = $("#dashEmpty");
  const hasData = trend.length > 0 && !dashEmpty(trend);
  if (empty) empty.hidden = hasData;
  // 没有任何已结束任务时不画空坐标系，直接给一句人话
  if (canvas) canvas.hidden = !hasData;
  if (canvas && hasData) {
    drawDashTrend(canvas, trend);
    canvas.onmousemove = (event) => {
      if (!trend.length) return;
      // 每次先擦掉上一帧的参考线，否则鼠标划过会留下一条条竖线
      const live = drawDashTrend(canvas, trend);
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const { pad, width } = live;
      const ratio = (x - pad.left) / Math.max(width - pad.left - pad.right, 1);
      const index = Math.min(Math.max(Math.round(ratio * (trend.length - 1)), 0), trend.length - 1);
      showDashTip(index, live);
    };
    canvas.onmouseleave = () => {
      const tip = $("#dashTip");
      if (tip) tip.hidden = true;
      drawDashTrend(canvas, dashTrend); // 移开时擦掉参考线
    };
    if (dashResizeObserver) dashResizeObserver.disconnect();
    dashResizeObserver = new ResizeObserver(() => {
      if (state.view !== "dashboard") return;
      drawDashTrend(canvas, dashTrend);
    });
    dashResizeObserver.observe(canvas);
  }
}

async function loadDashboard() {
  try {
    state.stats = await api(`/api/stats?days=${dashDays}`);
    renderDashboard();
  } catch (error) {
    toast(error.message);
  }
}


/* =========================================================================
   settings view
   ========================================================================= */
function renderSettings() {
  const boot = state.boot;
  if (!boot) return;
  const s = state.stats ?? {};
  const online = state.health === true;
  const healthState = state.health === null ? "pending" : online ? "ok" : "bad";
  const healthText = state.health === null ? "检测中" : online ? "在线" : "离线";
  const total = s.total ?? 0;
  const completed = s.completed ?? 0;
  const failed = s.failed ?? 0;
  const rt = boot.runtime ?? {};
  const runtimeUptime = (seconds) => {
    const s = Number(seconds) || 0;
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  };
  // 完整路径太长，只显示末两级，完整值放 title 里备查
  const shortPath = (full) => {
    const parts = String(full || "").split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : String(full || "—");
  };
  const version = (boot.codexVersion || "").replace("codex-cli ", "") || "未检测到";

  // 更新块的一行摘要：折叠着也要能看出「有没有新版、要不要重启」
  const upd = state.update;
  const updSummary = updateSummaryText(upd);

  const box = $("#settings");
  // 健康检查每 20 秒重绘整页；用户正在输入（端口、更新源地址）时先别动他的光标
  if (box.contains(document.activeElement) && ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  // 折叠是用户手动状态，重渲染前后必须留住
  const setFold = new Map([...box.querySelectorAll(".set-fold")].map((item) => [item.dataset.fold, item.open]));
  const agentReady = (boot.agents ?? []).filter((agent) => agent.available).length;
  box.innerHTML = `
    <div class="set-hero">
      <div class="hero-cell ${healthState}">
        <span>网关</span>
        <b><i class="pulse-dot"></i>${healthText}</b>
        <em>${esc(boot.service?.host === "0.0.0.0" ? "0.0.0.0（局域网）" : boot.service?.host ?? "127.0.0.1")}:${boot.service?.port ?? 4317}</em>
      </div>
      <div class="hero-cell">
        <span>Codex</span>
        <b class="mono">${esc(version)}</b>
        <em>本机 CLI 版本</em>
      </div>
      <div class="hero-cell">
        <span>并发占用</span>
        <b class="mono">${boot.running ?? 0}<small> / ${boot.maxConcurrency}</small></b>
        <em>${(boot.queue ?? 0) > 0 ? `${boot.queue} 个排队中` : "队列空闲"}</em>
      </div>
      <div class="hero-cell">
        <span>近 7 天任务</span>
        <b class="mono">${total}</b>
        <em>${completed} 完成 · ${failed} 失败</em>
      </div>
    </div>

    <!-- AI 员工：置顶、默认展开。员工管理本质是设置的一部分，不再单独占导航位 -->
    <details class="set-fold set-agents" data-fold="agents" open>
      <summary><b>AI 员工</b><em>${(boot.agents ?? []).length} 位 · ${agentReady} 位就绪</em></summary>
      <div class="set-fold-body">
        <div class="fact-hero" id="agentHero"></div>
        <div class="lib-bar">
          <div class="lib-tabs" id="agentTabs"></div>
          <button type="button" class="primary" id="agentNew">新增员工</button>
        </div>
        <div id="agentList" class="agent-list"></div>
      </div>
    </details>

    <details class="set-fold" data-fold="service">
      <summary><b>服务与开关</b><em>网关开关、内网开放、开机自启</em></summary>
      <div class="set-fold-body"><div id="serviceCard"></div></div>
    </details>

    <details class="set-fold set-update" data-fold="update"${upd?.lastCheck?.available || upd?.applied?.pendingRestart ? " open" : ""}>
      <summary><b>版本与更新</b><em>${esc(updSummary)}</em></summary>
      <div class="set-fold-body"><div id="updateCard"></div></div>
    </details>

    <details class="set-fold" data-fold="runtime">
      <summary><b>运行环境</b><em>网关进程实际配置与本机偏好</em></summary>
      <div class="set-fold-body">
        <section class="set-card set-env">
          <div class="set-row"><span>网关进程</span><b class="mono">PID ${rt.pid ?? "—"} · ${rt.nodeVersion ?? ""}</b></div>
          <div class="set-row"><span>本次已运行</span><b class="mono">${runtimeUptime(rt.uptimeSeconds)}</b></div>
          <div class="set-row"><span>派活方式</span><b class="mono">${esc(rt.runnerMode ?? "exec")}</b></div>
          <div class="set-row"><span>单任务超时</span><b class="mono">${rt.taskTimeoutMinutes ?? "—"} 分钟</b></div>
          <div class="set-row"><span>静默告警</span><b class="mono">${rt.silenceWarnMinutes ? `无输出 ${rt.silenceWarnMinutes} 分钟` : "已关闭"}</b></div>
          <div class="set-row"><span>推理强度</span><b class="mono">${esc(rt.reasoningEffort || "未设置")}</b></div>
          <div class="set-row"><span>网络出口</span><b class="${rt.useSystemProxy ? "pending" : "ok"}">${rt.useSystemProxy ? "跟随系统代理" : "已剥离宿主代理"}</b></div>
          <div class="set-row"><span>Codex 可执行文件</span><b class="mono ellipsis" title="${esc(rt.codexCommand || "")}">${esc(shortPath(rt.codexCommand))}</b></div>
          <div class="set-row stack">
            <span>允许写入的目录</span>
            <div class="root-list">${(boot.allowedRoots ?? []).map((root) => `<code title="${esc(root)}">${esc(root)}</code>`).join("")}</div>
          </div>
          <div class="group-label">本机偏好</div>
          <div class="set-row"><span>本机工作方法</span><b class="mono">${state.skills.length} 个</b></div>
          <div class="set-row"><span>系统通知</span><button class="set-action" id="askNotify">申请授权</button></div>
          <div class="set-row"><span>本地缓存</span><button class="set-action danger" id="clearLocal">清空</button></div>
        </section>
      </div>
    </details>

    <details class="set-fold" data-fold="quick">
      <summary><b>快捷入口</b><em>${state.quick.length} 个 · 顶部工具栏的模板与网址</em></summary>
      <div class="set-fold-body">
        <section class="set-card set-quick">
          <div id="quickEditor"></div>
        </section>
      </div>
    </details>`;

  // 折叠状态回填：用户展开过哪组，刷新后还是展开
  box.querySelectorAll(".set-fold").forEach((item) => {
    if (setFold.has(item.dataset.fold)) item.open = setFold.get(item.dataset.fold);
  });

  // 员工块每次重渲染都换新节点，事件得跟着重绑
  $("#agentNew")?.addEventListener("click", () => openAgentDialog(null));
  renderAgents();
  renderQuickEditor();
  renderServiceCard();
  renderUpdateCard();
  $("#askNotify")?.addEventListener("click", async () => {
    await ensureNotifyPermission();
    toast(Notification.permission === "granted" ? "已允许通知" : "未获得通知权限");
  });
  $("#clearLocal")?.addEventListener("click", () => {
    for (const key of Object.values(LS)) if (key !== LS.token) localStorage.removeItem(key);
    state.composer.skills = [];
    state.quick = DEFAULT_QUICK;
    toast("本地缓存已清空");
    renderQuickbar();
    renderSettings();
  });
}

/* ---- 设置页 · 服务管理：网关开关、监听范围、内网访问地址 ---- */
/* =========================================================================
   版本与更新（设置页）
   -------------------------------------------------------------------------
   更新是唯一会「改程序文件 + 重启进程」的开关，所以这一块的原则是：
   · 先说清现在是什么版本、有没有新版、上次检查成没成
   · 装之前必须有人点确认（自动安装要单独打开）
   · 装完明确告诉用户「还要重启」，不让人以为点完就生效了
   ========================================================================= */

const fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
};

const shortSource = (url) => String(url || "").replace(/^https?:\/\//, "").slice(0, 48) || "未设置";

/** 折叠标题上那句话。检查完只重绘卡片时，标题也要跟着变，不然两处说法会打架。 */
function updateSummaryText(upd) {
  if (!upd) return "网关版本与更新包";
  if (upd.applied?.pendingRestart) return `已装 v${upd.applied.to} · 重启后生效`;
  if (upd.lastCheck?.available) return `当前 v${upd.current} · 可更新到 v${upd.lastCheck.latest}`;
  const tail = !upd.lastCheck
    ? "还没检查"
    : upd.lastCheck.ok
      ? "已是最新"
      : upd.lastCheck.kind === "absent"
        ? "暂无更新包"
        : "上次检查没成功";
  return `当前 v${upd.current} · ${tail}`;
}

function syncUpdateSummary({ expandWhenAvailable = false } = {}) {
  const fold = document.querySelector('.set-fold[data-fold="update"]');
  if (!fold) return;
  const em = fold.querySelector("summary em");
  if (em) em.textContent = updateSummaryText(state.update);
  if (expandWhenAvailable && state.update?.lastCheck?.available && !fold.open) fold.open = true;
  renderUpdateBadge();
}

function renderUpdateCard() {
  const box = $("#updateCard");
  if (!box) return;
  const upd = state.update;
  if (!upd) {
    box.innerHTML = `<p class="set-empty">网关没有返回版本信息，可能这版还不支持自动更新。</p>`;
    return;
  }

  const check = upd.lastCheck ?? null;
  const applied = upd.applied ?? null;
  const busy = state.updateBusy;
  const pendingRestart = Boolean(applied?.pendingRestart);
  const available = Boolean(check?.available);
  const backups = upd.backups ?? [];

  let pill = { tone: "", text: "还没检查" };
  if (pendingRestart) pill = { tone: "wait", text: "重启后生效" };
  else if (available) pill = { tone: "wait", text: `可更新 v${check.latest}` };
  else if (check?.ok) pill = { tone: "ok", text: "已是最新" };
  // 404 是「平台还没发过网关包」，不是故障——别用红色吓人
  else if (check && !check.ok) pill = check.kind === "absent" ? { tone: "", text: "暂无更新包" } : { tone: "bad", text: "检查失败" };

  const notes = check?.manifest?.notes || "";
  const srcValue = state.updateSrcDraft || upd.manifestUrl || "";

  box.innerHTML = `
    <div class="set-card upd-card">
      <div class="upd-head">
        <div class="upd-ver"><span>网关版本</span><b class="mono">v${esc(upd.current)}</b></div>
        <span class="state-pill ${pill.tone}">${esc(pill.text)}</span>
      </div>

      <div class="set-row"><span>更新源</span><b class="mono ellipsis" title="${esc(upd.manifestUrl || "")}">${esc(shortSource(upd.manifestUrl))}</b></div>
      <div class="set-row"><span>上次检查</span><b class="${check && !check.ok && check.kind !== "absent" ? "bad" : "pending"}">${check ? esc(relTime(check.checkedAt)) : "从未检查"}</b></div>
      ${applied ? `<div class="set-row"><span>上次更新</span><b class="mono">v${esc(applied.from)} → v${esc(applied.to)}${pendingRestart ? " · 待重启" : " · 已生效"}${applied.files ? ` · ${applied.files} 个文件` : ""}</b></div>` : ""}

      ${check?.error ? `<p class="set-hint${check.kind === "absent" ? "" : " bad-hint"}">${esc(check.error)}</p>` : ""}
      ${check?.blockedBy ? `<p class="set-hint bad-hint">${esc(check.blockedBy)}</p>` : ""}
      ${available && notes ? `<div class="upd-notes"><b>更新说明</b><pre>${esc(notes)}</pre></div>` : ""}

      <div class="upd-actions">
        <button type="button" class="btn" id="updCheck"${busy ? " disabled" : ""}>${busy === "check" ? "检查中…" : "检查更新"}</button>
        ${available ? `<button type="button" class="primary" id="updApply"${busy ? " disabled" : ""}>${busy === "apply" ? "下载安装中…" : `下载并安装 v${esc(check.latest)}`}</button>` : ""}
        ${pendingRestart ? `<button type="button" class="primary" id="updRestart"${busy ? " disabled" : ""}>立即重启生效</button>` : ""}
        ${backups.length ? `<button type="button" class="btn ghost" id="updRollback"${busy ? " disabled" : ""}>回滚到 v${esc(applied?.from || backups[0]?.version || "上一版")}</button>` : ""}
      </div>

      <div class="upd-opts">
        <label class="check"><input type="checkbox" id="updAutoCheck"${upd.settings?.autoCheck ? " checked" : ""}><span>启动后自动检查更新</span></label>
        <label class="check"><input type="checkbox" id="updAutoInstall"${upd.settings?.autoInstall ? " checked" : ""}><span>有新版自动安装（只在没有任务运行时动手）</span></label>
      </div>

      <div class="upd-src">
        <label class="field"><span>更新源地址（留空用平台默认）</span>
          <input id="updSrc" placeholder="http://平台地址/hub/release/gateway.json" value="${esc(srcValue)}">
        </label>
        <button type="button" class="set-action" id="updSrcSave">保存地址</button>
      </div>
      <p class="set-hint">更新只替换程序文件（src、public 等），运行数据 state/ 与本机密钥不动。安装前整包备份到 backups/，重启后不对可一键回滚。</p>
    </div>`;

  $("#updCheck")?.addEventListener("click", checkUpdate);
  $("#updApply")?.addEventListener("click", applyUpdate);
  $("#updRestart")?.addEventListener("click", restartGateway);
  $("#updRollback")?.addEventListener("click", rollbackUpdate);
  $("#updAutoCheck")?.addEventListener("change", (event) => patchUpdateSettings({ autoCheck: event.target.checked }));
  $("#updAutoInstall")?.addEventListener("change", (event) => patchUpdateSettings({ autoInstall: event.target.checked }));
  $("#updSrc")?.addEventListener("input", (event) => { state.updateSrcDraft = event.target.value; });
  $("#updSrcSave")?.addEventListener("click", () => patchUpdateSettings({ manifestUrl: state.updateSrcDraft || "" }));
}

async function refreshUpdate() {
  try {
    const data = await api("/api/system/update");
    state.update = data;
    state.updateSrcDraft = "";
    renderUpdateCard();
    syncUpdateSummary();
  } catch (error) {
    toast(error.message);
  }
}

async function checkUpdate() {
  state.updateBusy = "check";
  renderUpdateCard();
  try {
    const result = await api("/api/system/update/check", { method: "POST", body: "{}" });
    toast(result.available ? `平台有新版 v${result.latest}` : `已是最新（v${result.current}）`);
  } catch (error) {
    // 后端已经把失败原因写进 lastCheck，refreshUpdate 会把它显示出来
    toast(`检查没成功：${error.message}`);
  } finally {
    state.updateBusy = "";
    await refreshUpdate();
    syncUpdateSummary({ expandWhenAvailable: true });
  }
}

async function applyUpdate() {
  const check = state.update?.lastCheck;
  if (!check?.manifest) return;
  const size = check.manifest.size ? `（${fmtBytes(check.manifest.size)}）` : "";
  const okInstall = await confirmDialog({
    title: `安装 v${check.latest}`,
    message: `安装 v${check.latest}${size}？`,
    detail: "会替换本机程序文件，需要重启服务。安装期间页面会断开约 5 秒，正在跑的任务不受影响。",
    okText: "安装",
  });
  if (!okInstall) return;
  state.updateBusy = "apply";
  renderUpdateCard();
  try {
    const result = await api("/api/system/update/apply", { method: "POST", body: JSON.stringify({ manifest: check.manifest }) });
    toast(`已安装 v${result.to}，点「立即重启生效」完成更新`);
  } catch (error) {
    toast(`安装失败：${error.message}`);
  } finally {
    state.updateBusy = "";
    await refreshUpdate();
    syncUpdateSummary();
  }
}

async function rollbackUpdate() {
  const applied = state.update?.applied;
  const okRollback = await confirmDialog({
    title: "回滚这次更新",
    message: `回滚到 v${applied?.from || "上一版"}？`,
    detail: "会还原更新前的程序文件，同样需要重启生效。",
    okText: "回滚",
    tone: "danger",
  });
  if (!okRollback) return;
  state.updateBusy = "rollback";
  renderUpdateCard();
  try {
    const result = await api("/api/system/update/rollback", { method: "POST", body: "{}" });
    toast(`已还原到 v${result.to || "上一版"}，重启后生效`);
  } catch (error) {
    toast(`回滚失败：${error.message}`);
  } finally {
    state.updateBusy = "";
    await refreshUpdate();
    syncUpdateSummary();
  }
}

async function patchUpdateSettings(patch) {
  try {
    const settings = await api("/api/system/update/settings", { method: "PATCH", body: JSON.stringify(patch) });
    state.update = {
      ...state.update,
      settings: { autoCheck: settings.autoCheck, autoInstall: settings.autoInstall, intervalHours: settings.intervalHours },
      manifestUrl: settings.effectiveManifestUrl,
      manifestUrlCustom: Boolean(settings.manifestUrl),
    };
    state.updateSrcDraft = "";
    toast("已保存");
    renderUpdateCard();
    syncUpdateSummary();
  } catch (error) {
    toast(error.message);
    renderUpdateCard();
  }
}

/** 重启后自动回到工作台：/health 不需要 token，起了就能跳。 */
async function waitGatewayBack() {
  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch("/health", { cache: "no-store" });
      if (response.ok) { location.reload(); return; }
    } catch { /* 还没起来 */ }
  }
  state.updateBusy = "";
  renderUpdateCard();
  toast("重启后 90 秒内没连上，看 logs/update-*.log，或手动启动网关");
}

async function restartGateway() {
  const okRestart = await confirmDialog({
    title: "重启网关",
    message: "现在重启网关？",
    detail: "正在跑的任务会被中断，建议在没有任务时重启。恢复后页面会自动刷新。",
    okText: "重启",
    tone: "danger",
  });
  if (!okRestart) return;
  state.updateBusy = "restart";
  renderUpdateCard();
  try {
    await api("/api/system/restart", { method: "POST", body: "{}" });
    toast("正在重启，恢复后页面会自动刷新");
    await waitGatewayBack();
  } catch (error) {
    state.updateBusy = "";
    renderUpdateCard();
    toast(`重启失败：${error.message}`);
  }
}

function renderServiceCard() {
  const box = $("#serviceCard");
  if (!box) return;
  const svc = state.service;
  if (!svc) {
    box.innerHTML = `<p class="set-empty">服务信息拿不到（网关可能已停止，双击桌面图标重启）。</p>`;
    return;
  }
  const isLan = svc.mode === "lan";
  const draftPort = state.serviceDraft.port || String(svc.port);
  const lanRows = (svc.lanAddresses ?? []).map((ip) => `
    <div class="lan-row">
      <code title="http://${esc(ip)}:${svc.port}">http://${esc(ip)}:${svc.port}</code>
      <button type="button" class="set-action" data-copy="http://${esc(ip)}:${svc.port}/?token=${encodeURIComponent(state.token)}">复制访问链接</button>
    </div>`).join("");
  box.innerHTML = `
    <div class="set-card">
      <p class="set-hint fold-lead">网关的开关、内网开放都在这里，改监听即时生效不用重启进程。</p>
      <div class="set-row"><span>监听范围</span><b class="${isLan ? "pending" : "ok"}">${isLan ? "局域网开放" : "仅本机"}</b></div>
      <div class="set-row"><span>监听地址</span><b class="mono">${esc(svc.host === "0.0.0.0" ? "0.0.0.0（所有网卡）" : svc.host)}:${svc.port}</b></div>
      <div class="service-switch">
        <label class="check"><input type="radio" name="svcMode" value="local"${!isLan ? " checked" : ""}><span>仅本机（127.0.0.1）</span></label>
        <label class="check"><input type="radio" name="svcMode" value="lan"${isLan ? " checked" : ""}><span>局域网开放（0.0.0.0）</span></label>
        <label class="svc-port"><span>端口</span><input id="svcPort" inputmode="numeric" maxlength="5" value="${esc(draftPort)}"></label>
        <button type="button" class="set-action" id="svcApply">应用</button>
      </div>
      ${isLan && (svc.lanAddresses ?? []).length
        ? `<div class="set-block"><span>内网访问地址（点「复制访问链接」发给同事，密钥已拼在链接里）</span>${lanRows}</div>`
        : isLan ? `<p class="set-empty">没找到局域网网卡地址。</p>`
        : `<p class="set-empty">切到「局域网开放」后，同一内网的同事可以打开工作台。</p>`}
      <div class="set-row"><span>开机自启</span>${
        svc.autostartSupported
          ? `<button type="button" class="set-action${svc.autostart ? "" : " off"}" id="svcAutostart">${svc.autostart ? "已开启 · 点击关闭" : "已关闭 · 点击开启"}</button>`
          : `<b class="mono">仅 Windows 支持</b>`
      }</div>
      <div class="set-row"><span>停止服务</span><button type="button" class="set-action danger" id="svcStop">停止网关</button></div>
      <p class="set-hint">停止后工作台离线，双击桌面图标「AI网关-开关」重新启动；改动监听范围会写进配置，重启后仍保持。</p>
    </div>`;

  box.querySelectorAll('input[name="svcMode"]').forEach((radio) => {
    radio.addEventListener("change", () => { state.serviceDraft.mode = radio.value; });
  });
  box.querySelector("#svcPort")?.addEventListener("input", (event) => {
    state.serviceDraft.port = event.target.value.replace(/\D/g, "");
  });
  box.querySelector("#svcApply")?.addEventListener("click", applyServiceListen);
  box.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); toast("访问链接已复制，发给同事即可"); }
      catch { toast("复制失败，请手动选中地址复制"); }
    });
  });
  box.querySelector("#svcAutostart")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const enable = !state.service?.autostart;
    button.disabled = true;
    try {
      const result = await api("/api/service/autostart", { method: "POST", body: JSON.stringify({ enabled: enable }) });
      if (state.service) state.service.autostart = result.enabled;
      toast(result.enabled ? "已开启：开机登录后自动启动网关（不弹窗）" : "已关闭开机自启");
      renderServiceCard();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });
  const stopBtn = box.querySelector("#svcStop");
  stopBtn?.addEventListener("click", async () => {
    // 高危操作走二次确认：第一次点只变红，4 秒内再点才真停。
    if (!stopBtn.classList.contains("armed")) {
      stopBtn.classList.add("armed");
      stopBtn.textContent = "再点一次确认停止";
      clearTimeout(state.serviceStopTimer);
      state.serviceStopTimer = setTimeout(() => {
        stopBtn.classList.remove("armed");
        stopBtn.textContent = "停止网关";
      }, 4000);
      return;
    }
    clearTimeout(state.serviceStopTimer);
    try {
      await api("/api/service/stop", { method: "POST" });
      toast("网关已停止，双击桌面图标可重新启动");
      state.health = false;
      state.service = null;
      renderServiceCard();
      updateTitle();
    } catch (error) { toast(error.message); }
  });
}

async function applyServiceListen() {
  const svc = state.service;
  if (!svc) return;
  const mode = state.serviceDraft.mode || svc.mode;
  const port = Number(state.serviceDraft.port || svc.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { toast("端口要在 1024–65535 之间"); return; }
  if (mode === svc.mode && port === svc.port) { toast("当前就是这个配置"); return; }
  try {
    await api("/api/service/listen", { method: "POST", body: JSON.stringify({ mode, port }) });
    // 服务端延迟 400ms 才真正切换（要让响应先落地），留足时间再走；
    // 期望值记在本地，回到页面后核对是否真的生效。
    localStorage.setItem("wb.svcWant", JSON.stringify({ mode, port }));
    toast("正在切换监听…");
    setTimeout(() => {
      if (port !== Number(location.port || 80)) location.href = `${location.protocol}//${location.hostname}:${port}/`;
      else location.reload();
    }, 1300);
  } catch (error) { toast(error.message); }
}

function renderQuickEditor() {
  const box = $("#quickEditor");
  if (!box) return;

  const actions = state.quick.filter((item) => item.type !== "link");
  const links = state.quick.filter((item) => item.type === "link");

  const rowHtml = (item) => {
    const isLink = item.type === "link";
    const sub = isLink ? item.url : domainLabel(item.domain) || "快速派发";
    return `
      <div class="quick-row">
        <div class="quick-main">
          <b>${esc(item.label)}</b>
          <em title="${esc(sub)}">${esc(sub)}</em>
        </div>
        <button class="quick-del" type="button" data-id="${esc(item.id)}">移除</button>
      </div>`;
  };

  const groups = document.createElement("div");
  groups.className = "quick-groups";
  const group = (title, items, cols) => {
    if (!items.length) return "";
    return `<div class="quick-group">
      <div class="group-label">${title} · ${items.length}</div>
      <div class="quick-list cols-${cols}">${items.map(rowHtml).join("")}</div>
    </div>`;
  };
  groups.innerHTML = group("工作模板", actions, 2) + group("网页入口", links, 2)
    || '<p class="set-empty">还没有快捷入口，用下面的表单加一个网址。</p>';

  groups.querySelectorAll(".quick-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.quick = state.quick.filter((entry) => entry.id !== btn.dataset.id);
      save(LS.quick, state.quick);
      renderQuickbar();
      renderQuickEditor();
    });
  });

  const add = document.createElement("div");
  add.className = "quick-add";
  add.innerHTML = `
    <div class="quick-add-fields">
      <input class="qa-label" placeholder="名称，如 中国招标投标网" autocomplete="off">
      <input class="qa-url" placeholder="https://" autocomplete="off">
    </div>
    <div class="quick-add-actions">
      <button class="btn sm" id="quickAddLink" type="button">添加网页入口</button>
      <button class="btn sm ghost" id="quickReset" type="button">恢复默认</button>
    </div>`;

  const labelInput = add.querySelector(".qa-label");
  const urlInput = add.querySelector(".qa-url");
  add.querySelector("#quickAddLink").addEventListener("click", () => {
    const label = labelInput.value.trim();
    const url = urlInput.value.trim();
    if (!label || !/^https?:\/\//.test(url)) { toast("填名称和 http(s) 网址"); return; }
    state.quick = [...state.quick, { id: `l-${Date.now().toString(36)}`, type: "link", label, url }];
    save(LS.quick, state.quick);
    renderQuickbar();
    renderQuickEditor();
    toast("已添加");
  });
  add.querySelector("#quickReset").addEventListener("click", () => {
    state.quick = DEFAULT_QUICK;
    save(LS.quick, state.quick);
    renderQuickbar();
    renderQuickEditor();
  });

  box.replaceChildren(groups, add);
}

/* =========================================================================
   events wiring
   ========================================================================= */
function wire() {
  const sideToggle = $("#sideToggle");
  const appRoot = document.querySelector(".app");
  if (matchMedia("(max-width: 850px)").matches) appRoot.classList.add("is-collapsed");
  const syncSide = () => {
    const collapsed = appRoot.classList.contains("is-collapsed");
    sideToggle.setAttribute("aria-expanded", String(!collapsed));
    sideToggle.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
    sideToggle.firstElementChild.textContent = collapsed ? "»" : "«";
    sideToggle.querySelector(".side-toggle-label").textContent = collapsed ? "展开" : "收起";
  };
  sideToggle.addEventListener("click", () => { appRoot.classList.toggle("is-collapsed"); syncSide(); });
  syncSide();
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
  // 任务页内部页签：临时任务 / 流程编排
  $("#wsTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) gotoWorksiteTab(button.dataset.tab);
  });
  $("#dashRange").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-days]");
    if (!button) return;
    dashDays = Number(button.dataset.days) || 7;
    $$("#dashRange button").forEach((item) => item.classList.toggle("active", item === button));
    loadDashboard();
  });
  $$('[data-go]').forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.go)));

  // 协作页点「任务来源」→ 切回任务页并打开那条任务的详情抽屉
  document.addEventListener("wb-open-task", (event) => {
    const id = event.detail?.id;
    if (!id) return;
    if (state.view !== "worksite") setView("worksite");
    openDrawer(id);
  });

  // 员工面板：点「+N 更多」卡开关，点外面或按 Esc 收起（面板里点行自己会收）
  $("#teamMore")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if ($("#teamMenu")?.hidden === false) closeTeamMenu();
    else openTeamMenu();
  });
  document.addEventListener("click", (event) => {
    if (!$("#teamWrap")?.classList.contains("open")) return;
    if (event.target.closest("#teamWrap")) return;
    closeTeamMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTeamMenu();
  });
  $("#closeComposer").addEventListener("click", closeComposer);
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", () => { closeDrawer(); closeComposer(); });

  $("#dispatchTask").addEventListener("click", () => submitTask({ draft: false }));
  $("#adhocRun")?.addEventListener("click", () => submitAdhoc({ draft: false }));
  $("#adhocDraft")?.addEventListener("click", () => submitAdhoc({ draft: true }));
  $("#adhocPrompt")?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAdhoc({ draft: false });
  });
  $("#saveDraft").addEventListener("click", () => submitTask({ draft: true }));
  $("#sendFollowUp").addEventListener("click", sendFollowUp);
  $("#taskPrompt").addEventListener("input", () => { previewRoute(); persistDraft(); });
  $("#taskDomain").addEventListener("change", previewRoute);
  $("#taskAgent").addEventListener("change", () => { previewRoute(); persistDraft(); });

  $("#agentForm").addEventListener("submit", (event) => { event.preventDefault(); saveAgentConfig(); });
  $("#agentSave").addEventListener("click", saveAgentConfig);
  $("#agentTestBtn").addEventListener("click", testAgentConnection);
  $("#agentPriceFetch").addEventListener("click", startPriceFetch);
  $("#agentDelete").addEventListener("click", removeAgent);
  $("#presetSwitch").addEventListener("click", () => setPresetCollapsed(false));

  // ---------------------------------------------------------------- flows
  $("#flowNew").addEventListener("click", () => openFlowDialog(null));
  $("#flowForm").addEventListener("submit", (event) => { event.preventDefault(); saveFlow(); });
  $("#flowSave").addEventListener("click", saveFlow);
  $("#flowCancel").addEventListener("click", closeFlowEditor);
  $("#flowDelete").addEventListener("click", deleteFlowFromDialog);
  $("#flowAddStep").addEventListener("click", () => appendStepWithAgent("codex"));
  $("#flowAddVar").addEventListener("click", () => {
    readFlowVarsFromDom();
    flowDraft.variables.push({ name: nextVarName(), label: "", description: "", defaultValue: "", required: false });
    $("#flowVarBox").open = true;
    renderFlowVars();
    refreshPromptChips();
    const rows = $$("#flowVars .flow-var");
    rows[rows.length - 1]?.querySelector(".flow-var-label")?.focus();
  });
  // 步骤删除走事件委托（节点和检查器各一份），避免每次重渲染都重新绑
  const flowStepAction = (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    if (act === "toggleSkill") {
      // 只切按钮状态，不重渲染检查器（否则正在编辑的提示词会丢焦点）
      const chip = button;
      const step = flowDraft.steps[selectedStepIndex];
      if (!step) return;
      const on = chip.classList.toggle("active");
      const current = new Set(step.skills ?? []);
      if (on) {
        if (current.size >= 8) { chip.classList.remove("active"); $("#flowNote").textContent = "一步最多挂 8 个技能"; return; }
        current.add(chip.dataset.skill);
      } else {
        current.delete(chip.dataset.skill);
      }
      const next = [...current];
      if (next.length) step.skills = next;
      else delete step.skills;
      const counter = chip.closest(".flow-step-skills")?.querySelector(".flow-skills-head em");
      if (counter) counter.textContent = next.length ? `已选 ${next.length} 个` : "不选就只靠提示词";
      // 节点卡上的方法标签跟着换，不然画布看起来没反应
      const node = $(`#flowCanvas .flow-node-card[data-index="${selectedStepIndex}"]`);
      if (node) {
        const old = node.querySelector(".flow-node-skills");
        if (old) old.remove();
        const html = flowNodeSkillsHtml(step);
        if (html) node.querySelector(".flow-node-meta")?.insertAdjacentHTML("afterend", html);
        fitFlowCanvas();
        drawFlowEdges();
      }
      return;
    }
    if (act === "deledge") {
      readFlowStepsFromDom();
      flowDraft.edges.splice(selectedEdgeIndex, 1);
      selectedEdgeIndex = -1;
      renderFlowSteps();
      return;
    }
    if (act === "canceledge") {
      selectedEdgeIndex = -1;
      drawFlowEdges();
      renderFlowInspector();
      return;
    }
    if (act === "addoption") {
      readFlowStepsFromDom();
      const step = flowDraft.steps[selectedStepIndex];
      if (!step || step.kind !== "condition") return;
      if ((step.options ?? []).length >= 5) { $("#flowNote").textContent = "出线选项最多 5 个"; return; }
      const used = new Set(step.options ?? []);
      let n = (step.options ?? []).length + 1;
      while (used.has(`选项${n}`)) n += 1;
      step.options = [...(step.options ?? []), `选项${n}`];
      renderFlowSteps();
      const inputs = $$("#flowInspector .flow-cond-option");
      const input = inputs[inputs.length - 1];
      if (input) { input.focus(); input.select(); }
      return;
    }
    if (act === "deloption") {
      readFlowStepsFromDom();
      const step = flowDraft.steps[selectedStepIndex];
      const optIndex = Number(button.dataset.optIndex);
      if (!step || step.kind !== "condition" || !Number.isInteger(optIndex)) return;
      if ((step.options ?? []).length <= 2) { $("#flowNote").textContent = "出线选项至少保留 2 个"; return; }
      const [removed] = step.options.splice(optIndex, 1);
      // 选项没了，从它出去的线也没了存在的意义，一并拆掉
      flowDraft.edges = flowDraft.edges.filter((edge) => !(edge.from === step.key && edge.branch === removed));
      renderFlowSteps();
      return;
    }
    const host = button.closest("[data-index]");
    if (!host) return;
    if (act === "del") deleteFlowStep(Number(host.dataset.index));
  };
  $("#flowCanvas").addEventListener("click", (event) => {
    if (event.target.closest("button[data-act]")) { flowStepAction(event); return; }
    const node = event.target.closest(".flow-node-card");
    if (!node) return;
    selectedStepIndex = Number(node.dataset.index);
    selectedEdgeIndex = -1;
    $$("#flowCanvas .flow-node-card").forEach((item) => item.classList.toggle("selected", item === node));
    drawFlowEdges();
    renderFlowInspector();
  });
  // 点连线 = 选中这条线，检查器里可以看到两端并删除
  $("#flowEdges").addEventListener("click", (event) => {
    const path = event.target.closest("path[data-edge]");
    if (!path) return;
    selectedEdgeIndex = Number(path.dataset.edge);
    selectedStepIndex = -1;
    $$("#flowCanvas .flow-node-card").forEach((item) => item.classList.remove("selected"));
    drawFlowEdges();
    renderFlowInspector();
  });
  $("#flowInspector").addEventListener("click", flowStepAction);
  $("#flowVars").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act='del']");
    if (!button) return;
    readFlowVarsFromDom();
    flowDraft.variables.splice(Number(button.closest(".flow-var").dataset.index), 1);
    renderFlowVars();
    refreshPromptChips();
  });

  // 边填边更新：「项目名称」改一个字，步骤里的按钮也跟着改
  $("#flowVars").addEventListener("input", refreshPromptChips);
  // 检查器里任何字段改动都直接写回 draft；改名还要刷新占位符按钮
  $("#flowInspector").addEventListener("input", (event) => {
    syncInspectorToDraft();
    if (event.target.classList.contains("flow-step-name")) refreshPromptChips();
    if (event.target.classList.contains("flow-cond-option")) {
      // 改选项文案：节点卡上的出线口跟着换字换色，连线标签重画；不整块重渲染，输入框不丢焦点
      const value = event.target.value.trim();
      const portIndex = event.target.dataset.optIndex;
      const node = $(`#flowCanvas .flow-node-card[data-index="${selectedStepIndex}"]`);
      const port = node?.querySelector(`.flow-port.out[data-port="${portIndex}"]`);
      const label = node?.querySelector(`.flow-port-label[data-port="${portIndex}"]`);
      if (port && value) {
        port.dataset.branch = value;
        port.title = `${value} → 从这根线出去`;
        port.classList.remove("yes", "no", "mid");
        port.classList.add(conditionOptionClass(value));
      }
      if (label && value) label.textContent = value;
      drawFlowEdges();
    }
  });
  $("#flowInspector").addEventListener("change", (event) => {
    syncInspectorToDraft();
    // 检查点开关：勾上才显示「谁来检查 / 查什么」
    const toggle = event.target.closest(".flow-step-cp");
    if (toggle) {
      const body = toggle.closest(".flow-step")?.querySelector(".flow-cp-body");
      if (body) body.hidden = !toggle.checked;
    }
  });

  // 占位符按钮：插到光标处，光标留在插入内容之后
  $("#flowInspector").addEventListener("click", (event) => {
    const chip = event.target.closest(".flow-chip");
    if (!chip) return;
    event.preventDefault();
    const textarea = chip.closest(".flow-prompt")?.querySelector(".flow-step-prompt");
    if (!textarea) return;
    const token = chip.dataset.token ?? "";
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`;
    const caret = start + token.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    syncInspectorToDraft();
  });

  // ---------------------------------------------------- 画布编排：拖节点摆位、拖员工进来
  // 员工芯片拖到节点上 = 换人做；拖到画布空白 = 在落点新增一步
  $("#flowCanvasWrap").addEventListener("dragover", (event) => {
    if (!dragPayload) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    clearDropMarks();
    const node = event.target.closest?.(".flow-node-card");
    if (node) node.classList.add("drop-target");
  });
  $("#flowCanvasWrap").addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !$("#flowCanvasWrap").contains(event.relatedTarget)) clearDropMarks();
  });
  $("#flowCanvasWrap").addEventListener("drop", (event) => {
    if (!dragPayload || !["agent", "condition"].includes(dragPayload.kind)) return;
    event.preventDefault();
    const payload = dragPayload;
    dragPayload = null;
    const node = event.target.closest?.(".flow-node-card");
    clearDropMarks();
    if (payload.kind === "agent" && node) {
      const index = Number(node.dataset.index);
      const step = flowDraft.steps[index];
      if (step?.kind === "condition") {
        $("#flowNote").textContent = "条件节点由它自己判断，不用换人；要换就在右侧「谁来判断」里选";
        renderFlowSteps();
        return;
      }
      flowDraft.steps[index] = { ...step, agentMode: "fixed", agentId: payload.agentId };
      renderFlowSteps();
      toast(`「${step.name}」改由 ${agentNameOf(payload.agentId)} 来做`);
      return;
    }
    // 落在空白：新节点出现在松手的位置（条件节点拖到节点上也按空白处理）
    const canvas = $("#flowCanvas");
    const box = canvas.getBoundingClientRect();
    const pos = {
      x: Math.max(8, event.clientX - box.left + $("#flowCanvasWrap").scrollLeft - 90),
      y: Math.max(8, event.clientY - box.top + $("#flowCanvasWrap").scrollTop - 30),
    };
    if (payload.kind === "condition") appendConditionNode(pos);
    else appendStepWithAgent(payload.agentId, pos);
  });

  // ---------------------------------------------------- 从出端口拖到入端口 = 拉一条执行线
  // 加这条线前先查环、查重复；条件节点每个选项一个出线口，拖哪个口分支就定哪个选项。
  $("#flowCanvas").addEventListener("pointerdown", (event) => {
    const port = event.target.closest(".flow-port.out");
    if (!port || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const card = port.closest(".flow-node-card");
    const fromIndex = Number(card.dataset.index);
    const fromStep = flowDraft.steps[fromIndex];
    if (!fromStep) return;
    const branch = port.dataset.branch || "";
    const canvas = $("#flowCanvas");
    const canvasBox = canvas.getBoundingClientRect();
    readFlowStepsFromDom();
    const from = portAnchor(card, "out", branch);
    const move = (moveEvent) => {
      drawFlowEdges({
        from,
        to: {
          x: moveEvent.clientX - canvasBox.left + $("#flowCanvasWrap").scrollLeft,
          y: moveEvent.clientY - canvasBox.top + $("#flowCanvasWrap").scrollTop,
        },
      });
      // 悬停目标节点高亮，提示「松手就连这里」
      const hovered = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.(".flow-node-card");
      $$("#flowCanvas .flow-node-card").forEach((item) => item.classList.toggle("drop-target", item === hovered && item !== card));
    };
    const finish = (upEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      const targetCard = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest?.(".flow-node-card");
      $$("#flowCanvas .flow-node-card").forEach((item) => item.classList.remove("drop-target"));
      drawFlowEdges();
      if (!targetCard || targetCard === card) return;
      const toStep = flowDraft.steps[Number(targetCard.dataset.index)];
      if (!toStep) return;
      // 环检查：加上这条线后从终点出发不能回到起点
      const reaches = (startKey, goalKey) => {
        const seen = new Set();
        const stack = [startKey];
        while (stack.length) {
          const current = stack.pop();
          if (current === goalKey) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const edge of flowDraft.edges) if (edge.from === current) stack.push(edge.to);
        }
        return false;
      };
      if (reaches(toStep.key, fromStep.key)) {
        $("#flowNote").textContent = `这条线会让流程绕回「${fromStep.name}」形成死循环，没加上`;
        return;
      }
      if (flowDraft.edges.some((edge) => edge.from === fromStep.key && edge.to === toStep.key)) {
        $("#flowNote").textContent = `「${fromStep.name}」到「${toStep.name}」之间已经有连线了`;
        return;
      }
      flowDraft.edges.push({ from: fromStep.key, to: toStep.key, branch });
      $("#flowNote").textContent = "";
      selectedEdgeIndex = flowDraft.edges.length - 1;
      selectedStepIndex = -1;
      $$("#flowCanvas .flow-node-card").forEach((item) => item.classList.remove("selected"));
      renderFlowSteps();
      toast(`已连线：${fromStep.name} → ${toStep.name}${branch ? `（${branch}）` : ""}`);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  });

  // 启动台：输入 + 选流程 + 开始，一路在当前页面完成
  $("#flowLaunch").addEventListener("submit", submitLaunch);
  // 大窗顶部那条纪要同时是折叠开关
  $("#runBoardToggle").addEventListener("click", toggleRunOpen);
  // 滑轨滚动/窗口缩放时更新右侧渐隐：滑到底就不再虚化
  $("#flowList").addEventListener("scroll", (event) => syncRailEdge(event.currentTarget), { passive: true });
  window.addEventListener("resize", () => syncRailEdge($("#flowList")), { passive: true });
  $("#flowLaunchSelect").addEventListener("change", () => {
    state.launchFlowId = $("#flowLaunchSelect").value;
    // 换流程要重建变量区：不同流程的必填项不一样，旧值不能串过去
    $("#flowLaunchVars").replaceChildren();
    renderLaunchVars();
  });
  // 输入框跟着内容长高，最多四行，别把上面的内容挤下去
  $("#flowLaunchInput").addEventListener("input", (event) => {
    const box = event.target;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 96)}px`;
  });
  // 回车提交，Shift+回车换行
  $("#flowLaunchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitLaunch(new Event("submit"));
    }
  });

  $("#runContinueBtn").addEventListener("click", () => runDetailId && actRun(runDetailId, "continue"));
  // 打回是重做一整步，误点代价不小：第一次只上膛，五秒内再点才执行
  $("#runRejectBtn").addEventListener("click", () => {
    if (!runDetailId) return;
    if (!runRejectArmed) {
      runRejectArmed = true;
      const button = $("#runRejectBtn");
      button.textContent = "再点一次：打回重做";
      button.classList.add("armed");
      clearTimeout(runRejectTimer);
      runRejectTimer = setTimeout(() => {
        runRejectArmed = false;
        button.textContent = "打回重做";
        button.classList.remove("armed");
      }, 5000);
      toast("会清掉这一步的产出并重做，前几步不受影响；再点一次确认");
      return;
    }
    runRejectArmed = false;
    clearTimeout(runRejectTimer);
    actRun(runDetailId, "reject");
  });
  $("#runRetryBtn").addEventListener("click", () => runDetailId && actRun(runDetailId, "retry"));
  $("#runIgnoreBtn").addEventListener("click", () => runDetailId && actRun(runDetailId, "ignore"));
  $("#runCancelBtn").addEventListener("click", () => runDetailId && actRun(runDetailId, "cancel"));
  // 运行详情里点「查看任务详情」复用现有抽屉，不另做一套
  $("#runSteps").addEventListener("click", async (event) => {
    const fileButton = event.target.closest(".run-file");
    if (fileButton) {
      await toggleRunFile(fileButton);
      return;
    }
    // 单步重跑：两段式确认。下游已成功的节点不会被重算，用户得知道这一点。
    const retryStepButton = event.target.closest(".run-retry-step");
    if (retryStepButton) {
      if (!runDetailId) return;
      if (!retryStepButton.classList.contains("armed")) {
        retryStepButton.dataset.backup = retryStepButton.textContent;
        retryStepButton.textContent = "再点一次确认重跑";
        retryStepButton.classList.add("armed");
        clearTimeout(retryStepTimer);
        retryStepTimer = setTimeout(() => {
          retryStepButton.classList.remove("armed");
          retryStepButton.textContent = retryStepButton.dataset.backup ?? "只重跑这一步";
        }, 4000);
        return;
      }
      clearTimeout(retryStepTimer);
      retryStepButton.classList.remove("armed");
      try {
        const run = await api(`/api/flows/runs/${runDetailId}/retry-step`, {
          method: "POST",
          body: JSON.stringify({ stepKey: retryStepButton.dataset.step }),
        });
        // 立刻重绘再开订阅：这一步的旧结论要马上消失，不能等下一轮推送
        renderRunDetail(run);
        openRunStream(runDetailId);
        toast(`已重跑「${retryStepButton.dataset.name}」`);
      } catch (error) {
        toast(`重跑失败：${error.message}`);
      }
      return;
    }
    const button = event.target.closest(".run-open-task");
    if (!button) return;
    // 面板留在原地，只是把事件流让给任务抽屉，回来时再点标签重连
    closeRunStream();
    openDrawer(button.dataset.task);
  });

  $("#runDirCopy").addEventListener("click", async () => {
    const path = $("#runDirPath").textContent;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      toast("运行目录已复制");
    } catch {
      toast("复制失败，请手动选中路径");
    }
  });

  $("#runWsCopy").addEventListener("click", async () => {
    const path = $("#runWsPath").textContent;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      toast("副本路径已复制");
    } catch {
      toast("复制失败，请手动选中路径");
    }
  });

  $("#runApplyBtn").addEventListener("click", applyRunChanges);
  $("#runDropBtn").addEventListener("click", dropRunWorkspace);
  $("#agentCancel").addEventListener("click", () => $("#agentDialog").close());
  // 关弹窗 = 放弃这次查价，别让迟到的回填写进下一次打开的表单
  $("#agentDialog").addEventListener("close", () => {
    priceFetchAbort?.abort();
    priceFetchAbort = null;
    setPriceFetchState("");
  });
  $("#agentModel").addEventListener("input", syncPriceFetchButton);
  $("#agentClearKey").addEventListener("click", () => {
    agentClearKeyPending = true;
    $("#agentApiKey").value = "";
    const keyState = $("#agentKeyState");
    keyState.className = "warn";
    keyState.textContent = "保存后将清除密钥";
    $("#agentClearKey").hidden = true;
  });

  // 表单一改，上一次的测试结论就不成立了，直接清掉，避免看着旧结果去保存
  for (const sel of ["#agentModel", "#agentBaseUrl", "#agentApiKey", "#agentName", "#agentSummary"]) {
    $(sel).addEventListener("input", () => {
      clearAgentTestResult();
      if (sel === "#agentModel") updateAdvHint();
      // 名字变了，默认头像格里的首字要跟着变
      if (sel === "#agentName" && !selectedAvatar) renderAvatarPicker("", null);
    });
  }

  bindSkillLibrary();

  $("#tokenForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = $("#tokenInput").value.trim();
    sessionStorage.setItem(LS.token, state.token);
    $("#tokenDialog").close();
    start();
  });

  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if ($("#composer").classList.contains("open")) { event.preventDefault(); submitTask({ draft: false }); }
      else if ($("#drawer").classList.contains("open")) { event.preventDefault(); sendFollowUp(); }
      return;
    }
    if (event.key === "Escape") { closeComposer(); closeDrawer(); }
    if (!typing && (event.key === "n" || event.key === "N") && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      openComposer();
    }
  });
}

/* =========================================================================
   health + polling
   ========================================================================= */
async function checkHealth() {
  try {
    const response = await fetch("/health");
    const data = await response.json();
    state.health = response.ok;
    const el = $("#gwStatus");
    el.className = `gw-status ${response.ok ? "ok" : "bad"}`;
    el.querySelector("span").textContent = response.ok
      ? `${data.codexVersion ? data.codexVersion.replace("codex-cli ", "Codex ") : "在线"}${data.running ? ` · ${data.running} 运行中` : ""}`
      : "Codex 不可用";
    renderOpsOverview();
  } catch {
    state.health = false;
    const el = $("#gwStatus");
    el.className = "gw-status bad";
    el.querySelector("span").textContent = "网关离线";
    renderOpsOverview();
  }
}

/* =========================================================================
   start
   ========================================================================= */
async function start() {
  if (!state.token) {
    $("#tokenDialog").showModal();
    return;
  }
  try {
    await bootstrap();
    setView("dashboard");
    checkHealth();
    loadFlows();
    // 平台已配置时顺手把云端目录拉一次：用户切到「工作方法」就能看到有货没货
    loadHubSkills();
    ensureFlowPolling();
    setInterval(() => refreshTasks(), 4000);
    setInterval(refreshStats, 60_000);
    setInterval(checkHealth, 20_000);
  } catch (error) {
    toast(error.message);
    if (!state.token) $("#tokenDialog").showModal();
  }
}

wire();
start();
