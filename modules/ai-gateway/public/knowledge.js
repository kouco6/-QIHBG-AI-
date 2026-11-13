/**
 * 产品中枢知识库 · 前端模块（独立于 app.js 主体，避免主文件继续膨胀）。
 *
 * 页面结构对应规格书 4.2/4.3：首页四层 + 四个知识空间 + 审核中心 + 导入中心 + 运行记录。
 * P0 边界：AI 问答 / 知识图谱 / 词表治理是 P1，界面上只留「待上线」占位，不假装有功能。
 * 视图偏好（卡片/表格）记 localStorage；草稿自动保存 20s 一次。
 */

import { confirmDialog, promptDialog, formDialog } from "./dialog.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

async function kApi(path, options = {}) {
  // token 键与 app.js 的 LS.token 保持一致（sessionStorage "wb.token"）
  const token = sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";
  const headers = { ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof File) && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && typeof options.body !== "string") {
    options = { ...options, body: JSON.stringify(options.body) };
  }
  if (options.body && typeof options.body === "string") headers["content-type"] = "application/json";
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`);
  return data;
}

function kToast(msg, kind = "info") {
  const host = $("#kbToasts") ?? document.body;
  const el = document.createElement("div");
  el.className = `kb-toast ${kind}`;
  el.textContent = msg;
  host.append(el);
  setTimeout(() => el.remove(), 3600);
}

/**
 * 轻量 Markdown 渲染：标题/粗体/行内代码/列表/分段。正文来自本机与 Vault，先转义再渲染。
 * 灵感正文里的 `![[附件名]]` 是 Obsidian 嵌入语法：按 attachments 换成真图，
 * 匹配不到（比如 Obsidian 里手工引用别的文件）就退化成一行文件名，不要露出语法本身。
 */
function mdLite(text, attachments = []) {
  const atts = new Map((attachments ?? []).map((a) => [String(a.path ?? "").split("/").pop(), a]));
  const embeds = [];
  const embedOf = (bang, name) => {
    const att = atts.get(name);
    return att
      ? `<figure class="kb-md-att${bang ? " pic" : ""}"><img alt="" data-att="${att.id}"><figcaption>${esc(att.name)}</figcaption></figure>`
      : `<span class="kb-md-attxt">${bang ? "🖼" : "📎"} ${esc(name)}</span>`;
  };
  const protect = (s) => String(s).replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, bang, name) => {
    embeds.push(embedOf(bang, name));
    return `\u0000${embeds.length - 1}\u0000`;
  });

  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };
  for (const line of lines) {
    const inline = (s) => esc(protect(s))
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    // 整行只有一个嵌入：不要包进 <p>（<figure> 不是 phrasing content）
    const solo = /^\s*(!?)\[\[([^\]]+)\]\]\s*$/.exec(line);
    if (solo) { closeList(); out.push(`<div class="kb-md-embed">${embedOf(solo[1], solo[2])}</div>`); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    if (/^[-*]\s+/.test(line)) { if (!listOpen) { out.push("<ul>"); listOpen = true; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`); continue; }
    if (/^\d+\.\s+/.test(line)) { if (!listOpen) { out.push("<ul>"); listOpen = true; } out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`); continue; }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => embeds[Number(i)] ?? "");
}

/* ---------------------------------------------------------------- 模块状态 */

const kb = {
  boot: null,          // /api/knowledge/bootstrap
  tab: localStorage.getItem("kb-tab") || "home",
  topics: [],
  viewMode: localStorage.getItem("kb-view") || "cards",
  filters: { status: "", type: "", classification: "", folder: "" },
  topicId: null,       // 详情态
  editing: false,
  draftTimer: null,
  search: { q: "", result: null },
  health: null,
  asking: false,
  graph: null,
  movePanel: false,    // 详情页「迁移到其他空间」面板
  spawnPanel: false,   // 详情页「流转为派生主题」面板（灵感专用）
  selected: new Set(), // 列表多选（批量操作）
  batchMove: null,     // 批量迁移面板 { space, type }
  // 灵感空间：随手记捕获台 + 灵感流
  ideaFilter: localStorage.getItem("kb-idea-filter") || "todo",
  captureFiles: [],    // 已上传待收下的附件 [{ id, name, size, kind, preview }]
  captureDraft: "",    // 捕获框里没提交的文字（切筛选/切页签回来还在）
  captureBusy: false,
};

const STATUS_TONE = { draft: "off", pending: "wait", revise: "bad", published: "ok", archived: "off", deleted: "off" };
const STATUS_NAME = { draft: "草稿", pending: "待审核", revise: "待修订", published: "已发布", archived: "已归档", deleted: "已废止" };
const CLASS_NAME = { public: "公开", internal: "内部", secret: "机密" };
const SPACE_NAME = { research: "调研", planning: "企划", product: "产品", idea: "灵感" };
const SUGGEST_NAME = { skip: "跳过", merge: "合并为同一来源", "new-version": "登记为新版本", import: "独立导入" };

/* ---------------------------------------------------------------- 数据加载 */

async function loadBootstrap() {
  kb.boot = await kApi("/api/knowledge/bootstrap");
}

async function loadTopics() {
  const tab = kb.tab;
  const space = ["research", "planning", "product", "idea"].includes(tab) ? tab : undefined;
  const params = new URLSearchParams();
  if (space) params.set("space", space);
  if (kb.filters.status) params.set("status", kb.filters.status);
  if (kb.filters.type) params.set("type", kb.filters.type);
  if (kb.filters.classification) params.set("classification", kb.filters.classification);
  if (kb.filters.folder) params.set("folder", kb.filters.folder);
  const data = await kApi(`/api/knowledge/topics?${params}`);
  kb.topics = data.items ?? [];
}

async function loadHealth() {
  try { kb.health = await kApi("/api/knowledge/health"); } catch { kb.health = null; }
}

/* ---------------------------------------------------------------- 渲染骨架 */

export function renderKnowledge() {
  const box = $("#knowledge");
  if (!box) return;
  box.innerHTML = `
    <div class="kb-tabs" id="kbTabs"></div>
    <div class="kb-body" id="kbBody"><div class="kb-loading">加载中…</div></div>`;
  renderKbTabs();
  renderKbTab().catch((error) => {
    $("#kbBody").innerHTML = `<div class="kb-empty">知识库加载失败：${esc(error.message)}</div>`;
  });
  // 侧栏角标（待审核数），与 app.js 的 renderSidebar 解耦
  loadBootstrap().then(() => updateKbBadge()).catch(() => {});
}

function updateKbBadge() {
  const badge = $("#navKnowledge");
  if (!badge || !kb.boot) return;
  const pending = kb.boot.stats?.pendingReviews ?? 0;
  badge.hidden = !pending;
  badge.textContent = pending > 99 ? "99+" : String(pending);
  badge.title = `${pending} 条待审核`;
}

const TABS = [
  { key: "home", name: "首页" },
  { key: "research", name: "调研" },
  { key: "planning", name: "企划" },
  { key: "product", name: "产品" },
  { key: "idea", name: "灵感" },
  { key: "graph", name: "图谱" },
  { key: "reviews", name: "审核中心" },
  { key: "imports", name: "导入中心" },
  { key: "ops", name: "运行记录" },
];

function renderKbTabs() {
  const tabs = $("#kbTabs");
  if (!tabs) return;
  tabs.innerHTML = TABS.map((t) => `<button type="button" class="kb-tab${kb.tab === t.key ? " active" : ""}" data-kb-tab="${t.key}">${t.name}</button>`).join("");
  $$("#kbTabs .kb-tab").forEach((btn) => btn.addEventListener("click", () => {
    kb.tab = btn.dataset.kbTab;
    kb.topicId = null;
    kb.editing = false;
    kb.filters.folder = ""; // 目录属于空间，换空间必须清掉，否则会筛出空列表
    localStorage.setItem("kb-tab", kb.tab);
    renderKbTabs();
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  }));
}

async function renderKbTab() {
  const body = $("#kbBody");
  if (!body) return;
  if (!kb.boot) await loadBootstrap();
  updateKbBadge();
  if (kb.topicId) return renderTopicDetail();
  switch (kb.tab) {
    case "home": return renderHome();
    case "idea": return renderIdeaSpace();
    case "research": case "planning": case "product": return renderSpace();
    case "graph": return renderGraph();
    case "reviews": return renderReviews();
    case "imports": return renderImports();
    case "ops": return renderOps();
    default: kb.tab = "home"; return renderHome();
  }
}

/* ---------------------------------------------------------------- 首页（规格书 4.3 四层） */

async function renderHome() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  await loadBootstrap();
  const s = kb.boot.stats;
  const pendingReviews = s.pendingReviews;
  const failedImports = s.failedImports;
  const conflicts = (await loadHealth(), (kb.health?.issues ?? []).filter((i) => i.type === "conflict").length);
  const spaces = kb.boot.spaces ?? [];
  const topics = await kApi("/api/knowledge/topics?limit=8");
  const recent = topics.items ?? [];

  body.innerHTML = `
    <div class="kb-home">
      <section class="kb-hero">
        <div class="kb-search">
          <input id="kbSearch" type="search" placeholder="搜索知识、来源、型号、行业…（支持中英文子串）" autocomplete="off">
          <select id="kbSearchScope" class="kb-scope" title="双索引检索范围：摘要层权重高于正文层">
            <option value="all">摘要+正文</option>
            <option value="summary">只搜摘要</option>
            <option value="body">只搜正文</option>
          </select>
          <button type="button" class="btn primary" id="kbSearchGo">搜索</button>
          <button type="button" class="btn ghost" id="kbAsk" title="基于知识库主题正文与来源片段回答，结论带 [n] 引用；机密资料只走本机通道">AI 问答</button>
        </div>
        <div class="kb-ask" id="kbAskPanel" hidden>
          <div class="kb-ask-bar">
            <input id="kbAskInput" type="text" placeholder="问知识库一个问题，例如：凯越有多少人？" autocomplete="off">
            <button type="button" class="btn primary" id="kbAskSend">提问</button>
            <button type="button" class="btn ghost" id="kbAskClear" title="清空问答记录">清空</button>
          </div>
          <p class="kb-ask-hint">检索范围＝主题正文＋来源片段。回答只依据命中资料并标注 [n]，资料不够会直说缺什么。</p>
          <div class="kb-ask-log" id="kbAskLog"></div>
        </div>
        <div class="kb-hero-acts">
          <button type="button" class="btn" id="kbGoImport">导入资料</button>
          <button type="button" class="btn" id="kbGoNew">新建主题</button>
        </div>
        <div class="kb-search-result" id="kbSearchResult" hidden></div>
      </section>

      <section class="kb-pending">
        <h3>待处理</h3>
        <div class="kb-pending-grid">
          <button type="button" class="kb-pending-card${pendingReviews ? " hot" : ""}" data-goto="reviews"><b>${pendingReviews}</b><span>待审核</span></button>
          <button type="button" class="kb-pending-card${failedImports ? " hot" : ""}" data-goto="imports"><b>${failedImports}</b><span>导入失败</span></button>
          <button type="button" class="kb-pending-card${conflicts ? " hot" : ""}" data-goto="ops"><b>${conflicts}</b><span>内容冲突</span></button>
          <button type="button" class="kb-pending-card${(kb.health?.issues ?? []).length ? " hot" : ""}" data-goto="ops"><b>${(kb.health?.issues ?? []).length}</b><span>健康提醒</span></button>
        </div>
      </section>

      <section class="kb-spaces">
        <h3>知识空间</h3>
        <div class="kb-space-grid">
          ${spaces.map((sp) => `
            <button type="button" class="kb-space-card" data-goto="${sp.key}">
              <strong>${esc(sp.name)}</strong>
              <span>${(sp.types ?? []).slice(0, 4).map(esc).join(" · ")}</span>
              ${sp.key === "product" || sp.key === "idea" ? '<em>基础能力已开放</em>' : ""}
            </button>`).join("")}
        </div>
      </section>

      <div class="kb-home-cols">
        <section class="kb-recent">
          <h3>最近更新</h3>
          ${recent.length ? `<div class="kb-topic-list">${recent.map(topicRowHtml).join("")}</div>` : `<div class="kb-empty">还没有主题，先从「导入资料」或「新建主题」开始</div>`}
        </section>
        <section class="kb-stats">
          <h3>轻量统计</h3>
          <div class="kb-stat-grid">
            <div><b>${s.topics}</b><span>知识主题</span></div>
            <div><b>${s.sources}</b><span>来源资料</span></div>
            <div><b>${s.published}</b><span>已发布</span></div>
            <div><b>${s.avgQuality}</b><span>平均质量分</span></div>
            <div><b>${s.weekNew}</b><span>本周新增</span></div>
            <div><b>${s.fragments}</b><span>来源片段</span></div>
          </div>
          <p class="kb-note">Vault：${esc(kb.boot.vaultDir)}${kb.boot.backup?.available ? "" : `<br><span class="kb-warn">备份目标不可用：${esc(kb.boot.backupDir)}（未挂载或不存在）</span>`}</p>
        </section>
      </div>
    </div>`;

  bindSearch();
  $("#kbGoImport").addEventListener("click", () => gotoKbTab("imports"));
  // 首页没有所属空间：传 null，让弹窗里自己选
  $("#kbGoNew").addEventListener("click", () => newTopicDraft(null));
  $$("[data-goto]", body).forEach((btn) => btn.addEventListener("click", () => gotoKbTab(btn.dataset.goto)));
  bindTopicRows(body);
  bindAsk();
}

/**
 * AI 问答：检索增强 + [n] 引用。
 * 面板自带输入框，可连续追问（上一轮问答留在记录里）；引用能直接点开对应主题，
 * 不再依赖浏览器 prompt 弹窗——弹窗一关问题就丢了，也没法回看引用。
 */
function bindAsk() {
  const panel = $("#kbAskPanel");
  const log = $("#kbAskLog");
  const input = $("#kbAskInput");
  if (!panel || !log || !input) return;

  $("#kbAsk").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    if (!input.value.trim()) input.value = ($("#kbSearch")?.value ?? "").trim();
    input.focus();
  });
  $("#kbAskClear").addEventListener("click", () => { log.innerHTML = ""; input.focus(); });
  $("#kbAskSend").addEventListener("click", () => askRun(input.value.trim()));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    askRun(input.value.trim());
  });

  async function askRun(question) {
    if (!question || kb.asking) return;
    kb.asking = true;
    input.value = "";
    const channel = kb.boot?.askChannel === "cloud" ? "云端员工" : kb.boot?.askChannel === "local" ? "本机 CLI" : "检测中";
    const qEl = document.createElement("div");
    qEl.className = "kb-ask-q";
    qEl.innerHTML = `<b>Q</b><span>${esc(question)}</span>`;
    log.append(qEl);
    const aEl = document.createElement("div");
    aEl.className = "kb-ask-a";
    aEl.innerHTML = `<div class="kb-loading">正在检索知识库并组织回答…（${esc(channel)}，最长约 2 分钟）</div>`;
    log.append(aEl);
    aEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      const result = await kApi("/api/knowledge/ask", { method: "POST", body: JSON.stringify({ question }) });
      const hit = result.retrieval;
      aEl.innerHTML = `
        <div class="kb-ask-meta">
          <span>${result.modelKind === "cloud" ? "云端" : "本机"}通道</span>
          ${hit ? `<span>命中 ${hit.topics} 个主题 · ${hit.entries} 段资料</span>` : ""}
          ${hit?.terms?.length ? `<span>检索词：${esc(hit.terms.slice(0, 8).join("、"))}</span>` : ""}
          <span>引用 ${result.citations.length} 条</span>
        </div>
        <div class="kb-md kb-answer">${mdLite(result.answer)}</div>
        ${result.citations.length ? `<details class="kb-ask-cites"><summary>引用资料 ${result.citations.length} 条（点开看原文）</summary>
          <div class="kb-frag-list">${result.citations.map((c) => `
            <div class="kb-frag">
              <span class="kb-frag-src">[${c.n}] ${esc(c.sourceName)}${c.locator ? ` · ${esc(c.locator)}` : ""}${c.topicId ? ` <button type="button" class="kb-frag-open" data-topic="${esc(c.topicId)}">打开主题</button>` : ""}</span>
              <p>${esc(c.text)}</p>
            </div>`).join("")}</div></details>` : ""}
        ${result.topics?.length ? `<div class="kb-ask-related">${result.topics.map((t) => `<button type="button" class="kb-frag-open" data-topic="${esc(t.id)}">${esc(t.title)}</button>`).join("")}</div>` : ""}`;
      // 引用卡片与相关主题都能直接跳到主题详情
      $$("[data-topic]", aEl).forEach((btn) => btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        kb.topicId = btn.dataset.topic;
        kb.editing = false;
        renderKbTab().catch((e) => kToast(e.message, "bad"));
      }));
    } catch (error) {
      aEl.innerHTML = `<div class="kb-empty">${esc(error.message)}</div>`;
    } finally {
      kb.asking = false;
      input.focus();
    }
  }
}

function spaceOfTab(tab) {
  return ["research", "planning", "product", "idea"].includes(tab) ? tab : "research";
}

function gotoKbTab(tab) {
  kb.tab = tab;
  kb.topicId = null;
  kb.selected.clear();
  kb.batchMove = null;
  localStorage.setItem("kb-tab", tab);
  renderKbTabs();
  renderKbTab().catch((e) => kToast(e.message, "bad"));
}

function bindSearch() {
  const input = $("#kbSearch");
  if (!input) return;
  const run = async () => {
    const q = input.value.trim();
    const box = $("#kbSearchResult");
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="kb-loading">搜索中…</div>`;
    try {
      const scope = $("#kbSearchScope")?.value ?? "all";
      const result = await kApi(`/api/knowledge/search?q=${encodeURIComponent(q)}&status=any&scope=${scope}&limit=12`);
      kb.search = { q, result };
      const took = result.tookMs != null ? `${result.tookMs}ms` : "";
      box.innerHTML = `
        <div class="kb-search-head">找到 <b>${result.topics.length}</b> 个主题、<b>${result.fragments.length}</b> 条来源片段 <span>${took}</span></div>
        ${result.topics.length ? `<div class="kb-topic-list">${result.topics.map((t) => topicRowHtml(t, t._match)).join("")}</div>` : `<div class="kb-empty">没有命中的主题</div>`}
        ${result.fragments.length ? `<div class="kb-frag-list">${result.fragments.slice(0, 6).map((f) => `
          <div class="kb-frag"><span class="kb-frag-src">${esc(f.source_name)} · ${esc(f.locator || "")}</span><p>${esc(f._snip || f.text.slice(0, 120))}</p></div>`).join("")}</div>` : ""}`;
      bindTopicRows(box);
    } catch (error) {
      box.innerHTML = `<div class="kb-empty">${esc(error.message)}</div>`;
    }
  };
  $("#kbSearchGo").addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}

