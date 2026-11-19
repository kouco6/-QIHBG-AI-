/**
 * 运行工作副本。
 *
 * 为什么要有：同一个项目目录被多次运行共用时，两个流程会互相覆盖文件，
 * 失败重试也会看到上一次的半成品。隔离做法是每次运行先复制一份作业目录，
 * 所有读写都发生在副本里，源目录保持干净。
 *
 * 设计取舍：
 *   - 用「复制」而不是「git worktree」：worktree 只带已提交内容，用户没提交的
 *     改动会凭空消失，这比复制慢一点危险得多。
 *   - 副本放在源目录同级的 .flows-runs/ 下：同盘、路径短、不污染项目内部，
 *     复制时也天然避开递归（副本不在源目录内部）。
 *   - 失败不静默降级成原地运行：那等于悄悄写用户真实代码，是最坏的失败方式。
 */

import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const WORKSPACE_ROOT = ".flows-runs";
export const WORKSPACE_MODES = ["isolated", "inplace"];

/** 复制时跳过的目录名：依赖、版本库、构建产物、旧工件目录。 */
const SKIP_NAMES = new Set([
  "node_modules", ".git", ".flows", ".flows-runs", ".hg", ".svn",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".parcel-cache", ".cache", ".rollup.cache", ".vite",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".venv", "venv", "env", ".env.d", ".idea", ".vscode",
]);

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;

/** 依赖目录不复制，但可以链回来——否则副本里 `npm test` 直接报缺模块。 */
const LINK_NAMES = ["node_modules", ".venv", "venv"];

export const workspaceMode = (raw) => (WORKSPACE_MODES.includes(raw) ? raw : "isolated");

/** 副本目录命名：<项目名>__<runId>，能一眼看出属于哪次运行。 */
export const workspacePathFor = (source, runId, base = null) =>
  join(base ?? dirname(source), WORKSPACE_ROOT, `${basename(source) || "root"}__${runId}`);

const inside = (dir, target) => {
  const base = resolve(dir);
  const absolute = resolve(target);
  return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
};

/**
 * 为一次运行准备作业目录。
 * 返回的 path 就是这次运行的 cwd：后面所有步骤、工具沙箱、工件目录都基于它。
 */
export function prepareWorkspace({ runId, source, mode = "isolated", fallbackBase = null }) {
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) throw new Error(`工作目录不存在：${sourcePath}`);
  if (!statSync(sourcePath).isDirectory()) throw new Error(`工作目录不是文件夹：${sourcePath}`);

  if (workspaceMode(mode) === "inplace") {
    return {
      mode: "inplace",
      source: sourcePath,
      path: sourcePath,
      strategy: "none",
      fileCount: 0,
      bytes: 0,
      warnings: ["原地运行：本次改动会直接写进这个目录，与其他运行共用文件"],
      createdAt: new Date().toISOString(),
    };
  }

  const primary = workspacePathFor(sourcePath, runId);
  const target = inside(sourcePath, primary) ? workspacePathFor(sourcePath, runId, fallbackBase) : primary;

  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // 副本可能落在某个 git 仓库的子目录旁，加个自忽略文件，别污染用户的 git status。
  try {
    const marker = join(dirname(target), ".gitignore");
    if (!existsSync(marker)) writeFileSync(marker, "*\n", "utf8");
  } catch {
    /* 忽略失败不影响运行 */
  }

  let fileCount = 0;
  let bytes = 0;
  const warnings = [];

  try {
    cpSync(sourcePath, target, {
      recursive: true,
      errorOnExist: false,
      filter: (current) => {
        if (resolve(current) === resolve(target)) return false;
        const name = basename(current);
        if (SKIP_NAMES.has(name)) return false;
        let info;
        try {
          info = statSync(current);
        } catch {
          return false;
        }
        if (info.isFile()) {
          fileCount += 1;
          bytes += info.size;
          if (fileCount > MAX_FILES) throw new Error(`文件数超过 ${MAX_FILES}，请先在项目里清理，或改用「原地运行」`);
          if (bytes > MAX_BYTES) throw new Error(`体积超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，请改用「原地运行」`);
        }
        return true;
      },
    });
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    const message = error?.message || String(error);
    // 文件数/体积超限是用户可理解的限制，原样抛出；其余是 IO 异常，补一句出路。
    if (message.startsWith("文件数") || message.startsWith("体积")) throw error;
    throw new Error(`创建工作副本失败：${message}。可以改用「原地运行」，或把项目目录换成有写权限的位置`);
  }

  if (!fileCount) warnings.push("源目录没有可复制的文件，副本是空的");

  // 依赖目录不进副本（体积太大），但链回源目录，副本里才能真的跑测试。
  const dependencies = linkDependencies(sourcePath, target);
  warnings.push(...dependencies.warnings);

  return {
    mode: "isolated",
    source: sourcePath,
    path: target,
    strategy: "copy",
    fileCount,
    bytes,
    dependencies: dependencies.linked,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 把依赖目录链回源目录。
 *
 * 为什么不在副本里装一遍：装一次可能几分钟，而且每次运行都装是纯浪费。
 * 为什么用目录链：Windows 的 junction 不需要管理员权限，跨盘也能用。
 * 代价：流程如果在副本里跑了 `npm install`，改的是源目录那份依赖——界面要提示这一点。
 */
function linkDependencies(source, target) {
  const linked = [];
  const warnings = [];
  const candidates = [];

  for (const name of LINK_NAMES) candidates.push(name);
  // monorepo：packages/web、apps/api 这类子包里也各自带依赖，向下探两层足够
  const walk = (dir, prefix, level) => {
    if (level > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_NAMES.has(entry.name)) continue;
      const childDir = join(dir, entry.name);
      const childRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const name of LINK_NAMES) {
        if (existsSync(join(childDir, name))) candidates.push(`${childRel}/${name}`);
      }
      walk(childDir, childRel, level + 1);
    }
  };
  walk(source, "", 1);

  for (const rel of candidates) {
    const from = join(source, rel);
    const to = join(target, rel);
    try {
      if (!existsSync(from) || !statSync(from).isDirectory()) continue;
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(resolve(from), to, process.platform === "win32" ? "junction" : "dir");
      linked.push(rel);
    } catch (error) {
      warnings.push(`依赖目录 ${rel} 没能链接到副本（${error?.code || error?.message || error}），这一步里跑命令可能缺依赖`);
    }
  }

  return { linked, warnings };
}

