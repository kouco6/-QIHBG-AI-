/* =========================================================================
   工作台通用弹窗
   替代 window.confirm / prompt / alert。三类：
     confirmDialog({ title, message, okText, cancelText, tone })  → boolean
     promptDialog({ title, label, value, placeholder, multiline })  → string | null
     formDialog({ title, fields: [...], okText })                  → object | null
   约定：Esc 取消、点遮罩取消、Enter 确认（多行输入框用 Ctrl/Cmd+Enter）、
   打开时聚焦首个可输入控件，关闭后焦点还回触发元素。
   ========================================================================= */

let root = null;
let activeClose = null;
/** 宽度只走 CSS class：站点 CSP 是 style-src 'self'，内联样式会被直接拦掉。 */
const DLG_WIDTHS = [420, 440, 460, 520, 560];

function ensureRoot() {
  if (root) return root;
  root = document.createElement("div");
  root.className = "wb-dlg-root";
  root.hidden = true;
  document.body.appendChild(root);
  return root;
}

function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 底层：渲染一个弹窗。body 为 HTML 字符串，返回 DOM 供调用方绑定自己的逻辑；
 * resolve 由调用方在合适的时机调用。
 */
function openDialog({ title, subtitle = "", body = "", footer, tone = "normal", onMount, width = 460 }) {
  const host = ensureRoot();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  host.innerHTML = `
    <div class="wb-dlg-mask" data-dlg-mask></div>
    <div class="wb-dlg${tone === "danger" ? " wb-dlg-danger" : ""} w${DLG_WIDTHS.includes(width) ? width : 460}" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
      <header class="wb-dlg-head">
        <div class="wb-dlg-titles">
          <strong>${escHtml(title)}</strong>
          ${subtitle ? `<span>${escHtml(subtitle)}</span>` : ""}
        </div>
        <button type="button" class="wb-dlg-x" data-dlg-cancel aria-label="关闭">×</button>
      </header>
      <div class="wb-dlg-body">${body}</div>
      <footer class="wb-dlg-foot">${footer ?? ""}</footer>
    </div>`;
  host.hidden = false;
  document.body.classList.add("wb-dlg-open");

  const panel = host.querySelector(".wb-dlg");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("wb-dlg-open");
      host.hidden = true;
      host.innerHTML = "";
      activeClose = null;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
      resolve(value);
    };
    activeClose = () => finish(null);

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
        return;
      }
      if (event.key === "Tab") {
        // 焦点圈在弹窗内，避免 Tab 跑到背后的页面
        const focusables = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);

    host.querySelector("[data-dlg-mask]").addEventListener("click", () => finish(null));
    host.querySelectorAll("[data-dlg-cancel]").forEach((btn) => btn.addEventListener("click", () => finish(null)));

    onMount?.({
      panel,
      close: finish,
      // 回车确认（多行框交给 Ctrl/Cmd+Enter）
      onEnter(handler) {
        panel.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          if (event.target instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey) return;
          if (event.target instanceof HTMLButtonElement && event.target.dataset.dlgCancel !== undefined) return;
          event.preventDefault();
          handler();
        });
      },
    });

    requestAnimationFrame(() => {
      const target = panel.querySelector("[data-dlg-autofocus]") ?? panel.querySelector("input, textarea, select")
        ?? panel.querySelector(".btn.primary");
      target?.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const len = target.value.length;
        target.setSelectionRange?.(len, len);
      }
    });
  });
}

/** 确认框 → Promise<boolean> */
export function confirmDialog({
  title = "确认操作",
  message = "",
  detail = "",
  okText = "确定",
  cancelText = "取消",
  tone = "normal",
} = {}) {
  return openDialog({
    title,
    tone,
    width: 420,
    body: `
      <div class="wb-dlg-msg">
        <p>${escHtml(message)}</p>
        ${detail ? `<p class="wb-dlg-detail">${escHtml(detail)}</p>` : ""}
      </div>`,
    footer: `
      <button type="button" class="btn ghost" data-dlg-cancel>${escHtml(cancelText)}</button>
      <button type="button" class="btn ${tone === "danger" ? "danger" : "primary"}" data-dlg-ok>${escHtml(okText)}</button>`,
    onMount({ panel, close, onEnter }) {
      const done = (value) => close(value);
      panel.querySelector("[data-dlg-ok]").addEventListener("click", () => done(true));
      onEnter(() => done(true));
    },
  }).then((value) => value === true);
}

/** 输入框 → Promise<string | null>（取消返回 null） */
export function promptDialog({
  title = "请输入",
  label = "",
  value = "",
  placeholder = "",
  hint = "",
  multiline = false,
  okText = "确定",
  cancelText = "取消",
  required = true,
  maxlength = 200,
} = {}) {
  return openDialog({
    title,
    width: multiline ? 560 : 440,
    body: `
      ${label ? `<label class="wb-dlg-label">${escHtml(label)}</label>` : ""}
      ${multiline
        ? `<textarea class="wb-dlg-input" data-dlg-input rows="5" maxlength="2000" placeholder="${escHtml(placeholder)}">${escHtml(value)}</textarea>`
        : `<input class="wb-dlg-input" data-dlg-input type="text" maxlength="${maxlength}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}">`}
      <p class="wb-dlg-hint" data-dlg-hint>${escHtml(hint || (multiline ? "Ctrl + Enter 提交" : ""))}</p>`,
    footer: `
      <button type="button" class="btn ghost" data-dlg-cancel>${escHtml(cancelText)}</button>
      <button type="button" class="btn primary" data-dlg-ok>${escHtml(okText)}</button>`,
    onMount({ panel, close, onEnter }) {
      const input = panel.querySelector("[data-dlg-input]");
      const hintEl = panel.querySelector("[data-dlg-hint]");
      const ok = panel.querySelector("[data-dlg-ok]");
      input.dataset.dlgAutofocus = "";
      const submit = () => {
        const text = input.value.trim();
        if (required && !text) {
          hintEl.textContent = "这一项不能为空";
          hintEl.classList.add("bad");
          input.focus();
          return;
        }
        close(text);
      };
      ok.addEventListener("click", submit);
      input.addEventListener("input", () => { hintEl.classList.remove("bad"); });
      onEnter(submit);
    },
  });
}