function topicRowHtml(t, matchNote) {
  return `
    <button type="button" class="kb-topic-row" data-topic="${esc(t.id)}">
      <span class="kb-dot ${STATUS_TONE[t.status] ?? "off"}"></span>
      <span class="kb-topic-main">
        <strong>${esc(t.title)}</strong>
        <span>${esc(t.type)} · ${CLASS_NAME[t.classification] ?? ""} · 更新 ${fmtTime(t.updated_at)}${matchNote ? ` · ${esc(matchNote)}` : ""}</span>
      </span>
      <span class="kb-quality" title="质量分">${t.quality ?? 0}</span>
    </button>`;
}

function bindTopicRows(root) {
  $$("[data-topic]", root).forEach((row) => row.addEventListener("click", () => {
    kb.topicId = row.dataset.topic;
    kb.editing = false;
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  }));
}

/* ---------------------------------------------------------------- 灵感空间：随手记 + 灵感流
   灵感不是「主题」，是碎片：一句话、一张截图、一个随手丢进来的文件。
   所以这里不设「新建主题」表单，只有一个常驻捕获框；标题自动从内容里取，事后整理再改。 */

const IDEA_FILTERS = [
  { key: "todo", name: "待整理", hint: "还没标签、也没流出去的" },
  { key: "all", name: "全部", hint: "按收下时间倒序" },
  { key: "spawned", name: "已流出", hint: "已经长成调研 / 企划 / 产品的" },
];

const blobCache = new Map();

/** 附件要走 bearer 鉴权，<img src> 带不了 header：先 fetch 成 blob，再给 URL。 */
async function kBlobUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const token = sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";
  const resp = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!resp.ok) throw new Error(`附件读取失败（${resp.status}）`);
  const url = URL.createObjectURL(await resp.blob());
  blobCache.set(path, url);
  return url;
}

