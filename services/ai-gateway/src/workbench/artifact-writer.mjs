/**
 * Turns a step's free-form answer into real files on disk.
 *
 * Two sources, same authority order as artifacts.mjs:
 *   1. fenced code blocks tagged with a path   -> content authority
 *   2. the "产出文件" list at the end of the answer -> description authority
 *
 * Fenced blocks carry the bytes, the list carries the notes. A path that only
 * appears in the list is registered but not written: the producing agent may have
 * written it itself (Codex does), and silently creating an empty file there would
 * destroy real work.
 *
 * Every path is forced inside the step directory. A model that emits
 * `file:../../src/index.js` gets a warning, never a write.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_STEP_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 50;

const EXT_BY_OUTPUT_TYPE = {
  markdown: "md",
  document: "md",
  json: "json",
  text: "txt",
  code: "txt",
};

const EXT_BY_LANG = {
  javascript: "js", js: "js", jsx: "jsx", mjs: "mjs", cjs: "cjs",
  typescript: "ts", ts: "ts", tsx: "tsx",
  python: "py", py: "py",
  java: "java", kotlin: "kt", kt: "kt", swift: "swift",
  c: "c", h: "h", cpp: "cpp", "c++": "cpp", cs: "cs", csharp: "cs",
  go: "go", golang: "go", rust: "rs", rs: "rs",
  php: "php", ruby: "rb", rb: "rb", perl: "pl",
  shell: "sh", sh: "sh", bash: "sh", zsh: "sh", powershell: "ps1", ps1: "ps1",
  sql: "sql", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yml", yml: "yml", toml: "toml", xml: "xml", ini: "ini",
  markdown: "md", md: "md", text: "txt", txt: "txt", csv: "csv",
};

/**
 * How a file should be presented to a human. The step detail renders by kind,
 * not by guessing from the path on the client: one authority, one answer.
 */
const KIND_BY_EXT = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  bmp: "image", svg: "image", ico: "image", avif: "image",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  csv: "table", tsv: "table", xlsx: "table", xls: "table",
  txt: "text", log: "text", json: "text", yml: "text", yaml: "text",
  toml: "text", ini: "text", xml: "text", html: "text", css: "text",
  js: "text", mjs: "text", cjs: "text", ts: "text", tsx: "text", jsx: "text",
  py: "text", java: "text", go: "text", rs: "text", sh: "text", ps1: "text",
  sql: "text", c: "text", h: "text", cpp: "text", cs: "text", php: "text",
};

const TEXT_KINDS = new Set(["markdown", "text", "table"]);

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  md: "text/markdown", csv: "text/csv", json: "application/json",
  pdf: "application/pdf",
};

/** Classify a path. Unknown extensions stay `binary` — guessing is worse than "can't preview". */
export function classifyArtifact(path) {
  const ext = extname(String(path ?? "")).replace(/^\./, "").toLowerCase();
  const kind = KIND_BY_EXT[ext] ?? "binary";
  return { kind, isText: TEXT_KINDS.has(kind), ext, mime: MIME_BY_EXT[ext] ?? "" };
}

/**
 * Fill in kind/mime/bytes for anything that only knows its path.
 * `bytes` is read from disk when the file is reachable, otherwise left as given.
 */
export function describeArtifact(file, { absolute = file?.absolute } = {}) {
  const { kind, ext, mime } = classifyArtifact(file?.path ?? absolute ?? "");
  let bytes = Number.isFinite(file?.bytes) ? file.bytes : NaN;
  if (!Number.isFinite(bytes) && absolute) {
    const stat = safeStat(absolute);
    if (stat) bytes = stat.size;
  }
  return { kind, ext, mime, bytes: Number.isFinite(bytes) ? bytes : 0 };
}

