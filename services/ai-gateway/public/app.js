/* =========================================================================
   工作台 · front end
   Vanilla ES modules, no build step. The gateway serves this folder with a
   strict CSP, so: no inline handlers, no inline styles from HTML.
   ========================================================================= */

import { renderCollabPanel } from "./collab.js";
import { renderCollabPage } from "./collab-page.js";
import { renderPeopleSection } from "./people.js";
import { confirmDialog, promptDialog, infoDialog, openDialog } from "./dialog.js";

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
  // 系统员工（本机 CLI 执行位）只对管理员开放，其他人的派活下拉里只放自己的员工
  isAdmin: false,
  // 我的模型池（地址 + Key + 上游模型名），员工引用它
  myModels: [],
  myAgents: [],
  tasks: [],
  counts: {},
  stats: null,
  // 执行器在线状态（导航绿点与执行器页共用）
  runners: [],
  view: "worksite",
  // 任务页内部的页签：临时任务（adhoc）/ 流程编排（flows）
  worksiteTab: "adhoc",
  adhocFilter: "all",
  adhocAgent: "",
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

// 子模块（人员与账号等）不 import app.js，用事件把提示递过来
document.addEventListener("wb-toast", (event) => toast(event.detail ?? ""));

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
// 我的员工（ua- 开头）和平台内置员工可能撞名，找名字时两个清单都查一遍
// 员工被删掉后，历史流程/记录里只剩 id：别把裸 id 当名字显示出来
const agentNameOf = (id = "codex") => {
  const known = agentById(id)?.name ?? (state.myAgents ?? []).find((agent) => agent.id === id)?.name;
  if (known) return known;
  return String(id).startsWith("ua-") ? "已删除的员工" : id;
};

/** 我的员工清单：派活下拉和员工页共用这一份缓存。401/离线时静默置空。 */
async function loadMyAgents() {
  try {
    const data = await api("/api/user-agents");
    state.myAgents = data.items ?? [];
  } catch {
    state.myAgents = [];
  }
  renderMyAgents();
  // 员工清单是异步到的，流程编辑器的员工面板要跟着补一次
  if (state.view === "worksite") {
    renderFlowPalette();
    // 临时任务的「交给」下拉也要补：刚建的员工得能立刻被选到
    if ((state.worksiteTab ?? "adhoc") === "adhoc") renderAdhocAgents();
  }
}

/** 模型池：员工弹窗的「选模型」和设置页的模型卡都读这一份。 */
async function loadMyModels() {
  try {
    const data = await api("/api/models");
    state.myModels = data.items ?? [];
  } catch {
    state.myModels = [];
  }
  renderMyModels();
}