/** 删副本前先把目录链摘掉：rmSync 顺着链删下去会毁掉源项目的依赖。 */
function unlinkDependencies(dir) {
  const paths = LINK_NAMES.map((name) => join(dir, name));
  const walk = (current, level) => {
    if (level > 2) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // 目录链本身在 Dirent 里是 symlink，不是 directory，所以不会走进源目录
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const childDir = join(current, entry.name);
      for (const name of LINK_NAMES) paths.push(join(childDir, name));
      walk(childDir, level + 1);
    }
  };
  walk(dir, 1);
  for (const target of paths) {
    try {
      if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true });
    } catch {
      /* 不存在或不是链，跳过 */
    }
  }
}

/** 删除前先确认目标长得像我们的副本，避免误删用户的真实目录。 */
export function isManagedWorkspace(workspace) {
  if (!workspace || workspace.mode !== "isolated" || !workspace.path) return false;
  const path = resolve(workspace.path);
  if (basename(dirname(path)) !== WORKSPACE_ROOT) return false;
  // 副本命名必须能对上这次运行，否则不认领。
  return !workspace.runId || basename(path).endsWith(`__${workspace.runId}`);
}

export function removeWorkspace(workspace) {
  if (!workspace || workspace.mode !== "isolated") throw new Error("原地运行没有副本可清理");
  const path = resolve(workspace.path);
  if (basename(dirname(path)) !== WORKSPACE_ROOT) throw new Error(`拒绝删除非副本目录：${path}`);
  if (!existsSync(path)) return { removed: false, path };
  unlinkDependencies(path);
  rmSync(path, { recursive: true, force: true });
  return { removed: true, path };
}

// ------------------------------------------------------------------ diffing

const readOrNull = (file) => {
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    if (info.size > 8 * 1024 * 1024) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * 本步产出的文件相对源目录是什么状态。
 * status: added（源目录没有）/ modified（内容不同）/ same（没变）
 */
export function diffPath(workspace, relativePath) {
  if (!workspace || workspace.mode !== "isolated") return { path: relativePath, status: "same" };
  const clean = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return { path: "", status: "same" };
  const inCopy = join(workspace.path, clean);
  const inSource = join(workspace.source, clean);
  if (!inside(workspace.path, inCopy) || !inside(workspace.source, inSource)) return { path: clean, status: "skipped" };
  const copy = readOrNull(inCopy);
  if (!copy) return { path: clean, status: "missing" };
  const original = readOrNull(inSource);
  if (!original) return { path: clean, status: "added" };
  return { path: clean, status: Buffer.compare(copy, original) === 0 ? "same" : "modified" };
}

/** 一份运行改动摘要，供界面显示「改了哪些文件」。 */
export function summarizeChanges(workspace, paths = []) {
  const seen = new Set();
  const changes = [];
  for (const item of paths) {
    const rel = String(item || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const diff = diffPath(workspace, rel);
    if (diff.status === "skipped" || diff.status === "missing") continue;
    changes.push(diff);
  }
  return {
    total: changes.length,
    added: changes.filter((item) => item.status === "added").length,
    modified: changes.filter((item) => item.status === "modified").length,
    unchanged: changes.filter((item) => item.status === "same").length,
    files: changes,
  };
}

/**
 * 把副本里的改动写回源目录。
 * 覆盖前把原文件备份到 backupDir，出问题时还能捞回来。
 */
export function applyChanges(workspace, paths = [], { backupDir = null } = {}) {
  if (!workspace || workspace.mode !== "isolated") throw new Error("只有副本运行才需要回写");
  const applied = [];
  const skipped = [];
  const backupRoot = backupDir ?? join(dirname(workspace.path), `__backup__${workspace.runId ?? ""}`);

  for (const item of paths) {
    const rel = String(item || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) continue;
    const from = join(workspace.path, rel);
    const to = join(workspace.source, rel);
    if (!inside(workspace.path, from) || !inside(workspace.source, to)) {
      skipped.push({ path: rel, reason: "路径越界" });
      continue;
    }
    if (!existsSync(from)) {
      skipped.push({ path: rel, reason: "副本里没有这个文件" });
      continue;
    }
    const original = readOrNull(to);
    if (original) {
      // 内容一致就不重复写：回写要幂等，连点两次不该产生两次备份。
      const current = readOrNull(from);
      if (current && Buffer.compare(current, original) === 0) {
        skipped.push({ path: rel, reason: "内容一致，无需回写" });
        continue;
      }
      const backup = join(backupRoot, rel);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, original);
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    applied.push(rel);
  }

  return { applied, skipped, backupDir: applied.length ? backupRoot : null };
}

export const workspaceRelative = (workspace, absolute) =>
  workspace?.path ? relative(workspace.path, absolute).replace(/\\/g, "/") : String(absolute ?? "");