/** 上传附件：raw body + query 传名字，和导入中心一致，不走 2MB JSON 限制。 */
async function kUploadAttachment(file) {
  const token = sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";
  const name = file.name || `截图-${Date.now()}.png`;
  const resp = await fetch(`/api/knowledge/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `上传失败（${resp.status}）`);
  return data;
}

const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 正文里只用于嵌入的 wikilink 行不该出现在卡片预览里。 */
function ideaExcerpt(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^!?\[\[.*\]\]$/.test(line.trim()) && !/^-\s*📎/.test(line.trim()))
    .join(" ")
    .replace(/[#>*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ideaIsTodo = (t) => !(t.spawned_count > 0) && !(t.tags ?? []).length;

async function renderIdeaSpace() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  await loadTopics();
  const all = kb.topics;
  const todo = all.filter(ideaIsTodo);
  const spawned = all.filter((t) => t.spawned_count > 0);
  if (!IDEA_FILTERS.some((f) => f.key === kb.ideaFilter)) kb.ideaFilter = "todo";
  const list = kb.ideaFilter === "todo" ? todo : kb.ideaFilter === "spawned" ? spawned : all;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = all.filter((t) => (t.created_at ?? 0) >= today.getTime()).length;

  body.innerHTML = `
    <section class="kb-capture" id="kbCapture">
      <textarea id="kbCaptureText" rows="2" placeholder="想到什么就写一句，不用起标题…&#10;截图直接 Ctrl+V 贴进来，文件拖到这个框里也行"></textarea>
      <div class="kb-capture-files" id="kbCaptureFiles" hidden></div>
      <div class="kb-capture-foot">
        <button type="button" class="btn tiny ghost" id="kbCapturePick">＋ 文件 / 截图</button>
        <input type="file" id="kbCaptureInput" multiple hidden>
        <span class="kb-capture-tip">Ctrl + Enter 收下 · 事后整理</span>
        <span class="kb-grow"></span>
        <button type="button" class="btn primary" id="kbCaptureSend">丢进灵感池</button>
      </div>
    </section>

    <div class="kb-idea-bar">
      <div class="kb-idea-seg">
        ${IDEA_FILTERS.map((f) => `
          <button type="button" data-idea-filter="${f.key}" class="${kb.ideaFilter === f.key ? "active" : ""}" title="${esc(f.hint)}">
            ${f.name}<b>${f.key === "todo" ? todo.length : f.key === "all" ? all.length : spawned.length}</b>
          </button>`).join("")}
      </div>
      <span class="kb-idea-stat">今天收下 ${todayCount} 条 · 共 ${all.length} 条</span>
      <span class="kb-grow"></span>
      <a class="kb-idea-link" href="#" id="kbIdeaImport" title="大文件、成批资料建议走导入中心（会解析正文）">批量导入资料 →</a>
    </div>

    ${list.length ? `<div class="kb-idea-list">${list.map(ideaCardHtml).join("")}</div>`
      : `<div class="kb-empty">${kb.ideaFilter === "todo" ? "没有待整理的灵感，清空了" : "这个筛选下还没有灵感"}</div>`}`;

  bindCapture();
  bindIdeaCards();
  loadIdeaCovers(body);
}

function ideaCardHtml(t) {
  const excerpt = ideaExcerpt(t.body);
  // 标题就是正文首句截的：短句时再显示一遍预览只是重复，长句才值得补全文
  const showExcerpt = excerpt.length > String(t.title).replace(/…$/, "").length + 12;
  const tags = (t.tags ?? []).slice(0, 3).map((tag) => `<span class="kb-tag">${esc(tag)}</span>`).join("");
  return `
    <article class="kb-idea${t.spawned_count ? " done" : ""}${t.cover ? " has-cover" : ""}" data-topic="${esc(t.id)}" tabindex="0" role="button">
      ${t.cover ? `<div class="kb-idea-cover"><img alt="" data-cover="${esc(t.cover.id)}"></div>` : ""}
      <div class="kb-idea-main">
        <header>
          <strong>${esc(t.title)}</strong>
          ${ideaIsTodo(t) ? '<span class="kb-idea-todo">待整理</span>' : ""}
          ${t.spawned_count ? `<span class="kb-tag ok">已流出 ${t.spawned_count}</span>` : ""}
        </header>
        <p>${showExcerpt ? esc(excerpt.slice(0, 160)) : (excerpt ? "" : "（只有附件，点开看）")}</p>
        <footer>
          <span class="kb-idea-time">${fmtTime(t.created_at)}</span>
          ${t.attachment_count ? `<span class="kb-idea-att" title="附件 ${t.attachment_count} 个">附件 ${t.attachment_count}</span>` : ""}
          ${tags}
          <span class="kb-grow"></span>
          <button type="button" class="btn tiny ghost" data-idea-edit="${esc(t.id)}">补一句</button>
          <button type="button" class="btn tiny" data-idea-spawn="${esc(t.id)}">整理为…</button>
        </footer>
      </div>
    </article>`;
}

function bindIdeaCards() {
  const open = (id) => { kb.topicId = id; kb.editing = false; kb.spawnPanel = false; renderKbTab().catch((e) => kToast(e.message, "bad")); };
  $$(".kb-idea").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      open(card.dataset.topic);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(card.dataset.topic); }
    });
  });
  $$("[data-idea-spawn]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.stopPropagation();
    kb.topicId = btn.dataset.ideaSpawn;
    kb.editing = false;
    kb.spawnPanel = true;   // 直接展开「整理为」面板，少一次点击
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  }));
  $$("[data-idea-edit]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.stopPropagation();
    kb.topicId = btn.dataset.ideaEdit;
    kb.editing = true;
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  }));
  $("#kbIdeaImport")?.addEventListener("click", (event) => {
    event.preventDefault();
    kb.tab = "imports";
    kb.topicId = null;
    localStorage.setItem("kb-tab", kb.tab);
    renderKbTabs();
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  });
  $$("[data-idea-filter]").forEach((btn) => btn.addEventListener("click", () => {
    kb.ideaFilter = btn.dataset.ideaFilter;
    localStorage.setItem("kb-idea-filter", kb.ideaFilter);
    renderIdeaSpace().catch((e) => kToast(e.message, "bad"));
  }));
}

/** 详情页附件缩略图：同一套鉴权 fetch，失败就留占位不报错。 */
async function loadAttImages(root) {
  for (const img of $$("img[data-att]", root)) {
    try { img.src = await kBlobUrl(`/api/knowledge/attachments/${img.dataset.att}`); }
    catch { /* 文件可能已被移走 */ }
  }
}

async function loadIdeaCovers(root) {
  for (const img of $$("img[data-cover]", root)) {
    try { img.src = await kBlobUrl(`/api/knowledge/attachments/${img.dataset.cover}`); }
    catch { img.closest(".kb-idea-cover")?.remove(); }
  }
}

/* ---------------------------------------------------------------- 捕获台 */

function captureFilesHtml() {
  if (!kb.captureFiles.length) return "";
  return kb.captureFiles.map((f) => `
    <div class="kb-cp-file${f.kind === "image" ? " pic" : ""}" data-capture-file="${esc(f.id)}">
      ${f.kind === "image" && f.preview
        ? `<img alt="" src="${esc(f.preview)}">`
        : `<span class="kb-cp-ext">${esc((f.name.split(".").pop() || "FILE").toUpperCase().slice(0, 4))}</span>`}
      <b title="${esc(f.name)}">${esc(f.name)}</b>
      <em>${fmtSize(f.size ?? 0)}</em>
      <button type="button" class="kb-cp-x" data-capture-remove="${esc(f.id)}" aria-label="移除">×</button>
    </div>`).join("");
}

function refreshCaptureFiles() {
  const box = $("#kbCaptureFiles");
  if (!box) return;
  box.innerHTML = captureFilesHtml();
  box.hidden = !kb.captureFiles.length;
  $$("[data-capture-remove]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.stopPropagation();
    kb.captureFiles = kb.captureFiles.filter((f) => f.id !== btn.dataset.captureRemove);
    refreshCaptureFiles();
  }));
}

async function addCaptureFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  for (const file of list) {
    const preview = file.type?.startsWith("image/") ? URL.createObjectURL(file) : "";
    try {
      const uploaded = await kUploadAttachment(file);
      kb.captureFiles.push({
        id: uploaded.id, name: uploaded.name, size: uploaded.size, kind: uploaded.kind, preview,
      });
      refreshCaptureFiles();
    } catch (error) {
      kToast(`「${file.name}」上传失败：${error.message}`, "bad");
    }
  }
}

function bindCapture() {
  const box = $("#kbCapture");
  const area = $("#kbCaptureText");
  const send = $("#kbCaptureSend");
  const input = $("#kbCaptureInput");
  if (!box || !area || !send) return;

  // 不在这里清空：切筛选会重渲染，清掉就等于把用户正在写的东西扔了
  area.value = kb.captureDraft ?? "";
  refreshCaptureFiles();

  // 不用 element.style（CSP style-src 'self' 会拦）：按内容改 rows
  const autoGrow = () => {
    const lines = (area.value.match(/\n/g)?.length ?? 0) + 1 + Math.floor(area.value.length / 48);
    area.rows = Math.max(2, Math.min(7, lines));
  };
  autoGrow();
  area.addEventListener("input", () => { kb.captureDraft = area.value; autoGrow(); });
  requestAnimationFrame(() => area.focus({ preventScroll: true }));

  const submit = async () => {
    if (kb.captureBusy) return;
    const text = area.value.trim();
    if (!text && !kb.captureFiles.length) {
      kToast("写一句话，或者贴张图 / 丢个文件", "bad");
      area.focus();
      return;
    }
    kb.captureBusy = true;
    send.disabled = true;
    send.textContent = "收下中…";
    try {
      const result = await kApi("/api/knowledge/inbox", {
        method: "POST",
        body: JSON.stringify({ text, attachments: kb.captureFiles.map((f) => f.id) }),
      });
      for (const f of kb.captureFiles) if (f.preview) URL.revokeObjectURL(f.preview);
      kb.captureFiles = [];
      kb.captureDraft = "";
      kToast(`已收下「${result.topic.title}」`);
      await renderIdeaSpace();
    } catch (error) {
      kToast(error.message, "bad");
      kb.captureBusy = false;
      send.disabled = false;
      send.textContent = "丢进灵感池";
    }
  };

  send.addEventListener("click", submit);
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  });

  $("#kbCapturePick")?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", async () => {
    await addCaptureFiles(input.files ?? []);
    input.value = "";
  });

  // 截图：剪贴板里的图片文件
  area.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    await addCaptureFiles(files.map((f, i) => new File([f], f.name && f.name !== "image.png" ? f.name : `截图-${Date.now()}-${i + 1}.png`, { type: f.type })));
  });

  // 文件：拖到捕获框任意位置
  let depth = 0;
  box.addEventListener("dragenter", (event) => { event.preventDefault(); depth += 1; box.classList.add("drop"); });
  box.addEventListener("dragover", (event) => { event.preventDefault(); });
  box.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) box.classList.remove("drop"); });
  box.addEventListener("drop", async (event) => {
    event.preventDefault();
    depth = 0;
    box.classList.remove("drop");
    await addCaptureFiles(event.dataTransfer?.files ?? []);
  });
}

/* ---------------------------------------------------------------- 空间页（卡片/表格） */

async function renderSpace() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  await loadTopics();
  // 筛选变化后，已勾选但不在当前列表里的 id 要剔除，避免「看不见却被批量处理」
  const visible = new Set(kb.topics.map((t) => t.id));
  for (const id of [...kb.selected]) if (!visible.has(id)) kb.selected.delete(id);

  const spaceMeta = (kb.boot.spaces ?? []).find((s) => s.key === kb.tab);
  // 灵感已有独立的流转能力，不再笼统标 P1
  const p1Hint = kb.tab === "idea" ? "P1 · 可把灵感流转为调研 / 企划 / 产品主题（原件保留）"
    : kb.tab === "product" ? "P1 规划中，先可用基础能力" : "";
  const types = spaceMeta?.types ?? [];
  // 目录分档：Vault 里同一空间可能既有「类型目录」又有「主题汇编」这类分册目录，
  // 光按类型筛会把 60 多页汇编和普通主题混在一起，所以给一排目录开关。
  const folders = spaceMeta?.folders ?? [];
  body.innerHTML = `
    <div class="kb-toolbar">
      <div class="kb-toolbar-left">
        <h3>${esc(spaceMeta?.name ?? kb.tab)}空间</h3>
        ${p1Hint ? `<span class="kb-tag p1">${p1Hint}</span>` : ""}
        <span class="kb-count">${kb.topics.length} 个主题</span>
      </div>
      <div class="kb-toolbar-right">
        <select id="kbFilterType"><option value="">全部类型</option>${types.map((t) => `<option value="${esc(t)}"${kb.filters.type === t ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
        <select id="kbFilterStatus">
          <option value="">全部状态</option>
          ${Object.entries(STATUS_NAME).filter(([k]) => k !== "deleted").map(([k, v]) => `<option value="${k}"${kb.filters.status === k ? " selected" : ""}>${v}</option>`).join("")}
        </select>
        <select id="kbFilterClass">
          <option value="">全部密级</option>
          ${Object.entries(CLASS_NAME).map(([k, v]) => `<option value="${k}"${kb.filters.classification === k ? " selected" : ""}>${v}</option>`).join("")}
        </select>
        <div class="kb-view-switch">
          <button type="button" data-mode="cards" class="${kb.viewMode === "cards" ? "active" : ""}" title="卡片视图">卡片</button>
          <button type="button" data-mode="table" class="${kb.viewMode === "table" ? "active" : ""}" title="表格视图">表格</button>
        </div>
        <button type="button" class="btn" id="kbBulkSubmitAll" title="把当前筛选下的全部草稿一次性提交审核">提交本空间草稿</button>
        <button type="button" class="btn primary" id="kbNewTopic">新建主题</button>
      </div>
    </div>

    ${folders.length > 1 ? `<div class="kb-folders">
      <span class="kb-folders-label">目录</span>
      <button type="button" data-folder="" class="${kb.filters.folder ? "" : "active"}">全部 <b>${folders.reduce((n, f) => n + f.count, 0)}</b></button>
      ${folders.map((f) => `<button type="button" data-folder="${esc(f.dir)}" class="${kb.filters.folder === f.dir ? "active" : ""}" title="${esc(f.dir)}">${esc(f.name)} <b>${f.count}</b></button>`).join("")}
    </div>` : ""}

    <div class="kb-batchbar${kb.selected.size ? " has" : ""}" id="kbBatchBar">
      <span class="kb-batch-count">已选 <b id="kbBatchCount">${kb.selected.size}</b> 项</span>
      <span class="kb-batch-hint">勾选卡片左上角 / 表格首列，可批量提交、迁移、导出、废止</span>
      <button type="button" class="btn tiny" id="kbSelAll">全选当前 ${kb.topics.length}</button>
      <button type="button" class="btn tiny ghost" id="kbSelNone">清空</button>
      <span class="kb-grow"></span>
      <button type="button" class="btn tiny" id="kbBatchSubmit"${kb.selected.size ? "" : " disabled"}>提交审核</button>
      <button type="button" class="btn tiny" id="kbBatchMove"${kb.selected.size ? "" : " disabled"}>迁移…</button>
      <button type="button" class="btn tiny" id="kbBatchExport"${kb.selected.size ? "" : " disabled"}>导出 ZIP</button>
      <button type="button" class="btn tiny danger" id="kbBatchDelete"${kb.selected.size ? "" : " disabled"}>废止</button>
    </div>

    ${kb.batchMove ? batchMovePanelHtml() : ""}

    <div id="kbTopicArea">${kb.topics.length ? (kb.viewMode === "cards" ? topicCardsHtml(kb.topics) : topicTableHtml(kb.topics)) : `<div class="kb-empty">这个空间还没有主题</div>`}</div>`;

  $("#kbNewTopic").addEventListener("click", () => newTopicDraft(kb.tab));
  $("#kbFilterType").addEventListener("change", (e) => { kb.filters.type = e.target.value; kb.selected.clear(); renderSpace(); });
  $("#kbFilterStatus").addEventListener("change", (e) => { kb.filters.status = e.target.value; kb.selected.clear(); renderSpace(); });
  $("#kbFilterClass").addEventListener("change", (e) => { kb.filters.classification = e.target.value; kb.selected.clear(); renderSpace(); });
  $$("[data-folder]").forEach((btn) => btn.addEventListener("click", () => {
    kb.filters.folder = btn.dataset.folder || "";
    kb.selected.clear();
    renderSpace().catch((e) => kToast(e.message, "bad"));
  }));
  $("#kbBulkSubmitAll").addEventListener("click", async () => {
    const drafts = kb.topics.filter((t) => t.status === "draft" && (!kb.filters.status || kb.filters.status === "draft")).length;
    if (!drafts) return kToast("当前筛选下没有草稿可提交", "bad");
    if (!(await confirmDialog({
      title: "提交本空间草稿",
      message: `把当前筛选下的 ${drafts} 个草稿全部提交审核？`,
      detail: "提交后进入审核中心，通过并发布才会回写 Obsidian。",
      okText: "提交审核",
    }))) return;
    try {
      const result = await kApi("/api/knowledge/topics/bulk-submit", { method: "POST", body: JSON.stringify({ space: kb.tab, type: kb.filters.type || undefined, classification: kb.filters.classification || undefined }) });
      kToast(`已提交 ${result.submitted} 个草稿进入审核`);
      renderSpace();
      updateKbBadge();
    } catch (error) { kToast(error.message, "bad"); }
  });
  $$(".kb-view-switch button", body).forEach((btn) => btn.addEventListener("click", () => {
    kb.viewMode = btn.dataset.mode;
    localStorage.setItem("kb-view", kb.viewMode);
    renderSpace();
  }));
  bindTopicCards(body);
  bindBatchBar(types);
}

/** 批量操作条：勾选、全选、提交、迁移、导出、废止。 */
function bindBatchBar(types) {
  const selectedIds = () => [...kb.selected];
  const refresh = () => {
    const n = kb.selected.size;
    const bar = $("#kbBatchBar");
    if (!bar) return;
    $("#kbBatchCount").textContent = n;
    bar.classList.toggle("has", n > 0);
    $$("[data-check]", $("#kbTopicArea")).forEach((el) => el.classList.toggle("on", kb.selected.has(el.dataset.check)));
    $$("[data-topic]", $("#kbTopicArea")).forEach((el) => el.classList.toggle("picked", kb.selected.has(el.dataset.topic)));
    $$("[data-check-all]", $("#kbTopicArea")).forEach((el) => {
      el.classList.toggle("on", n > 0 && n === kb.topics.length);
      el.classList.toggle("part", n > 0 && n < kb.topics.length);
    });
    ["kbBatchSubmit", "kbBatchMove", "kbBatchExport", "kbBatchDelete"].forEach((id) => {
      const btn = $(`#${id}`);
      if (btn) btn.disabled = n === 0;
    });
  };
  const toggle = (id) => {
    if (kb.selected.has(id)) kb.selected.delete(id); else kb.selected.add(id);
    refresh();
  };
  $$("[data-check]", $("#kbTopicArea")).forEach((el) => el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation(); // 勾选不要顺带打开详情
    toggle(el.dataset.check);
  }));
  $$("[data-check-all]", $("#kbTopicArea")).forEach((el) => el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (kb.selected.size === kb.topics.length) kb.selected.clear();
    else kb.topics.forEach((t) => kb.selected.add(t.id));
    refresh();
  }));
  $("#kbSelAll").addEventListener("click", () => { kb.topics.forEach((t) => kb.selected.add(t.id)); refresh(); });
  $("#kbSelNone").addEventListener("click", () => { kb.selected.clear(); refresh(); });

  $("#kbBatchSubmit").addEventListener("click", async () => {
    const ids = selectedIds();
    const drafts = kb.topics.filter((t) => ids.includes(t.id) && t.status === "draft").length;
    if (!drafts) return kToast("选中的主题里没有草稿（只有草稿能提交审核）", "bad");
    try {
      const r = await kApi("/api/knowledge/topics/bulk-submit", { method: "POST", body: JSON.stringify({ ids }) });
      kToast(drafts === ids.length ? `已提交 ${r.submitted} 个草稿进入审核` : `已提交 ${r.submitted} 个草稿（${ids.length - r.submitted} 个状态不是草稿，已跳过）`);
      kb.selected.clear();
      renderSpace();
      updateKbBadge();
    } catch (error) { kToast(error.message, "bad"); }
  });

  $("#kbBatchMove").addEventListener("click", () => {
    kb.batchMove = kb.batchMove ? null : { space: kb.tab, type: types[0] ?? "" };
    renderSpace();
  });
  if (kb.batchMove) bindBatchMovePanel();

  $("#kbBatchExport").addEventListener("click", async () => {
    const ids = selectedIds();
    try {
      kToast(`正在打包 ${ids.length} 篇…`);
      await kDownload("/api/knowledge/topics/bulk-export", { ids });
      kToast(`已导出 ${ids.length} 篇为 ZIP`);
    } catch (error) { kToast(error.message, "bad"); }
  });

  $("#kbBatchDelete").addEventListener("click", async () => {
    const ids = selectedIds();
    const okDelete = await confirmDialog({
      title: "废止选中的主题",
      message: `把 ${ids.length} 个主题标记为「已废止」并从空间列表移除？`,
      detail: "· 状态变为「已废止」，从空间列表消失\n· Vault 页面移到 90-归档 保留，不删文件\n· 需要时可在运行记录里查回",
      okText: "废止",
      tone: "danger",
    });
    if (!okDelete) return;
    try {
      const r = await kApi("/api/knowledge/topics/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) });
      kToast(r.failed ? `已废止 ${r.deleted} 个，${r.failed} 个失败` : `已废止 ${r.deleted} 个主题（页面在 90-归档）`, r.failed ? "bad" : "info");
      kb.selected.clear();
      renderSpace();
      updateKbBadge();
    } catch (error) { kToast(error.message, "bad"); }
  });
}

