/**
 * 任务协作 · 任务窗内的协作面板 + 成员管理。
 *
 * 数据流：成员本机智能体 → POST /api/collab/push（成员 Token）→ 本面板 SSE 实时刷新。
 * 面板只读展示 + 管理（成员/Token、移动、删除）；推送动作全部发生在成员端。
 */

const getSessionToken = () =>
  sessionStorage.getItem("wb.token") || new URLSearchParams(location.search).get("token") || "";

export async function cApi(path, options = {}) {
  const token = getSessionToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== "string") {
    headers["content-type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败 ${resp.status}`);
  return data;
}

// ---------- SSE 实时流（模块级单例，断线重连） ----------

let streamSource = null;
const listeners = new Set();

function ensureStream() {
  if (streamSource) return;
  const token = getSessionToken();
  const connect = () => {
    streamSource = new EventSource(`/api/collab/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    streamSource.addEventListener("push", (e) => {
      const push = JSON.parse(e.data);
      listeners.forEach((fn) => fn(push));
    });
    streamSource.onerror = () => {
      streamSource?.close();
      streamSource = null;
      setTimeout(ensureStream, 5000);
    };
  };
  connect();
}

export function onPush(fn) {
  listeners.add(fn);
  ensureStream();
  return () => listeners.delete(fn);
}

// ---------- 渲染 ----------

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
export const isImage = (p) => p.fileName && (p.mime ? IMAGE_MIMES.has(p.mime) : /\.(png|jpe?g|gif|webp|bmp)$/i.test(p.fileName));

export const agentClass = (agent) => {
  const a = (agent || "").toLowerCase();
  if (a.includes("workbuddy")) return "workbuddy";
  if (a.includes("kimi")) return "kimi";
  if (a.includes("doubao") || a.includes("豆包")) return "doubao";
  if (a.includes("codex")) return "codex";
  if (a.includes("claude")) return "claude";
  return "other";
};

function pushCard(p) {
  const card = document.createElement("article");
  card.className = `cb-card kind-${p.kind}`;
  card.dataset.pushId = p.id;
  const fileChip = p.fileName
    ? (isImage(p)
      ? `<img class="cb-img" src="/api/collab/files/${p.id}" alt="${esc(p.fileName)}" loading="lazy">`
      : `<a class="cb-file" href="/api/collab/files/${p.id}" download="${esc(p.fileName)}"><span class="cb-file-icon"></span>${esc(p.fileName)}<small>${p.size ? Math.max(1, Math.round(p.size / 1024)) + " KB" : ""}</small></a>`)
    : "";
  card.innerHTML = `
    <div class="cb-avatar" title="${esc(p.memberName)}">${esc(p.memberName.slice(0, 1))}</div>
    <div class="cb-main">
      <header>
        <b>${esc(p.memberName)}</b>
        <span class="cb-agent ${agentClass(p.agent)}">${esc(p.agent)}</span>
        <span class="cb-kind">${p.kind === "note" ? "动态" : "产物"}</span>
        <time>${esc(relTime(p.createdAt))}</time>
      </header>
      <h4>${esc(p.title)}</h4>
      ${p.body && p.kind === "note" ? `<p>${esc(p.body.length > 160 ? p.body.slice(0, 160) + "…" : p.body)}</p>` : ""}
      ${p.body && p.kind === "artifact" ? `<pre class="cb-body">${esc(p.body.length > 600 ? p.body.slice(0, 600) + "…" : p.body)}</pre>` : ""}
      ${fileChip}
    </div>
    <div class="cb-actions">
      <button class="cb-move" title="挪到别的任务窗">移动</button>
      <button class="cb-del" title="删除这条推送">删除</button>
    </div>`;
  card.querySelector(".cb-del").onclick = async () => {
    const { confirmDialog } = await import("./dialog.js");
    if (!(await confirmDialog({ title: "删除这条推送", message: `「${p.title}」将从协作流中删除，不可恢复。`, tone: "danger" }))) return;
    await cApi(`/api/collab/pushes/${p.id}`, { method: "DELETE" });
    card.remove();
  };
  card.querySelector(".cb-move").onclick = async () => {
    const { promptDialog } = await import("./dialog.js");
    const target = await promptDialog({
      title: "挪到别的任务窗", message: "粘贴目标任务 ID（可从任务地址栏或任务卡复制）：",
      placeholder: "任务 ID", value: "", okText: "挪过去",
    });
    if (!target) return;
    try {
      const moved = await cApi(`/api/collab/pushes/${p.id}`, { method: "POST", body: { task: target.trim() } });
      card.remove();
      document.dispatchEvent(new CustomEvent("collab-external-push", { detail: moved }));
    } catch (err) { alertPop(err.message); }
  };
  return card;
}

function alertPop(message) {
  import("./dialog.js").then(({ infoDialog }) =>
    infoDialog({ title: "操作未完成", bodyHtml: `<p class="cb-hint">${esc(message)}</p>`, okText: "知道了" }));
}

/** 任务窗里的协作面板。app.js 在 renderWorksite 时调用。 */
export function renderCollabPanel(task) {
  const box = document.createElement("section");
  box.className = "cb-panel";
  box.dataset.taskId = task.id;
  box.innerHTML = `
    <header class="cb-head">
      <h3>任务协作</h3>
      <span class="cb-counts" id="cbCounts"></span>
      <div class="cb-head-actions">
        <button class="cb-refresh" title="重新拉取">刷新</button>
        <button class="cb-members">成员与 Token</button>
      </div>
    </header>
    <p class="cb-hint">成员在本机智能体里推送的产物和动态会实时出现在这里。接入方法见「成员与 Token」。</p>
    <div class="cb-feed" id="cbFeed"><div class="cb-empty">还没有推送。</div></div>
    <details class="cb-notes" id="cbNotes" hidden>
      <summary>动态 <span id="cbNotesCount"></span></summary>
      <div id="cbNotesFeed"></div>
    </details>`;

  const feed = box.querySelector("#cbFeed");
  const notesFeed = box.querySelector("#cbNotesFeed");
  const counts = box.querySelector("#cbCounts");
  let pushes = [];

  const paint = () => {
    const arts = pushes.filter((p) => p.kind === "artifact");
    const notes = pushes.filter((p) => p.kind === "note");
    counts.textContent = `产物 ${arts.length} · 动态 ${notes.length}`;
    feed.replaceChildren(...(arts.length
      ? arts.map(pushCard)
      : [Object.assign(document.createElement("div"), { className: "cb-empty", textContent: "还没有推送。" })]));
    const notesBox = box.querySelector("#cbNotes");
    notesBox.hidden = notes.length === 0;
    box.querySelector("#cbNotesCount").textContent = notes.length ? `(${notes.length})` : "";
    notesFeed.replaceChildren(...notes.map(pushCard));
  };

  const load = async () => {
    try {
      const data = await cApi(`/api/collab/tasks/${task.id}/pushes?limit=200`);
      pushes = data.items;
      paint();
    } catch (err) {
      feed.replaceChildren(Object.assign(document.createElement("div"),
        { className: "cb-empty", textContent: `加载失败：${err.message}` }));
    }
  };

  const off = onPush((push) => {
    // 面板随任务窗重渲染被替换后，旧监听自动退订，避免累积
    if (!box.isConnected) { off(); return; }
    if (push.taskId !== task.id) return;
    pushes = [push, ...pushes.filter((p) => p.id !== push.id)];
    paint();
  });
  document.addEventListener("collab-external-push", () => load());

  box.querySelector(".cb-refresh").onclick = load;
  box.querySelector(".cb-members").onclick = () => openMemberAdmin();
  load();
  return box;
}

// ---------- 成员管理 ----------

export async function openMemberAdmin() {
  const { infoDialog } = await import("./dialog.js");
  while (true) {
    const members = await cApi("/api/collab/members").then((d) => d.items).catch(() => []);
    const rows = members.map((m) => `
      <div class="cb-member-row" data-id="${m.id}">
        <b>${esc(m.name)}</b>
        <code class="cb-token-hint">${esc(m.token_hint)}</code>
        <small>${m.push_count} 条推送</small>
        <button type="button" class="cb-relink" data-act="reissue" data-id="${m.id}" data-name="${esc(m.name)}">换 Token</button>
        <button type="button" class="cb-remove" data-act="remove" data-id="${m.id}">移除</button>
      </div>`).join("");
    const name = await infoDialog({
      title: "协作成员与 Token",
      subtitle: "新成员的 Token 只显示一次，发给对方填进推送脚本即可。成员在本机智能体里推送的内容会实时出现在任务协作窗。",
      bodyHtml: `
        <div class="cb-member-list">${rows || '<p class="cb-hint">还没有成员，在下面输入姓名添加第一个。</p>'}</div>
        <div class="cb-add-row">
          <input class="wb-dlg-input" data-dlg-value placeholder="新成员姓名，如：小李" maxlength="24">
        </div>`,
      okText: "添加成员",
      onMount: ({ panel, close }) => {
        panel.querySelectorAll("[data-act]").forEach((btn) => {
          btn.onclick = async () => {
            const { id, act, name: mName } = btn.dataset;
            try {
              if (act === "reissue") {
                const reissued = await cApi(`/api/collab/members/${id}/token`, { method: "POST" });
                close(null);
                await showTokenOnce(reissued);
              } else if (act === "remove") {
                await cApi(`/api/collab/members/${id}`, { method: "DELETE" });
                btn.closest(".cb-member-row")?.remove();
              }
            } catch (err) { alertPop(err.message); }
          };
        });
      },
    });
    if (name === null) return; // 关闭弹窗退出
    const clean = (name || "").trim();
    if (!clean) continue;
    try {
      const created = await cApi("/api/collab/members", { method: "POST", body: { name: clean } });
      await showTokenOnce(created);
    } catch (err) { await alertPop(err.message); }
  }
}

async function showTokenOnce({ name, token }) {
  const { infoDialog } = await import("./dialog.js");
  await infoDialog({
    title: `${name} 的推送 Token`,
    subtitle: "只显示这一次，请立即复制发给成员。",
    bodyHtml: `
      <div class="cb-token-show"><code id="cbTokenText">${esc(token)}</code>
      <button type="button" class="cb-copy">复制 Token</button></div>
      <p class="cb-hint">成员端使用：在本机智能体目录运行 node push-agent.mjs init，填工作台地址和这个 Token。</p>`,
    okText: "完成",
    onMount: ({ panel }) => {
      panel.querySelector(".cb-copy").onclick = async (e) => {
        await navigator.clipboard.writeText(token).catch(() => {});
        e.target.textContent = "已复制";
      };
    },
  });
}
