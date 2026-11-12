#!/usr/bin/env node
/**
 * 任务协作推送端 push-agent.mjs（零依赖，单文件，拷到成员电脑即可用）。
 *
 * 用法：
 *   node push-agent.mjs init                 首次配置：工作台地址、成员 Token
 *   node push-agent.mjs use <任务ID>         选「当前任务」，之后推送都进它
 *   node push-agent.mjs tasks                列出工作台上的任务（选当前任务用）
 *   node push-agent.mjs push 报告.md         推文件（按扩展名识别图片/文本）
 *   node push-agent.mjs push --kind note "完成竞品对比初稿，要点：…"   推一段动态
 *   echo "结论文本" | node push-agent.mjs push -                      从管道推文本
 *   node push-agent.mjs clip                 把剪贴板内容推成产物（网页版 AI 兜底）
 *   node push-agent.mjs clip --kind note     把剪贴板内容推成动态
 *
 * 智能体接入：让本机智能体（WorkBuddy 技能 / CLI hook）执行 push 命令即可，
 * agent 名会随推送声明到工作台（--agent 参数，默认 workbuddy）。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { execSync } from "node:child_process";

const CONFIG_FILE = join0(process.env.USERPROFILE || process.env.HOME || ".", ".collab-push.json");
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function join0(...parts) { return parts.join("/").replace(/\/+/g, "/"); }

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

function requireConfig(cfg) {
  if (!cfg.server) die("还没配置工作台地址，先运行：node push-agent.mjs init");
  if (!cfg.token) die("还没配置成员 Token，先运行：node push-agent.mjs init");
  if (!cfg.task) die("还没选当前任务，先运行：node push-agent.mjs use <任务ID>（tasks 子命令可列出任务）");
  return cfg;
}

async function api(cfg, path, options = {}) {
  const resp = await fetch(`${cfg.server.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${cfg.token}`, ...(options.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) die(data.error || `请求失败 ${resp.status}`);
  return data;
}

function readClipboard() {
  try {
    if (process.platform === "win32") return execSync("powershell -NoProfile -Command Get-Clipboard", { encoding: "utf8" });
    if (process.platform === "darwin") return execSync("pbpaste", { encoding: "utf8" });
    return execSync("xclip -selection clipboard -o", { encoding: "utf8" });
  } catch { die("读不到剪贴板内容"); }
}

async function push({ server, token, task }, { kind, agent, title, file, text }) {
  const params = new URLSearchParams({ task, kind, agent: agent || "workbuddy" });
  if (title) params.set("title", title);
  let headers = {};
  let body;
  if (file) {
    const name = basename(file);
    const mime = MIME[extname(name).toLowerCase()];
    const data = readFileSync(file);
    const isText = mime?.startsWith("text/");
    if (!isText && mime) {
      params.set("filename", name);
      headers["content-type"] = mime;
      body = data;
    } else {
      headers["content-type"] = "text/markdown; charset=utf-8";
      body = data;
    }
  } else {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify({ text: text ?? "" });
  }
  const resp = await fetch(`${server.replace(/\/$/, "")}/api/collab/push?${params}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) die(data.error || `推送失败 ${resp.status}`);
  ok(`已推送到任务窗（${kind === "note" ? "动态" : "产物"} · ${agent || "workbuddy"}）${data.push?.title ? `：${data.push.title}` : ""}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  rest.splice(i, 1);
  const [v] = rest.splice(i, 1);
  return v ?? true;
};

(async () => {
  const cfg = loadConfig();
  switch (cmd) {
    case "init": {
      const server = rest[0] ?? process.env.COLLAB_SERVER;
      if (!server) die("用法：node push-agent.mjs init <工作台地址，如 http://192.168.1.20:4317>");
      saveConfig({ server });
      ok(`工作台地址已保存：${server}`);
      console.log("下一步：把管理员发给你的成员 Token 填进来 →");
      console.log("  node push-agent.mjs token <粘贴Token>");
      break;
    }
    case "token": {
      const token = rest[0];
      if (!token) die("用法：node push-agent.mjs token <成员Token>");
      saveConfig({ token });
      ok("成员 Token 已保存");
      break;
    }
    case "tasks": {
      requireConfig({ ...cfg, task: "-" });
      const { items } = await api(cfg, "/api/collab/tasks");
      if (!items.length) return console.log("工作台上暂无任务");
      for (const t of items) console.log(`${t.id}  [${t.status}]  ${t.label}`);
      console.log("\n选定当前任务：node push-agent.mjs use <任务ID>");
      break;
    }
    case "use": {
      const id = rest[0];
      if (!id) die("用法：node push-agent.mjs use <任务ID>");
      saveConfig({ task: id });
      const { items } = await api({ ...cfg, task: "-" }, "/api/collab/tasks");
      const hit = items.find((t) => t.id === id);
      ok(`当前任务：${hit?.label ?? id}`);
      break;
    }
    case "clip": {
      const kind = flag("--kind") || "artifact";
      const agent = flag("--agent") || "clipboard";
      await push(requireConfig(cfg), { kind, agent, text: readClipboard().trim() });
      break;
    }
    case "push": {
      const kind = flag("--kind") || "artifact";
      const agent = flag("--agent") || "workbuddy";
      const title = flag("--title");
      const target = rest[0];
      if (!target) die("用法：push <文件路径> | push --kind note \"文本\" | 管道输入 push -");
      if (target === "-") {
        const input = readFileSync(0, "utf8").trim();
        if (!input) die("管道里没有内容");
        await push(requireConfig(cfg), { kind, agent, title, text: input });
      } else if (existsSync(target) && statSync(target).isFile()) {
        await push(requireConfig(cfg), { kind, agent, title: title || undefined, file: target });
      } else {
        await push(requireConfig(cfg), { kind, agent, title, text: target });
      }
      break;
    }
    default:
      console.log(`任务协作推送端 · 用法：
  node push-agent.mjs init <工作台地址>      首次配置
  node push-agent.mjs token <成员Token>      填管理员发的 Token
  node push-agent.mjs tasks                  列出任务
  node push-agent.mjs use <任务ID>           选当前任务
  node push-agent.mjs push <文件|文本|->     推送（- 为管道输入）
  node push-agent.mjs clip [--kind note]     推剪贴板内容`);
  }
})();