function batchMovePanelHtml() {
  const spaces = (kb.boot.spaces ?? []).filter((s) => ["research", "planning", "product", "idea"].includes(s.key));
  const cur = kb.batchMove ?? { space: kb.tab, type: "" };
  const types = spaces.find((s) => s.key === cur.space)?.types ?? [];
  return `
    <section class="kb-move kb-batch-move">
      <h4>把选中的 ${kb.selected.size} 个主题迁移到</h4>
      <div class="kb-move-row">
        <label><span>目标空间</span><select id="kbBatchSpace">
          ${spaces.map((s) => `<option value="${esc(s.key)}"${s.key === cur.space ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
        <label><span>目标类型</span><select id="kbBatchType">
          ${types.map((t) => `<option${t === cur.type ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select></label>
        <button type="button" class="btn primary" id="kbBatchMoveGo">确认迁移</button>
        <button type="button" class="btn ghost" id="kbBatchMoveCancel">取消</button>
      </div>
      <p class="kb-note">逐个搬移 Vault 文件并改写 frontmatter；单个失败不影响其余，失败项会列出来。</p>
    </section>`;
}

function bindBatchMovePanel() {
  const spaceSel = $("#kbBatchSpace");
  const typeSel = $("#kbBatchType");
  const syncTypes = () => {
    const types = (kb.boot.spaces ?? []).find((s) => s.key === spaceSel.value)?.types ?? [];
    typeSel.innerHTML = types.map((t) => `<option>${esc(t)}</option>`).join("");
  };
  spaceSel.addEventListener("change", syncTypes);
  $("#kbBatchMoveCancel").addEventListener("click", () => { kb.batchMove = null; renderSpace(); });
  $("#kbBatchMoveGo").addEventListener("click", async () => {
    const ids = [...kb.selected];
    if (!ids.length) return kToast("先勾选要迁移的主题", "bad");
    const space = spaceSel.value;
    const type = typeSel.value;
    try {
      const r = await kApi("/api/knowledge/topics/bulk-move", { method: "POST", body: JSON.stringify({ ids, space, type }) });
      const bad = r.results.filter((x) => !x.ok);
      if (r.failed) {
        kToast(`迁移 ${r.moved} 个，失败 ${r.failed} 个：${bad.slice(0, 2).map((x) => x.error).join("；")}`, "bad");
      } else {
        kToast(`已迁移 ${r.moved} 个到「${SPACE_NAME[space] ?? space} · ${type}」${r.unchanged ? `（${r.unchanged} 个本来就在该空间）` : ""}`);
      }
      kb.batchMove = null;
      kb.selected.clear();
      kb.tab = space; // 跟着主题走，返回时看到迁移后的列表
      localStorage.setItem("kb-tab", kb.tab);
      renderKbTabs();
      renderSpace();
    } catch (error) { kToast(error.message, "bad"); }
  });
}

/** 带鉴权下载（批量导出 zip 不能走 kApi，它默认按 JSON 解析）。 */
async function kDownload(path, payload) {
  const token = sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";
  const resp = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload ?? {}),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `下载失败（${resp.status}）`);
  }
  const blob = await resp.blob();
  const match = /filename\*=UTF-8''([^;]+)/i.exec(resp.headers.get("content-disposition") ?? "");
  const filename = match ? decodeURIComponent(match[1]) : `知识库导出-${new Date().toISOString().slice(0, 10)}.zip`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

function topicCardsHtml(items) {
  return `<div class="kb-cards">${items.map((t) => `
    <div class="kb-card${kb.selected.has(t.id) ? " picked" : ""}" role="button" tabindex="0" data-topic="${esc(t.id)}" aria-label="${esc(t.title)}">
      <span class="kb-check${kb.selected.has(t.id) ? " on" : ""}" data-check="${esc(t.id)}" role="checkbox" tabindex="0"
            aria-checked="${kb.selected.has(t.id)}" title="勾选后可批量操作"></span>
      <header>
        <strong>${esc(t.title)}</strong>
        <span class="kb-pill ${STATUS_TONE[t.status] ?? "off"}">${STATUS_NAME[t.status] ?? t.status}</span>
      </header>
      <p>${esc(t.summary || "（无摘要）")}</p>
      <footer>
        <span>${esc(t.type)}</span>
        ${t.spawned_count ? `<span class="kb-tag ok" title="已流转出 ${t.spawned_count} 个派生主题">已孵化 ${t.spawned_count}</span>` : ""}
        ${(t.tags ?? []).slice(0, 3).map((tag) => `<span class="kb-tag">${esc(tag)}</span>`).join("")}
        <span class="kb-grow"></span>
        <span class="kb-quality" title="质量分（来源30/证据25/审核20/新鲜15/一致10）">${t.quality ?? 0} 分</span>
        <span>${fmtTime(t.updated_at)}</span>
      </footer>
    </div>`).join("")}</div>`;
}

function topicTableHtml(items) {
  const all = items.length && items.every((t) => kb.selected.has(t.id));
  return `<table class="kb-table kb-table-pick"><thead><tr>
    <th class="kb-pick"><span class="kb-check${all ? " on" : ""}" data-check-all="1" role="checkbox" tabindex="0" aria-checked="${all}" title="全选"></span></th>
    <th>标题</th><th>类型</th><th>状态</th><th>密级</th><th>质量分</th><th>更新时间</th>
  </tr></thead><tbody>${items.map((t) => `
    <tr data-topic="${esc(t.id)}" class="${kb.selected.has(t.id) ? "picked" : ""}">
      <td class="kb-pick"><span class="kb-check${kb.selected.has(t.id) ? " on" : ""}" data-check="${esc(t.id)}" role="checkbox" tabindex="0" aria-checked="${kb.selected.has(t.id)}"></span></td>
      <td>${esc(t.title)}${t.spawned_count ? ` <span class="kb-tag ok" title="已流转出 ${t.spawned_count} 个派生主题">已孵化 ${t.spawned_count}</span>` : ""}</td><td>${esc(t.type)}</td>
      <td><span class="kb-pill ${STATUS_TONE[t.status] ?? "off"}">${STATUS_NAME[t.status] ?? t.status}</span></td>
      <td>${CLASS_NAME[t.classification] ?? ""}</td>
      <td>${t.quality ?? 0}</td><td>${fmtTime(t.updated_at)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function bindTopicCards(root) {
  const open = (row) => {
    kb.topicId = row.dataset.topic;
    kb.editing = false;
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  };
  $$("[data-topic]", root).forEach((row) => {
    row.addEventListener("click", () => open(row));
    // 卡片从 <button> 换成 div 才能嵌勾选框，键盘可达性要自己补
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(row); }
    });
  });
  // 勾选框本身也要能用键盘切换
  $$("[data-check]", root).forEach((box) => box.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); box.click(); }
  }));
}

/* ---------------------------------------------------------------- 主题详情 + 编辑 */