const modelById = (id) => (state.myModels ?? []).find((item) => item.id === id) ?? null;

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
    // 平台账号体系：会话失效直接回登录页
    if (window.parent !== window) window.parent.postMessage({type:"ai-error",message:"登录已失效，请重新登录平台。"},location.origin);
    else location.replace("/login");
    throw new Error("未登录");
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
  state.isAdmin = boot.isAdmin === true;
  state.myModels = boot.models ?? [];
  state.service = boot.service ?? null;
  state.tasks = boot.tasks;
  state.counts = boot.counts;
  state.stats = boot.stats;
  state.skills = boot.skills ?? [];
  state.hub = boot.hub ?? null;
  // 版本与更新：当前版本、有没有新版、上次检查结果
  state.update = boot.update ?? null;
  for (const task of boot.tasks) state.known.set(task.id, task.status);
  loadMyAgents(); // 异步补齐「我的员工」，到了再刷下拉和卡片
  loadMyModels(); // 模型池同理：员工弹窗要用
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
    state.stats = await api("/api/stats?days=7");
    renderSidebar();
    if (state.view === "settings") renderSettings();
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
  const section = view === "flowEdit" ? "worksite" : view;
  if (["worksite","collab","artifacts","templates","runner","stats","settings"].includes(section)) {
    history.replaceState(null, "", "#" + section);
    if (window.parent !== window) window.parent.postMessage({ type: "ai-view", view: section }, location.origin);
  }
  $(".app").dataset.view = view;
  // 流程编辑页在视觉上属于「任务」，导航高亮归到任务位
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === (view === "flowEdit" ? "worksite" : view)));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view${view[0].toUpperCase()}${view.slice(1)}`));
  const titles = {
    worksite: ["任务执行", "说清要做什么：临时派给一个员工，或走一条编排流程"],
    flowEdit: ["流程编排", "整页编排，右侧配置每一步"],
    artifacts: ["产出库", "按文件取件，并定位到来源任务"],
    collab: ["协作", "成员本机智能体推来的产物与动态，全组汇总"],
    stats: ["统计", "按人员汇总 AI 执行数据（仅管理人员）"],
    runner: ["执行器", "我这台电脑接单跑什么、跑到哪一步、还允许碰哪些目录"],
    templates: ["工作方法", "卡片管理本机与云端的工作方法"],
    settings: ["设置", "我的 AI 员工、执行器、网关与本机偏好"],
  };
  $("#viewTitle").textContent = titles[view]?.[0] ?? "工作台";
  $("#viewSub").textContent = titles[view]?.[1] ?? "";
  if (view === "worksite") {
    applyWorksiteTab();
    // 临时任务：只刷派活表单和最近列表，不碰流程
    if ((state.worksiteTab ?? "adhoc") === "adhoc") {
      renderAdhoc();
    } else {
      renderFlows();
      loadFlows({ quiet: false });
      refreshLaunchProjects();
      if (state.runTabId) openRunStream(state.runTabId);
    }
  }
  if (view === "stats") renderStats();
  if (view === "artifacts") renderArtifacts();
  if (view === "collab") renderCollabPage();
  if (view === "templates") renderSkillLibrary();
  if (view !== "worksite") {
    // 离开流程页就断流，别在后台空转
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
  // 执行器页：进来就轮询（执行器心跳 2.5 秒一次，4 秒刷新足够跟手），离开就停
  if (view === "runner") {
    stopRunnerPoll();
    refreshTasks({ quiet: true }).then(() => renderRunnerPage()).catch(() => renderRunnerPage());
    runnerPollTimer = setInterval(() => {
      if (state.view !== "runner") return stopRunnerPoll();
      renderRunnerPage({ quiet: true });
    }, RUNNER_POLL_MS);
  } else {
    stopRunnerPoll();
  }
}

function renderBoard() {
  if (state.view !== "worksite") return;
  // 两个页签各自有渲染入口：临时任务刷列表就行，流程页要推启动台+详情
  if ((state.worksiteTab ?? "adhoc") === "adhoc") {
    // bootstrap 落地晚于首渲染：下拉还是空的话这里补一次
    if (!$("#adhocAgent")?.options.length) renderAdhocAgents();
    renderAdhocList();
  } else {
    renderFlows();
  }
}

/* =========================================================================
   任务页页签：临时任务（说一句就派活）/ 流程编排
   ========================================================================= */

function applyWorksiteTab() {
  const tab = state.worksiteTab ?? "adhoc";
  $$("#wsTabs .ws-tab").forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  const adhoc = $("#wsPaneAdhoc");
  const flows = $("#wsPaneFlows");
  if (adhoc) adhoc.hidden = tab !== "adhoc";
  if (flows) flows.hidden = tab !== "flows";
  // 启动台属于流程：临时任务时收起来，页面别一半是别人家的东西
  const launch = $("#flowLaunch");
  if (launch) launch.hidden = tab !== "flows";
}

function gotoWorksiteTab(tab) {
  state.worksiteTab = tab;
  if (state.view !== "worksite") {
    setView("worksite");
    return;
  }
  applyWorksiteTab();
  if (tab === "flows") {
    renderFlows();
    loadFlows({ quiet: false });
    if (state.runTabId) openRunStream(state.runTabId);
  } else {
    // 离开流程页签就断流，别在后台空转
    if (runDetailId) {
      closeRunStream();
      clearInterval(runTicker);
      runTicker = null;
    }
    renderAdhoc();
  }
}

/* ---- 临时任务：一句话派活 ---- */

const ADHOC_ACTIVE = ["queued", "running", "waiting_approval", "waiting_user", "approval_required"];
const ADHOC_DONE = ["completed", "failed", "cancelled", "interrupted"];

/** 派活候选：我的员工（可用）在前；系统员工是网关本机的执行位，只给管理员看。 */
function adhocAgentChoices() {
  const list = [];
  for (const agent of state.myAgents ?? []) {
    if (!agent.enabled) continue;
    // 副标题优先显示角色：一眼知道该派给谁
    list.push({ value: `ua:${agent.id}`, label: agent.name, hint: agent.role || "我的员工" });
  }
  if (!state.isAdmin) return list;
  for (const agent of state.boot?.agents ?? []) {
    list.push({
      value: `sys:${agent.id}`,
      label: agent.name,
      hint: agent.available ? "系统员工" : "未接入",
      disabled: !agent.available,
    });
  }
  return list;
}

function adhocWho(task) {
  if (String(task?.agent ?? "").startsWith("ua-")) {
    return (state.myAgents ?? []).find((agent) => agent.id === task.agent)?.name ?? "我的员工";
  }
  return agentNameOf(task?.agent);
}

function renderAdhocAgents() {
  const select = $("#adhocAgent");
  if (!select) return;
  const choices = adhocAgentChoices();
  const current = select.value || state.adhocAgent || "";
  select.replaceChildren();
  if (!choices.length) {
    select.append(new Option(state.isAdmin ? "还没有可派活的员工" : "还没有自己的 AI 员工 · 去「设置」添加", ""));
    return;
  }
  for (const choice of choices) {
    const option = new Option(`${choice.label} · ${choice.hint}`, choice.value);
    option.disabled = Boolean(choice.disabled);
    select.append(option);
  }
  // 沿用上次选的；那位被删/停用了就落到第一个能用的
  const usable = choices.find((choice) => !choice.disabled && choice.value === current)
    ?? choices.find((choice) => !choice.disabled);
  if (usable) select.value = usable.value;
}

async function refreshAdhocProjects() {
  const select = $("#adhocProject");
  const wrap = $("#adhocProjectWrap");
  if (!select) return;
  try {
    const data = await api("/api/collab/projects");
    const items = data.items ?? [];
    if (!items.length) {
      wrap?.setAttribute("hidden", "");
      return;
    }
    wrap?.removeAttribute("hidden");
    const current = select.value;
    select.replaceChildren(
      new Option("不归档", ""),
      ...items.map((item) => new Option(item.name || item.title || item.id, item.id)),
    );
    if (current && items.some((item) => item.id === current)) select.value = current;
  } catch {
    wrap?.setAttribute("hidden", "");
  }
}

/** 从工作方法库点「派活」过来时，这里显示挂上的方法；点 × 摘掉。 */
function renderAdhocSkills() {
  const box = $("#adhocSkills");
  if (!box) return;
  const names = state.composer.skills ?? [];
  box.hidden = !names.length;
  box.innerHTML = names.map((name) => `
    <span class="adhoc-skill">${esc(name)}<button type="button" data-drop-skill="${esc(name)}" aria-label="摘掉 ${esc(name)}">×</button></span>`).join("");
  box.querySelectorAll("[data-drop-skill]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.composer.skills = (state.composer.skills ?? []).filter((name) => name !== btn.dataset.dropSkill);
      renderAdhocSkills();
    });
  });
}

function adhocTasks() {
  // 流程里拆出来的步骤任务（domain=flow）归流程页的执行记录，这里列单任务派活
  return state.tasks.filter((task) => task.domain !== "flow" && !["draft", "archived"].includes(task.status));
}

function renderAdhocTabs() {
  const box = $("#adhocTabs");
  if (!box) return;
  const list = adhocTasks();
  const active = state.adhocFilter ?? "all";
  const buckets = {
    all: list.length,
    active: list.filter((task) => ADHOC_ACTIVE.includes(task.status)).length,
    done: list.filter((task) => ADHOC_DONE.includes(task.status)).length,
  };
  const labels = { all: "全部", active: "进行中", done: "已结束" };
  box.replaceChildren(...["all", "active", "done"].map((key) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `lib-tab${active === key ? " active" : ""}`;
    btn.innerHTML = `${labels[key]}<i>${buckets[key]}</i>`;
    btn.addEventListener("click", () => {
      state.adhocFilter = key;
      renderAdhocList();
    });
    return btn;
  }));
}

function renderAdhocList() {
  renderAdhocTabs();
  const box = $("#adhocList");
  const count = $("#adhocCount");
  if (!box) return;
  const filter = state.adhocFilter ?? "all";
  const rows = adhocTasks().filter((task) => (
    filter === "active" ? ADHOC_ACTIVE.includes(task.status)
      : filter === "done" ? ADHOC_DONE.includes(task.status)
        : true
  ));
  if (count) count.textContent = rows.length ? `${rows.length} 条` : "";
  if (!rows.length) {
    box.innerHTML = `<div class="empty-state"><b>还没有临时任务</b><span>上面写一句话、选个员工，就能派活</span></div>`;
    return;
  }
  box.innerHTML = rows.slice(0, 30).map((task) => {
    const pill = `<span class="state-pill ${TASK_TONE[task.status] ?? "off"}">${esc(STATUS_TEXT[task.status] ?? task.status)}</span>`;
    const who = adhocWho(task);
    const when = task.status === "running"
      ? duration(task) || "刚开始"
      : relTime(task.finishedAt || task.updatedAt || task.createdAt);
    const artifacts = (task.artifacts ?? []).length;
    const conclusion = String(task.summary || task.finalResponse || "").replace(/\s+/g, " ").trim().slice(0, 70);
    const sub = conclusion || `${who} · ${when}${artifacts ? ` · ${artifacts} 个产出` : ""}`;
    return `<button type="button" class="adhoc-row" data-task="${esc(task.id)}">
      ${pill}
      <span class="adhoc-row-main"><b>${esc(task.label || "未命名任务")}</b><em>${esc(sub)}</em></span>
      <span class="adhoc-row-meta"><b>${esc(who)}</b><i>${esc(when)}${artifacts ? ` · ${artifacts} 个产出` : ""}</i></span>
      <span class="adhoc-row-open" aria-hidden="true">›</span>
    </button>`;
  }).join("");
  box.querySelectorAll("[data-task]").forEach((btn) => {
    btn.addEventListener("click", () => openDrawer(btn.dataset.task));
  });
}

function renderAdhoc() {
  renderAdhocAgents();
  refreshAdhocProjects();
  renderAdhocSkills();
  renderAdhocList();
}

async function submitAdhoc() {
  const prompt = $("#adhocPrompt")?.value.trim() ?? "";
  if (!prompt) {
    toast("先写一句要做什么");
    $("#adhocPrompt")?.focus();
    return;
  }
  const choice = $("#adhocAgent")?.value ?? "";
  if (!choice) {
    toast(state.isAdmin ? "还没有可派活的员工" : "系统员工只对管理员开放：先在「设置」里建一个自己的 AI 员工");
    return;
  }
  const body = {
    prompt,
    mode: $("#adhocWrite")?.checked ? "workspace-write" : "read-only",
  };
  // 个人员工走执行器本机跑；系统员工走网关本机
  if (choice.startsWith("ua:")) body.userAgentId = choice.slice(3);
  else if (choice.startsWith("sys:")) body.agent = choice.slice(4);
  const projectId = $("#adhocProject")?.value;
  if (projectId) body.projectId = projectId;
  if ((state.composer.skills ?? []).length) body.skills = state.composer.skills;

  const button = $("#adhocGo");
  const note = $("#adhocNote");
  if (note) { note.hidden = true; note.textContent = ""; }
  button.disabled = true;
  button.textContent = "派活中…";
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    $("#adhocPrompt").value = "";
    state.composer.skills = [];
    state.adhocAgent = choice;
    renderAdhocSkills();
    await refreshTasks({ quiet: true });
    renderAdhoc();
    toast(`已派给 ${adhocWho(task)}`);
    // 派完直接开抽屉看过程，不用再去列表里找
    openDrawer(task.id);
  } catch (error) {
    if (note) { note.hidden = false; note.textContent = error.message; }
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "派活";
  }
}

function bindAdhoc() {
  $$("#wsTabs [data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => gotoWorksiteTab(btn.dataset.tab));
  });
  $("#adhocForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAdhoc();
  });
  // Enter 派活、Shift+Enter 换行：和流程启动台一个手感
  $("#adhocPrompt")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitAdhoc();
    }
  });
}


/** 通用格式化：token 数 / 文件体积 / 能力标签（原属系统员工与看板模块，重构后全局共用）。 */
function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatSize(bytes) {
  const v = Number(bytes) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

const CAP_LABEL = {
  code: "代码执行", files: "本地文件", shell: "命令行", "office-files": "Office 文件",
  web: "联网检索", research: "联网调研", longform: "长文写作", "chinese-writing": "中文写作",
  "long-context": "超长上下文", doc: "文档理解", summarize: "归纳摘要",
};

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
  const facts = [
    ["创建", esc(relTime(task.createdAt)), new Date(task.createdAt || Date.now()).toLocaleString("zh-CN")],
    task.startedAt ? ["耗时", esc(duration(task)), ""] : null,
    usage ? ["用量", `${esc(fmtTokens(usage.totalTokens))} tokens`, ""] : null,
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
  // 系统员工是管理员的执行位；其他人只看自己的员工
  const roster = state.isAdmin
    ? (state.boot?.agents ?? []).map((agent) => ({ name: agent.name, ready: agent.available, off: "未接入" }))
    : (state.myAgents ?? []).map((agent) => ({ name: agent.name, ready: agent.enabled, off: "已停用" }));
  if (!roster.length) {
    const row = document.createElement("div");
    row.className = "ml-row";
    row.innerHTML = '<span class="status-dot cancelled"></span><span>还没有自己的 AI 员工</span><b>去设置添加</b>';
    right.append(row);
  }
  roster.forEach((agent) => {
    const row = document.createElement("div");
    row.className = "ml-row";
    row.innerHTML = `<span class="status-dot ${agent.ready ? "completed" : "cancelled"}"></span><span>${esc(agent.name)}</span><b>${agent.ready ? "可派活" : esc(agent.off)}</b>`;
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
    if (state.view === "worksite") renderFlows();
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
    renderFlows();
  }
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
      // 挂上这个方法，切到临时任务，写一句话就能派
      state.composer.skills = [skillUse];
      gotoWorksiteTab("adhoc");
      renderAdhocSkills();
      $("#adhocPrompt")?.focus();
      toast(`已挂「${skillUse}」，写一句要做什么就派活`);
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

/** 员工头像：系统员工 UI 已下线，这里只给我的员工卡片和详情抽屉用。 */
function agentAvatar(agent) {
  const key = agent?.avatar;
  if (key) return `<img src="/assets/avatars/${esc(key)}.svg" alt="">`;
  return `<span class="agent-avatar" aria-hidden="true">${esc((agent?.name || "?").trim().slice(0, 1))}</span>`;
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
    if (state.view === "worksite") renderFlows();
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
    go.textContent = state.launchBusy ? "启动中…" : "开始执行";
  }
  if (!usable.length) {
    select.replaceChildren(new Option("还没有可运行的流程", ""));
  }
  syncFlowPick(usable);
  renderLaunchVars();
}

/**
 * 启动台里的流程选择器：原生 select 只当数据源藏着，
 * 露出来的是和全站同一套描边的按钮 + 弹出列表（原生下拉在深色主题里长得完全不一样）。
 */
function syncFlowPick(usable) {
  const trigger = $("#flowPickTrigger");
  if (!trigger) return;
  const current = usable.find((flow) => flow.id === $("#flowLaunchSelect")?.value) ?? null;
  trigger.disabled = !usable.length;
  trigger.classList.toggle("empty", !current);
  const name = $("#flowPickName");
  const meta = $("#flowPickMeta");
  if (name) name.textContent = current?.name ?? "还没有流程";
  if (meta) meta.textContent = current ? `${current.steps?.length ?? 0} 步` : "";
  renderFlowPickMenu(usable);
}

function renderFlowPickMenu(usable) {
  const menu = $("#flowPickMenu");
  if (!menu) return;
  if (!usable.length) {
    menu.innerHTML = `<p class="flow-pick-empty">还没有可运行的流程，先点「新建流程」串一条</p>`;
    return;
  }
  const current = $("#flowLaunchSelect")?.value ?? "";
  menu.innerHTML = usable.map((flow) => `
    <button type="button" class="flow-pick-item${flow.id === current ? " active" : ""}"
            role="option" data-flow="${esc(flow.id)}" aria-selected="${flow.id === current}">
      <b>${esc(flow.name)}</b>
      <em>${flow.steps?.length ?? 0} 步 · v${esc(String(flow.version ?? 1))}</em>
    </button>`).join("");
}

function closeFlowPick() {
  const menu = $("#flowPickMenu");
  const trigger = $("#flowPickTrigger");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  $("#flowPick")?.classList.remove("open");
}

function toggleFlowPick() {
  const menu = $("#flowPickMenu");
  const trigger = $("#flowPickTrigger");
  if (!menu || trigger?.disabled) return;
  const open = menu.hidden;
  menu.hidden = !open;
  trigger?.setAttribute("aria-expanded", open ? "true" : "false");
  $("#flowPick")?.classList.toggle("open", open);
  if (open) menu.querySelector(".flow-pick-item.active")?.scrollIntoView({ block: "nearest" });
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

  const projectId = $("#flowLaunchProject")?.value || null;
  state.launchBusy = true;
  renderLaunch(currentFlows());
  try {
    const run = await api(`/api/flows/${flowId}/run`, {
      method: "POST",
      // 默认最安全的运行方式：复制一份再干，源目录不动
      body: JSON.stringify({ input, variables, cwd: state.boot?.defaultRoot ?? null, mode: "isolated", projectId }),
    });
    $("#flowLaunchInput").value = "";
    state.launchBusy = false;
    // 刚点了「开始」，确保大窗是展开的：人按完按钮总得看到第一步在跑
    state.runOpen = true;
    await loadFlows();
    await openRunDetail(run.id);
    toast(projectId ? `已启动「${flow.name}」，产出会自动归档进协作项目` : `已启动「${flow.name}」，正在副本里跑第一步`);
  } catch (error) {
    note.hidden = false;
    note.textContent = error.message;
  } finally {
    state.launchBusy = false;
    renderLaunch(currentFlows());
  }
}

/** 启动台「归档到」下拉：本人参与（或全部，管理员）的协作项目。拉不到就不显示。 */
async function refreshLaunchProjects() {
  const select = $("#flowLaunchProject");
  if (!select) return;
  try {
    const data = await api("/api/collab/projects");
    const items = data.items ?? [];
    if (!items.length) {
      select.closest(".flow-launch-project")?.setAttribute("hidden", "");
      return;
    }
    select.closest(".flow-launch-project")?.removeAttribute("hidden");
    const current = select.value;
    select.replaceChildren(
      new Option("不归档", ""),
      ...items.map((item) => new Option(item.name || item.title || item.id, item.id)),
    );
    if (current && items.some((item) => item.id === current)) select.value = current;
  } catch {
    select.closest(".flow-launch-project")?.setAttribute("hidden", "");
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
    const name = `${agentNameOf(step.agentId)} 来判断`;
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
      <span class="tag quiet">v${esc(String(flow.version ?? 1))}</span>
      ${flow.status === "disabled" ? `<span class="tag quiet bad">已停用</span>` : ""}
    </header>
    <div class="flow-chain">${chain}</div>`;

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
  syncFlowPick(currentFlows().filter((item) => item.status !== "disabled"));
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
  // 新流程的默认两步也挂自己的员工：全局员工跑在服务器上，普通账号根本没有执行通道
  const first = (state.myAgents ?? []).find((agent) => agent.enabled);
  const agentId = first?.id ?? "";
  return [
    {
      key: "design",
      name: "出方案",
      agentMode: "fixed",
      agentId,
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
      agentId,
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
  setView("worksite");
}

function agentOptionsHtml(selectedId) {
  // AI 员工跟账号走：流程步骤只能选自己的员工（ua- 前缀），由自己的执行器执行。
  // 不再保留「自动路由」——自动只会在服务器全局员工里挑，那类员工跑在服务器上，
  // 和「每人用自己的电脑干活」冲突。旧流程里的 auto 步骤要求重新选一次人。
  const agents = state.myAgents ?? [];
  const options = agents.map((agent) => {
    const label = `${agent.name}（${agent.kind === "builtin" ? `本机 ${agent.ref}` : agent.model || "云端"}${agent.enabled ? "" : " · 停用"}）`;
    return `<option value="${esc(agent.id)}"${agent.id === selectedId ? " selected" : ""}>${esc(label)}</option>`;
  });
  // 顺手就能建：编排时发现没有合适的员工，不用先跑去设置页
  const createOption = `<option value="__new__">＋ 新建一个我的员工…</option>`;
  if (!options.length) return `<option value="" disabled selected>还没有自己的员工</option>${createOption}`;
  const known = agents.some((agent) => agent.id === selectedId);
  if (!known) return `<option value="" disabled selected>选一个人来做这步</option>${options.join("")}${createOption}`;
  return options.join("") + createOption;
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
  // 只用「我的员工」：全局员工跑在服务器上，普通人员点了也只是个空步骤
  const agents = state.myAgents ?? [];
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
    chip.innerHTML = `<b>${esc(agent.name)}</b><em>${esc(agent.summary || (agent.kind === "builtin" ? `本机 ${agent.ref}` : agent.model || "云端模型"))}</em>`;
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
  // 一个员工都没有时，给个能直接建的入口，不用绕去设置页
  if (!agents.length) {
    const tip = document.createElement("button");
    tip.type = "button";
    tip.className = "flow-agent-chip is-empty";
    tip.innerHTML = "<b>＋ 还没有员工</b><em>点一下建一个，再回来加步骤</em>";
    tip.addEventListener("click", () => openMyAgentDialog(null, () => renderFlowPalette()));
    chips.push(tip);
  }
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
    agentId: agentId || "",
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
  const agents = (state.myAgents ?? []).filter((agent) => agent.enabled);
  const step = {
    key: `step${n}`,
    name: `条件判断 ${flowDraft.steps.filter((item) => item.kind === "condition").length + 1}`,
    kind: "condition",
    agentMode: "fixed",
    agentId: agents[0]?.id ?? "",
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
      <div class="flow-node-agent" title="谁来做">${esc(agentNameOf(step.agentId))}</div>
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
  // 检查点也用「我的员工」：全局员工跑在服务器上，和个人员工的执行通道不是一回事
  const inspectorOptions = [
    `<option value=""${cp.agentId ? "" : " selected"}>我自己看（只停一下）</option>`,
    ...(state.myAgents ?? []).map((agent) => `<option value="${esc(agent.id)}"${cp.agentId === agent.id ? " selected" : ""}>${esc(agent.name)}</option>`),
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
  step.agentMode = "fixed";
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
    node.querySelector(".flow-node-agent").textContent = agentNameOf(step.agentId);
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
    if (state.view !== "worksite") setView("worksite");
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
    if (state.view !== "worksite") return;
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
          <span class="run-step-agent">${esc(step.agentId ? agentNameOf(step.agentId) : "—")}</span>
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
    if (state.view !== "worksite") return;
    loadFlows({ quiet: true });
  }, 15_000);
}

/* =========================================================================
   stats view（管理员）：按人员汇总 AI 执行数据
   ========================================================================= */
async function renderStats() {
  const table = $("#statsTable");
  if (!table) return;
  let items = state.tasks ?? [];
  try {
    items = (await api("/api/tasks?range=all")).items ?? [];
  } catch (error) {
    table.innerHTML = `<p class="empty-state">读取任务数据失败：${esc(error.message)}</p>`;
    return;
  }
  const byOwner = new Map();
  for (const task of items) {
    const key = task.ownerAccountId || "(无主/历史)";
    const row = byOwner.get(key) ?? { name: task.ownerName || "（历史任务）", total: 0, done: 0, failed: 0, busy: 0, tokens: 0, ms: 0 };
    row.total += 1;
    if (task.status === "completed") row.done += 1;
    if (["failed", "interrupted"].includes(task.status)) row.failed += 1;
    if (["running", "queued"].includes(task.status)) row.busy += 1;
    const usage = task.usage ?? {};
    row.tokens += Number(usage.totalTokens ?? 0);
    const started = new Date(task.startedAt || task.createdAt || 0).getTime();
    const ended = new Date(task.finishedAt || task.updatedAt || 0).getTime();
    if (task.status === "completed" && ended > started) row.ms += ended - started;
    byOwner.set(key, row);
  }
  const rows = [...byOwner.values()].sort((x, y) => y.total - x.total);
  if (!rows.length) {
    table.innerHTML = `<p class="empty-state">还没有任务数据。</p>`;
    return;
  }
  const fmtMs = (ms) => ms >= 3600_000 ? `${Math.floor(ms / 3600_000)} 小时 ${Math.round((ms % 3600_000) / 60_000)} 分` : ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
  table.innerHTML = `
    <table class="stats-table-inner"><thead><tr>
      <th>人员</th><th>任务数</th><th>完成</th><th>失败</th><th>进行中</th><th>累计 Tokens</th><th>累计执行时长</th>
    </tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b></td><td class="mono">${r.total}</td>
      <td class="mono ok">${r.done}</td><td class="mono ${r.failed ? "bad" : ""}">${r.failed}</td>
      <td class="mono">${r.busy}</td><td class="mono">${r.tokens ? fmtTokens(r.tokens) : "—"}</td>
      <td class="mono">${r.ms ? fmtMs(r.ms) : "—"}</td>
    </tr>`).join("")}
    </tbody></table>`;
}
/* =========================================================================
   settings view
   ========================================================================= */

/* ---- 设置页 · 我的员工：挂在账号下、在自己电脑的执行器上跑 ---- */
/* =========================================================================
   设置页 · 我的模型（模型池）
   一个模型 = 接口地址 + Key + 上游模型名。配一次，多个员工共用；
   同模型被多位员工同时派活时，按「同时执行数」排队（默认 1）。
   ========================================================================= */
const shortUrl = (url) => {
  const text = String(url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
};

function renderMyModels() {
  const box = $("#myModelList");
  if (!box) return;
  const list = state.myModels ?? [];
  const summary = $("#myModelSummary");
  if (summary) summary.textContent = list.length ? `${list.length} 个 · 可被多位员工共用` : "还没配模型";
  if (!list.length) {
    box.innerHTML = `<div class="empty-state ua-empty">
      <b>还没配模型</b>
      <span>模型就是<strong>接口地址 + Key + 上游模型名</strong>：配一次，员工都选它，不用每个人重填一遍 Key。</span>
      <em>同一个模型被多位员工共用时，按「同时执行数」排队（默认 1 = 排队）</em>
    </div>`;
    return;
  }
  box.replaceChildren(...list.map(renderMyModelCard));
}

function renderMyModelCard(model) {
  const card = document.createElement("article");
  card.className = `agent-card ua-card${model.enabled ? "" : " bucket-off"}`;
  card.innerHTML = `
    <header class="agent-card-head">
      <div class="agent-ident">
        <h3>${esc(model.name)}</h3>
        <p class="mono" title="${esc(model.baseUrl)}">${esc(model.model)} · ${esc(shortUrl(model.baseUrl))}</p>
      </div>
    </header>
    <div class="agent-tags">
      <span class="tag state ${model.enabled ? "ready" : "off"}">${model.enabled ? "启用" : "停用"}</span>
      ${model.apiKeyMasked
        ? `<span class="tag quiet ok">${esc(model.apiKeyMasked)}</span>`
        : `<span class="tag quiet bad">未配置密钥</span>`}
      <span class="tag quiet" title="同一个模型同时最多跑几个任务">并发 ${Number(model.concurrency) || 1}</span>
      <span class="tag ${model.agentCount ? "cap" : "quiet"}"
            title="${esc((model.agentNames ?? []).join("、") || "还没有员工选它")}">${model.agentCount ? `${model.agentCount} 位员工在用` : "还没有员工用"}</span>
    </div>`;
  const ops = document.createElement("div");
  ops.className = "ua-ops";
  const button = (label, cls, fn) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", fn);
    return btn;
  };
  ops.append(
    button("编辑", "agent-edit", () => openMyModelDialog(model)),
    button(model.enabled ? "停用" : "启用", "agent-edit", async () => {
      try {
        await api(`/api/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !model.enabled }) });
        toast(model.enabled ? "已停用：用它的员工暂时派不出活" : "已启用");
        await loadMyModels();
        await loadMyAgents();
      } catch (error) { toast(error.message); }
    }),
    button("删除", "agent-edit ua-danger", async () => {
      const ok = await confirmDialog({
        title: "删除模型",
        message: model.agentCount
          ? `「${model.name}」还有 ${model.agentCount} 位员工在用，先给它们换模型再删。`
          : `删除「${model.name}」？地址和 Key 会一起删掉。`,
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api(`/api/models/${model.id}`, { method: "DELETE" });
        toast("已删除");
        await loadMyModels();
      } catch (error) { toast(error.message); }
    }),
  );
  card.append(ops);
  return card;
}