/**
 * 表单弹窗 → Promise<Record<string,string> | null>
 * fields: [{ key, label, type: "text"|"textarea"|"select", value, options:[{value,label}], placeholder, hint, required }]
 */
export function formDialog({
  title = "填写信息",
  fields = [],
  okText = "确定",
  cancelText = "取消",
  note = "",
  width = 520,
  /** 字段变化时回调：返回 { 字段key: { options, value } } 用来联动下拉（如空间 → 类型） */
  onChange,
} = {}) {
  const fieldHtml = (f) => {
    const common = `data-dlg-field="${escHtml(f.key)}"`;
    if (f.type === "select") {
      return `<select class="wb-dlg-input" ${common}>
        ${(f.options ?? []).map((o) => `<option value="${escHtml(o.value)}"${String(o.value) === String(f.value ?? "") ? " selected" : ""}>${escHtml(o.label)}</option>`).join("")}
      </select>`;
    }
    if (f.type === "textarea") {
      return `<textarea class="wb-dlg-input" ${common} rows="${f.rows ?? 4}" placeholder="${escHtml(f.placeholder ?? "")}">${escHtml(f.value ?? "")}</textarea>`;
    }
    return `<input class="wb-dlg-input" type="${f.type === "number" ? "number" : "text"}" ${common} value="${escHtml(f.value ?? "")}" placeholder="${escHtml(f.placeholder ?? "")}">`;
  };

  return openDialog({
    title,
    width,
    subtitle: note,
    body: `<div class="wb-dlg-form">${fields.map((f) => `
      <label class="wb-dlg-field${f.half ? " half" : ""}">
        <span>${escHtml(f.label)}${f.required === false ? "" : ""}</span>
        ${fieldHtml(f)}
        ${f.hint ? `<em>${escHtml(f.hint)}</em>` : ""}
      </label>`).join("")}</div>
      <p class="wb-dlg-hint bad" data-dlg-err hidden></p>`,
    footer: `
      <button type="button" class="btn ghost" data-dlg-cancel>${escHtml(cancelText)}</button>
      <button type="button" class="btn primary" data-dlg-ok>${escHtml(okText)}</button>`,
    onMount({ panel, close, onEnter }) {
      const errEl = panel.querySelector("[data-dlg-err]");
      const collect = () => {
        const values = {};
        for (const f of fields) {
          const el = panel.querySelector(`[data-dlg-field="${f.key}"]`);
          const raw = el?.value ?? "";
          values[f.key] = typeof raw === "string" ? raw.trim() : raw;
        }
        return values;
      };
      // 联动：改「空间」时重填「类型」选项（保持当前选中值若仍合法）
      if (typeof onChange === "function") {
        for (const el of panel.querySelectorAll("[data-dlg-field]")) {
          el.addEventListener("change", () => {
            const patch = onChange(collect(), panel);
            for (const [key, cfg] of Object.entries(patch ?? {})) {
              const target = panel.querySelector(`[data-dlg-field="${key}"]`);
              if (!target) continue;
              if (cfg.options) {
                target.innerHTML = cfg.options.map((o) => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join("");
              }
              if (cfg.value !== undefined) target.value = cfg.value;
            }
          });
        }
      }
      const submit = () => {
        const values = collect();
        for (const f of fields) {
          if (f.required === false) continue;
          if (!values[f.key]) {
            errEl.hidden = false;
            errEl.textContent = `请填写「${f.label}」`;
            panel.querySelector(`[data-dlg-field="${f.key}"]`)?.focus();
            return;
          }
        }
        close(values);
      };
      panel.querySelector("[data-dlg-ok]").addEventListener("click", submit);
      onEnter(submit);
    },
  });
}

/**
 * 信息/管理弹窗 → Promise<string|null>。
 * body 自由 HTML；若含 [data-dlg-value] 输入框，确认时返回其值，否则返回 true。
 * 供成员管理这类「列表 + 动作按钮 + 可选输入」的场景复用。
 */
export function infoDialog({
  title = "信息",
  subtitle = "",
  bodyHtml = "",
  okText = "确定",
  onMount,
  width = 560,
} = {}) {
  return openDialog({
    title, subtitle, width,
    body: bodyHtml,
    footer: `<button type="button" class="btn primary" data-dlg-ok>${escHtml(okText)}</button>`,
    onMount({ panel, close, onEnter }) {
      const submit = () => {
        const input = panel.querySelector("[data-dlg-value]");
        close(input ? input.value.trim() : true);
      };
      panel.querySelector("[data-dlg-ok]").addEventListener("click", submit);
      onEnter(submit);
      onMount?.({ panel, close, onEnter });
    },
  });
}

/** 程序内主动关闭（如外部状态变化），无弹窗时为空操作。 */
export function closeDialog() {
  activeClose?.();
}
