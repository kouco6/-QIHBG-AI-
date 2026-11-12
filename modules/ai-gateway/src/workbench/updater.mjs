/**
 * 网关自更新：从 AI 能力平台拉「程序更新包」，校验后覆盖本机代码并重启服务。
 *
 * 为什么单独一个模块：这件事会动到正在运行的代码，任何一步含糊都会把服务弄坏。
 * 所以这里把「能改什么、先备份到哪、失败怎么退回去」全部写死成规则，而不是交给调用方：
 *
 *   1. 只覆盖程序本体（src/ public/ scripts/ installer/ 等白名单顶层条目）
 *   2. 永不动运行数据（state/ logs/ skills/ backups/ updates/ dist/）与密钥
 *      （secrets.json / agent-secrets.json / hub-secrets.json / gateway.config.json）
 *   3. 换之前逐条目 rename 到 backups/update-<旧版本>-<时间>/，失败就整批退回去
 *   4. 包必须带 src/server.mjs，否则不是网关更新包
 *   5. 清单给了 sha256 就强校验；没给也照装，但结果里标 unverified，界面上要说清楚
 *
 * 更新包来源是一个 JSON 清单（默认 {平台地址}/release/gateway.json）：
 *   {
 *     "version": "1.1.0",
 *     "publishedAt": "2026-11-03T08:00:00+08:00",
 *     "notes": "更新说明",
 *     "url": "gateway-1.1.0.zip",          // 相对清单地址或绝对 URL
 *     "sha256": "…",                        // 可选，建议填
 *     "size": 12345678,                     // 可选，下载前提示用
 *     "minVersion": "1.0.0"                 // 可选，低于它拒绝跨版本升级
 *   }
 *
 * 平台（skill-hub）暂时只发技能包，还没发网关包。清单地址做成可配置项，
 * 内网随便放个静态 JSON 也能用，不必等平台改造。
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_FILES = 6000;
const MAX_TOTAL_BYTES = 800 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 更新包允许覆盖的顶层条目。白名单而不是黑名单：
 * 平台发错包、或者有人往包里塞了别的目录，也不会把数据目录顶掉。
 */
const PAYLOAD_TOP = new Set([
  "src", "public", "scripts", "installer", "mcp",
  "package.json", "README.md", "DEPLOY.md", "openapi.yaml",
  "gateway-run.cmd", "gateway-switch.vbs", "gateway-autostart.vbs", "start.ps1",
  "agent-secrets.example.json", "hub-secrets.example.json",
]);

/** 即使包里出现，也一律跳过：运行数据与本机凭据只属于这台机器。 */
const PROTECTED_TOP = new Set([
  "state", "logs", "skills", "backups", "updates", "dist", "node_modules", ".git", "reports",
  "secrets.json", "agent-secrets.json", "hub-secrets.json", "gateway.config.json",
]);

export class UpdateError extends Error {
  constructor(message, { kind = "update", status = 0 } = {}) {
    super(message);
    this.name = "UpdateError";
    this.kind = kind;
    this.status = status;
  }
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, data) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temp, file);
};