function openMyModelDialog(model, onDone) {
  const creating = !model;
  const form = {
    baseUrl: model?.baseUrl ?? "",
    model: model?.model ?? "",
    maxOutputTokens: model?.maxOutputTokens ?? 16384,
    concurrency: model?.concurrency ?? 1,
    fetched: [],
  };

  const body = `
    <div class="ua-dlg">
      <label class="ua-field">
        <span>模型名称<em>自己看得懂就行</em></span>
        <input class="wb-dlg-input" id="mdName" maxlength="30" autocomplete="off" data-dlg-autofocus
               value="${esc(model?.name ?? "")}" placeholder="如：自建网关 · Claude">
      </label>

      <div class="ua-block">
        <div class="ua-block-head"><b>接口地址</b><em>兼容 OpenAI /chat/completions 的 Base URL</em></div>
        <input class="wb-dlg-input" id="mdBaseUrl" autocomplete="off" value="${esc(form.baseUrl)}"
               placeholder="http://172.16.131.10:9001/v1">
      </div>

      <div class="ua-block">
        <div class="ua-block-head"><b>API Key</b><em>加密存在服务器，只在派活瞬间发给执行器</em></div>
        <div class="ua-keyrow">
          <input class="wb-dlg-input" id="mdKey" type="password" autocomplete="off"
                 placeholder="${model?.apiKeyMasked ? `留空保持原 Key（当前 ${esc(model.apiKeyMasked)}）` : "粘贴网关的 Key"}">
          <button type="button" class="ua-eye" id="mdKeyEye">显示</button>
        </div>
      </div>

      <div class="ua-block">
        <div class="ua-block-head">
          <b>模型</b>
          <em id="mdModelsHint">填好地址和 Key 后点「↻ 拉取」，也可以直接填</em>
          <button type="button" class="ua-pull" id="mdPullBtn" title="从 {Base URL}/models 拉取可用模型">↻ 拉取</button>
        </div>
        <div class="ua-models" id="mdModels" hidden></div>
        <input class="wb-dlg-input" id="mdModel" autocomplete="off" value="${esc(form.model)}"
               placeholder="上游模型名，如 Claude-Fable-5.1">
      </div>

      <div class="ua-adv-row">
        <label class="ua-field">
          <span>最大输出 tokens</span>
          <input class="wb-dlg-input" id="mdMaxTokens" type="number" min="256" max="65536" step="256"
                 value="${Number(form.maxOutputTokens) || 16384}">
        </label>
        <label class="ua-field">
          <span>同时执行数<em>1 = 排队</em></span>
          <input class="wb-dlg-input" id="mdConcurrency" type="number" min="1" max="8" step="1"
                 value="${Number(form.concurrency) || 1}">
        </label>
      </div>
      <p class="wb-dlg-hint" style="margin:-4px 0 0">同一个模型被多位员工共用时，超出的任务会在队列里等，不会一起打爆网关。</p>

      <div class="ua-testrow">
        <button type="button" class="btn" id="mdTestBtn">测试连接</button>
        <span class="agent-test" id="mdTestOut">保存前先测一次，通了再用</span>
      </div>
      <p class="wb-dlg-hint bad" id="mdError" hidden></p>
    </div>`;

  openDialog({
    title: creating ? "新增模型" : `编辑模型 · ${model.name}`,
    subtitle: "模型与员工分开管：这里配一次地址和 Key，员工只选模型",
    width: 640,
    body,
    footer: `<button class="btn" data-dlg-cancel>取消</button>
             <button class="btn primary" data-dlg-ok>${creating ? "创建模型" : "保存"}</button>`,
    onMount: ({ panel, close }) => {
      const q = (sel) => panel.querySelector(sel);
      const errEl = q("#mdError");
      const fail = (message) => { errEl.hidden = false; errEl.textContent = message; };
      const ok = () => { errEl.hidden = true; errEl.textContent = ""; };

      const paintModels = () => {
        const current = q("#mdModel").value.trim();
        panel.querySelectorAll("#mdModels [data-model]").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.model === current);
        });
      };
      const renderModels = () => {
        const box = q("#mdModels");
        const models = form.fetched;
        box.hidden = !models.length;
        box.innerHTML = models.map((name) => `
          <button type="button" class="ua-model-chip${q("#mdModel").value.trim() === name ? " active" : ""}" data-model="${esc(name)}">${esc(name)}</button>`).join("");
        box.querySelectorAll("[data-model]").forEach((btn) => {
          btn.addEventListener("click", () => {
            q("#mdModel").value = btn.dataset.model;
            paintModels();
          });
        });
      };
      q("#mdModel").addEventListener("input", paintModels);

      // 保存时 Key 留空 → 用已存的那把（服务端解密，只在那一个请求里用）
      const keyOf = () => q("#mdKey").value.trim();
      const probePayload = (extra = {}) => {
        const payload = {
          baseUrl: q("#mdBaseUrl").value.trim(),
          apiKey: keyOf(),
          model: q("#mdModel").value.trim(),
          ...extra,
        };
        if (!payload.apiKey && !creating) payload.modelId = model.id;
        return payload;
      };

      q("#mdKeyEye").addEventListener("click", () => {
        const input = q("#mdKey");
        const shown = input.type === "text";
        input.type = shown ? "password" : "text";
        q("#mdKeyEye").textContent = shown ? "显示" : "隐藏";
      });

      q("#mdPullBtn").addEventListener("click", async () => {
        const btn = q("#mdPullBtn");
        const hint = q("#mdModelsHint");
        const baseUrl = q("#mdBaseUrl").value.trim();
        if (!baseUrl) {
          hint.textContent = "先填接口地址";
          q("#mdBaseUrl").focus();
          return;
        }
        if (!keyOf() && creating) {
          hint.textContent = "先填 API Key 再拉取";
          q("#mdKey").focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = "拉取中…";
        hint.textContent = `正在请求 ${baseUrl.replace(/\/+$/, "")}/models …`;
        try {
          const result = await api("/api/models/pull", { method: "POST", body: JSON.stringify(probePayload()) });
          if (result.ok) {
            form.fetched = result.models ?? [];
            hint.textContent = `拉到 ${form.fetched.length} 个模型，点一下即选`;
            if (!form.fetched.includes(q("#mdModel").value.trim())) q("#mdModel").value = form.fetched[0] ?? "";
            renderModels();
            paintModels();
          } else {
            hint.textContent = result.error || "拉取失败";
          }
        } catch (error) {
          hint.textContent = error.message;
        } finally {
          btn.disabled = false;
          btn.textContent = "↻ 拉取";
        }
      });

      q("#mdTestBtn").addEventListener("click", async () => {
        const btn = q("#mdTestBtn");
        const out = q("#mdTestOut");
        if (!q("#mdBaseUrl").value.trim()) {
          out.className = "agent-test bad";
          out.textContent = "先填接口地址";
          return;
        }
        if (!keyOf() && creating) {
          out.className = "agent-test bad";
          out.textContent = "先填 API Key";
          return;
        }
        if (!q("#mdModel").value.trim()) {
          out.className = "agent-test bad";
          out.textContent = "先选或填一个模型";
          return;
        }
        btn.disabled = true;
        btn.textContent = "测试中…";
        out.className = "agent-test";
        out.textContent = "正在请求…";
        try {
          const result = await api("/api/models/test", { method: "POST", body: JSON.stringify(probePayload()) });
          if (result.ok) {
            out.className = "agent-test ok";
            out.textContent = `连接正常 · ${result.latencyMs}ms${result.sample ? ` · 回「${result.sample}」` : ""}`;
          } else {
            out.className = "agent-test bad";
            out.textContent = result.error || "连接失败";
          }
        } catch (error) {
          out.className = "agent-test bad";
          out.textContent = error.message;
        } finally {
          btn.disabled = false;
          btn.textContent = "测试连接";
        }
      });

      q("[data-dlg-ok]").addEventListener("click", async () => {
        ok();
        const name = q("#mdName").value.trim();
        const baseUrl = q("#mdBaseUrl").value.trim();
        const modelName = q("#mdModel").value.trim();
        const key = keyOf();
        if (!name) return q("#mdName").focus(), fail("先给模型起个名字");
        if (!baseUrl) return q("#mdBaseUrl").focus(), fail("先填接口地址");
        if (!modelName) return q("#mdModel").focus(), fail("先选或填一个模型");
        if (creating && !key) return q("#mdKey").focus(), fail("新增模型要填 API Key");
        const payload = {
          name,
          baseUrl,
          model: modelName,
          maxOutputTokens: Number(q("#mdMaxTokens").value) || 16384,
          concurrency: Number(q("#mdConcurrency").value) || 1,
        };
        if (key) payload.apiKey = key;
        const button = q("[data-dlg-ok]");
        button.disabled = true;
        try {
          const saved = creating
            ? await api("/api/models", { method: "POST", body: JSON.stringify(payload) })
            : await api(`/api/models/${model.id}`, { method: "PATCH", body: JSON.stringify(payload) });
          close(true);
          toast(creating ? `已创建模型「${saved?.name ?? name}」` : "模型已保存");
          await loadMyModels();
          await loadMyAgents();
          if (state.view === "settings") renderSettings();
          onDone?.(saved ?? null);
        } catch (error) {
          button.disabled = false;
          fail(error.message);
        }
      });
      renderModels();
    },
  });
}