async function renderTopicDetail() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  let topic;
  try {
    topic = await kApi(`/api/knowledge/topics/${kb.topicId}`);
  } catch (error) {
    kb.topicId = null;
    body.innerHTML = `<div class="kb-empty">${esc(error.message)}</div>`;
    return;
  }
  if (kb.editing) return renderTopicEditor(topic);

  const conflict = topic.conflict;
  // 流向区：灵感 ↔ 派生主题，两边都能点进去；没有关系时给一句「下一步做什么」
  const flowItem = (dir, d) => `
    <button type="button" class="kb-flow-item" data-goto="${esc(d.id)}">
      <span class="kb-flow-dir">${dir}</span>
      <b>${esc(d.title)}</b>
      <span class="kb-flow-meta">${SPACE_NAME[d.space] ?? esc(d.space)} · ${esc(d.type)} · ${STATUS_NAME[d.status] ?? d.status}</span>
    </button>`;
  // 正文里已经用 ![[...]] 嵌进去的附件不再在「附件」区重复列一次
  const inlineNames = new Set([...String(topic.body ?? "").matchAll(/!?\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
  const looseAttachments = (topic.attachments ?? []).filter((a) => !inlineNames.has(String(a.path ?? "").split("/").pop()));
  const flowHtml = [
    ...(topic.spawnedFrom ?? []).map((d) => flowItem("来源灵感", d)),
    ...(topic.derived ?? []).map((d) => flowItem("已流转为", d)),
  ].join("") || `<div class="kb-empty">${topic.space === "idea" ? "还没有流转。验证成立后用右上「流转为…」长出调研或企划主题，灵感原件会留下" : "暂无流向关系"}</div>`;
  body.innerHTML = `
    <div class="kb-detail">
      <div class="kb-detail-head">
        <button type="button" class="btn ghost" id="kbBack">← 返回</button>
        <div class="kb-detail-title">
          <h3>${esc(topic.title)}</h3>
          <div class="kb-detail-meta">
            <span class="kb-pill ${STATUS_TONE[topic.status] ?? "off"}">${STATUS_NAME[topic.status] ?? topic.status}</span>
            <span>${SPACE_NAME[topic.space] ?? esc(topic.space)} · ${esc(topic.type)} · ${CLASS_NAME[topic.classification] ?? ""} · v${topic.version} · 质量分 ${topic.quality}</span>
            <span>更新 ${fmtTime(topic.updated_at)}</span>
            ${topic.vault_path ? `<span class="kb-vault-path" title="${esc(topic.vault_path)}">Vault: ${esc(topic.vault_path)}</span>` : ""}
          </div>
        </div>
        <div class="kb-detail-acts">
          ${topic.space === "idea" ? '<button type="button" class="btn primary" id="kbSpawn" title="保留这条灵感，在调研 / 企划 / 产品里长出一个派生主题">流转为…</button>' : ""}
          <button type="button" class="btn" id="kbEdit">编辑</button>
          <button type="button" class="btn" id="kbMove" title="放错空间了？迁移到正确的知识空间（同步搬移 Vault 文件）">迁移</button>
          <button type="button" class="btn" id="kbExport" title="导出为 Markdown 交付文件（含 frontmatter 与来源证据附录）">导出 MD</button>
          ${topic.status === "draft" ? '<button type="button" class="btn primary" id="kbSubmit">提交审核</button>' : ""}
          ${["pending", "revise"].includes(topic.status) ? '<button type="button" class="btn primary" id="kbPublish">审核通过并发布</button>' : ""}
          ${topic.status === "published" ? '<button type="button" class="btn" id="kbArchive">归档</button>' : ""}
        </div>
      </div>

      ${conflict ? `
        <div class="kb-conflict">
          <h4>⚠ 检测到 Obsidian 外部修改与工作台草稿冲突</h4>
          <div class="kb-conflict-cols">
            <div><b>Vault 当前内容</b><pre>${esc(conflict.vaultBody?.slice(0, 800))}</pre></div>
            <div><b>工作台草稿</b><pre>${esc(conflict.draftBody?.slice(0, 800))}</pre></div>
          </div>
          <div class="kb-conflict-acts">
            <button type="button" class="btn" id="kbTakeVault">采用 Vault 内容</button>
            <button type="button" class="btn" id="kbKeepDraft">保留工作台草稿</button>
          </div>
        </div>` : ""}

      ${kb.movePanel ? movePanelHtml(topic) : ""}
      ${kb.spawnPanel && topic.space === "idea" ? spawnPanelHtml(topic) : ""}

      <div class="kb-detail-cols">
        <div class="kb-detail-main">
          ${topic.space === "idea" ? "" : `
          <section class="kb-section">
            <div class="kb-section-head">
              <h4>摘要</h4>
              ${topic.summarySource ? `<span class="kb-tag${topic.summaryAuto ? " ok" : ""}" title="摘要来源">${esc(topic.summarySource)}</span>` : ""}
              <span class="kb-grow"></span>
              <button type="button" class="btn tiny" id="kbResummarize" title="按「产品概述 / 系统概述 / 核心结论」等章节重新摘取">重新摘取</button>
            </div>
            <p class="kb-summary">${esc(topic.summary || "（无摘要，编辑里可补）")}</p>
          </section>`}
          ${looseAttachments.length ? `
          <section class="kb-section">
            <h4>附件 ${looseAttachments.length}</h4>
            <div class="kb-att-grid">
              ${looseAttachments.map((a) => a.kind === "image" ? `
                <button type="button" class="kb-att pic" data-att-open="${esc(a.id)}" title="${esc(a.name)}">
                  <img alt="" data-att="${esc(a.id)}">
                  <span>${esc(a.name)}</span>
                </button>` : `
                <button type="button" class="kb-att" data-att-open="${esc(a.id)}" title="${esc(a.name)}">
                  <span class="kb-att-ext">${esc((a.ext || "").replace(".", "").toUpperCase().slice(0, 4) || "FILE")}</span>
                  <b>${esc(a.name)}</b>
                  <em>${fmtSize(a.size ?? 0)}</em>
                </button>`).join("")}
            </div>
          </section>` : ""}
          <section class="kb-section">
            <h4>结构化正文</h4>
            <div class="kb-md">${mdLite(topic.body, topic.attachments)}</div>
          </section>
        </div>
        <div class="kb-detail-side">
          <section class="kb-section">
            <h4>流向</h4>
            <div class="kb-flow">${flowHtml}</div>
          </section>
          <section class="kb-section">
            <h4>来源证据</h4>
            ${(topic.citations ?? []).length ? `<div class="kb-cite-list">${topic.citations.map((c) => `
              <div class="kb-cite">
                <b>${esc(c.source_name)} · ${esc(c.frag_locator || c.locator || "未定位")}</b>
                <p>${esc((c.frag_text || "").slice(0, 100))}…</p>
              </div>`).join("")}</div>` : `<div class="kb-empty">暂无来源引用（证据不足，质量分受影响）</div>`}
          </section>
          ${topic.space === "idea" ? "" : `
          <section class="kb-section">
            <h4>质量分构成</h4>
            <div class="kb-quality-detail">
              ${Object.entries(topic.quality_detail ?? {}).map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join("") || `<div class="kb-empty">发布后计算</div>`}
            </div>
          </section>`}
          ${topic.space === "idea" ? "" : `
          <section class="kb-section">
            <h4>版本记录</h4>
            ${(topic.versions ?? []).length ? `<div class="kb-version-list">${topic.versions.map((v) => `
              <div class="kb-version"><span>v${v.version} · ${esc(v.note || "—")}</span><button type="button" class="btn tiny" data-rollback="${v.version}">回滚到此版</button></div>`).join("")}</div>`
              : `<div class="kb-empty">还没有版本记录</div>`}
          </section>`}
        </div>
      </div>
    </div>`;

  loadAttImages(body);
  $$("[data-att-open]", body).forEach((btn) => btn.addEventListener("click", async () => {
    try {
      const url = await kBlobUrl(`/api/knowledge/attachments/${btn.dataset.attOpen}`);
      window.open(url, "_blank", "noopener");
    } catch (error) { kToast(error.message, "bad"); }
  }));
  $("#kbBack").addEventListener("click", () => { kb.topicId = null; kb.movePanel = false; renderKbTab(); });
  $("#kbEdit").addEventListener("click", () => { kb.editing = true; renderTopicDetail(); });
  $("#kbMove").addEventListener("click", () => { kb.movePanel = !kb.movePanel; kb.spawnPanel = false; renderTopicDetail(); });
  $("#kbSpawn")?.addEventListener("click", () => { kb.spawnPanel = !kb.spawnPanel; kb.movePanel = false; renderTopicDetail(); });
  if (kb.movePanel) bindMovePanel(topic);
  if (kb.spawnPanel) bindSpawnPanel(topic);
  // 流向区块：点一下就跳到对端主题
  $$("[data-goto]", body).forEach((btn) => btn.addEventListener("click", () => {
    kb.topicId = btn.dataset.goto;
    kb.editing = false;
    kb.spawnPanel = false;
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  }));
  $("#kbResummarize")?.addEventListener("click", async () => {
    try {
      const r = await kApi(`/api/knowledge/topics/${topic.id}/summarize`, { method: "POST", body: JSON.stringify({ apply: true }) });
      if (!r.applied) return kToast("正文里没有找到「产品概述 / 系统概述」这类段落，请手动补写", "bad");
      kToast(`已按「${r.section || "首段正文"}」重新摘取摘要`);
      renderTopicDetail();
    } catch (error) { kToast(error.message, "bad"); }
  });
  $("#kbExport").addEventListener("click", async () => {
    try {
      // 带鉴权下载：fetch 拿内容再落 Blob，避免 URL 带 token 的暴露
      const token = sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";
      const resp = await fetch(`/api/knowledge/topics/${topic.id}/export`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `导出失败（${resp.status}）`);
      const blob = await resp.blob();
      const name = decodeURIComponent((resp.headers.get("content-disposition") ?? "").match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "topic-export.md");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      kToast("已导出 Markdown 文件");
    } catch (error) { kToast(error.message, "bad"); }
  });
  $("#kbSubmit")?.addEventListener("click", async () => {
    await kApi(`/api/knowledge/topics/${topic.id}/submit`, { method: "POST" });
    kToast("已提交审核");
    renderKbTab();
  });
  $("#kbPublish")?.addEventListener("click", async () => {
    await kApi(`/api/knowledge/topics/${topic.id}/publish`, { method: "POST" });
    kToast("已发布并回写 Obsidian Vault");
    renderKbTab();
  });
  $("#kbArchive")?.addEventListener("click", async () => {
    await kApi(`/api/knowledge/topics/${topic.id}/archive`, { method: "POST" });
    kToast("已归档");
    renderKbTab();
  });
  $$("[data-rollback]", body).forEach((btn) => btn.addEventListener("click", async () => {
    const okRollback = await confirmDialog({
      title: "回滚版本",
      message: `回滚到 v${btn.dataset.rollback}？`,
      detail: "当前未发布的修改会丢失。回滚会写一条新版本，历史不会被删。",
      okText: "回滚",
      tone: "danger",
    });
    if (!okRollback) return;
    await kApi(`/api/knowledge/topics/${topic.id}/rollback`, { method: "POST", body: JSON.stringify({ version: Number(btn.dataset.rollback) }) });
    kToast("已回滚");
    renderKbTab();
  }));
  $("#kbTakeVault")?.addEventListener("click", async () => {
    await kApi(`/api/knowledge/topics/${topic.id}/draft`, { method: "PATCH", body: JSON.stringify({ body: conflict.vaultBody, conflict: "" }) });
    kToast("已采用 Vault 内容");
    renderKbTab();
  });
  $("#kbKeepDraft")?.addEventListener("click", async () => {
    await kApi(`/api/knowledge/topics/${topic.id}/draft`, { method: "PATCH", body: JSON.stringify({ body: conflict.draftBody, conflict: "" }) });
    kToast("已保留工作台草稿，重新发布即可覆盖 Vault");
    renderKbTab();
  });
}

/** 迁移面板：目标空间 + 目标类型联动，确认后调 move 接口（Vault 文件同步搬家）。 */
function movePanelHtml(topic) {
  const spaces = kb.boot.spaces ?? [];
  const types = spaces.find((s) => s.key === topic.space)?.types ?? [topic.type];
  return `
    <section class="kb-move">
      <h4>迁移到其他知识空间</h4>
      <div class="kb-move-row">
        <label><span>目标空间</span><select id="kbMoveSpace">
          ${spaces.map((s) => `<option value="${esc(s.key)}"${s.key === topic.space ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
        <label><span>目标类型</span><select id="kbMoveType">
          ${types.map((t) => `<option${t === topic.type ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select></label>
        <button type="button" class="btn primary" id="kbMoveGo">确认迁移</button>
        <button type="button" class="btn ghost" id="kbMoveCancel">取消</button>
      </div>
      <p class="kb-note">迁移会把 Vault 里的页面搬到新目录（旧文件删除）并改写 frontmatter 的类型，否则下一轮扫描会按类型把页面拽回旧目录。</p>
    </section>`;
}

function bindMovePanel(topic) {
  const syncTypes = () => {
    const space = $("#kbMoveSpace").value;
    const types = kb.boot.spaces.find((s) => s.key === space)?.types ?? [];
    $("#kbMoveType").innerHTML = types.map((t) => `<option>${esc(t)}</option>`).join("");
    if (space === topic.space) $("#kbMoveType").value = topic.type;
  };
  $("#kbMoveSpace").addEventListener("change", syncTypes);
  $("#kbMoveCancel").addEventListener("click", () => { kb.movePanel = false; renderTopicDetail(); });
  $("#kbMoveGo").addEventListener("click", async () => {
    const space = $("#kbMoveSpace").value;
    const type = $("#kbMoveType").value;
    if (space === topic.space && type === topic.type) return kToast("目标空间和类型都没变", "bad");
    try {
      const r = await kApi(`/api/knowledge/topics/${topic.id}/move`, { method: "POST", body: JSON.stringify({ space, type }) });
      const spaceName = SPACE_NAME[r.topic.space] ?? r.topic.space;
      kToast(r.removed ? `已迁移到「${spaceName} · ${r.topic.type}」，旧文件已删除` : `已迁移到「${spaceName} · ${r.topic.type}」`);
      kb.movePanel = false;
      // 跟着主题走：空间页签切到目标空间，返回时看到的是迁移后的列表
      kb.tab = r.topic.space;
      localStorage.setItem("kb-tab", kb.tab);
      renderKbTabs();
      renderKbTab();
    } catch (error) { kToast(error.message, "bad"); }
  });
}

/** 标题后缀：流转到不同空间时自动跟一句，避免派生主题和灵感原件同名认不出。 */
const SPAWN_SUFFIX = { research: "（验证）", planning: "（立项）", product: "（需求）" };

/** 流转面板：灵感 → 调研 / 企划 / 产品，生成派生主题，原件保留。 */
function spawnPanelHtml(topic) {
  const targets = (kb.boot.spaces ?? []).filter((s) => s.key !== "idea");
  return `
    <section class="kb-move kb-spawn">
      <h4>把这条灵感流转为</h4>
      <div class="kb-move-row">
        <label><span>目标空间</span><select id="kbSpawnSpace">
          ${targets.map((s) => `<option value="${esc(s.key)}"${s.key === "planning" ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
        <label><span>目标类型</span><select id="kbSpawnType"></select></label>
        <label class="kb-move-title"><span>派生主题标题</span><input id="kbSpawnTitle" maxlength="120" value="${esc(String(topic.title).replace(/…$/, ""))}${SPAWN_SUFFIX.planning}"></label>
        <button type="button" class="btn primary" id="kbSpawnGo">确认流转</button>
        <button type="button" class="btn ghost" id="kbSpawnCancel">取消</button>
      </div>
      <p class="kb-note">灵感原件保留：不搬家、不删 Vault 文件、状态不变。派生主题是草稿，正文带灵感原文和一张待验证清单；两边页面的 source_refs 互相链接，图谱里画成带箭头的流向。</p>
    </section>`;
}

function bindSpawnPanel(topic) {
  const baseTitle = String(topic.title).replace(/…$/, "");
  const suffixOf = (space) => SPAWN_SUFFIX[space] ?? "";
  let autoTitle = `${baseTitle}${suffixOf($("#kbSpawnSpace").value)}`;
  const syncTypes = () => {
    const space = $("#kbSpawnSpace").value;
    const types = kb.boot.spaces.find((s) => s.key === space)?.types ?? [];
    $("#kbSpawnType").innerHTML = types.map((t) => `<option>${esc(t)}</option>`).join("");
    // 标题没被手改过 → 跟着目标空间换后缀；改过就不动用户的字
    const input = $("#kbSpawnTitle");
    const next = `${baseTitle}${suffixOf(space)}`;
    if (!input.value.trim() || input.value.trim() === autoTitle.trim()) input.value = next;
    autoTitle = next;
  };
  syncTypes();
  $("#kbSpawnSpace").addEventListener("change", syncTypes);
  $("#kbSpawnCancel").addEventListener("click", () => { kb.spawnPanel = false; renderTopicDetail(); });
  $("#kbSpawnGo").addEventListener("click", async () => {
    const space = $("#kbSpawnSpace").value;
    const type = $("#kbSpawnType").value;
    const title = $("#kbSpawnTitle").value.trim();
    const spaceName = SPACE_NAME[space] ?? space;

    try {
      const r = await kApi(`/api/knowledge/topics/${topic.id}/spawn`, {
        method: "POST", body: JSON.stringify({ space, type, title }),
      });
      kb.spawnPanel = false;
      kToast(r.reused
        ? `这条灵感之前已经流转过，已定位到「${r.topic.title}」`
        : `已流转为「${spaceName} · ${r.topic.type}」的「${r.topic.title}」，原件保留`);
      renderTopicDetail();
    } catch (error) { kToast(error.message, "bad"); }
  });
}

function renderTopicEditor(topic) {
  const body = $("#kbBody");
  body.innerHTML = `
    <div class="kb-detail">
      <div class="kb-detail-head">
        <button type="button" class="btn ghost" id="kbBack">← 放弃编辑</button>
        <div class="kb-detail-title"><h3>编辑：${esc(topic.title)}</h3>
          <div class="kb-detail-meta"><span id="kbDraftState">草稿自动保存已开启</span></div>
        </div>
        <div class="kb-detail-acts">
          <button type="button" class="btn" id="kbSaveDraft">保存草稿</button>
          <button type="button" class="btn primary" id="kbSaveSubmit">保存并提交审核</button>
        </div>
      </div>
      <div class="kb-editor">
        <label class="kb-field"><span>标题</span><input id="kbEditTitle" value="${esc(topic.title)}" maxlength="120"></label>
        <div class="kb-field">
          <span>摘要
            ${topic.summarySource ? `<em class="kb-src-note">${esc(topic.summarySource)}</em>` : ""}
            <button type="button" class="kb-inline-btn" id="kbEditSummarize" title="先保存正文，再按「产品概述 / 系统概述 / 核心结论」章节摘取">按概述章节重新摘取</button>
          </span>
          <textarea id="kbEditSummary" rows="2" maxlength="400">${esc(topic.summary)}</textarea>
        </div>
        <div class="kb-editor-cols">
          <label class="kb-field"><span>正文（Markdown）</span><textarea id="kbEditBody" rows="18">${esc(topic.body)}</textarea></label>
          <div class="kb-preview"><span>实时预览</span><div class="kb-md" id="kbPreview">${mdLite(topic.body)}</div></div>
        </div>
        <div class="kb-editor-props">
          <label><span>空间</span><select id="kbEditSpace">${(kb.boot.spaces ?? []).map((sp) => `<option value="${esc(sp.key)}"${sp.key === topic.space ? " selected" : ""}>${esc(sp.name)}</option>`).join("")}</select></label>
          <label><span>类型</span><select id="kbEditType">${(kb.boot.spaces.find((s) => s.key === topic.space)?.types ?? [topic.type]).map((t) => `<option${t === topic.type ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          <label><span>密级</span><select id="kbEditClass">${Object.entries(CLASS_NAME).map(([k, v]) => `<option value="${k}"${k === topic.classification ? " selected" : ""}>${v}</option>`).join("")}</select></label>
          <label><span>标签（逗号分隔）</span><input id="kbEditTags" value="${esc((topic.tags ?? []).join(", "))}" placeholder="例：线阵列, 户外, 2026"></label>
          <label class="kb-class-note" id="kbClassNote"></label>
        </div>
        <div class="kb-vocab-chips" id="kbVocabChips"></div>
      </div>
    </div>`;

  const readDraft = () => ({
    title: $("#kbEditTitle").value.trim() || "未命名主题",
    summary: $("#kbEditSummary").value.trim(),
    body: $("#kbEditBody").value,
    space: $("#kbEditSpace").value,
    type: $("#kbEditType").value,
    classification: $("#kbEditClass").value,
    tags: $("#kbEditTags").value.split(/[,，;；]/).map((t) => t.trim()).filter(Boolean).slice(0, 12),
  });
  let summaryTouched = false;
  $("#kbEditSummary").addEventListener("input", () => { summaryTouched = true; });
  // 空间改了 → 类型列表跟着换（避免把「招投标」留在企划里）
  const syncEditTypes = (preferred) => {
    const space = $("#kbEditSpace").value;
    const types = kb.boot.spaces.find((s) => s.key === space)?.types ?? [];
    $("#kbEditType").innerHTML = types.map((t) => `<option${t === preferred ? " selected" : ""}>${esc(t)}</option>`).join("");
  };
  $("#kbEditSpace").addEventListener("change", () => syncEditTypes(topic.type));
  $("#kbEditSummarize").addEventListener("click", async () => {
    try {
      // 先存一次，保证摘取的是当前正文，而不是上次保存的版本
      await saveDraft(true);
      const r = await kApi(`/api/knowledge/topics/${topic.id}/summarize`, { method: "POST", body: JSON.stringify({ apply: false }) });
      if (!r.summary) return kToast("正文里没有找到概述类章节，请手动补写", "bad");
      $("#kbEditSummary").value = r.summary;
      summaryTouched = true;
      kToast(`已按「${r.section || "首段正文"}」摘取，保存后生效`);
    } catch (error) { kToast(error.message, "bad"); }
  });
  // 高频标签（受控词表底账）：点一下就加进标签栏，减少随意造新词
  kApi("/api/knowledge/vocab").then(({ items }) => {
    const chips = $("#kbVocabChips");
    if (!chips) return;
    const top = (items ?? []).slice(0, 14);
    chips.innerHTML = top.length ? `<span>高频标签：</span>${top.map((v) => `<button type="button" class="kb-tag kb-tag-add" data-tag="${esc(v.name)}" title="${v.uses} 个主题在用">${esc(v.name)}<i>${v.uses}</i></button>`).join("")}` : "";
    $$(".kb-tag-add", chips).forEach((btn) => btn.addEventListener("click", () => {
      const current = new Set(readDraft().tags);
      current.add(btn.dataset.tag);
      $("#kbEditTags").value = [...current].join(", ");
    }));
  }).catch(() => {});
  const classNote = () => {
    const rule = { public: "可使用普通云模型", internal: "仅摘要或脱敏片段可上云", secret: "禁止上云，只能本地处理" };
    $("#kbClassNote").textContent = `云端规则：${rule[$("#kbEditClass").value]}`;
  };
  classNote();
  $("#kbEditClass").addEventListener("change", classNote);
  $("#kbEditBody").addEventListener("input", () => { $("#kbPreview").innerHTML = mdLite($("#kbEditBody").value); });
  // 直接退会丢页面上的改动：有改动先确认，没改动就别拦
  $("#kbBack").addEventListener("click", async () => {
    const now = readDraft();
    const dirty = now.title !== topic.title
      || now.body !== topic.body
      || now.summary !== (topic.summary ?? "")
      || now.space !== topic.space
      || now.type !== topic.type
      || now.classification !== topic.classification
      || now.tags.join("|") !== (topic.tags ?? []).join("|");
    if (dirty) {
      const ok = await confirmDialog({
        title: "放弃这次编辑？",
        message: "页面上还没保存的改动会丢掉。",
        detail: "想留着下次继续，先点「保存草稿」再退出。",
        okText: "放弃改动",
        cancelText: "继续编辑",
        tone: "danger",
      });
      if (!ok) return;
    }
    kb.editing = false;
    clearInterval(kb.draftTimer);
    renderTopicDetail();
  });

  const saveDraft = async (quiet = true) => {
    try {
      const patch = readDraft();
      const { space, type, ...rest } = patch;
      // 空间/类型变更交给 move 接口处理：若先 PATCH 改了 type，move 会判定为「没变化」而不搬文件
      const needsMove = space !== topic.space || type !== topic.type;
      if (!needsMove) rest.type = type;
      if (summaryTouched) Object.assign(rest, { summary_source: "人工编辑", summary_auto: 0 });
      await kApi(`/api/knowledge/topics/${topic.id}/draft`, { method: "PATCH", body: JSON.stringify(rest) });
      if (needsMove) {
        const r = await kApi(`/api/knowledge/topics/${topic.id}/move`, { method: "POST", body: JSON.stringify({ space, type }) });
        topic.space = r.topic.space;
        topic.type = r.topic.type;
        topic.vault_path = r.topic.vault_path;
        syncEditTypes(topic.type);
        kToast(`已迁移到「${SPACE_NAME[topic.space] ?? topic.space} · ${topic.type}」`);
      }
      if (!quiet) kToast("草稿已保存");
      $("#kbDraftState").textContent = `草稿已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      if (!quiet) kToast(error.message, "bad");
    }
  };
  // 自动保存（规格书 6.3）：20s 一次，只动草稿区
  clearInterval(kb.draftTimer);
  kb.draftTimer = setInterval(() => { if (kb.editing) saveDraft(true); }, 20_000);

  $("#kbSaveDraft").addEventListener("click", () => saveDraft(false));
  $("#kbSaveSubmit").addEventListener("click", async () => {
    clearInterval(kb.draftTimer);
    await saveDraft(true);
    await kApi(`/api/knowledge/topics/${topic.id}/submit`, { method: "POST" });
    kToast("已保存并提交审核");
    kb.editing = false;
    renderKbTab();
  });
}

async function newTopicDraft(space) {
  const spaces = kb.boot.spaces ?? [];
  // 首页点「新建主题」时 space 会被回落到 research，这时让用户自己选，别默认猜错
  const needSpace = !space || !["research", "planning", "product", "idea"].includes(space);
  const spaceKey = needSpace ? "research" : space;
  const typesOf = (key) => spaces.find((s) => s.key === key)?.types ?? [];
  const types = typesOf(spaceKey);
  const values = await formDialog({
    title: "新建主题",
    note: "先定空间、标题和类型，正文进编辑器再补；每 20 秒自动保存草稿。",
    width: 520,
    fields: [
      ...(needSpace ? [{
        key: "space", label: "知识空间", type: "select", value: spaceKey,
        options: spaces.map((s) => ({ value: s.key, label: s.name })),
      }] : []),
      { key: "title", label: "标题", placeholder: "例如：宁波凯越集团调研报告", required: true },
      {
        key: "type", label: "类型", type: "select", value: types[0],
        options: types.map((t) => ({ value: t, label: t })),
      },
    ],
    onChange: (current) => {
      const next = typesOf(current.space);
      return { type: { options: next.map((t) => ({ value: t, label: t })), value: next[0] } };
    },
    okText: "创建并编辑",
  });
  if (!values) return;
  try {
    const topic = await kApi("/api/knowledge/topics", {
      method: "POST",
      body: JSON.stringify({ space: values.space ?? spaceKey, type: values.type, title: values.title }),
    });
    kToast("主题已创建，开始编辑");
    kb.topicId = topic.id;
    kb.editing = true;
    gotoDetail();
  } catch (error) { kToast(error.message, "bad"); }
}

function gotoDetail() {
  renderKbTabs();
  renderKbTab().catch((e) => kToast(e.message, "bad"));
}

/* ---------------------------------------------------------------- 审核中心 */

async function renderReviews() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  const data = await kApi("/api/knowledge/reviews?status=pending");
  const items = data.items ?? [];
  body.innerHTML = `
    <div class="kb-toolbar"><div class="kb-toolbar-left"><h3>审核中心</h3><span class="kb-count">${items.length} 条待处理</span></div>
      <div class="kb-toolbar-right">
        <span class="kb-note">重要结论逐条确认；AI 只能生成候选，未审核候选不会覆盖正式知识（规格书 9.1）</span>
        ${items.length ? '<button type="button" class="btn" id="kbBulkApprove">全部通过并发布</button>' : ""}
      </div></div>
    ${items.length ? `<div class="kb-review-list">${items.map((r) => `
      <div class="kb-review-card" data-review="${esc(r.id)}">
        <header><b>${esc(r.title || "候选内容")}</b><span class="kb-tag">${r.created_by === "ai" ? "AI 候选" : "人工提交"} · ${fmtTime(r.created_at)}</span></header>
        <pre class="kb-review-body">${esc((r.candidate || "").slice(0, 600))}</pre>
        <footer>
          <button type="button" class="btn tiny primary" data-decide="approved">通过并发布</button>
          <button type="button" class="btn tiny" data-decide="returned">退回修改</button>
          <button type="button" class="btn tiny ghost" data-decide="rejected">拒绝</button>
        </footer>
      </div>`).join("")}</div>` : `<div class="kb-empty">没有待审核项</div>`}`;

  $("#kbBulkApprove")?.addEventListener("click", async () => {
    if (!(await confirmDialog({
      title: "全部通过并发布",
      message: `把全部 ${items.length} 条待审核项通过并发布？`,
      detail: "发布后会回写 Obsidian Vault，成为正式知识。",
      okText: "全部通过",
    }))) return;
    try {
      const result = await kApi("/api/knowledge/reviews/bulk-approve", { method: "POST" });
      kToast(`已通过 ${result.approved}/${result.total}${result.failed?.length ? `，失败 ${result.failed.length} 条` : ""}`);
      renderReviews();
      updateKbBadge();
    } catch (error) { kToast(error.message, "bad"); }
  });

  $$("[data-decide]", body).forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest("[data-review]");
    const status = btn.dataset.decide;
    let comment = "";
    if (status !== "approved") {
      const reason = await promptDialog({
        title: status === "returned" ? "退回修改" : "拒绝这条候选",
        label: status === "returned" ? "退回原因（会用来改进后续候选）" : "拒绝原因",
        multiline: true,
        placeholder: status === "returned" ? "例如：缺少客户侧证据，请补一份访谈记录" : "例如：与现有结论重复，已有更权威来源",
        okText: status === "returned" ? "退回" : "拒绝",
        required: false,
      });
      // 取消就把这次操作整个放弃，不要带着空原因提交
      if (reason === null) return;
      comment = reason;
    }
    try {
      await kApi(`/api/knowledge/reviews/${card.dataset.review}/decide`, { method: "POST", body: JSON.stringify({ status, comment }) });
      kToast(status === "approved" ? "已通过并发布" : "已处理");
      renderReviews();
      updateKbBadge();
    } catch (error) { kToast(error.message, "bad"); }
  }));
}

/* ---------------------------------------------------------------- 导入中心 */

async function renderImports() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  const data = await kApi("/api/knowledge/imports");
  const batches = data.items ?? [];
  const spaces = kb.boot.spaces ?? [];
  body.innerHTML = `
    <div class="kb-import">
      <div class="kb-drop-overlay" id="kbDropOverlay">
        <strong>松开即可导入</strong>
        <span>支持多文件与整个文件夹，按当前「空间 / 类型 / 密级」导入</span>
      </div>
      <section class="kb-section kb-import-form">
        <h4>新建导入（本地解析，密级决定云端边界）${kb.boot?.ocr ? `<span class="kb-note kb-note-indent">OCR：${esc(kb.boot.ocr.note)}</span>` : ""}</h4>
        <div class="kb-import-row">
          <label><span>目标空间</span><select id="kbImpSpace">${spaces.filter((s) => s.key !== "product").map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join("")}</select></label>
          <label><span>主题类型</span><select id="kbImpType"></select></label>
          <label><span>密级</span><select id="kbImpClass">${Object.entries(CLASS_NAME).map(([k, v]) => `<option value="${k}"${k === "internal" ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        </div>
        <div class="kb-import-ways">
          <div class="kb-import-way">
            <b>本地文件</b>
            <p>PPT / PDF / Word / Excel / XMind / 图片 / Markdown / HTML / 文本，可多选，也可直接拖进来</p>
            <label class="kb-drop" id="kbImpDrop" for="kbImpFiles">
              <span class="kb-drop-title">拖文件或文件夹到这里，或点击选择</span>
              <span class="kb-drop-sub">整个导入页都能接住拖入；文件夹会递归展开，不支持的文件自动跳过。也可多选文件后一次导入</span>
              <input type="file" id="kbImpFiles" multiple accept=".pptx,.ppt,.pdf,.docx,.doc,.xlsx,.xls,.xmind,.png,.jpg,.jpeg,.webp,.md,.markdown,.mdown,.txt,.log,.csv,.html,.htm,.xhtml">
            </label>
          </div>
          <div class="kb-import-way">
            <b>粘贴文本</b>
            <p>会议纪要、聊天记录、资料片段</p>
            <textarea id="kbImpText" rows="4" placeholder="粘贴内容后点导入"></textarea>
            <button type="button" class="btn" id="kbImpTextGo">导入文本</button>
          </div>
          <div class="kb-import-way">
            <b>网页链接</b>
            <p>手动提交单个链接（不做自动抓取）</p>
            <input type="url" id="kbImpUrl" placeholder="https://…">
            <button type="button" class="btn" id="kbImpUrlGo">导入链接</button>
          </div>
        </div>
        <div class="kb-import-result" id="kbImpResult"></div>
      </section>
      <section class="kb-section">
        <h4>导入批次</h4>
        ${batches.length ? `<table class="kb-table"><thead><tr><th>批次</th><th>进度</th><th>状态</th><th>时间</th></tr></thead><tbody>
          ${batches.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.files_done}/${b.files_total}</td><td>${b.status === "completed" ? "完成" : b.status === "failed" ? "失败" : "进行中"}${b.error ? ` · ${esc(b.error)}` : ""}</td><td>${fmtTime(b.created_at)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="kb-empty">还没有导入记录</div>`}
      </section>
    </div>`;

  const classOf = () => $("#kbImpClass").value;
  const spaceOf = () => $("#kbImpSpace").value;
  const typeOf = () => $("#kbImpType").value;
  // 类型选项跟随空间联动，避免把「招投标」塞进企划空间
  const syncTypes = () => {
    const space = spaceOf();
    const types = kb.boot.spaces.find((s) => s.key === space)?.types ?? [];
    $("#kbImpType").innerHTML = types.map((t) => `<option>${esc(t)}</option>`).join("");
  };
  syncTypes();
  $("#kbImpSpace").addEventListener("change", syncTypes);

  /* ---------------------------------------------------------------- 批量导入队列 */

  const SUPPORTED_EXT = new Set([
    "pptx", "ppt", "pdf", "docx", "doc", "xlsx", "xls", "xmind",
    "png", "jpg", "jpeg", "webp", "bmp", "gif",
    "md", "markdown", "mdown", "txt", "log", "csv",
    "html", "htm", "xhtml", "shtml",
  ]);
  const extOf = (name) => String(name).split(".").pop().toLowerCase();
  const supported = (name) => SUPPORTED_EXT.has(extOf(name));
  const MAX_FILES = 300;

  let queue = [];   // { file, state, result }
  let abort = false;
  let running = false;

  const stateText = (row) => {
    if (row.state === "wait") return "等待";
    if (row.state === "run") return "解析中…";
    if (row.state === "abort") return "已取消";
    if (row.state === "bad") return "失败";
    if (row.state === "skip") return "跳过";
    return "完成";
  };

  const renderQueue = (summary = "") => {
    const box = $("#kbImpResult");
    if (!box) return;
    const done = queue.filter((r) => ["ok", "skip", "bad", "abort"].includes(r.state)).length;
    const ok = queue.filter((r) => r.state === "ok" && r.result?.topicId).map((r) => r.result.topicId);
    box.innerHTML = `
      <div class="kb-queue-head">
        <b>${running ? `正在导入 ${done}/${queue.length}` : `导入完成 ${done}/${queue.length}`}</b>
        <span class="kb-note">${esc(summary)}</span>
        <span class="kb-grow"></span>
        ${running ? '<button type="button" class="btn tiny ghost" id="kbImpStop">停止</button>' : ""}
        ${!running && ok.length ? `<button type="button" class="btn tiny" id="kbImpSubmitAll">把这 ${ok.length} 个候选主题提交审核</button>` : ""}
        ${!running ? '<button type="button" class="btn tiny ghost" id="kbImpClear">清空结果</button>' : ""}
      </div>
      <div class="kb-queue">
        ${queue.map((row) => `
          <div class="kb-imp-item ${row.state === "bad" ? "bad" : row.state === "skip" || row.state === "abort" ? "muted" : ""}">
            <span class="kb-queue-state ${row.state}">${stateText(row)}</span>
            <b>${esc(row.file.name)}</b>
            ${row.state === "ok" ? `<span>${row.result.fragments} 个片段 · ${esc(row.result.quality === "need-ocr" ? "待 OCR" : row.result.fragments ? "解析完成" : "无文字内容")}</span>` : ""}
            ${row.result?.note ? `<span class="kb-warn">${esc(row.result.note)}</span>` : ""}
            ${row.result?.suggestion ? `<span class="kb-tag ${row.result.suggestion.action === "skip" ? "" : "ok"}">${SUGGEST_NAME[row.result.suggestion.action] ?? row.result.suggestion.action}：${esc(row.result.suggestion.reason)}</span>` : ""}
            ${row.error ? `<span class="kb-warn">${esc(row.error)}</span>` : ""}
            ${row.result?.topicId ? `<button type="button" class="btn tiny" data-open-topic="${esc(row.result.topicId)}">打开候选主题</button>` : ""}
          </div>`).join("")}
      </div>`;
    $$("[data-open-topic]", box).forEach((btn) => btn.addEventListener("click", () => {
      kb.topicId = btn.dataset.openTopic;
      kb.editing = true;
      gotoDetail();
    }));
    $("#kbImpStop")?.addEventListener("click", () => { abort = true; kToast("正在停止：当前文件解析完就停"); });
    $("#kbImpClear")?.addEventListener("click", () => { queue = []; $("#kbImpResult").innerHTML = ""; });
    $("#kbImpSubmitAll")?.addEventListener("click", async () => {
      try {
        const r = await kApi("/api/knowledge/topics/bulk-submit", { method: "POST", body: JSON.stringify({ ids: ok }) });
        kToast(`已提交 ${r.submitted} 个候选主题进入审核`);
        loadBootstrap().then(updateKbBadge).catch(() => {});
      } catch (error) { kToast(error.message, "bad"); }
    });
  };

  /**
   * 顺序上传（单文件 200MB 上限）：一次一个，避免几十个并发把内存和 SQLite 写锁打满。
   * 单个失败只标记该行，不影响整批。
   */
  const uploadFiles = async (files, { skipped = [] } = {}) => {
    const list = [...files].filter((f) => f && f.size >= 0);
    const empty = list.filter((f) => !f.size).map((f) => f.name);
    const usable = list.filter((f) => f.size > 0);
    if (!usable.length && !skipped.length && !empty.length) return;

    queue = [
      ...usable.slice(0, MAX_FILES).map((file) => ({ file, state: "wait" })),
      // 不支持的文件也留在列表里标「跳过」，否则用户不知道拖进去的东西去哪了
      ...skipped.map((name) => ({ file: { name }, state: "skip", skipUpload: true, error: "格式不支持（不在可解析列表里）" })),
      ...empty.map((name) => ({ file: { name }, state: "skip", skipUpload: true, error: "空文件" })),
    ];
    const overflow = Math.max(0, usable.length - MAX_FILES);
    abort = false;
    running = true;
    const pre = [
      overflow ? `${overflow} 个超出单批 ${MAX_FILES} 个上限，未导入` : "",
      skipped.length ? `另有 ${skipped.length} 个格式不支持，已跳过` : "",
    ].filter(Boolean).join("；");
    renderQueue(pre);

    for (const row of queue) {
      if (row.skipUpload) continue; // 预筛掉的行只用于展示，不发给服务端
      if (abort) { row.state = "abort"; renderQueue(pre); continue; }
      row.state = "run";
      renderQueue(pre);
      try {
        const params = new URLSearchParams({
          name: row.file.name, space: spaceOf(), type: typeOf(), classification: classOf(),
          batch: `文件导入 ${new Date().toLocaleString("zh-CN")}`,
        });
        const result = await kApi(`/api/knowledge/imports/files?${params}`, { method: "POST", body: row.file });
        const first = result.results?.[0] ?? {};
        row.result = first;
        row.state = first.error ? "bad" : first.suggestion?.action === "skip" ? "skip" : "ok";
        if (first.error) row.error = first.error;
      } catch (error) {
        row.state = "bad";
        row.error = error.message;
      }
      renderQueue(pre);
    }
    running = false;
    renderQueue(pre);
    loadBootstrap().then(updateKbBadge).catch(() => {});
  };

  $("#kbImpFiles").addEventListener("change", async (e) => {
    await uploadFiles(e.target.files);
    e.target.value = "";
  });

  /* ---------------------------------------------------------------- 拖放（整页 + 文件夹） */

  /** 拖进来的可能是文件夹：webkitGetAsEntry 递归取文件，返回 { files, skipped }。 */
  const collectDrop = async (dt) => {
    const items = [...(dt?.items ?? [])];
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) {
      const files = [...(dt?.files ?? [])];
      return { files: files.filter((f) => supported(f.name)), skipped: files.filter((f) => !supported(f.name)).map((f) => f.name) };
    }
    const files = [];
    const skipped = [];
    const walk = async (entry, depth) => {
      if (!entry || depth > 8) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        if (supported(file.name)) files.push(file); else skipped.push(file.name);
        return;
      }
      if (entry.isDirectory) {
        const name = entry.name ?? "";
        // 隐藏目录与依赖目录没有知识价值，递归进去只会浪费时间
        if (/^\./.test(name) || ["node_modules", "__MACOSX", "$RECYCLE.BIN"].includes(name)) return;
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child, depth + 1);
        }
      }
    };
    for (const entry of entries) await walk(entry, 0);
    return { files, skipped };
  };

  const host = $(".kb-import");
  const overlay = $("#kbDropOverlay");
  let dragDepth = 0;
  const setHot = (on) => {
    overlay?.classList.toggle("on", on);
    $("#kbImpDrop")?.classList.toggle("hot", on);
  };
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  ["dragenter", "dragover"].forEach((ev) => host.addEventListener(ev, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (ev === "dragenter") dragDepth++;
    setHot(true);
  }));
  host.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setHot(false);
  });
  host.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    setHot(false);
    const { files, skipped } = await collectDrop(e.dataTransfer);
    if (!files.length && !skipped.length) return kToast("没有识别到可导入的文件", "bad");
    if (skipped.length) kToast(`已跳过 ${skipped.length} 个不支持的格式（${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? "…" : ""}）`);
    await uploadFiles(files, { skipped });
  });
  // 拖到导入页之外时拦住浏览器默认的「打开文件」，否则会把工作台顶掉
  ["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
  }, false));

  $("#kbImpTextGo").addEventListener("click", async () => {
    const text = $("#kbImpText").value.trim();
    if (!text) return kToast("先粘贴内容", "bad");
    const result = await kApi("/api/knowledge/imports/text", { method: "POST", body: JSON.stringify({ name: `粘贴文本 ${new Date().toLocaleTimeString("zh-CN")}`, text, space: spaceOf(), type: typeOf(), classification: classOf() }) });
    showResult(result);
    $("#kbImpText").value = "";
  });

  $("#kbImpUrlGo").addEventListener("click", async () => {
    const url = $("#kbImpUrl").value.trim();
    if (!url) return kToast("先填链接", "bad");
    const box = $("#kbImpResult");
    box.innerHTML = `<div class="kb-loading">抓取网页中…</div>`;
    try {
      const result = await kApi("/api/knowledge/imports/url", { method: "POST", body: JSON.stringify({ url, space: spaceOf(), type: typeOf(), classification: classOf() }) });
      showResult(result);
      $("#kbImpUrl").value = "";
    } catch (error) { box.innerHTML = `<div class="kb-imp-item bad">✕ ${esc(error.message)}</div>`; }
  });
}

/* ---------------------------------------------------------------- 图谱（主题关联 + 词表治理） */

const SPACE_COLOR = { research: "#54d6ff", planning: "#7dd6a0", product: "#e2b05c", idea: "#c39be0" };

async function renderGraph() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">计算主题关联中…</div>`;
  const [graph, vocab] = await Promise.all([
    kApi("/api/knowledge/graph?limit=150"),
    kApi("/api/knowledge/vocab"),
  ]);
  kb.graph = graph;
  const vocabItems = vocab.items ?? [];
  body.innerHTML = `
    <div class="kb-toolbar">
      <div class="kb-toolbar-left"><h3>知识图谱</h3><span class="kb-count">${graph.nodes.length} 个主题 · ${graph.edges.length} 条关联</span></div>
      <span class="kb-note">连线 = 共享标签 / 共享来源资料；连线越粗关联越强。点节点打开主题。</span>
    </div>
    <div class="kb-graph-wrap">
      <canvas id="kbGraphCanvas" width="1200" height="560"></canvas>
      <div class="kb-graph-legend">${Object.keys(SPACE_COLOR).map((k) => `<span><i data-space="${k}"></i>${({ research: "调研", planning: "企划", product: "产品", idea: "灵感" })[k]}</span>`).join("")}<span><i class="kb-arrow"></i>灵感已流转</span></div>
    </div>
    <section class="kb-section kb-section-gap">
      <h4>受控词表（标签治理）</h4>
      <p class="kb-note kb-note-mb">改名将同步更新所有主题的标签（即合并同义标签，如「线阵」→「线阵列」）。</p>
      ${vocabItems.length ? `<table class="kb-table"><thead><tr><th>标签</th><th>使用主题数</th><th>改名 / 合并</th></tr></thead><tbody>
        ${vocabItems.slice(0, 40).map((v) => `
          <tr data-vocab="${esc(v.name)}">
            <td><span class="kb-tag">${esc(v.name)}</span></td>
            <td>${v.uses}</td>
            <td><input class="kb-vocab-input" placeholder="改成…" data-old="${esc(v.name)}"><button type="button" class="btn tiny" data-rename="${esc(v.name)}">改名</button></td>
          </tr>`).join("")}
      </tbody></table>` : `<div class="kb-empty">还没有标签。编辑主题时打标签，词表会自动汇总。</div>`}
    </section>`;

  drawGraph(graph);
  $$("[data-rename]", body).forEach((btn) => btn.addEventListener("click", async () => {
    const from = btn.dataset.rename;
    const to = $(`input[data-old="${CSS.escape(from)}"]`, body)?.value.trim();
    if (!to) return kToast("先输入新名字", "bad");
    try {
      const result = await kApi("/api/knowledge/vocab/rename", { method: "POST", body: JSON.stringify({ from, to }) });
      kToast(`已把「${result.from}」改为「${result.to}」，更新 ${result.changed} 个主题`);
      renderGraph();
    } catch (error) { kToast(error.message, "bad"); }
  }));
}

/** 画布版关联图：按空间分四簇环形布局，边透明度随权重。不引第三方库。 */
function drawGraph(graph) {
  const canvas = $("#kbGraphCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 按空间分簇：四簇各占一个扇区，簇内按更新时间环形排
  const clusters = new Map();
  for (const n of nodes) {
    const list = clusters.get(n.space) ?? [];
    list.push(n);
    clusters.set(n.space, list);
  }
  const keys = [...clusters.keys()];
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.36;
  keys.forEach((space, ci) => {
    const list = clusters.get(space);
    const sector = (Math.PI * 2) / Math.max(keys.length, 1);
    const centerAngle = ci * sector + sector / 2 - Math.PI / 2;
    list.forEach((n, i) => {
      const spread = Math.min(sector * 0.86, (Math.PI * 2 * 0.86) / list.length);
      const a = centerAngle + (i - (list.length - 1) / 2) * (spread / Math.max(list.length - 1, 1)) * (list.length > 1 ? 1 : 0);
      const r = 40 + (i % 3) * 26;
      n._x = cx + Math.cos(a) * (R * 0.62 + r * 0.4) * (list.length > 1 ? 1 : 0.6);
      n._y = cy + Math.sin(a) * (R * 0.62 + r * 0.4) * (list.length > 1 ? 1 : 0.6);
    });
  });
  // 没节点的兜底（空库）：中心提示
  ctx.clearRect(0, 0, W, H);
  if (!nodes.length) {
    ctx.fillStyle = "#526985";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("还没有主题，先去导入资料或新建主题", cx, cy);
    return;
  }
  // 节点半径先算好：画有向边时箭头要收在节点边缘，不能压到圆上
  const maxQ = Math.max(...nodes.map((n) => n.quality ?? 0), 1);
  for (const n of nodes) n._r = 5 + ((n.quality ?? 0) / maxQ) * 6;
  // 边：共享标签/来源是灰色无向线，灵感流向是橙色箭头
  for (const e of graph.edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a?._x || !b?._x) continue;
    if (e.directed) {
      const ang = Math.atan2(b._y - a._y, b._x - a._x);
      const sx = a._x + Math.cos(ang) * ((a._r ?? 6) + 2);
      const sy = a._y + Math.sin(ang) * ((a._r ?? 6) + 2);
      const tx = b._x - Math.cos(ang) * ((b._r ?? 6) + 3);
      const ty = b._y - Math.sin(ang) * ((b._r ?? 6) + 3);
      ctx.strokeStyle = "rgba(245,170,80,.95)";
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      const size = 9;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ang - 0.4) * size, ty - Math.sin(ang - 0.4) * size);
      ctx.lineTo(tx - Math.cos(ang + 0.4) * size, ty - Math.sin(ang + 0.4) * size);
      ctx.closePath();
      ctx.fillStyle = "rgba(245,170,80,.98)";
      ctx.fill();
      continue;
    }
    ctx.strokeStyle = `rgba(120,170,220,${Math.min(0.08 + e.weight * 0.06, 0.5)})`;
    ctx.lineWidth = Math.min(e.weight, 5) * 0.6;
    ctx.beginPath();
    ctx.moveTo(a._x, a._y);
    ctx.lineTo(b._x, b._y);
    ctx.stroke();
  }
  // 节点
  for (const n of nodes) {
    if (n._x == null) continue;
    const radius = n._r;
    ctx.beginPath();
    ctx.arc(n._x, n._y, radius, 0, Math.PI * 2);
    ctx.fillStyle = SPACE_COLOR[n.space] ?? "#8899aa";
    ctx.globalAlpha = n.status === "published" ? 0.95 : 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // 悬停/点击命中
  const hit = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (W / rect.width);
    const y = (event.clientY - rect.top) * (H / rect.height);
    return nodes.find((n) => n._x != null && (x - n._x) ** 2 + (y - n._y) ** 2 <= (n._r + 4) ** 2);
  };
  canvas.onmousemove = (event) => {
    const n = hit(event);
    canvas.title = n ? `${n.title}（${n.type} · 质量分 ${n.quality ?? 0}）` : "";
    canvas.style.cursor = n ? "pointer" : "default";
  };
  canvas.onclick = (event) => {
    const n = hit(event);
    if (!n) return;
    kb.topicId = n.id;
    kb.editing = false;
    renderKbTab().catch((e) => kToast(e.message, "bad"));
  };
}