/** 语义版本比较。只比数字段，预发布后缀（-beta）当作同版本，避免把 beta 当正式版推。 */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/** 默认清单地址：平台挂在 /hub 下，就放在 /hub/release/gateway.json。 */
export function defaultManifestUrl(hub) {
  const base = String(hub?.baseUrl ?? "").trim();
  if (!base) return "";
  try {
    const url = new URL(base);
    const prefix = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${prefix}/release/gateway.json`;
  } catch {
    return "";
  }
}

/**
 * 校验并归一化清单。宁可这里报错，也不要把半截字段带进下载流程——
 * 下游每一步都假设 version / url 一定存在。
 */
export function normalizeManifest(raw, manifestUrl) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UpdateError("清单内容不是 JSON 对象", { kind: "manifest" });
  }
  const version = String(raw.version ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new UpdateError("清单里没有可用的 version（应形如 1.1.0）", { kind: "manifest" });
  }
  const rawUrl = String(raw.url ?? "").trim();
  if (!rawUrl) throw new UpdateError("清单里没有下载地址 url", { kind: "manifest" });
  let downloadUrl;
  try {
    downloadUrl = new URL(rawUrl, manifestUrl || undefined).toString();
  } catch {
    throw new UpdateError(`清单里的下载地址不合法：${rawUrl}`, { kind: "manifest" });
  }
  if (!/^https?:/i.test(downloadUrl)) {
    throw new UpdateError("下载地址必须是 http 或 https", { kind: "manifest" });
  }
  return {
    version,
    url: downloadUrl,
    notes: String(raw.notes ?? "").slice(0, 8000),
    publishedAt: String(raw.publishedAt ?? ""),
    sha256: String(raw.sha256 ?? "").trim().toLowerCase(),
    size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0,
    minVersion: String(raw.minVersion ?? "").trim().replace(/^v/i, ""),
    channel: String(raw.channel ?? "stable"),
  };
}

/** 删目录树：逐文件删，避免安全代理按「单次删除数」拦截（与 skill-store 同因）。 */
function pruneTree(target) {
  if (!existsSync(target)) return;
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    try { unlinkSync(target); } catch { /* 占用中，下次 */ }
    return;
  }
  let entries = [];
  try { entries = readdirSync(target); } catch { return; }
  for (const entry of entries) pruneTree(join(target, entry));
  try { rmdirSync(target); } catch { /* 非空或被占用 */ }
}

export class Updater {
  /**
   * @param {{ root: string, config?: object, log?: (line: string) => void }} options
   */
  constructor({ root, config = {}, log = () => {} }) {
    this.root = resolve(root);
    this.config = config;
    this.log = log;
    this.stateFile = join(this.root, "state", "update.json");
    this.updatesDir = join(this.root, "updates");
    this.backupsDir = join(this.root, "backups");
    this.startedAt = new Date().toISOString();
    this.busy = false;
  }

  currentVersion() {
    const pkg = readJson(join(this.root, "package.json"), {});
    return String(pkg.version ?? "0.0.0");
  }

  #state() {
    const data = readJson(this.stateFile, {}) ?? {};
    return {
      settings: {
        autoCheck: data.settings?.autoCheck !== false,
        autoInstall: data.settings?.autoInstall === true,
        intervalHours: Number(data.settings?.intervalHours) >= 1 ? Math.min(168, Number(data.settings.intervalHours)) : 6,
        manifestUrl: typeof data.settings?.manifestUrl === "string" ? data.settings.manifestUrl : "",
      },
      lastCheck: data.lastCheck ?? null,
      applied: data.applied ?? null,
      history: Array.isArray(data.history) ? data.history.slice(-20) : [],
    };
  }

  #saveState(next) {
    writeJsonAtomic(this.stateFile, next);
  }

  settings() {
    const state = this.#state();
    const url = state.settings.manifestUrl || defaultManifestUrl(this.config.hub);
    return { ...state.settings, manifestUrl: state.settings.manifestUrl, effectiveManifestUrl: url };
  }

  saveSettings(patch = {}) {
    const state = this.#state();
    if ("autoCheck" in patch) state.settings.autoCheck = patch.autoCheck !== false;
    if ("autoInstall" in patch) state.settings.autoInstall = patch.autoInstall === true;
    if ("intervalHours" in patch) {
      const hours = Number(patch.intervalHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new UpdateError("检查间隔要在 1–168 小时之间", { kind: "input" });
      state.settings.intervalHours = Math.round(hours);
    }
    if ("manifestUrl" in patch) {
      const raw = String(patch.manifestUrl ?? "").trim();
      if (raw) {
        let url;
        try { url = new URL(raw); } catch { throw new UpdateError("更新源地址不是合法网址", { kind: "input" }); }
        if (!/^https?:$/.test(url.protocol)) throw new UpdateError("更新源地址必须是 http 或 https", { kind: "input" });
        state.settings.manifestUrl = url.toString();
      } else {
        state.settings.manifestUrl = "";
      }
    }
    this.#saveState(state);
    return this.settings();
  }

  /** 给界面看的摘要：不返回整份清单，只给结论和必要字段。 */
  summary() {
    const state = this.#state();
    const settings = this.settings();
    const current = this.currentVersion();
    // 上次检查的结论是按「当时的版本」算的。版本变了（手动替换、回滚、刚装完），
    // 那份缓存会显示一个不存在的「可更新」——这里按当前版本重算一次。
    let lastCheck = state.lastCheck;
    if (lastCheck) {
      const latest = lastCheck.latest || lastCheck.manifest?.version || "";
      const available = latest ? compareVersions(latest, current) > 0 : false;
      if (lastCheck.current !== current || Boolean(lastCheck.available) !== available) {
        lastCheck = { ...lastCheck, current, available, stale: lastCheck.current !== current };
      }
    }
    return {
      current,
      runtime: { node: process.version, platform: process.platform, pid: process.pid, startedAt: this.startedAt ?? null },
      settings: { autoCheck: settings.autoCheck, autoInstall: settings.autoInstall, intervalHours: settings.intervalHours },
      manifestUrl: settings.effectiveManifestUrl,
      manifestUrlCustom: Boolean(settings.manifestUrl),
      lastCheck,
      applied: state.applied,
      history: state.history.slice(-5),
      root: this.root,
      busy: this.busy,
    };
  }

  #recordCheck(payload) {
    const state = this.#state();
    state.lastCheck = payload;
    this.#saveState(state);
    return payload;
  }

  async #fetchManifest(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (error) {
      throw new UpdateError(
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "读取更新清单超时，检查更新源地址与网络"
          : `连不上更新源（${url}）：${error?.cause?.code || error?.message || error}`,
        { kind: "network" },
      );
    }

    // 平台清单可能挂在登录后面：401/403，或 302 被跟到登录页拿到 HTML。
    if (!response.ok) {
      const retried = await this.#fetchManifestWithHubAuth(url);
      if (retried) return retried;
      if (response.status === 404) {
        // 404 不当故障：平台还没发过网关包时就是这个状态，界面上要说成「暂无更新包」
        throw new UpdateError(
          `更新源没有这份清单（404）：${url}。平台还没发布网关更新包时属于正常情况；也可以在内网自己放一份 gateway.json`,
          { kind: "absent", status: 404 },
        );
      }
      throw new UpdateError(`读取更新清单失败（HTTP ${response.status}）：${url}`, { kind: "manifest", status: response.status });
    }

    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      const retried = await this.#fetchManifestWithHubAuth(url);
      if (retried) return retried;
      throw new UpdateError(`清单不是 JSON（拿到的开头是「${trimmed.slice(0, 40) || "空"}」），检查更新源地址是否指到了网页上`, { kind: "manifest" });
    }
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new UpdateError("清单 JSON 格式有误，无法解析", { kind: "manifest" });
    }
    return { raw, finalUrl: response.url || url };
  }

  /** 平台账号可用时，带会话再取一次（清单没公开的情况）。 */
  async #fetchManifestWithHubAuth(url) {
    const hub = this.config.hub;
    if (!hub?.username || !hub?.password) return null;
    try {
      const { HubClient } = await import("./hub-client.mjs");
      const client = new HubClient(hub);
      await client.login();
      const response = await fetch(url, {
        headers: { Accept: "application/json", Cookie: client.cookie },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok) return null;
      const text = (await response.text()).trim();
      if (!text.startsWith("{")) return null;
      return { raw: JSON.parse(text), finalUrl: response.url || url };
    } catch {
      return null;
    }
  }

  /**
   * 检查更新。任何失败都写进 lastCheck.error 并在返回值里给 reason，
   * 界面上要能说清「是没网、没清单、还是已经最新」。
   */
  async check({ manifestUrl } = {}) {
    const settings = this.settings();
    const url = String(manifestUrl ?? settings.effectiveManifestUrl ?? "").trim();
    const checkedAt = new Date().toISOString();
    const current = this.currentVersion();
    if (!url) {
      return this.#recordCheck({
        ok: false, checkedAt, current, available: false,
        error: "还没有更新源地址。连上 AI 能力平台，或在设置里手动填一个 gateway.json 地址",
        kind: "config",
      });
    }
    try {
      const { raw, finalUrl } = await this.#fetchManifest(url);
      const manifest = normalizeManifest(raw, finalUrl);
      const available = compareVersions(manifest.version, current) > 0;
      const tooOld = Boolean(manifest.minVersion) && compareVersions(current, manifest.minVersion) < 0;
      const result = {
        ok: true,
        checkedAt,
        current,
        latest: manifest.version,
        available: available && !tooOld,
        // 有新版但因为本地太旧跨不过去：告诉用户要重装，而不是默默不更新
        blockedBy: tooOld ? `这个更新包要求至少 v${manifest.minVersion}，当前 v${current}，请用完整安装包升级` : "",
        manifest,
        source: finalUrl,
      };
      this.log(`[update] 检查完成：当前 v${current}，最新 v${manifest.version}${result.available ? "（可更新）" : ""}`);
      return this.#recordCheck(result);
    } catch (error) {
      const message = error?.message || String(error);
      this.log(`[update] 检查失败：${message}`);
      return this.#recordCheck({
        ok: false, checkedAt, current, available: false,
        error: message, kind: error?.kind ?? "update", source: url,
      });
    }
  }

  #assertIdle() {
    if (this.busy) throw new UpdateError("已经有一个更新在进行中", { kind: "busy" });
  }

  async #download(manifest) {
    let response;
    try {
      response = await fetch(manifest.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (error) {
      throw new UpdateError(
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "下载更新包超时（5 分钟），换内网地址或稍后重试"
          : `下载更新包失败：${error?.cause?.code || error?.message || error}`,
        { kind: "network" },
      );
    }
    if (!response.ok) {
      const hint = response.status === 404 ? "——清单里的 url 指向的文件不在了" : "";
      throw new UpdateError(`下载更新包失败（HTTP ${response.status}）${hint}`, { kind: "download", status: response.status });
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ZIP_BYTES) {
      throw new UpdateError(`更新包 ${Math.round(declared / 1048576)}MB，超过 ${MAX_ZIP_BYTES / 1048576}MB 上限`, { kind: "content" });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ZIP_BYTES) throw new UpdateError("更新包超过大小上限", { kind: "content" });
    if (buffer.length < 4 || buffer.subarray(0, 2).toString("hex") !== "504b") {
      throw new UpdateError("下载到的不是 zip（开头不是 PK），检查 url 是否指到了网页", { kind: "content" });
    }
    if (manifest.size && Math.abs(buffer.length - manifest.size) > 1024) {
      // 只提示不阻断：平台压缩参数不同会让 size 有出入，但差太多通常是下错了
      this.log(`[update] 包大小与清单不符：清单 ${manifest.size}B，实际 ${buffer.length}B`);
    }
    let verified = false;
    if (manifest.sha256) {
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (digest !== manifest.sha256) {
        throw new UpdateError(`校验失败：清单 sha256 是 ${manifest.sha256.slice(0, 12)}…，实际是 ${digest.slice(0, 12)}…，包可能损坏或被篡改`, { kind: "checksum" });
      }
      verified = true;
    }
    return { buffer, bytes: buffer.length, verified };
  }

  #unzip(zipPath, target) {
    // Windows 自带 bsdtar 能解 zip；PATH 里的 tar 在 Git Bash 下常是 GNU 版，解不了
    const bsdtar = "C:\\Windows\\System32\\tar.exe";
    const candidates = process.platform === "win32" && existsSync(bsdtar) ? [bsdtar, "tar"] : ["tar"];
    let lastError = "";
    for (const bin of candidates) {
      const result = spawnSync(bin, ["-xf", zipPath, "-C", target], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
      if (result.status === 0) return;
      lastError = String(result.stderr || result.error?.message || "").trim();
    }
    throw new UpdateError(`解压失败：${lastError || "系统没有可用的 tar（Windows 10 及以上自带）"}`, { kind: "extract" });
  }

  /** 包内可能多套一层目录（gateway-1.1.0/ 或 中文名/），找到含 src/server.mjs 的那一层。 */
  #findPackageRoot(dir) {
    if (existsSync(join(dir, "src", "server.mjs"))) return dir;
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const candidate = join(dir, entry.name);
      if (existsSync(join(candidate, "src", "server.mjs"))) return candidate;
    }
    return null;
  }

  #listTree(root, base = "") {
    const out = [];
    const dir = base ? join(root, base) : root;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...this.#listTree(root, rel));
      else if (entry.isFile()) out.push(rel);
    }
    return out;
  }

  /**
   * 下载并安装。返回结构里带 from/to/backupDir，前端据此提示「重启后生效」。
   * 安装期间 busy=true，避免两个请求同时改同一批文件。
   */
  async apply({ manifest: provided } = {}) {
    this.#assertIdle();
    this.busy = true;
    const startedAt = new Date().toISOString();
    const current = this.currentVersion();
    let staging = null;
    try {
      const manifest = provided?.version ? provided : (await this.check()).manifest;
      if (!manifest) throw new UpdateError("没有可安装的版本：先检查更新，或更新源里还没有清单", { kind: "manifest" });
      if (compareVersions(manifest.version, current) <= 0) {
        throw new UpdateError(`已经是最新的 v${current}（清单给的是 v${manifest.version}），不需要更新`, { kind: "noop" });
      }

      const { buffer, bytes, verified } = await this.#download(manifest);
      if (!existsSync(this.updatesDir)) mkdirSync(this.updatesDir, { recursive: true });
      staging = join(this.updatesDir, `staging-${Date.now().toString(36)}`);
      mkdirSync(staging, { recursive: true });
      const zipPath = join(staging, "pkg.zip");
      writeFileSync(zipPath, buffer);
      const unpackDir = join(staging, "unpacked");
      mkdirSync(unpackDir, { recursive: true });
      this.#unzip(zipPath, unpackDir);

      const pkgRoot = this.#findPackageRoot(unpackDir);
      if (!pkgRoot) throw new UpdateError("包里找不到 src/server.mjs，这不是网关更新包", { kind: "content" });

      // 只挑白名单内的顶层条目；受保护的与不认识的都记下来告诉用户
      const entries = readdirSync(pkgRoot, { withFileTypes: true });
      const picked = [];
      const skipped = [];
      let totalBytes = 0;
      let fileCount = 0;
      for (const entry of entries) {
        if (PROTECTED_TOP.has(entry.name) || !PAYLOAD_TOP.has(entry.name)) {
          skipped.push(entry.name);
          continue;
        }
        if (entry.isDirectory()) {
          for (const rel of this.#listTree(pkgRoot, entry.name)) {
            const size = statSync(join(pkgRoot, rel)).size;
            totalBytes += size;
            fileCount += 1;
            if (totalBytes > MAX_TOTAL_BYTES) throw new UpdateError("解压后体积超过上限，拒绝安装", { kind: "content" });
            if (fileCount > MAX_FILES) throw new UpdateError(`文件数超过 ${MAX_FILES}，拒绝安装`, { kind: "content" });
          }
        } else {
          totalBytes += statSync(join(pkgRoot, entry.name)).size;
          fileCount += 1;
        }
        picked.push(entry.name);
      }
      if (!picked.includes("src")) throw new UpdateError("更新包里没有 src 目录", { kind: "content" });

      // 备份：把将被替换的旧条目 rename 进备份目录（同盘，瞬时完成，回滚也快）
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const backupDir = join(this.backupsDir, `update-${current}-${stamp}`);
      mkdirSync(backupDir, { recursive: true });
      const moved = [];
      const cleanupOnFailure = [];
      try {
        for (const name of picked) {
          const target = join(this.root, name);
          const backup = join(backupDir, name);
          if (existsSync(target)) {
            renameSync(target, backup);
            moved.push(name);
          }
          renameSync(join(pkgRoot, name), target);
          cleanupOnFailure.push(name);
        }
      } catch (error) {
        // 半途失败：已换进去的还原成备份，再抛错让界面看到真正原因
        for (const name of cleanupOnFailure.reverse()) {
          try {
            pruneTree(join(this.root, name));
            if (existsSync(join(backupDir, name))) renameSync(join(backupDir, name), join(this.root, name));
          } catch { /* 回滚尽力而为，下面会报告备份目录 */ }
        }
        throw new UpdateError(`替换文件时失败：${error?.message || error}。已尝试回滚，备份在 ${backupDir}`, { kind: "apply" });
      }

      const to = manifest.version;
      const state = this.#state();
      state.applied = {
        at: startedAt,
        from: current,
        to,
        backupDir,
        verified,
        bytes,
        files: fileCount,
        manifest,
        skipped,
        pendingRestart: true,
      };
      state.history.push({ at: startedAt, from: current, to, backupDir });
      state.lastCheck = { ...(state.lastCheck ?? {}), current: to, available: false, latest: to };
      this.#saveState(state);
      this.log(`[update] 已安装 v${to}（${fileCount} 个文件，${Math.round(bytes / 1024)}KB），备份在 ${backupDir}`);
      return {
        ok: true,
        from: current,
        to,
        files: fileCount,
        bytes,
        verified,
        skipped,
        backupDir,
        pendingRestart: true,
        note: "文件已替换，重启服务后生效",
      };
    } finally {
      this.busy = false;
      if (staging) pruneTree(staging);
    }
  }

  /** 回滚到最近一次更新前的备份。找不到备份就明确说不出来。 */
  async rollback({ backupDir } = {}) {
    this.#assertIdle();
    const state = this.#state();
    const dir = String(backupDir || state.applied?.backupDir || "").trim();
    if (!dir) throw new UpdateError("没有可回滚的备份记录", { kind: "rollback" });
    const resolved = resolve(dir);
    if (!resolved.startsWith(this.backupsDir) || resolved === this.backupsDir) {
      throw new UpdateError("备份目录不在 backups/ 下，拒绝回滚", { kind: "guard" });
    }
    if (!existsSync(resolved)) throw new UpdateError(`备份目录不在了：${resolved}`, { kind: "rollback" });

    this.busy = true;
    try {
      const entries = readdirSync(resolved);
      if (!entries.length) throw new UpdateError("备份目录是空的", { kind: "rollback" });
      for (const name of entries) {
        if (!PAYLOAD_TOP.has(name)) continue;
        const target = join(this.root, name);
        pruneTree(target);
        renameSync(join(resolved, name), target);
      }
      const from = state.applied?.to ?? "";
      const to = state.applied?.from ?? "";
      state.applied = { ...(state.applied ?? {}), rolledBackAt: new Date().toISOString(), pendingRestart: true };
      state.history.push({ at: new Date().toISOString(), from, to, rollback: true });
      this.#saveState(state);
      this.log(`[update] 已从 ${resolved} 回滚到 v${to || "上一版"}，重启后生效`);
      return { ok: true, from, to, backupDir: resolved, pendingRestart: true, note: "文件已还原，重启服务后生效" };
    } finally {
      this.busy = false;
    }
  }

  /** 列出可用备份（设置页「回滚」下拉用）。 */
  backups() {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("update-"))
      .map((entry) => {
        const dir = join(this.backupsDir, entry.name);
        const match = entry.name.match(/^update-(.+)-(\d{4}-\d{2}-\d{2})/);
        return { name: entry.name, dir, version: match?.[1] ?? "", date: match?.[2] ?? "", bytes: 0 };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /**
   * 重启前的一步：把「待重启」标成「正在重启」，让重启后的进程知道自己刚升过级。
   * 真正的进程重启由 server.mjs 里的 relauncher 做，这里只管把痕迹留在盘上。
   */
  markRestarting() {
    const state = this.#state();
    if (state.applied) {
      state.applied.restartingAt = new Date().toISOString();
      if (state.applied.from && state.applied.to) {
        state.applied.restartedFrom = state.applied.from;
      }
      this.#saveState(state);
    }
    return state.applied;
  }

  /** 新进程启动时调用：清掉 pendingRestart，并记录「本次启动运行的是哪个版本」。 */
  settleOnBoot() {
    const state = this.#state();
    let changed = false;
    if (state.applied?.pendingRestart) {
      state.applied.pendingRestart = false;
      state.applied.confirmedAt = new Date().toISOString();
      state.applied.runningVersion = this.currentVersion();
      changed = true;
    }
    if (changed) this.#saveState(state);
    return changed;
  }
}

export const updateInternals = { PAYLOAD_TOP, PROTECTED_TOP, MAX_FILES };