function renderMyAgents() {
  const box = $("#myAgentList");
  if (!box) return;
  const list = state.myAgents ?? [];
  const summary = $("#myAgentSummary");
  if (summary) summary.textContent = `${list.length} 位 · 跟随本账号`;
  if (!list.length) {
    box.innerHTML = `<div class="empty-state ua-empty">
      <b>还没有自己的员工</b>
      <span>点右上角「＋ 新增我的员工」：<strong>云端模型</strong>选一家厂商、填一次 API Key 就能派活；<strong>本机执行位</strong>用你电脑上已装的 Codex / Claude / DeepSeek Harness。</span>
      <em>员工挂在你的账号下，只在你自己的执行器上跑</em>
    </div>`;
    return;
  }
  box.replaceChildren(...list.map(renderMyAgentCard));
}

function renderMyAgentCard(agent) {
  const local = agent.kind === "builtin";
  // 云端员工的模型在模型池里：卡片显示模型名 + 上游模型，不再显示 Key（Key 归模型管）
  const bound = !local && agent.modelId ? modelById(agent.modelId) : null;
  const vendor = local
    ? (agent.ref === "claude" ? "Claude Code" : agent.ref === "dsh" ? "DeepSeek Harness" : "Codex CLI")
    : (bound?.name ?? presetOfBase(agent.baseUrl)?.label);
  const upstream = bound?.model || agent.model || "";
  const skillCount = (agent.skills ?? []).length;
  const card = document.createElement("article");
  card.className = `agent-card ua-card${agent.enabled ? "" : " bucket-off"}`;
  card.innerHTML = `
    <header class="agent-card-head">
      ${agentAvatar({ name: agent.name, avatar: agent.avatar })}
      <div class="agent-ident">
        <h3>${esc(agent.name)}</h3>
        <p>${esc(agent.role || agent.summary || (local ? "在本机执行器上跑命令行 AI" : "云端模型 · 会搜索、读写文件，还能自己装工具跑命令"))}</p>
      </div>
    </header>
    <div class="agent-tags">
      <span class="tag state ${agent.enabled ? "ready" : "off"}">${agent.enabled ? "启用" : "停用"}</span>
      ${vendor ? `<span class="tag quiet">${esc(vendor)}</span>` : ""}
      ${upstream ? `<span class="tag quiet mono" title="上游模型名">${esc(upstream)}</span>` : ""}
      ${!local && !bound ? `<span class="tag quiet bad">没绑模型</span>` : ""}
      ${!local && bound && !bound.enabled ? `<span class="tag quiet bad">模型已停用</span>` : ""}
      ${!local ? `<span class="tag ${agent.tools === false ? "quiet" : "cap"}" title="${agent.tools === false ? "已关闭工具：只会纯文本回答" : "联网搜索、读网页、白名单内文件读写，并能在执行器本机跑命令、自己安装工具（run_cmd）"}">${agent.tools === false ? "无工具" : "联网·文件·命令"}</span>` : ""}
      ${skillCount ? `<span class="tag cap" title="${esc((agent.skills ?? []).join("、"))}">${skillCount} 个工作方法</span>` : ""}
      ${agent.defaultMode === "read-only" ? `<span class="tag quiet" title="派活时默认只读，不会改文件">只读</span>` : ""}
      ${(agent.capabilities ?? []).slice(0, 2).map((cap) => `<span class="tag cap">${esc(CAP_LABEL[cap] ?? cap)}</span>`).join("")}
    </div>`;
  const ops = document.createElement("div");
  ops.className = "ua-ops";
  const button = (label, cls, fn) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", fn);
    return btn;
  };
  ops.append(
    button("编辑", "agent-edit", () => openMyAgentDialog(agent)),
    button(agent.enabled ? "停用" : "启用", "agent-edit", async () => {
      try {
        await api(`/api/user-agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }) });
        toast(agent.enabled ? "已停用" : "已启用");
        await loadMyAgents();
        if (state.view === "settings") renderSettings();
      } catch (error) { toast(error.message); }
    }),
    button("删除", "agent-edit ua-danger", async () => {
      const ok = await confirmDialog({ title: "删除员工", message: `删除「${agent.name}」？删除后历史任务记录还在，但不能再派活。`, tone: "danger" });
      if (!ok) return;
      try {
        await api(`/api/user-agents/${agent.id}`, { method: "DELETE" });
        toast("已删除");
        await loadMyAgents();
        if (state.view === "settings") renderSettings();
      } catch (error) { toast(error.message); }
    }),
  );
  card.append(ops);
  return card;
}

/* 个人员工的能力标签：只影响卡片上那排小标签，不影响派活逻辑 */
const UA_CAP_OPTIONS = ["chinese-writing", "longform", "doc", "code", "research", "long-context", "summarize"];

/** 云端厂商预设（OpenAI 兼容那一批）。 */
function cloudPresets() {
  return (state.boot?.agentPresets ?? []).filter((preset) => !preset.local);
}

/** 磁贴第二行只说「在哪」：内网用户最在意的是这个地址通不通。 */
const PRESET_REGION = { cn: "国内直连", aggregate: "聚合平台", global: "海外直连", local: "本机离线" };

/** 本机 CLI 预设（Codex / Claude），带 installed 标记。 */
function localPresets() {
  return (state.boot?.agentPresets ?? []).filter((preset) => preset.local);
}

/** 从 Base URL 反查是哪家：卡片上显示厂商名，比显示「云端」有意义。 */
function presetOfBase(baseUrl) {
  const url = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!url) return null;
  return cloudPresets().find((preset) => preset.baseUrl.replace(/\/+$/, "") === url) ?? null;
}

/**
 * 新建/编辑我的员工。
 * 交互对标原来的系统员工面板：头像 → 名称 → 类型 → 服务商磁贴 → 模型 → Key → 测试连接，
 * 地址、输出上限这类技术字段收进「高级设置」，第一次建的人不用被它们挡住。
 */
function openMyAgentDialog(agent, onDone) {
  const creating = !agent;
  const clis = localPresets();
  const avatars = state.boot?.avatars ?? [];
  const models = state.myModels ?? [];
  const skills = state.skills ?? [];
  // 有模型默认走云端（解耦后不用填 Key）；一台模型都没有才退回本机位
  const cliReady = clis.some((preset) => preset.installed);
  const form = {
    kind: agent?.kind ?? (models.length ? "openai" : cliReady ? "builtin" : "openai"),
    ref: agent?.ref ?? "codex",
    avatar: agent?.avatar ?? "",
    modelId: agent?.modelId ?? models[0]?.id ?? "",
    role: agent?.role ?? "",
    duties: agent?.duties ?? "",
    skills: [...(agent?.skills ?? [])],
    defaultMode: agent?.defaultMode ?? "workspace-write",
    tools: agent?.tools !== false,
    capabilities: agent?.capabilities?.length ? [...agent.capabilities] : [...UA_CAP_OPTIONS],
  };

  const body = `
    <div class="ua-dlg">
      <div class="ua-idrow">
        <span class="ua-avatar-lg" id="uaAvatarLg" aria-hidden="true">${esc((agent?.name || "?").trim().slice(0, 1))}</span>
        <label class="ua-name">
          <span>员工名称</span>
          <input class="wb-dlg-input" id="uaName" maxlength="20" autocomplete="off" data-dlg-autofocus
                 value="${esc(agent?.name ?? "")}" placeholder="如：标书工程师小陈">
        </label>
      </div>

      <div class="ua-avrow" id="uaAvatars" role="radiogroup" aria-label="员工头像">
        <button type="button" class="avatar-pick${form.avatar ? "" : " on"}" data-avatar="" title="用名字首字">
          <span class="avatar-frame"><span class="avatar-letter" id="uaLetter">${esc((agent?.name || "?").trim().slice(0, 1))}</span></span>
          <em>首字</em>
        </button>
        ${avatars.map((item) => `
          <button type="button" class="avatar-pick${form.avatar === item.key ? " on" : ""}" data-avatar="${esc(item.key)}" title="${esc(item.label)}">
            <span class="avatar-frame"><img src="/assets/avatars/${esc(item.key)}.svg" alt=""></span>
            <em>${esc(item.label)}</em>
          </button>`).join("")}
      </div>

      ${creating ? `
      <div class="ua-seg" id="uaKind" role="tablist" aria-label="员工类型">
        <button type="button" class="ua-seg-btn${form.kind === "openai" ? " active" : ""}" data-kind="openai" role="tab">
          云端模型<em>选一个模型，配好角色职责就能派活</em>
        </button>
        <button type="button" class="ua-seg-btn${form.kind === "builtin" ? " active" : ""}" data-kind="builtin" role="tab">
          本机执行位<em>用你电脑上已装的 CLI</em>
        </button>
      </div>` : `
      <p class="ua-kindline">类型：<b>${form.kind === "builtin" ? `本机执行位 · ${esc(form.ref === "claude" ? "Claude Code" : form.ref === "dsh" ? "DeepSeek Harness" : "Codex CLI")}` : "云端模型"}</b><em>创建后不可改，要换类型请新建一位</em></p>`}

      <div class="ua-pane" id="uaPaneCloud">
        <div class="ua-block">
          <div class="ua-block-head">
            <b>用哪个模型</b>
            <em>模型管地址和 Key，员工只管人格与技能</em>
            <button type="button" class="ua-pull" id="uaNewModel" title="地址和 Key 只配一次，之后所有员工都能选">＋ 新建模型</button>
          </div>
          <div class="ua-models" id="uaModelList"></div>
          <p class="ua-model-pick" id="uaModelInfo"></p>
          <!-- 内联新建模型：不另开弹窗，建完直接选中，已填的人设不会丢 -->
          <div class="ua-newmodel" id="uaNewModelPane" hidden>
            <div class="ua-adv-row">
              <label class="ua-field">
                <span>模型名称</span>
                <input class="wb-dlg-input" id="uaMdName" maxlength="30" placeholder="如：自建网关 · Claude">
              </label>
              <label class="ua-field">
                <span>上游模型名</span>
                <input class="wb-dlg-input" id="uaMdModelName" placeholder="如：Claude-Fable-5.1">
              </label>
            </div>
            <label class="ua-field">
              <span>接口地址<em>兼容 OpenAI /chat/completions</em></span>
              <input class="wb-dlg-input" id="uaMdBase" placeholder="http://172.16.131.10:9001/v1">
            </label>
            <label class="ua-field">
              <span>API Key<em>加密存在服务器</em></span>
              <input class="wb-dlg-input" id="uaMdKey" type="password" autocomplete="off" placeholder="粘贴网关的 Key">
            </label>
            <div class="ua-testrow">
              <button type="button" class="ua-pull" id="uaMdPull">↻ 拉取模型</button>
              <button type="button" class="btn primary" id="uaMdSave">保存并选用</button>
              <span class="agent-test" id="uaMdHint"></span>
            </div>
            <div class="ua-models" id="uaMdModels" hidden></div>
          </div>
        </div>
      </div>

      <div class="ua-pane" id="uaPaneLocal" hidden>
        <div class="ua-block">
          <div class="ua-block-head"><b>执行程序</b><em>跑在你自己电脑的执行器上，服务器不碰你的代码</em></div>
          <div class="ua-clis" id="uaClis"></div>
        </div>
      </div>

      <div class="ua-block ua-persona">
        <div class="ua-block-head">
          <b>人设</b>
          <em>角色和职责会写进系统提示，每次派活都带着；工作方法自动挂上，不用每次重挂</em>
        </div>
        <label class="ua-field">
          <span>角色<em>一句话说清它是谁</em></span>
          <input class="wb-dlg-input" id="uaRole" maxlength="40" autocomplete="off"
                 value="${esc(form.role)}" placeholder="如：资深投标文件工程师">
        </label>
        <label class="ua-field">
          <span>职责<em>写清做什么、不做什么，比「能力标签」管用</em></span>
          <textarea class="wb-dlg-input ua-duties" id="uaDuties" rows="3" maxlength="800"
                    placeholder="负责技术标的结构、参数对齐与偏离说明；商务条款和报价不碰，遇到就标出来让人确认。">${esc(form.duties)}</textarea>
        </label>
        <div class="ua-field">
          <span>挂载工作方法<em>${skills.length ? "派活时自动带上，不用每次勾" : "还没有工作方法：去「工作方法」里加一个"}</em></span>
          <div class="agent-caps" id="uaSkills"></div>
        </div>
        <div class="ua-adv-row">
          <label class="ua-field">
            <span>默认文件权限</span>
            <select class="wb-dlg-input" id="uaDefaultMode">
              <option value="workspace-write"${form.defaultMode === "workspace-write" ? " selected" : ""}>可写（能改文件）</option>
              <option value="read-only"${form.defaultMode === "read-only" ? " selected" : ""}>只读（只看不改）</option>
            </select>
          </label>
          <label class="ua-field ua-tools-field" id="uaToolsWrap">
            <span>基础工具</span>
            <span class="ua-tools-toggle">
              <input type="checkbox" id="uaTools"${form.tools ? " checked" : ""}>
              <em>联网 · 读网页 · 文件读写 · 跑命令装工具</em>
            </span>
          </label>
        </div>
      </div>

      <details class="agent-adv" id="uaAdv">
        <summary><b>能力标签</b><em>只影响卡片展示，不改变行为</em></summary>
        <div class="ua-adv-body">
          <div class="ua-field">
            <div class="agent-caps" id="uaCaps"></div>
          </div>
        </div>
      </details>

      <label class="ua-field ua-summary">
        <span>一句话说明<em>可空</em></span>
        <input class="wb-dlg-input" id="uaSummary" maxlength="40" value="${esc(agent?.summary ?? "")}" placeholder="这位员工擅长什么，例如：中文长文与文档归纳">
      </label>
      <p class="wb-dlg-hint bad" id="uaError" hidden></p>
    </div>`;

  openDialog({
    title: creating ? "新增 AI 员工" : `编辑 · ${agent.name}`,
    subtitle: "员工 = 人格 + 技能 + 一个模型；模型在「我的模型」里配一次，多个员工共用",
    width: 640,
    body,
    footer: `<button class="btn" data-dlg-cancel>取消</button>
             <button class="btn primary" data-dlg-ok>${creating ? "创建员工" : "保存"}</button>`,
    onMount: ({ panel, close }) => {
      const q = (sel) => panel.querySelector(sel);
      const errEl = q("#uaError");
      const fail = (message) => { errEl.hidden = false; errEl.textContent = message; };
      const ok = () => { errEl.hidden = true; errEl.textContent = ""; };

      /* ---- 头像 ---- */
      const paintAvatar = () => {
        const lg = q("#uaAvatarLg");
        if (!lg) return;
        lg.innerHTML = form.avatar
          ? `<img src="/assets/avatars/${esc(form.avatar)}.svg" alt="">`
          : esc((q("#uaName").value.trim() || "?").slice(0, 1));
        panel.querySelectorAll("[data-avatar]").forEach((btn) => {
          btn.classList.toggle("on", (btn.dataset.avatar || "") === form.avatar);
        });
      };
      panel.querySelectorAll("[data-avatar]").forEach((btn) => {
        btn.addEventListener("click", () => { form.avatar = btn.dataset.avatar || ""; paintAvatar(); });
      });
      q("#uaName").addEventListener("input", () => {
        const letter = q("#uaLetter");
        if (letter) letter.textContent = (q("#uaName").value.trim() || "?").slice(0, 1);
        if (!form.avatar) paintAvatar();
      });

      /* ---- 类型：云端 / 本机 ---- */
      const syncKind = () => {
        q("#uaPaneCloud").hidden = form.kind !== "openai";
        q("#uaPaneLocal").hidden = form.kind !== "builtin";
        q("#uaToolsWrap").hidden = form.kind !== "openai";
        panel.querySelectorAll("#uaKind .ua-seg-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.kind === form.kind);
          btn.setAttribute("aria-selected", btn.dataset.kind === form.kind ? "true" : "false");
        });
      };
      panel.querySelectorAll("#uaKind .ua-seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => { form.kind = btn.dataset.kind; syncKind(); });
      });
      syncKind();

      /* ---- 本机执行位：Codex / Claude / DSH ---- */
      const codexReady = (state.boot?.agents ?? []).some((item) => item.id === "codex" && item.available);
      const claudePreset = clis.find((preset) => preset.cli === "claude");
      const dshPreset = clis.find((preset) => preset.cli === "dsh");
      const cliCards = [
        { cli: "codex", label: "Codex CLI", note: "执行器检测到 codex 命令即可派活", installed: codexReady },
        { cli: "claude", label: "Claude Code", note: "执行器检测到 claude 命令即可派活", installed: Boolean(claudePreset?.installed) },
        { cli: "dsh", label: "DeepSeek Harness", note: "执行器检测到 dsh 且设了 DEEPSEEK_API_KEY 才能派活", installed: Boolean(dshPreset?.installed) },
      ];
      q("#uaClis").innerHTML = cliCards.map((item) => `
        <button type="button" class="ua-cli-card${form.ref === item.cli ? " active" : ""}" data-cli="${item.cli}">
          <b>${esc(item.label)}</b>
          <em>${esc(item.note)}</em>
          <i class="${item.installed ? "ok" : "warn"}">${item.installed ? "本机已检测到" : "本机未检测到"}</i>
        </button>`).join("");
      panel.querySelectorAll("#uaClis [data-cli]").forEach((btn) => {
        btn.addEventListener("click", () => {
          form.ref = btn.dataset.cli;
          panel.querySelectorAll("#uaClis [data-cli]").forEach((item) => {
            item.classList.toggle("active", item.dataset.cli === form.ref);
          });
        });
      });

      /* ---- 选模型：模型池里的清单，点一下即选 ---- */
      const renderModelPick = () => {
        const box = q("#uaModelList");
        const info = q("#uaModelInfo");
        if (!models.length) {
          box.hidden = true;
          info.innerHTML = "还没有模型：点右上角「＋ 新建模型」，地址和 Key 只配这一次。";
          return;
        }
        box.hidden = false;
        box.innerHTML = models.map((model) => `
          <button type="button" class="ua-model-chip${form.modelId === model.id ? " active" : ""}"
                  data-pick-model="${esc(model.id)}"${model.enabled ? "" : " data-off=\"1\""}
                  title="${esc(`${model.model} · ${model.baseUrl}`)}">${esc(model.name)}${model.enabled ? "" : "（停用）"}</button>`).join("");
        box.querySelectorAll("[data-pick-model]").forEach((btn) => {
          btn.addEventListener("click", () => {
            form.modelId = btn.dataset.pickModel;
            box.querySelectorAll("[data-pick-model]").forEach((item) => {
              item.classList.toggle("active", item.dataset.pickModel === form.modelId);
            });
            paintModelInfo();
          });
        });
        paintModelInfo();
      };
      const paintModelInfo = () => {
        const info = q("#uaModelInfo");
        const model = models.find((item) => item.id === form.modelId);
        if (!model) {
          info.textContent = "选一个模型：它决定用哪家网关、哪个上游模型。";
          return;
        }
        info.innerHTML = `<span class="mono">${esc(model.model)}</span> · ${esc(shortUrl(model.baseUrl))} · 并发 ${Number(model.concurrency) || 1}${model.enabled ? "" : " · <b class=\"bad\">已停用，暂时派不出活</b>"}`;
      };
      renderModelPick();

      /* ---- 内联新建模型：建完直接选中，员工弹窗里填的东西不丢 ---- */
      const pane = q("#uaNewModelPane");
      q("#uaNewModel").addEventListener("click", () => {
        pane.hidden = !pane.hidden;
        if (!pane.hidden) q("#uaMdName").focus();
      });

      q("#uaMdPull").addEventListener("click", async () => {
        const btn = q("#uaMdPull");
        const hint = q("#uaMdHint");
        const baseUrl = q("#uaMdBase").value.trim();
        const apiKey = q("#uaMdKey").value.trim();
        if (!baseUrl) { hint.textContent = "先填接口地址"; return; }
        if (!apiKey) { hint.textContent = "先填 API Key"; return; }
        btn.disabled = true;
        btn.textContent = "拉取中…";
        hint.textContent = "正在请求 /models …";
        try {
          const result = await api("/api/models/pull", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }) });
          if (!result.ok) { hint.textContent = result.error || "拉取失败"; return; }
          const box = q("#uaMdModels");
          box.hidden = !result.models.length;
          box.innerHTML = result.models.map((name) => `<button type="button" class="ua-model-chip" data-md-model="${esc(name)}">${esc(name)}</button>`).join("");
          box.querySelectorAll("[data-md-model]").forEach((item) => {
            item.addEventListener("click", () => {
              q("#uaMdModelName").value = item.dataset.mdModel;
              box.querySelectorAll("[data-md-model]").forEach((one) => one.classList.toggle("active", one === item));
            });
          });
          if (!q("#uaMdModelName").value.trim() && result.models.length) q("#uaMdModelName").value = result.models[0];
          hint.textContent = `拉到 ${result.models.length} 个模型，点一个填入`;
        } catch (error) {
          hint.textContent = error.message;
        } finally {
          btn.disabled = false;
          btn.textContent = "↻ 拉取模型";
        }
      });

      q("#uaMdSave").addEventListener("click", async () => {
        const hint = q("#uaMdHint");
        const name = q("#uaMdName").value.trim();
        const modelName = q("#uaMdModelName").value.trim();
        const baseUrl = q("#uaMdBase").value.trim();
        const apiKey = q("#uaMdKey").value.trim();
        if (!name) { hint.textContent = "先给模型起个名字"; return; }
        if (!modelName) { hint.textContent = "先填上游模型名"; return; }
        if (!baseUrl) { hint.textContent = "先填接口地址"; return; }
        if (!apiKey) { hint.textContent = "先填 API Key"; return; }
        const btn = q("#uaMdSave");
        btn.disabled = true;
        try {
          const created = await api("/api/models", { method: "POST", body: JSON.stringify({ name, model: modelName, baseUrl, apiKey }) });
          if (!models.some((item) => item.id === created.id)) models.push(created);
          form.modelId = created.id;
          renderModelPick();
          pane.hidden = true;
          toast(`已创建模型「${created.name}」，员工将用它`);
          await loadMyModels();
        } catch (error) {
          hint.textContent = error.message;
        } finally {
          btn.disabled = false;
        }
      });

      /* ---- 挂载工作方法：员工级技能 ---- */
      const renderSkills = () => {
        const box = q("#uaSkills");
        if (!skills.length) {
          box.innerHTML = `<span class="agent-hint">工作方法库里还没有技能，可以先去「工作方法」加一个。</span>`;
          return;
        }
        box.innerHTML = skills.map((skill) => `
          <label class="cap-chip"><input type="checkbox" value="${esc(skill.name)}"${form.skills.includes(skill.name) ? " checked" : ""}><span>${esc(skill.title || skill.name)}</span></label>`).join("");
        box.querySelectorAll("input").forEach((input) => {
          input.addEventListener("change", () => {
            form.skills = [...box.querySelectorAll("input:checked")].map((item) => item.value);
          });
        });
      };
      renderSkills();

      /* ---- 能力标签 ---- */
      const renderCaps = () => {
        const box = q("#uaCaps");
        box.innerHTML = UA_CAP_OPTIONS.map((cap) => `
          <label class="cap-chip"><input type="checkbox" value="${esc(cap)}"${form.capabilities.includes(cap) ? " checked" : ""}><span>${esc(CAP_LABEL[cap] ?? cap)}</span></label>`).join("");
        box.querySelectorAll("input").forEach((input) => {
          input.addEventListener("change", () => {
            form.capabilities = [...box.querySelectorAll("input:checked")].map((item) => item.value);
          });
        });
      };
      renderCaps();

      q("[data-dlg-ok]").addEventListener("click", async () => {
        ok();
        const name = q("#uaName").value.trim();
        if (!name) return q("#uaName").focus(), fail("先给员工起个名字");
        const payload = {
          name,
          summary: q("#uaSummary").value.trim(),
          avatar: form.avatar,
          role: q("#uaRole").value.trim(),
          duties: q("#uaDuties").value.trim(),
          skills: form.skills,
          defaultMode: q("#uaDefaultMode").value,
        };
        if (form.kind === "builtin") {
          payload.kind = "builtin";
          payload.ref = form.ref;
        } else {
          if (!form.modelId) return fail("先选一个模型：没有就去「我的模型」新建一个");
          if (creating) payload.kind = "openai";
          payload.modelId = form.modelId;
          payload.tools = q("#uaTools").checked;
          payload.capabilities = form.capabilities;
        }
        const button = q("[data-dlg-ok]");
        button.disabled = true;
        try {
          const saved = creating
            ? await api("/api/user-agents", { method: "POST", body: JSON.stringify(payload) })
            : await api(`/api/user-agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(payload) });
          close(true);
          toast(creating ? `已创建「${saved?.name ?? name}」` : "已保存");
          await loadMyAgents();
          if (state.view === "settings") renderSettings();
          onDone?.(saved ?? null);
        } catch (error) {
          button.disabled = false;
          fail(error.message);
        }
      });
      paintAvatar();
    },
  });
}