/** `file:src/a.js` / `file=src/a.js` / `path=...` inside the fence info string. */
const INFO_PATH = /\b(?:file|path)\s*[:=]\s*["'`]?([^\s"'`]+)/i;

/** `// file: src/a.js` as the first line of a block. */
const LEADING_PATH = /^\s*(?:\/\/|#|--|\/\*|<!--)\s*(?:file|path)\s*[:=]\s*([^\s>]+?)\s*(?:\*\/|-->)?\s*$/i;

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Split a Markdown answer into fenced blocks.
 * A fence without a matching closer runs to the end of the text on purpose: a
 * truncated answer should still yield a file rather than nothing.
 */
export function parseFileBlocks(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const open = lines[index].match(FENCE_OPEN);
    if (!open) {
      index += 1;
      continue;
    }
    const marker = open[2][0];
    const width = open[2].length;
    const info = open[3].trim();
    const closerSource = marker === "`" ? "`" : "~";
    const closer = new RegExp(`^\\s*${closerSource}{${width},}\\s*$`);
    const body = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      if (closer.test(lines[cursor])) {
        closed = true;
        break;
      }
      body.push(lines[cursor]);
      cursor += 1;
    }

    let path = null;
    const infoMatch = info.match(INFO_PATH);
    if (infoMatch) path = infoMatch[1];
    if (!path && body.length) {
      const lead = body[0].match(LEADING_PATH);
      if (lead) {
        path = lead[1];
        body.shift();
      }
    }
    blocks.push({ info, path, body, closed });
    index = closed ? cursor + 1 : lines.length;
  }
  return blocks;
}

const stripQuotes = (value) => String(value ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");

/**
 * Force a model-supplied path inside `stepDir`.
 * @returns {{relative:string, absolute:string}|null} null means rejected
 */
export function confinePath(rawPath, stepDir) {
  const raw = stripQuotes(rawPath);
  if (!raw) return null;
  // Absolute paths and drive letters are rejected outright: every artifact lives
  // under the step directory, and a model has no reason to say otherwise.
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) return null;

  const unified = raw.replace(/\\/g, "/");
  const segments = unified.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.length > 12) return null;
  if (segments.some((segment) => segment === "..")) return null;
  if (segments.some((segment) => /[<>|?*\u0000-\u001f]/.test(segment))) return null;

  const base = resolve(stepDir);
  const absolute = resolve(base, ...segments);
  const guard = base.endsWith(sep) ? base : `${base}${sep}`;
  if (!absolute.startsWith(guard)) return null;
  return { relative: segments.join("/"), absolute };
}

const safeStat = (path) => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

const countLines = (content) => {
  if (!content) return 0;
  return content.split("\n").length;
};

/**
 * Write a step's artifacts.
 *
 * @param {{text:string, stepDir:string, runDir:string, outputType?:string,
 *          declared?:Array<{path:string,type?:string,note?:string}>,
 *          reset?:boolean}} input
 * @returns {{files:Array, warnings:string[], written:number, bytes:number}}
 */
