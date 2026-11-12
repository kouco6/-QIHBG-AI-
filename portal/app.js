"use strict";

const names = { bg: "产品企划中心", ai: "AI调度中心", experience: "产品体验中心" };
const viewFrames = new Map();
const byId = id => document.getElementById(id);
let currentAccount;
let currentModule;

function preference(key, value) {
  if (!currentAccount) return null;
  const id = "bg-platform:" + currentAccount.id + ":" + key;
  try {
    if (value !== undefined) localStorage.setItem(id, value);
    return localStorage.getItem(id);
  } catch {
    return null;
  }
}

function modulePath(module, value) {
  if (!value) return null;
  try {
    const parsed = new URL(value, location.origin);
    if (parsed.origin === location.origin && parsed.pathname.startsWith("/" + module + "/")) {
      return parsed.pathname + parsed.hash;
    }
  } catch {
    return null;
  }
  return null;
}

function rememberView() {
  const frame = viewFrames.get(currentModule);
  if (!frame) return;
  try {
    const url = modulePath(currentModule, frame.contentWindow.location.href);
    if (url) preference(currentModule, url);
  } catch {
    // Ignore a frame that is loading or has opened a separate origin.
  }
}

function isDirty(frame) {
  try {
    return frame.contentDocument.documentElement.dataset.platformDirty === "true" ||
      frame.contentWindow.platformHasUnsavedWork?.() === true;
  } catch {
    return false;
  }
}

function selectModule(module, replace = false) {
  if (!currentAccount.modules.includes(module)) return;
  rememberView();
  let frame = viewFrames.get(module);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.title = names[module];
    frame.src = modulePath(module, preference(module)) || "/" + module + "/";
    frame.addEventListener("load", rememberView);
    viewFrames.set(module, frame);
    byId("views").append(frame);
  }
  currentModule = module;
  preference("module", module);
  byId("platform-name").textContent = "企划设计BG平台";
  byId("active-module").textContent = names[module];
  document.title = "企划设计BG平台";
  for (const [key, element] of viewFrames) element.hidden = key !== module;
  for (const button of byId("modules").children) {
    if (button.dataset.module === module) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const route = "/work/" + module;
  if (location.pathname !== route) history[replace ? "replaceState" : "pushState"](null, "", route);
}

function showWorkspace(account) {
  currentAccount = account;
  for (const [module, frame] of viewFrames) {
    if (account.modules.includes(module)) continue;
    frame.remove();
    viewFrames.delete(module);
  }
  byId("signin").hidden = true;
  byId("workspace").hidden = false;
  byId("account-name").textContent = account.name;
  byId("modules").replaceChildren();
  for (const module of account.modules) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.module = module;
    button.title = names[module];
    button.setAttribute("aria-label", names[module]);
    button.textContent = names[module];
    button.addEventListener("click", () => {
      if (module === currentModule) return;
      const current = viewFrames.get(currentModule);
      if (current && isDirty(current) && !confirm("当前模块有未保存内容，切换后会保留在原工作区。继续切换？")) return;
      selectModule(module);
    });
    byId("modules").append(button);
  }
  byId("empty").hidden = account.modules.length !== 0;
  const wanted = location.pathname.startsWith("/work/") ? location.pathname.split("/").at(-1) : preference("module");
  selectModule(account.modules.includes(wanted) ? wanted : account.modules[0], true);
}

async function checkSession(initial = false) {
  try {
    const response = await fetch("/platform/session");
    if (response.ok) {
      const account = await response.json();
      if (initial || account.modules.join() !== currentAccount?.modules.join()) showWorkspace(account);
      return;
    }
    if (response.status !== 401) throw new Error("无法连接平台，请重试。");
    if (!initial && currentAccount) {
      location.replace("/");
      return;
    }
  } catch (error) {
    if (!initial) return;
    byId("login-error").textContent = error.message;
  }
  if (initial) {
    byId("signin").hidden = false;
    byId("login").focus();
  }
}

byId("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector("button");
  byId("login-error").textContent = "";
  button.disabled = true;
  try {
    const response = await fetch("/platform/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: data.get("login"), password: data.get("password"), remember: data.has("remember") }),
    });
    if (!response.ok) throw new Error((await response.json()).message);
    form.reset();
    await checkSession(true);
  } catch (error) {
    byId("login-error").textContent = error.message || "无法连接平台，请重试。";
  } finally {
    button.disabled = false;
  }
});

byId("signout").addEventListener("click", async () => {
  if ([...viewFrames.values()].some(isDirty) && !confirm("有尚未保存的内容，确定退出？")) return;
  rememberView();
  try {
    const response = await fetch("/platform/logout", { method: "POST" });
    if (!response.ok) throw new Error();
    location.replace("/");
  } catch {
    alert("无法完成退出，请重试。");
  }
});

window.addEventListener("popstate", () => {
  const module = location.pathname.split("/").at(-1);
  if (currentAccount?.modules.includes(module)) selectModule(module, true);
});
window.addEventListener("pagehide", rememberView);
window.addEventListener("message", event => {
  if (event.origin === location.origin && [...viewFrames.values()].some(frame => frame.contentWindow === event.source)
      && event.data?.type === "platform-auth-check") void checkSession();
});
setInterval(rememberView, 700);
setInterval(checkSession, 20000);
void checkSession(true);
