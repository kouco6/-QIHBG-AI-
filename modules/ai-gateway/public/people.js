/**
 * 设置页 · 人员与账号
 *
 * 一条原则：账号 = 登录身份 = 协作身份。
 * · 登录：用户名 + 密码（scrypt 加盐，后端只存哈希）
 * · 协作：每个账号一个推送 Token，本机智能体用它往项目里推产物
 * · 角色：管理人员全权，其余五类只看到自己所在的项目
 *
 * 这里只做「看和改」，权限判定全在后端；前端拿不到列表就说明不是管理人员。
 */

import { cApi } from "./collab.js";
import { confirmDialog, formDialog, infoDialog, promptDialog } from "./dialog.js";

export const ROLE_LABELS = {
  planner: "企划人员", product: "产品人员", ux: "体验人员",
  ui: "UI人员", other: "其他人员", admin: "管理人员",
};

/** 角色展示顺序：管理在前，其余按业务链路排，其他人员兜底 */
const ROLE_ORDER = ["admin", "planner", "product", "ux", "ui", "other"];

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

/** app.js 里的 toast 由这个事件驱动，避免两个模块互相 import */
const say = (message) => document.dispatchEvent(new CustomEvent("wb-toast", { detail: message }));

const roleOptions = (current) => ROLE_ORDER
  .map((role) => `<option value="${role}"${role === current ? " selected" : ""}>${ROLE_LABELS[role]}</option>`)
  .join("");

const accountList = async () => (await cApi("/api/auth/accounts")).items ?? [];

/* ------------------------------------------------------------------ *
 * 入口：设置页渲染完这一块后调用
 * ------------------------------------------------------------------ */

let lastSig = "";

export async function renderPeopleSection(host) {
  if (!host) return;
  try {
    const items = await accountList();
    paint(host, items);
  } catch (err) {
    const message = /Unauthorized|未登录/.test(err.message)
      ? "只有管理人员能查看和修改人员与账号。"
      : `读取人员失败：${err.message}`;
    host.replaceChildren(Object.assign(document.createElement("p"), {
      className: "ppl-empty bad",
      textContent: message,
    }));
    syncSummary(null);
  }
}

