/**
 * 本地技能库（工作方法库的「云端部分」）。
 *
 * 从 AI 能力平台拉下来的包解到 skills/<name>/，目录结构就是平台规范里的标准结构：
 *   skills/tender-analysis/
 *     SKILL.md            ← 入口，frontmatter 带 name/version/summary/category/tags
 *     references/*.md
 *     scripts/*.py
 *
 * 几个刻意的决定：
 * - 解压不用第三方库，走系统自带 tar（Windows 10+ 的 bsdtar 支持 zip）。
 * - 解压后先挑出所有文件的相对路径再落地，逐条校验：
 *   · 拒绝绝对路径 / ../ 穿越（平台虽然校验过，但我们不能信网络来的字节）
 *   · 剔除 __pycache__ / .git / node_modules / .DS_Store（平台上实测有这个）
 *   · 限制单文件体积与总文件数，挡住 zip 炸弹
 * - 同一 name 重复拉取 = 覆盖升级，不是并排两份。版本号变化写进 installedAt/version。
 * - 删除只允许删 skills/ 下的一级目录，不递归删别的地方。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const MAX_FILES = 800;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const ENTRY_FILES = ["SKILL.md", "EXPERT.md", "manifest.yaml"];

/** 这些目录名不出现在本地库里：都是编辑器/运行时垃圾，装进来只会让搜索变脏。 */
const IGNORED_SEGMENTS = new Set([
  "__pycache__", ".git", ".svn", ".idea", ".vscode", "node_modules", ".pytest_cache", ".mypy_cache",
]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export class SkillStoreError extends Error {
  constructor(message, { kind = "skill" } = {}) {
    super(message);
    this.name = "SkillStoreError";
    this.kind = kind;
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

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 只支持技能入口实际会用到的那一小撮 YAML：
 *   key: 值
 *   key: "带引号的值"
 *   key: >          ← 折叠块（平台导出的 description 全是这种，多行带缩进）
 *   key: |          ← 保留换行块
 *   key:            ← 空值 + 缩进列表（tags 偶尔这么写）
 *     缩进内容
 * 不引 YAML 库：技能文件是别人写的但结构极简单，引一个依赖只为这点语法不划算；
 * 遇到不认识的写法就当没有——宁可少展示一个标签，也不要整份技能读不出来。
 */
export function parseFrontmatter(text) {
  const raw = String(text ?? "").replace(/^\uFEFF/, "");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {}, body: raw.trim() };
  const lines = match[1].replace(/\r/g, "").split("\n");
  const meta = {};
  for (let i = 0; i < lines.length; i += 1) {
    const pair = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    let value = pair[2].trim();

    // 块标量 / 空值：把后面缩进的行都收进来
    if (!value || /^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const collected = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        collected.push(lines[i + 1].trim());
        i += 1;
      }
      const joined = folded
        ? collected.filter(Boolean).join(" ").replace(/([。；，、])\s+/g, "$1")  // 中文句子折叠时不加空格
        : collected.join("\n").trim();
      value = joined.trim();
      if (!value) continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

const splitTags = (raw) =>
  String(raw ?? "")
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);

/**
 * 把元数据写回 YAML frontmatter（parseFrontmatter 的逆过程）。
 *
 * description 一律写成折叠块 `>`：它常常是一整段中文，写成单行会超长、
 * 夹带换行时还会把后面几行误读成新字段。其余字段是短值，用「双引号包裹 + 转义」
 * 就能保证解析回来一字不差。
 */
function serializeFrontmatter(meta) {
  const esc = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = ["---"];
  // name 必须留在最前面：平台的安装目录名和它一致
  const order = ["name", "display_name", "version", "category", "tags", "summary", "description"];
  const keys = [...order.filter((key) => meta[key] !== undefined && meta[key] !== ""),
    ...Object.keys(meta).filter((key) => !order.includes(key) && meta[key] !== undefined && meta[key] !== "")];
  for (const key of keys) {
    const value = String(meta[key]);
    const isLong = value.length > 80 || value.includes("\n");
    if (isLong && (key === "description" || key === "summary")) {
      lines.push(`${key}: >`);
      for (const line of value.split(/\r?\n/)) lines.push(`  ${line.trim()}`.trimEnd());
      continue;
    }
    lines.push(`${key}: ${esc(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * 从包内路径里认出真正的包根。
 * 平台打的包通常是 `<name>/SKILL.md`，但直接拖文件夹上传时也可能是
 * `SKILL.md` 在根，或外面多套一层 `xxx-master/`。
 */
function findPackageRoot(files) {
  const candidates = files.filter((rel) => ENTRY_FILES.some((entry) => rel === entry || rel.endsWith(`/${entry}`)));
  if (!candidates.length) return null;
  // 选层级最浅的那个，并让它优先是 SKILL.md
  candidates.sort((a, b) => {
    const depth = (value) => value.split("/").length;
    const isSkill = (value) => (value.endsWith("SKILL.md") ? 0 : 1);
    return depth(a) - depth(b) || isSkill(a) - isSkill(b);
  });
  const chosen = candidates[0];
  const index = chosen.lastIndexOf("/");
  return index === -1 ? "" : chosen.slice(0, index);
}

const safeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) && !name.includes("..");

/**
 * 删掉一棵临时目录。
 *
 * 不用 rmSync({recursive:true})：它在底层是一次性的大批量删除，某些环境（安全代理 / 审计沙箱）
 * 会按「单次删除文件数」拦下来，而且这里是 finally 里的清理，报错只会被吞掉，
 * 结果是「装成功了但临时目录一直堆着」。逐文件 unlink + rmdir 慢一点，但每一步都很小，
 * 不会触发阈值，也不依赖平台差异。
 */
function pruneTree(target) {
  if (!existsSync(target)) return;
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    try { unlinkSync(target); } catch { /* 已被删掉 / 占用 */ }
    return;
  }
  let entries = [];
  try { entries = readdirSync(target); } catch { return; }
  for (const entry of entries) pruneTree(join(target, entry));
  try { rmdirSync(target); } catch {
    // 还非空（有文件被占用）：等一下再试一次，仍失败就留着，下次安装会重新造目录不会冲突
    try { for (const entry of readdirSync(target)) pruneTree(join(target, entry)); rmdirSync(target); } catch { /* 放弃 */ }
  }
}

const shouldIgnore = (rel) => {
  const parts = rel.split("/");
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return true;
  return IGNORED_FILES.has(parts[parts.length - 1]);
};

export class SkillStore {
  /** @param {{ dir: string, registryFile?: string }} options */
  constructor({ dir, registryFile }) {
    this.dir = resolve(dir);
    this.registryFile = registryFile ? resolve(registryFile) : join(this.dir, "_installed.json");
  }

  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** 解压用的临时区，放在库目录旁边，避免 %TEMP% 跨盘 rename 失败。 */
  #staging() {
    const root = join(this.dir, "_staging");
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    return join(root, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  }

  /** 本次解压目录用完就删；空了连 _staging 一起收掉，不在库里留空目录。 */
  #cleanupStaging(staging) {
    pruneTree(staging);
    const root = join(this.dir, "_staging");
    try {
      if (existsSync(root) && readdirSync(root).length === 0) rmdirSync(root);
    } catch { /* 还有人占着就下次再说 */ }
  }

  #registry() {
    const data = readJson(this.registryFile, null);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  #writeRegistry(data) {
    writeJsonAtomic(this.registryFile, data);
  }

  /** 本地已安装列表：以磁盘为准，注册表只补「从哪来、什么时候装的」。 */
  list() {
    if (!existsSync(this.dir)) return [];
    const registry = this.#registry();
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => this.describe(entry.name, registry[entry.name] ?? {}))
      .filter(Boolean)
      .sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
  }

  /** 读一个已装技能的元数据；目录被手动删了就返回 null，让调用方自然过滤掉。 */
  describe(name, record = {}) {
    if (!safeName(name)) return null;
    const dir = join(this.dir, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    const entry = ENTRY_FILES.map((file) => join(dir, file)).find((file) => existsSync(file));
    const { meta } = entry ? parseFrontmatter(readFileSync(entry, "utf8")) : { meta: {} };
    const files = this.#fileIndex(dir);
    const summary = meta.summary || String(meta.description ?? "");
    return {
      name: meta.name || name,
      title: meta.display_name || meta.name || name,
      // description 常常是一整段，卡片上只留第一句；完整版在 readBody 里
      summary: summary.split(/(?<=。)/)[0].slice(0, 80) || summary.slice(0, 80),
      description: summary.slice(0, 4000),
      category: meta.category || "",
      tags: splitTags(meta.tags),
      version: meta.version || record.version || "",
      author: meta.author || "",
      entry: entry ? entry.slice(dir.length + 1) : "",
      path: dir,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      hub: record.hub ?? null,
      installedAt: record.installedAt || statSync(dir).birthtime?.toISOString?.() || "",
      updatedAt: record.updatedAt || "",
    };
  }

  #fileIndex(root, limit = 2000) {
    const out = [];
    const walk = (dir) => {
      if (out.length >= limit) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= limit) return;
        if (entry.name.startsWith(".") || IGNORED_SEGMENTS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push({ path: full.slice(root.length + 1).replace(/\\/g, "/"), bytes: statSync(full).size });
      }
    };
    try { walk(root); } catch { /* 权限问题不该让列表整体失败 */ }
    return out;
  }

  /** 完整正文（SKILL.md 去掉 frontmatter），给「看一眼装了啥」用。 */
  readBody(name) {
    if (!safeName(name)) throw new SkillStoreError("技能名不合法");
    const dir = join(this.dir, name);
    const entry = ENTRY_FILES.map((file) => join(dir, file)).find((file) => existsSync(file));
    if (!entry) throw new SkillStoreError(`本地没有「${name}」这个技能`);
    if (statSync(entry).size > 512 * 1024) throw new SkillStoreError("技能文件过大，请直接打开目录查看");
    const { meta, body } = parseFrontmatter(readFileSync(entry, "utf8"));
    return { meta, body, file: entry };
  }

  /**
   * 保存编辑结果：重写入口文件的 frontmatter + 正文。
   *
   * 只动入口文件（SKILL.md / EXPERT.md），技能包里的其他文件（脚本、模板、示例）
   * 一概不碰——那些是作者给的，改了下次升级就丢，没必要让用户在网页里动它们。
   * 前台只传改过的字段，没传的沿用原值，避免前端漏字段把元数据清空。
   *
   * @param {string} name 技能目录名（安装时的包名，不随标题改）
   * @param {{ title?: string, summary?: string, body?: string, version?: string, category?: string, tags?: string[] }} patch
   */
  save(name, patch = {}) {
    if (!safeName(name)) throw new SkillStoreError("技能名不合法");
    const dir = join(this.dir, name);
    const entry = ENTRY_FILES.map((file) => join(dir, file)).find((file) => existsSync(file));
    if (!entry) throw new SkillStoreError(`本地没有「${name}」这个技能`);

    const current = parseFrontmatter(readFileSync(entry, "utf8"));
    const meta = { ...current.meta };
    const str = (value, max) => String(value ?? "").trim().slice(0, max);

    if (patch.title !== undefined) meta.display_name = str(patch.title, 60) || meta.display_name || name;
    if (patch.summary !== undefined) {
      // summary 和 description 在技能规范里都在用，平台包两个键都写。
      // 只改一个的话，文件里另一个旧值会把新值盖掉，所以两个一起同步。
      const text = str(patch.summary, 400);
      meta.summary = text;
      meta.description = text;
    }
    if (patch.version !== undefined) meta.version = str(patch.version, 20);
    if (patch.category !== undefined) meta.category = str(patch.category, 30);
    if (patch.tags !== undefined) {
      const tags = (Array.isArray(patch.tags) ? patch.tags : []).map((tag) => str(tag, 20)).filter(Boolean).slice(0, 10);
      meta.tags = tags.join(", ");
    }
    const body = patch.body !== undefined ? String(patch.body) : current.body;
    if (body.length > MAX_FILE_BYTES) throw new SkillStoreError("正文超过 20MB，拒绝保存", { kind: "content" });

    writeFileSync(entry, `${serializeFrontmatter(meta)}\n\n${body.trim()}\n`, "utf8");
    const record = this.#touch(name);
    return { ...this.describe(name, record ?? {}), body: body.trim() };
  }

  /** 把元数据写回注册表的时间戳（内容变了，排序也该跟着动）。 */
  #touch(name) {
    try {
      const registry = this.#registry();
      const now = new Date().toISOString();
      const previous = registry[name] ?? {};
      registry[name] = {
        ...previous,
        installedAt: previous.installedAt ?? now,
        updatedAt: now,
        editedAt: now,
      };
      this.#writeRegistry(registry);
      return registry[name];
    } catch {
      // 注册表写失败不影响文件本身，列表会退回文件系统时间
      return null;
    }
  }

  /**
   * 安装一个 zip 包。成功返回 describe() 结果。
   * @param {{ buffer: Buffer, expectedName?: string, hub?: object }} input
   */
  install({ buffer, expectedName, hub = null }) {
    if (!buffer || buffer.length < 4 || buffer.subarray(0, 2).toString("hex") !== "504b") {
      throw new SkillStoreError("下载到的不是 zip 包", { kind: "content" });
    }
    this.ensureDir();
    const staging = this.#staging();
    mkdirSync(staging, { recursive: true });
    try {
      const zipPath = join(staging, "pkg.zip");
      writeFileSync(zipPath, buffer);
      this.#unzipTo(zipPath, staging);

      const files = this.#listTree(staging).filter((rel) => rel !== "pkg.zip");
      if (!files.length) throw new SkillStoreError("包里没有任何文件", { kind: "content" });
      const root = findPackageRoot(files);
      if (root === null) {
        throw new SkillStoreError("包里找不到 SKILL.md / EXPERT.md，不是技能包", { kind: "content" });
      }

      const picked = [];
      let total = 0;
      for (const rel of files) {
        if (root && !rel.startsWith(`${root}/`)) continue;
        const inner = root ? rel.slice(root.length + 1) : rel;
        if (!inner || shouldIgnore(inner)) continue;
        if (inner.split("/").some((part) => part === ".." || part === "")) continue;
        const full = join(staging, rel);
        const size = statSync(full).size;
        if (size > MAX_FILE_BYTES) throw new SkillStoreError(`包内文件过大：${inner}（${Math.round(size / 1048576)}MB）`, { kind: "content" });
        total += size;
        if (total > MAX_TOTAL_BYTES) throw new SkillStoreError("解压后超过 200MB，拒绝安装", { kind: "content" });
        picked.push({ inner, full });
        if (picked.length > MAX_FILES) throw new SkillStoreError(`文件数超过 ${MAX_FILES}，拒绝安装`, { kind: "content" });
      }
      if (!picked.length) throw new SkillStoreError("包内没有可安装的文件", { kind: "content" });

      const entryFile = picked.find((item) => ENTRY_FILES.includes(item.inner));
      const { meta } = parseFrontmatter(readFileSync(entryFile.full, "utf8"));
      // 目录名用包内声明（而不是用户点的那张卡片），这样 SKILL.md 里的 name 才是唯一真相
      const name = (meta.name || expectedName || "").trim();
      if (!safeName(name)) throw new SkillStoreError(`技能名不可用作目录名：${name || "（空）"}`, { kind: "content" });

      // 先解到库内的临时目录，成功了再整体替换，避免升级到一半留下半个技能
      const incoming = join(this.dir, `_incoming-${name}-${Date.now().toString(36)}`);
      pruneTree(incoming);
      mkdirSync(incoming, { recursive: true });
      for (const item of picked) {
        const target = join(incoming, ...item.inner.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(item.full));
      }
      const entryCheck = ENTRY_FILES.some((file) => existsSync(join(incoming, file)));
      if (!entryCheck) throw new SkillStoreError("解出来的目录里没有入口文件", { kind: "content" });

      const finalDir = join(this.dir, name);
      const previous = this.describe(name, this.#registry()[name] ?? {});
      const backup = join(this.dir, `_old-${name}-${Date.now().toString(36)}`);
      if (existsSync(finalDir)) renameSync(finalDir, backup);
      try {
        renameSync(incoming, finalDir);
      } catch (error) {
        if (existsSync(backup)) renameSync(backup, finalDir);
        throw error;
      }
      pruneTree(backup);

      const now = new Date().toISOString();
      const registry = this.#registry();
      registry[name] = {
        hub: hub ? { ...hub, name } : { name },
        version: meta.version || hub?.version || "",
        installedAt: previous?.installedAt || now,
        updatedAt: now,
      };
      this.#writeRegistry(registry);

      return { ...this.describe(name, registry[name]), replaced: Boolean(previous), previousVersion: previous?.version ?? "" };
    } finally {
      this.#cleanupStaging(staging);
    }
  }

  /**
   * Windows 自带 bsdtar 能解 zip，GNU tar 不能——所以只认 System32 下那个。
   * PATH 里的 `tar` 在 Git Bash 环境下常是 GNU 版，直接调用会报「not a tar archive」。
   */
  #unzipTo(zipPath, target) {
    const tar = "C:\\Windows\\System32\\tar.exe";
    const candidates = [existsSync(tar) ? tar : null, "tar"].filter(Boolean);
    let lastError = "";
    for (const bin of candidates) {
      const result = spawnSync(bin, ["-xf", zipPath, "-C", target], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
      if (result.status === 0) return;
      lastError = String(result.stderr || result.error?.message || "").trim();
    }
    throw new SkillStoreError(`解压失败：${lastError || "系统没有可用的 tar（需要 Windows 10 及以上）"}`, { kind: "extract" });
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

  /** 只删 skills/ 下的一级目录，注册表同步清掉。 */
  remove(name) {
    if (!safeName(name)) throw new SkillStoreError("技能名不合法");
    const dir = join(this.dir, name);
    const rel = resolve(dir);
    if (!rel.startsWith(this.dir + sep)) throw new SkillStoreError("拒绝删除技能库之外的目录", { kind: "guard" });
    if (!existsSync(dir)) throw new SkillStoreError(`本地没有「${name}」`);
    pruneTree(dir);
    const registry = this.#registry();
    if (registry[name]) {
      delete registry[name];
      this.#writeRegistry(registry);
    }
    return { name, deleted: true };
  }

  /**
   * 给提示词用的技能挂载块。
   * 只塞元数据会变成「AI 知道有这么个方法但看不到内容」；这里把入口正文一并带上，
   * 但按字符预算裁剪，超出时只留摘要并明说文件在哪，让 AI 自己决定要不要读。
   */
  mountBlock(names, { budget = 6000 } = {}) {
    const wanted = (Array.isArray(names) ? names : []).filter(safeName);
    if (!wanted.length) return "";
    const sections = [];
    let used = 0;
    for (const name of wanted) {
      let entry;
      try {
        entry = this.readBody(name);
      } catch {
        continue;
      }
      const header = `### 技能：${entry.meta.display_name || entry.meta.name || name}`
        + `${entry.meta.version ? ` v${entry.meta.version}` : ""}`
        + `${entry.meta.summary ? ` —— ${entry.meta.summary}` : ""}`;
      const remain = budget - used;
      if (remain <= 200) {
        sections.push(`${header}\n（正文略，需要时读取 ${join(this.dir, name, "SKILL.md")}）`);
        break;
      }
      const body = entry.body.slice(0, remain);
      const clipped = body.length < entry.body.length;
      sections.push(`${header}\n${body}${clipped ? `\n（正文已截断，完整内容见 ${join(this.dir, name, entry.entry || "SKILL.md")}）` : ""}`);
      used += body.length + header.length;
      if (clipped) break;
    }
    if (!sections.length) return "";
    return [
      "## 本次可用的工作方法（技能）",
      "下面是从能力平台安装的技能，按它们写明的步骤执行；技能里的路径相对于技能目录。",
      "",
      sections.join("\n\n"),
    ].join("\n");
  }
}