/* ---- 设置页 · 我的执行器：谁的本机执行器在线、正跑什么 ---- */
async function renderRunnerCard() {
  const box = $("#runnerCard");
  const summary = $("#runnerSummary");
  if (!box) return;
  let items = [];
  try {
    items = (await api("/api/runner/status")).items ?? [];
  } catch { /* 未登录等：保持占位 */ }
  const online = items.filter((item) => item.online);
  const isAdmin = state.user?.role === "admin";
  if (summary) {
    summary.textContent = isAdmin && items.length
      ? `在线 ${online.length} / 共 ${items.length} 台`
      : items.length
        ? `${online.length} 台在线 · 共 ${items.length} 台`
        : "还没启动过执行器";
  }

  if (!items.length) {
    box.innerHTML = `
      <p class="ppl-note">执行器跑在你自己的电脑上：领任务 → 用本机 Codex 执行 → 回传产物。服务器只记账，不碰你的代码和额度。</p>
      <pre class="runner-cmd">node runner-agent.mjs init --server http://网关地址:4317 --token 你的推送Token
node runner-agent.mjs start</pre>
      <p class="ppl-note">推送 Token 在「人员与账号」里；init 一次即可，之后 start 常驻领活。</p>`;
    return;
  }
  box.innerHTML = `${isAdmin && items.length > 1 ? `<p class="ppl-note">全平台执行器总览：<strong>${online.length} 台在线 / 共 ${items.length} 台</strong>。只有你能看到别人的执行器，成员只能看见自己这台。</p>` : ""}
  <section class="set-card">${items.map((item) => {
    const runningLabel = item.currentTaskId
      ? state.tasks.find((task) => task.id === item.currentTaskId)?.label ?? item.currentTaskId.slice(0, 8)
      : null;
    const roots = item.roots ?? [];
    return `
    <div class="set-row">
      <span><i class="runner-dot ${item.online ? "on" : ""}"></i>${esc(item.accountName)}</span>
      <b>${item.online ? "在线" : "离线"} · ${esc(item.platform || "—")} · v${esc(item.version || "?")}</b>
      <em>${esc(item.host || "")} · 最近心跳 ${esc(relTime(item.lastSeen))}${runningLabel ? ` · 正在跑「${esc(runningLabel)}」` : ""}${roots.length ? ` · 目录 ${roots.length} 个` : ""}</em>
    </div>`;
  }).join("")}</section>`;
}

