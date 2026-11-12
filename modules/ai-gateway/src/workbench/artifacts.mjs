/**
 * Artifact registration.
 *
 * Two sources, in this order of authority:
 *   1. the file list the model declares at the end of its answer (cheap, accurate)
 *   2. a directory scan for files touched after the run started (catches omissions)
 *
 * The scan is a fallback, not the primary path: it cannot tell a deliverable from
 * a log file, so declared entries win when the same path appears in both.
 */

import { readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".codex", ".cache", "state", "dist", "build",
  ".next", "coverage", "__pycache__", ".venv", "venv",
  // 流程工件目录自己会登记，目录扫描再收一遍只会产生重复条目。
  ".flows",
]);

const TYPE_BY_EXT = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".docx": "word",
  ".doc": "word",
  ".pptx": "ppt",
  ".ppt": "ppt",
  ".xlsx": "excel",
  ".xls": "excel",
  ".csv": "csv",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".svg": "image",
  ".json": "json",
  ".txt": "text",
};

const typeOf = (path) => TYPE_BY_EXT[extname(path).toLowerCase()] || "file";

const previewOf = (type) => {
  if (["markdown", "text", "json", "csv"].includes(type)) return "inline";
  if (["html", "image"].includes(type)) return "inline";
  if (["word", "ppt", "excel", "pdf"].includes(type)) return "download";
  return "download";
};

const toAbsolute = (path, cwd) => {
  const trimmed = String(path).trim().replace(/^["']|["']$/g, "");
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
};

const safeStat = (path) => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

/** Walk the working directory, collecting files modified at or after `since`. */
function scanTouched(cwd, since, limit = 200) {
  const found = [];
  const sinceMs = new Date(since).getTime();
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = safeStat(full);
      if (!stat) continue;
      if (stat.mtimeMs >= sinceMs - 1000) {
        found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(cwd, 0);
  return found;
};

let counter = 0;
const nextId = () => `art-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/**
 * @param {{declared:Array<{path,type,note}>, cwd:string, since:string,
 *          runId:string, agent:string}} input
 */
export function collectArtifacts({ declared = [], cwd, since, runId, agent, scan = true }) {
  const seen = new Map();

  const push = (absolutePath, note, declaredType) => {
    const normalized = resolve(absolutePath);
    if (seen.has(normalized)) return;
    const stat = safeStat(normalized);
    const type = typeOf(normalized);
    seen.set(normalized, {
      id: nextId(),
      name: normalized.split(/[\\/]/).pop() || normalized,
      path: normalized,
      relativePath: cwd ? relative(cwd, normalized) : normalized,
      type: declaredType && TYPE_BY_EXT[`.${declaredType}`] ? TYPE_BY_EXT[`.${declaredType}`] : type,
      size: stat?.size ?? null,
      exists: Boolean(stat),
      note: note || "",
      runId,
      producerAgent: agent,
      createdAt: new Date().toISOString(),
      previewCapability: previewOf(type),
    });
  };

  for (const item of declared) {
    if (!item?.path) continue;
    push(toAbsolute(item.path, cwd), item.note, null);
  }

  // scan=false 用于「自己会明确报出写了哪些文件」的执行器（如 Claude 的 Write/Edit），
  // 只认它报的路径，免得把 state/*.jsonl 这类自更新文件当成产物。
  if (scan && cwd && since) {
    for (const entry of scanTouched(cwd, since)) push(entry.path, "目录扫描发现", null);
  }

  return [...seen.values()];
}