function paint(host, items) {
  // 设置页每 20 秒整页重绘一次；数据没变就别重排，免得正在点的人手滑
  const sig = JSON.stringify(items.map((a) => [a.id, a.role, a.active, a.push_token_hint, a.name, a.username]));
  if (sig === lastSig && host.querySelector(".ppl")) return;
  lastSig = sig;

  const activeCount = items.filter((a) => a.active).length;
  const chips = ROLE_ORDER
    .map((role) => [role, items.filter((a) => a.role === role).length])
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `<span class="ppl-chip">${ROLE_LABELS[role]}<b>${count}</b></span>`)
    .join("");

  const row = (a) => `
    <div class="ppl-row${a.active ? "" : " off"}" data-id="${esc(a.id)}">
      <span class="ppl-name"><i class="ppl-avatar">${esc(String(a.name || a.username).slice(0, 1))}</i><b>${esc(a.name || a.username)}</b></span>
      <code class="ppl-user">@${esc(a.username)}</code>
      <select class="ppl-role" data-act="role" data-id="${esc(a.id)}" data-prev="${esc(a.role)}" title="改角色">${roleOptions(a.role)}</select>
      <code class="ppl-token${a.push_token_hint ? "" : " none"}" title="推送 Token（只显示后 4 位，完整值只发一次）">${esc(a.push_token_hint || "未发放")}</code>
      <span class="ppl-state ${a.active ? "on" : "off"}">${a.active ? "在用" : "已停用"}</span>
      <span class="ppl-ops">
        <button type="button" data-act="bootstrap" data-id="${esc(a.id)}" title="生成一次性配置码，员工执行器里粘贴即完成配置">配置码</button>
        <button type="button" data-act="reissue" data-id="${esc(a.id)}" title="重新生成 Token，旧 Token 立即失效">换 Token</button>
        <button type="button" data-act="reset" data-id="${esc(a.id)}" title="重置后该账号已登录的会话全部失效">重置密码</button>
        <button type="button" class="${a.active ? "danger" : ""}" data-act="toggle" data-id="${esc(a.id)}" data-active="${a.active ? "1" : "0"}">${a.active ? "停用" : "启用"}</button>
      </span>
    </div>`;

  host.innerHTML = `
    <div class="ppl">
      <div class="ppl-bar">
        <div class="ppl-sum">
          <span><b>${items.length}</b> 个账号 · ${activeCount} 人在用</span>
          <span class="ppl-chips">${chips}</span>
        </div>
        <button type="button" class="primary" data-act="new">＋ 新增人员</button>
      </div>
      <div class="ppl-table">
        <div class="ppl-row ppl-head">
          <span>人员</span><span>登录用户名</span><span>角色</span><span>推送 Token</span><span>状态</span><span class="ppl-ops-h">操作</span>
        </div>
        ${items.map(row).join("") || `<p class="ppl-empty">还没有账号。</p>`}
      </div>
      <p class="ppl-note">账号即协作身份：登录用「用户名 + 密码」，本机智能体推送用系统发的 Token。管理人员管全部项目，其余角色只看到自己所在的项目。</p>
    </div>`;

  syncSummary(items);

  host.querySelector('[data-act="new"]').onclick = () => createPerson(host);

  host.querySelectorAll(".ppl-role").forEach((sel) => {
    sel.onchange = async () => {
      const prev = sel.dataset.prev;
      try {
        await cApi(`/api/auth/accounts/${sel.dataset.id}`, { method: "PUT", body: { role: sel.value } });
        say(`角色已改为「${ROLE_LABELS[sel.value]}」`);
        await renderPeopleSection(host);
      } catch (err) {
        sel.value = prev;
        say(err.message);
      }
    };
  });

  host.querySelectorAll('[data-act="bootstrap"]').forEach((btn) => {
    btn.onclick = async () => {
      // 先确认服务器地址：配置码里会编码这个地址，员工机器拿它来连。
      // 用 127.0.0.1 打开平台的话，直接编码进去同事就兑不到了，服务端会自动换成内网 IP。
      const { promptDialog, infoDialog } = await import("./dialog.js");
      let server;
      try {
        server = await promptDialog({
          title: "生成执行器配置码",
          label: "员工机器访问的平台地址",
          value: window.location.origin,
          hint: "同事电脑要能连上这个地址。默认是本页地址；若以 127.0.0.1/localhost 打开，生成时会自动换成服务器内网 IP。",
          okText: "生成配置码",
          maxlength: 120,
        });
      } catch { return; }
      if (!server) return;
      try {
        const data = await cApi(`/api/auth/accounts/${btn.dataset.id}/bootstrap-code`, {
          method: "POST",
          body: { server },
        });
        const name = btn.closest(".ppl-row").querySelector(".ppl-name b")?.textContent ?? "本人";
        await infoDialog({
          title: `${name} 的执行器配置码`,
          subtitle: "发给员工，让他双击「启动执行器.bat」后粘贴这一串即可，不用再填任何东西。",
          bodyHtml: `
            <div class="cb-token-show"><code id="cbTokenText" style="word-break:break-all">${esc(data.packed)}</code>
            <button type="button" class="cb-copy">复制配置码</button></div>
            <p class="cb-hint">内嵌服务器地址：${esc(data.server || server)}<br>
            有效期至 ${esc(new Date(data.expiresAt).toLocaleTimeString("zh-CN", { hour12: false }))}（10 分钟），只能用一次；兑换成功后该员工旧 Token 立即失效。</p>`,
          okText: "完成",
          onMount: ({ panel }) => {
            panel.querySelector(".cb-copy").onclick = async (e) => {
              await navigator.clipboard.writeText(data.packed).catch(() => {});
              e.target.textContent = "已复制";
            };
          },
        });
      } catch (err) { say(err.message); }
    };
  });

  host.querySelectorAll('[data-act="reissue"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const account = await cApi(`/api/auth/accounts/${btn.dataset.id}/token`, { method: "POST" });
        await showTokenOnce(account);
        await renderPeopleSection(host);
      } catch (err) { say(err.message); }
    };
  });

  host.querySelectorAll('[data-act="reset"]').forEach((btn) => {
    btn.onclick = async () => {
      const password = await promptDialog({
        title: "重置密码",
        label: "新密码（至少 6 位）",
        placeholder: "新密码",
        type: "password",
        hint: "重置后该账号已登录的地方会全部退出",
        okText: "重置",
      });
      if (!password) return;
      try {
        await cApi(`/api/auth/accounts/${btn.dataset.id}`, { method: "PUT", body: { password } });
        say("密码已重置，记得把新密码告诉本人");
      } catch (err) { say(err.message); }
    };
  });

  host.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
    btn.onclick = async () => {
      const active = btn.dataset.active === "1";
      const name = btn.closest(".ppl-row").querySelector(".ppl-name b")?.textContent ?? "该账号";
      if (active) {
        const ok = await confirmDialog({
          title: "停用账号",
          message: `停用后 ${name} 无法登录，也推不了产物。`,
          detail: "账号和已推送的内容都会保留，随时可以再启用。",
          okText: "停用",
          tone: "danger",
        });
        if (!ok) return;
      }
      try {
        await cApi(`/api/auth/accounts/${btn.dataset.id}`, { method: "PUT", body: { active: !active } });
        say(active ? `${name} 已停用` : `${name} 已启用`);
        await renderPeopleSection(host);
      } catch (err) { say(err.message); }
    };
  });
}

/** 折叠标题上那句话：不展开也知道有几个人、有没有停用的 */
function syncSummary(items) {
  const el = document.querySelector("#peopleSummary");
  if (!el) return;
  if (!items) { el.textContent = "仅管理人员可查看"; return; }
  const admins = items.filter((a) => a.role === "admin").length;
  const off = items.filter((a) => !a.active).length;
  el.textContent = items.length
    ? `${items.length} 人 · 管理 ${admins}${off ? ` · 停用 ${off}` : ""}`
    : "还没有账号";
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function createPerson(host) {
  const values = await formDialog({
    title: "新增人员",
    note: "建完会给一个推送 Token，只显示一次，请立即发给本人。",
    okText: "创建账号",
    fields: [
      { key: "name", label: "姓名", placeholder: "如：小李" },
      { key: "username", label: "登录用户名", placeholder: "中文或字母数字，如：小李 / xiaoli", hint: "登录时用，建好后不能改" },
      { key: "role", label: "角色", type: "select", value: "other", options: ROLE_ORDER.map((role) => ({ value: role, label: ROLE_LABELS[role] })) },
      { key: "password", label: "初始密码", type: "password", placeholder: "至少 6 位" },
    ],
  });
  if (!values) return;
  try {
    const created = await cApi("/api/auth/accounts", {
      method: "POST",
      body: {
        username: values.username,
        name: values.name || values.username,
        role: values.role,
        password: values.password,
      },
    });
    await showTokenOnce(created);
    await renderPeopleSection(host);
  } catch (err) { say(err.message); }
}

async function showTokenOnce({ name, token }) {
  await infoDialog({
    title: `${name} 的推送 Token`,
    subtitle: "只显示这一次，请立即复制发给本人。",
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