/* ---- 平台侧目录白名单编辑：本人或管理员改完，执行器下次心跳生效 ---- */
async function openRunnerRootsDialog(accountId) {
  const isSelf = !accountId || accountId === state.user?.id;
  let current = [];
  try {
    const data = await api(`/api/runner-prefs${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
    current = data.roots ?? [];
  } catch (error) {
    toast(error.message);
    return;
  }
  const rowsHtml = (list) => list.map((root, index) => `
    <div class="roots-edit-row">
      <input class="wb-dlg-input" data-root-input value="${esc(root)}" placeholder="绝对路径，如 C:\\Users\\xx\\Documents">
      <button type="button" class="set-action danger" data-root-del="${index}">删除</button>
    </div>`).join("");
  openDialog({
    title: "目录白名单（平台覆盖）",
    subtitle: isSelf ? "管住 AI 在你这台电脑上能碰哪里" : `管理 ${accountId}`,
    width: 560,
    body: `
      <div id="rootsEditList">${rowsHtml(current) || `<p class="ppl-note">还没有设置，执行器会用本机白名单。</p>`}</div>
      <button type="button" class="set-action" id="rootsAdd">＋ 加一行</button>
      <p class="ppl-note">留空并保存 = 清除平台覆盖，执行器回到本机白名单。任务的工作目录必须落在生效白名单里，越界直接拒绝。</p>`,
    footer: `<button class="btn" data-dlg-cancel>取消</button><button class="btn primary" data-dlg-ok>保存</button>`,
    onMount: ({ panel, close }) => {
      const list = panel.querySelector("#rootsEditList");
      const rows = () => [...list.querySelectorAll(".roots-edit-row")];
      panel.querySelector("#rootsAdd").addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "roots-edit-row";
        row.innerHTML = `<input class="wb-dlg-input" data-root-input placeholder="绝对路径，如 C:\\Users\\xx\\Documents">
          <button type="button" class="set-action danger" data-root-del="-1">删除</button>`;
        list.append(row);
        bindRow(row);
      });
      const bindRow = (row) => {
        row.querySelector("[data-root-del]").addEventListener("click", () => row.remove());
      };
      rows().forEach(bindRow);
      panel.querySelector("[data-dlg-ok]").addEventListener("click", async () => {
        const roots = rows()
          .map((row) => row.querySelector("[data-root-input]").value.trim())
          .filter(Boolean);
        try {
          await api("/api/runner-prefs", {
            method: "PUT",
            body: JSON.stringify({ accountId: accountId || undefined, roots }),
          });
          close(true);
          toast("已保存，执行器下一次心跳生效");
          await refreshRunnerStatus();
          await renderRunnerPage({ quiet: true });
          renderRunnerCard();
        } catch (error) {
          toast(error.message);
        }
      });
    },
  });
}

/* ---- 执行器页：我的执行器在线状态 / 正在执行 / 最近任务 / 运行配置 ---- */
const RUNNER_POLL_MS = 4000;
let runnerPollTimer = null;

/** 执行器在线状态：全局 15 秒刷一次，导航绿点和执行器页共用这份数据。 */
async function refreshRunnerStatus() {
  try {
    state.runners = (await api("/api/runner/status")).items ?? [];
  } catch {
    state.runners = [];
  }
  const dot = $("#navRunnerDot");
  if (dot) dot.hidden = !state.runners.some((item) => item.online);
  return state.runners;
}

function stopRunnerPoll() {
  if (runnerPollTimer) {
    clearInterval(runnerPollTimer);
    runnerPollTimer = null;
  }
}

/** 这台执行器跑过的任务（远程 + 归属该账号），最近优先。 */
function runnerTasksOf(accountId) {
  return (state.tasks ?? [])
    .filter((task) => task.runner === "remote" && task.ownerAccountId === accountId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function renderRunnerTaskRow(task) {
  const label = task.label || task.prompt?.slice(0, 60) || "未命名任务";
  return `
    <button type="button" class="rp-task" data-task="${esc(task.id)}">
      <i class="rp-task-dot ${esc(task.status)}"></i>
      <span class="rp-task-copy">
        <strong>${esc(label)}</strong>
        <small>${esc(STATUS_TEXT[task.status] ?? task.status)} · ${esc(duration(task) || "—")} · ${esc(relTime(task.finishedAt || task.updatedAt || task.createdAt))}</small>
      </span>
      <span class="rp-task-go">查看</span>
    </button>`;
}

function wireRunnerPair(box) {
  if (!state.user?.integration || !box || box.querySelector('[data-runner-pair]')) return;
  const button = document.createElement("button");
  button.type = "button"; button.className = "primary"; button.dataset.runnerPair = "";
  button.textContent = "连接我的执行器";
  button.onclick = async () => {
    button.disabled = true;
    try {
      const data = await api("/api/runner/bootstrap-code", { method: "POST", body: "{}" });
      await infoDialog({ title: "连接我的执行器", subtitle: "在本机执行器运行 init，粘贴下方配置码，再启动执行器。",
        bodyHtml: `<p>配置码 10 分钟有效，只能兑换一次。兑换后，旧的执行器凭证立即失效。</p><pre class="runner-cmd">node runner-agent.mjs init
node runner-agent.mjs start</pre><textarea rows="5" readonly aria-label="执行器配置码">${esc(data.packed)}</textarea>`, okText: "完成" });
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };
  box.prepend(button);
}

async function renderRunnerPage({ quiet = false } = {}) {
  const box = $("#runnerPage");
  if (!box) return;
  let items = [];
  try {
    items = await refreshRunnerStatus();
  } catch (error) {
    if (!quiet) box.innerHTML = `<div class="rp-card rp-empty">读取执行器状态失败：${esc(error.message)}</div>`;
    return;
  }

  const svc = state.boot?.service ?? {};
  const serverLabel = state.boot?.runnerBase || `${svc.host === "0.0.0.0" ? "本机 IP" : svc.host ?? "127.0.0.1"}:${svc.port ?? 4317}`;

  if (!items.length) {
    box.innerHTML = `
      <div class="rp-hero">
        <div class="rp-hero-main">
          <span class="rp-state"><i class="runner-dot"></i>还没有执行器上线</span>
          <h2>在你自己的电脑上跑，平台只派活、只收结果</h2>
          <p>解压分发包 → 双击「启动执行器.bat」→ 按提示填服务器地址和个人 Token。窗口常驻后这里就会出现这台机器。</p>
        </div>
        <div class="rp-hero-side">
          <div class="rp-kv"><span>服务器</span><b class="mono">${esc(serverLabel)}</b></div>
          <div class="rp-kv"><span>Token 在哪</span><b>设置 · 人员与账号 · 换 Token</b></div>
        </div>
      </div>
      <div class="rp-card">
        <header><h3>第一次装</h3></header>
        <pre class="runner-cmd">node runner-agent.mjs init --server http://${esc(svc.host === "0.0.0.0" ? "服务器IP" : svc.host ?? "127.0.0.1")}:${svc.port ?? 4317} --token 你的推送Token
node runner-agent.mjs run</pre>
        <p class="ppl-note">更省事的方式：直接用分发包里的「启动执行器.bat」，首次运行会自动问你四个问题。</p>
      </div>`;
    wireRunnerPair(box);
    return;
  }

  box.innerHTML = items.map((item) => {
    const tasks = runnerTasksOf(item.accountId);
    const running = item.currentTaskId ? tasks.find((task) => task.id === item.currentTaskId) : null;
    const recent = tasks.slice(0, 8);
    const okCount = tasks.filter((task) => task.status === "completed").length;
    const failCount = tasks.filter((task) => task.status === "failed").length;
    const onlineFor = (() => {
      if (!item.online || !item.since) return "—";
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(item.since)) / 1000));
      if (seconds < 60) return `${seconds} 秒`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
      return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
    })();
    const codex = item.codex;
    const roots = item.roots ?? [];

    return `
    <div class="rp-hero">
      <div class="rp-hero-main">
        <span class="rp-state ${item.online ? "on" : ""}"><i class="runner-dot ${item.online ? "on" : ""}"></i>${item.online ? "在线" : "离线"}</span>
        <h2>${esc(item.accountName)} 的执行器</h2>
        <p>${item.online
          ? `已在岗 ${esc(onlineFor)}，每 2.5 秒领一次活。最近心跳 ${esc(relTime(item.lastSeen))}。`
          : `最近一次心跳 ${esc(relTime(item.lastSeen))}，现在联系不上。去本机看看执行器窗口是不是被关了。`}</p>
      </div>
      <div class="rp-hero-side">
        <div class="rp-kv"><span>版本 / 系统</span><b>v${esc(item.version || "?")} · ${esc(item.platform || "—")}</b></div>
        <div class="rp-kv"><span>服务器地址</span><b class="mono">${esc(serverLabel)}</b></div>
        <div class="rp-kv"><span>Codex</span><b class="${codex ? (codex.ok ? "ok" : "bad") : ""}">${codex ? (codex.ok ? esc(codex.version || "就绪") : "未检测到") : "未上报"}</b></div>
        <div class="rp-kv"><span>DSH</span><b class="${item.dsh ? (item.dsh.ok ? (item.dsh.apiKey ? "ok" : "bad") : "bad") : ""}">${item.dsh ? (item.dsh.ok ? (item.dsh.apiKey ? `就绪${item.dsh.version ? ` · ${esc(item.dsh.version)}` : ""}` : "已装但缺 DEEPSEEK_API_KEY") : "未检测到") : "未上报"}</b></div>
        <div class="rp-kv"><span>累计</span><b>成功 ${okCount} · 失败 ${failCount}</b></div>
      </div>
    </div>

    <div class="rp-grid">
      <div class="rp-card">
        <header><h3>正在执行</h3><span class="rp-hint">${running ? esc(STATUS_TEXT[running.status] ?? running.status) : "空闲"}</span></header>
        ${running
          ? `<div class="rp-running">
               <strong>${esc(running.label || running.prompt?.slice(0, 60) || "未命名任务")}</strong>
               <small>${esc(duration(running) || "刚开始")} · ${esc(running.model || (running.agent?.startsWith("ua-") ? (state.myAgents ?? []).find((a) => a.id === running.agent)?.name ?? "我的员工" : agentNameOf(running.agent)))}</small>
               <div class="rp-run-ops">
                 <button type="button" class="set-action" data-runner-open="${esc(running.id)}">看实时输出</button>
                 <button type="button" class="set-action danger" data-runner-cancel="${esc(running.id)}">取消任务</button>
               </div>
             </div>`
          : `<p class="ppl-empty">当前没有任务，空闲待命。</p>
             <div class="rp-run-ops"><button type="button" class="set-action" data-runner-dispatch>去任务页派活</button></div>`}
      </div>

      <div class="rp-card">
        <header><h3>运行配置</h3><span class="rp-hint">目录白名单管住 AI 能碰哪里</span></header>
        ${roots.length ? `<div class="rp-kv"><span>本机白名单（${roots.length} 个）</span></div>
        <div class="root-list">${roots.map((root) => `<code title="${esc(root)}">${esc(root)}</code>`).join("")}</div>` : ""}
        ${(() => {
          const override = item.rootsOverride;
          const note = override
            ? "平台侧已设置覆盖：上面这份本机白名单会被忽略，以下面的为准。"
            : "平台侧暂未覆盖，上面这份本机白名单就是生效配置。";
          return `
        <div class="rp-kv"><span>平台覆盖</span><b>${override ? `生效（${override.length} 个）` : "未设置"}</b></div>
        ${override?.length ? `<div class="root-list root-list-override">${override.map((root) => `<code title="${esc(root)}">${esc(root)}</code>`).join("")}</div>` : ""}
        <p class="ppl-note">${note} 改完保存，执行器下一次心跳（约 4 秒）自动拿走，不用去本机重跑 init。</p>
        <div class="rp-run-ops">
          <button type="button" class="set-action" data-runner-roots="${esc(item.accountId)}">在平台上改目录</button>
        </div>`;
        })()}
        <details class="rp-roots-help">
          <summary>为什么会看到两份目录？</summary>
          <p class="ppl-note"><strong>① 本机白名单</strong>：执行器装好时在你自己电脑上配置的（<code>node runner-agent.mjs init</code> 里填的那份），是这台机器的出厂设置。</p>
          <p class="ppl-note"><strong>② 平台覆盖</strong>：在网页上按人设置的目录，存在服务器上，执行器每次心跳都会同步。两份同时存在时<strong>以平台覆盖为准</strong>——这样管理员或你自己不用跑到每台电脑前改配置。</p>
          <p class="ppl-note">任务的工作目录必须落在生效的那份白名单里，越界直接拒绝执行。</p>
        </details>
        <div class="rp-kv"><span>Token</span><b class="mono">只存哈希，平台无法回显</b></div>
      </div>
    </div>

    <div class="rp-card">
      <header><h3>最近任务</h3><span class="rp-hint">这台执行器跑的，点一行看详情</span></header>
      ${recent.length ? `<div class="rp-tasks">${recent.map(renderRunnerTaskRow).join("")}</div>` : `<p class="ppl-empty">还没有任务。去「任务」里派一个，执行员工选自己的本机员工。</p>`}
    </div>`;
  }).join("");

  box.querySelectorAll("[data-task]").forEach((btn) => {
    btn.addEventListener("click", () => openDrawer(btn.dataset.task));
  });
  box.querySelectorAll("[data-runner-open]").forEach((btn) => {
    btn.addEventListener("click", () => openDrawer(btn.dataset.runnerOpen));
  });
  box.querySelectorAll("[data-runner-roots]").forEach((btn) => {
    btn.addEventListener("click", () => openRunnerRootsDialog(btn.dataset.runnerRoots));
  });
  box.querySelectorAll("[data-runner-dispatch]").forEach((btn) => {
    btn.addEventListener("click", () => setView("worksite"));
  });
  box.querySelectorAll("[data-runner-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/api/tasks/${btn.dataset.runnerCancel}/cancel`, { method: "POST", body: JSON.stringify({}) });
        toast("已请求取消，执行器下一次心跳会收到");
        await refreshTasks({ quiet: true });
        await renderRunnerPage({ quiet: true });
      } catch (error) {
        toast(error.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
  wireRunnerPair(box);
}

function renderSettings() {
  // 首屏点得快时 bootstrap 可能还没回来：给个空对象兜底，别让整个设置页渲染中断
  const boot = state.boot ?? {};
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
  // 设置页对所有人开放：「我的员工」「我的执行器」是每个人自己的事，
  // 只有人员管理、服务开关、版本更新、运行环境这些运维项留给管理人员。
  const isAdmin = state.user?.role === "admin";
  // 健康检查每 20 秒重绘整页；用户正在输入（端口、更新源地址）时先别动他的光标
  if (box.contains(document.activeElement) && ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  // 折叠是用户手动状态，重渲染前后必须留住
  const setFold = new Map([...box.querySelectorAll(".set-fold")].map((item) => [item.dataset.fold, item.open]));
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

    <!-- 我的模型：地址 + Key 只配一次，多个员工共用；同模型按并发上限排队 -->
    <details class="set-fold set-models" data-fold="models" open>
      <summary><b>我的模型</b><em id="myModelSummary"></em></summary>
      <div class="set-fold-body">
        <div class="my-agents-head">
          <div class="group-label">模型池 · 一个模型可以给多位员工共用，不必重复配 Key</div>
          <button type="button" class="set-action" id="myModelNew">＋ 新增模型</button>
        </div>
        <div id="myModelList" class="agent-list my-model-list"></div>
      </div>
    </details>

    <!-- 我的员工：AI 员工跟账号走，各自在自己电脑上配置，服务器不代管 -->
    <details class="set-fold set-agents" data-fold="agents" open>
      <summary><b>我的员工</b><em id="myAgentSummary"></em></summary>
      <div class="set-fold-body">
        <div class="my-agents-head">
          <div class="group-label">我的员工 · 在自己电脑的执行器上跑</div>
          <button type="button" class="set-action" id="myAgentNew">＋ 新增我的员工</button>
        </div>
        <div id="myAgentList" class="agent-list my-agent-list"></div>
      </div>
    </details>

    <details class="set-fold set-people" data-fold="people" data-admin-only>
      <summary><b>人员与账号</b><em id="peopleSummary">账号、角色与推送 Token</em></summary>
      <div class="set-fold-body">
        <div id="peoplePanel"><p class="ppl-empty">正在读取人员…</p></div>
      </div>
    </details>

    <details class="set-fold" data-fold="runner">
      <summary><b>我的执行器</b><em id="runnerSummary">本机接单跑 Codex</em></summary>
      <div class="set-fold-body">
        <div id="runnerCard"><p class="ppl-empty">正在读取执行器状态…</p></div>
      </div>
    </details>

    <details class="set-fold" data-fold="service" data-admin-only>
      <summary><b>服务与开关</b><em>网关开关、内网开放、开机自启</em></summary>
      <div class="set-fold-body"><div id="serviceCard"></div></div>
    </details>

    <details class="set-fold set-update" data-fold="update" data-admin-only${upd?.lastCheck?.available || upd?.applied?.pendingRestart ? " open" : ""}>
      <summary><b>版本与更新</b><em>${esc(updSummary)}</em></summary>
      <div class="set-fold-body"><div id="updateCard"></div></div>
    </details>

    <details class="set-fold" data-fold="runtime" data-admin-only>
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
    </details>`;

  // 折叠状态回填：用户展开过哪组，刷新后还是展开
  box.querySelectorAll(".set-fold").forEach((item) => {
    if (setFold.has(item.dataset.fold)) item.open = setFold.get(item.dataset.fold);
  });

  // 运维项只给管理人员：不只是藏起来，对应的数据也不去拉，免得普通账号刷一堆 403
  if (!isAdmin) {
    box.querySelectorAll("[data-admin-only]").forEach((item) => { item.hidden = true; });
    const hero = box.querySelector(".set-hero");
    if (hero) hero.hidden = true;
  }

  // 员工块每次重渲染都换新节点，事件得跟着重绑
  $("#agentNew")?.addEventListener("click", () => openAgentDialog(null));
  $("#myAgentNew")?.addEventListener("click", () => openMyAgentDialog(null));
  $("#myModelNew")?.addEventListener("click", () => openMyModelDialog(null));
  renderMyAgents();
  renderMyModels();
  loadMyModels();
  renderRunnerCard();
  if (isAdmin) {
    renderPeopleSection($("#peoplePanel"));
    renderServiceCard();
    renderUpdateCard();
  } else {
    // 清掉管理块残留的骨架，避免人已经藏了、占位文字还在
    const people = $("#peoplePanel");
    if (people) people.replaceChildren();
  }
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

/* =========================================================================
   events wiring
   ========================================================================= */
function wire() {
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $$('[data-go]').forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.go)));

  // 协作页点「任务来源」→ 切回任务页并打开那条任务的详情抽屉
  document.addEventListener("wb-open-task", (event) => {
    const id = event.detail?.id;
    if (!id) return;
    if (state.view !== "worksite") setView("worksite");
    openDrawer(id);
  });

  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);

  // ---------------------------------------------------------------- flows
  $("#flowNew").addEventListener("click", () => {
    // 流程的每一步都得挂一个「自己的」员工，一个都没有就先建，免得建完保存不了
    if (!(state.myAgents ?? []).some((agent) => agent.enabled)) {
      toast("先建一个自己的 AI 员工，流程才有执行的人");
      openMyAgentDialog(null, () => openFlowDialog(null));
      return;
    }
    openFlowDialog(null);
  });
  $("#flowForm").addEventListener("submit", (event) => { event.preventDefault(); saveFlow(); });
  $("#flowSave").addEventListener("click", saveFlow);
  $("#flowCancel").addEventListener("click", closeFlowEditor);
  $("#flowDelete").addEventListener("click", deleteFlowFromDialog);
  $("#flowAddStep").addEventListener("click", () => {
    const first = (state.myAgents ?? [])[0];
    if (!first) { toast("先在「设置 · 我的员工」建一个员工，再加步骤"); return; }
    appendStepWithAgent(first.id);
  });
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
    // 下拉里选了「＋ 新建员工」：先还原成上一次的选择，再去弹窗建人；
    // 建完把新员工选上，不用让人再折回来点一遍。
    if (event.target.classList.contains("flow-step-agent") && event.target.value === "__new__") {
      const select = event.target;
      const step = flowDraft.steps[selectedStepIndex];
      select.value = select.dataset.prev || step?.agentId || "";
      openMyAgentDialog(null, (created) => {
        if (!created?.id) return;
        const target = flowDraft.steps[selectedStepIndex];
        if (target) target.agentId = created.id;
        renderFlowInspector();
      });
      return;
    }
    if (event.target.classList.contains("flow-step-agent")) {
      event.target.dataset.prev = event.target.value;
    }
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
  // 临时任务：页签切换 + 一句话派活
  bindAdhoc();
  // 大窗顶部那条纪要同时是折叠开关
  $("#runBoardToggle").addEventListener("click", toggleRunOpen);
  // 滑轨滚动/窗口缩放时更新右侧渐隐：滑到底就不再虚化
  $("#flowList").addEventListener("scroll", (event) => syncRailEdge(event.currentTarget), { passive: true });
  window.addEventListener("resize", () => syncRailEdge($("#flowList")), { passive: true });
  $("#flowLaunchSelect").addEventListener("change", () => {
    state.launchFlowId = $("#flowLaunchSelect").value;
    // 换流程要重建变量区：不同流程的必填项不一样，旧值不能串过去
    $("#flowLaunchVars").replaceChildren();
    syncFlowPick(currentFlows().filter((item) => item.status !== "disabled"));
    renderLaunchVars();
  });

  // 流程选择器：点触发器开列表，选一条 → 写回隐藏的 select 并触发同一条链路
  $("#flowPickTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFlowPick();
  });
  $("#flowPickMenu").addEventListener("click", (event) => {
    const item = event.target.closest("[data-flow]");
    if (!item) return;
    const select = $("#flowLaunchSelect");
    select.value = item.dataset.flow;
    closeFlowPick();
    select.dispatchEvent(new Event("change"));
    $("#flowLaunchInput")?.focus();
  });
  // 点别处 / Esc 收起，别让菜单挂在页面上
  document.addEventListener("click", (event) => {
    const pick = $("#flowPick");
    if (pick && !pick.contains(event.target)) closeFlowPick();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFlowPick();
  });
  // 输入框跟着内容长高，最多六行，别把下面的流程卡挤走
  $("#flowLaunchInput").addEventListener("input", (event) => {
    const box = event.target;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 116)}px`;
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
    if (event.key === "Escape") closeDrawer();
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
  // 平台账号会话：未登录直接去登录页，登录后凭 cookie 访问 API
  // 注意：本页面可能被门户嵌在 /ai/ 下，跳转一律用相对路径，别写 "/login"
  try {
    const me = await fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!me?.account) {
      if (window.parent !== window) window.parent.postMessage({type:"ai-error",message:"登录已失效，请重新登录平台。"},location.origin);
      else location.replace("login");
      return;
    }
    state.user = me.account;
    // 门户统一身份（无网关会话）：退出要交回平台，网关自己没得退
    if (me.integration) state.user.integration = true;
  } catch { location.replace("login"); return; }
  renderUserChip();
  try {
    await bootstrap();
    setView("worksite");
    window.platformAiOpenView = view => {
      if (!["worksite","collab","artifacts","templates","runner","stats","settings"].includes(view)) return;
      if (view === "stats" && !state.isAdmin) view = "worksite";
      if (state.view !== view) setView(view);
    };
    window.platformHasUnsavedWork = () => Boolean(document.querySelector('#composer.open, dialog[open], [data-slot="dialog-content"]') || $("#adhocPrompt")?.value.trim() || state.view === "flowEdit");
    if (window.parent !== window) window.parent.postMessage({type:"ai-account",admin:state.isAdmin}, location.origin);
    window.dispatchEvent(new Event("ai-controller-ready"));
    checkHealth();
    loadFlows();
    // 平台已配置时顺手把云端目录拉一次：用户切到「工作方法」就能看到有货没货
    loadHubSkills();
    ensureFlowPolling();
    setInterval(() => refreshTasks(), 4000);
    setInterval(refreshStats, 60_000);
    setInterval(checkHealth, 20_000);
    // 导航上的「执行器」绿点：不管在哪个页面，都让人一眼看到本机执行器在不在
    refreshRunnerStatus();
    setInterval(refreshRunnerStatus, 15_000);
    // 我的员工清单：派活下拉、执行器页显示员工名都要用
    loadMyAgents();
  } catch (error) {
    toast(error.message);
  }
}

const ROLE_LABELS = {
  planner: "企划人员", product: "产品人员", ux: "体验人员",
  ui: "UI人员", other: "其他人员", admin: "管理人员",
};

function renderUserChip() {
  const u = state.user;
  if (!u) return;
  const chip = $("#userChip");
  if (!chip) return;
  chip.hidden = false;
  $("#userAvatar").textContent = String(u.name || u.username).slice(0, 1);
  $("#userName").textContent = u.name;
  $("#userRole").textContent = ROLE_LABELS[u.role] || u.role;
  $("#logoutBtn").addEventListener("click", async () => {
    // 门户内嵌时统一身份只在平台那一侧，网关没有会话 → 直接把退出交给平台并回到平台首页
    if (state.user?.integration) {
      await fetch("/platform/logout", { method: "POST" }).catch(() => {});
      (window.top || window).location.replace("/");
      return;
    }
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.replace("login");
  });
  // 「设置」对所有人开放：我的员工、我的执行器都在里面。
  // 人员管理、服务开关这些运维项在页面内部按角色隐藏（见 renderSettings）。
  const navStats = document.getElementById("navStats");
  if (navStats) navStats.hidden = u.role !== "admin";
}

wire();
start();