/* ---------------------------------------------------------------- 运行记录 */

async function renderOps() {
  const body = $("#kbBody");
  body.innerHTML = `<div class="kb-loading">加载中…</div>`;
  const ops = await kApi("/api/knowledge/ops");
  const issues = ops.health?.issues ?? [];
  body.innerHTML = `
    <div class="kb-toolbar">
      <div class="kb-toolbar-left"><h3>运行记录</h3><span class="kb-count">健康问题 ${issues.length} 条</span></div>
      <div class="kb-toolbar-right">
        <button type="button" class="btn" id="kbRecompute" title="按「产品概述 / 系统概述 / 核心结论」等章节重算摘要（空摘要与截断摘要会被替换）">重算摘要</button>
        <button type="button" class="btn" id="kbHealthRun">立即健康检查</button>
      </div>
    </div>
    ${issues.length ? `<div class="kb-issue-list">${issues.map((i) => `
      <div class="kb-imp-item ${i.severity === "high" ? "bad" : i.severity === "medium" ? "warn" : ""}">
        <b>${esc(i.title)}</b><span>${esc(i.type)} · ${esc(i.detail ?? "")}</span>
      </div>`).join("")}</div>` : `<div class="kb-empty">健康检查没有发现问题</div>`}
    <section class="kb-section">
      <h4>操作审计（只追加，规格书 12.2）</h4>
      <table class="kb-table"><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>变化</th></tr></thead><tbody>
        ${(ops.audit ?? []).slice(0, 30).map((a) => `<tr><td>${fmtTime(a.ts)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td>${esc([a.before, a.after].filter(Boolean).join(" → ") || "—")}</td></tr>`).join("")}
      </tbody></table>
    </section>`;

  $("#kbHealthRun").addEventListener("click", async () => {
    await kApi("/api/knowledge/health", { method: "POST" });
    kToast("健康检查完成");
    renderOps();
  });
  $("#kbRecompute").addEventListener("click", async () => {
    if (!(await confirmDialog({
      title: "重算摘要",
      message: "按「产品概述 / 系统概述 / 核心结论」等章节重算全部主题的摘要？",
      detail: "只替换空摘要和明显截断的摘要，其余不动。重算不会改动正文。",
      okText: "开始重算",
    }))) return;
    try {
      const r = await kApi("/api/knowledge/summaries/recompute", { method: "POST", body: JSON.stringify({}) });
      kToast(`已重算 ${r.updated} 条，跳过 ${r.skipped} 条（共 ${r.scanned} 条）`);
      renderOps();
    } catch (error) { kToast(error.message, "bad"); }
  });
}