export function writeStepArtifacts({
  text,
  stepDir,
  runDir,
  outputType = "markdown",
  declared = [],
  reset = true,
  skipPaths = [],
  fallback = true,
}) {
  const warnings = [];
  const base = resolve(stepDir);
  if (runDir) {
    const root = resolve(runDir);
    const guard = root.endsWith(sep) ? root : `${root}${sep}`;
    if (base === root || !base.startsWith(guard)) {
      return { files: [], warnings: ["步骤目录不在运行目录内，已跳过落盘"], written: 0, bytes: 0 };
    }
  }

  // Retry must not leave half of the previous attempt behind. Only this step's
  // own directory is touched, never the wider run directory.
  if (reset && existsSync(base)) {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`清理旧产出失败：${error?.message || error}`);
    }
  }
  mkdirSync(base, { recursive: true });

  const notes = new Map();
  for (const item of declared ?? []) {
    const confined = confinePath(item?.path, base);
    if (!confined) {
      if (item?.path) warnings.push(`忽略越界或非法路径：${stripQuotes(item.path)}`);
      continue;
    }
    notes.set(confined.relative, String(item.note ?? ""));
  }

  const blocks = parseFileBlocks(text);
  const written = [];
  const skip = new Set((skipPaths ?? []).map((item) => String(item).replace(/\\/g, "/")));
  let totalBytes = 0;

  for (const block of blocks) {
    if (!block.path) continue;
    const confined = confinePath(block.path, base);
    if (!confined) {
      warnings.push(`忽略越界或非法路径：${stripQuotes(block.path)}`);
      continue;
    }
    // 这个文件模型已经用工具真的写过了，不再往步骤目录里存一份影子副本。
    if (skip.has(confined.relative)) continue;
    if (written.some((item) => item.relative === confined.relative)) continue;
    if (written.length >= MAX_FILES) {
      warnings.push(`单步产出超过 ${MAX_FILES} 个文件，其余已跳过`);
      break;
    }
    const content = `${block.body.join("\n")}\n`;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      warnings.push(`${confined.relative} 超过单文件上限（${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB），已跳过`);
      continue;
    }
    if (totalBytes + bytes > MAX_STEP_BYTES) {
      warnings.push(`单步产出超过 ${MAX_STEP_BYTES / 1024 / 1024}MB，其余已跳过`);
      break;
    }
    if (!block.closed) warnings.push(`${confined.relative} 的代码块没有闭合，已按现有内容落盘`);

    try {
      const target = confined.absolute;
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, content, "utf8");
      renameSync(temp, target);
    } catch (error) {
      warnings.push(`写入 ${confined.relative} 失败：${error?.message || error}`);
      continue;
    }
    totalBytes += bytes;
    written.push({
      relative: confined.relative,
      absolute: confined.absolute,
      bytes,
      lines: countLines(content),
      note: notes.get(confined.relative) ?? "",
      source: "fence",
    });
  }

  // No path anywhere: keep the whole answer as one file so nothing is lost.
  if (!written.length && fallback) {
    const fence = blocks.find((block) => !block.path && block.closed);
    const lang = fence ? (fence.info.split(/\s+/)[0] || "").toLowerCase() : "";
    const ext = EXT_BY_LANG[lang] || EXT_BY_OUTPUT_TYPE[outputType] || "md";
    const content = `${String(text ?? "").trim()}\n`;
    if (content.trim()) {
      const target = resolve(base, `output.${ext}`);
      try {
        writeFileSync(target, content, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        totalBytes += bytes;
        written.push({
          relative: `output.${ext}`,
          absolute: target,
          bytes,
          lines: countLines(content),
          note: "未标注路径，整段回答存为单文件",
          source: "fallback",
        });
      } catch (error) {
        warnings.push(`写入兜底文件失败：${error?.message || error}`);
      }
    }
  }

  // Paths declared in the list but absent from disk are still registered: they
  // may have been produced by an agent that writes files itself.
  for (const [relative, note] of notes) {
    if (written.some((item) => item.relative === relative)) continue;
    const confined = confinePath(relative, base);
    if (!confined) continue;
    const stat = safeStat(confined.absolute);
    written.push({
      relative,
      absolute: confined.absolute,
      bytes: stat?.size ?? null,
      lines: null,
      note,
      source: stat ? "declared" : "missing",
    });
  }

  return {
    files: written.map((file) => ({ ...file, ...describeArtifact(file) })),
    warnings,
    written: written.filter((item) => item.source !== "missing").length,
    bytes: totalBytes,
  };
}

/** Keep a human-readable index at the root of the run directory. */
export function writeRunManifest(runDir, manifest) {
  mkdirSync(runDir, { recursive: true });
  // 运行目录落在用户项目里，自带 .gitignore 才不会污染 git status。
  const ignore = join(runDir, ".gitignore");
  if (!existsSync(ignore)) {
    try { writeFileSync(ignore, "*\n", "utf8"); } catch { /* 只影响整洁度 */ }
  }
  const target = join(runDir, "manifest.json");
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temp, target);
}

/** Read one artifact back for preview, with the same path guard. */export function readArtifact(filePath, runDir, maxBytes = 512 * 1024) {
  const confined = confinePath(filePath, runDir);
  if (!confined) throw new Error("路径越界，已拒绝读取");
  const stat = safeStat(confined.absolute);
  if (!stat) throw new Error("文件不存在");
  if (stat.size > maxBytes) {
    return { path: confined.relative, truncated: true, size: stat.size, content: "" };
  }
  const content = readFileSync(confined.absolute, "utf8");
  return {
    path: confined.relative,
    size: stat.size,
    truncated: false,
    ext: extname(confined.absolute).replace(".", "").toLowerCase(),
    content,
  };
}
