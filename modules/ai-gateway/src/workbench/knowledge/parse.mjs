/**
 * 产品中枢知识库 · 本地解析器（零依赖）。
 *
 * 全部解析在本地完成（规格书 7.3）：不发送任何字节上云。
 * - Office 文件（pptx/docx/xlsx）本质是 zip+xml：用自写 zip 读取器（zlib.inflateRaw）
 *   + 轻量 XML 文本提取，不引入第三方依赖，和网关的零依赖风格保持一致。
 * - PDF 做尽力而为的文本提取（FlateDecode 流 + Tj/TJ 字面量）；扫描件无文本层时
 *   标记 parse_status = "need-ocr"，留待 OCR 适配器（P1）接手。
 * - 图片：默认只登记元数据并标记 need-ocr，不做本地 OCR（无显卡机器上引擎选型
 *   按规格书 22 节留给试运行后确定）。
 * 每个解析结果都是片段数组，locator 保留「页码/章节/单元格」这类可读定位。
 */

import { inflateRawSync, inflateSync } from "node:zlib";
import { extname } from "node:path";

// ---------------------------------------------------------------- zip 读取

/** 解析 zip central directory，返回 { name → Buffer }。支持 store 与 deflate。 */
export function readZip(buffer) {
  const entries = new Map();
  // End of central directory：从尾部向前找签名 0x06054b50
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（pptx/docx/xlsx 应为 OOXML 包）");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // 少数导出器（WPS/第三方工具）在 zip 里写反斜杠路径，统一成正斜杠
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    // local file header 的尺寸字段要重读一遍（central 里 data descriptor 场景不可靠）
    const lfhNameLen = buffer.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      try { entries.set(name, inflateSync(raw)); } catch { /* 个别条目解不开就跳过 */ }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------- XML 文本提取

/** 提取 XML 里指定标签的文本内容，按出现顺序返回。标签用宽松匹配，避免拖解析器。 */
function extractTags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    out.push(m[1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, "&"));
  }
  return out;
}

const clean = (s) => s.replace(/\s+/g, " ").trim();
const stripXml = (s) => clean(s.replace(/<[^>]+>/g, ""));

// ---------------------------------------------------------------- PPTX

export function parsePptx(buffer, { ocr } = {}) {
  const zip = readZip(buffer);
  const slideNames = [...zip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const noteNames = new Map([...zip.keys()].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .map((n) => [Number(n.match(/\d+/)[0]), n]));
  const fragments = [];
  const outline = [];
  slideNames.forEach((name, index) => {
    const xml = zip.get(name).toString("utf8");
    const page = index + 1;
    // 每个 <a:p> 是一段；同一段内的 <a:t> 拼接（防止一行被拆散）
    const paras = xml.split(/<a:p[ >]/).slice(1);
    const lines = [];
    for (const para of paras) {
      const text = clean(extractTags(para, "a:t").join(""));
      if (text) lines.push(text);
    }
    if (lines.length) outline.push(`第${page}页：${lines[0]}`);
    const notesXml = noteNames.get(page) ? zip.get(noteNames.get(page))?.toString("utf8") : "";
    const notes = notesXml ? clean(extractTags(notesXml, "a:t").join(" ")) : "";
    if (lines.length || notes) {
      fragments.push({
        locator: `第 ${page} 页`,
        text: [...lines.map((l) => l), notes ? `备注：${notes}` : ""].filter(Boolean).join("\n"),
        page,
      });
    }
  });
  const title = slideNames.length ? (stripXml(extractTags(zip.get(slideNames[0]).toString("utf8"), "a:t")[0] ?? "") || "未命名演示") : "未命名演示";
  // 纯图版 PPT（效果图、设计稿导出）：没有文字层，页面需要 OCR 才能提取，不能当空文件丢掉
  const hasMedia = [...zip.keys()].some((n) => /^ppt\/media\/.+\.(png|jpe?g|gif|bmp|emf|wmf)$/i.test(n));
  if (!fragments.length) {
    // OCR 引擎可用时，逐页找出页面引用的图片（slideN.xml.rels → media），识别文字补成片段
    if (hasMedia && typeof ocr === "function" && slideNames.length) {
      const ocrFragments = ocrSlideImages(zip, slideNames, ocr);
      if (ocrFragments.fragments.length) {
        return {
          title,
          fragments: ocrFragments.fragments,
          outline: ocrFragments.fragments.map((f) => `第${f.page}页（图片识别）：${(f.text.split("\n")[0] ?? "").slice(0, 40)}`),
          quality: ocrFragments.quality,
          note: `纯图版 PPT 已用本地 OCR 识别（${ocrFragments.pages} 页）`,
          pages: slideNames.length,
        };
      }
      return {
        title, fragments: [], outline: [], quality: "need-ocr", pages: slideNames.length,
        note: `共 ${slideNames.length} 页图片页，OCR 引擎没有识别出有效文字（可能为装饰图或语言包缺失）`,
      };
    }
    return {
      title,
      fragments: [],
      outline: [],
      quality: hasMedia ? "need-ocr" : "empty",
      note: hasMedia
        ? `共 ${slideNames.length} 页，页面由图片构成（无文字层），需要本地 OCR 引擎才能提取文字`
        : "未提取到文字内容",
      pages: slideNames.length,
    };
  }
  return { title, fragments, outline, quality: "full", pages: slideNames.length };
}

// ---------------------------------------------------------------- DOCX

export function parseDocx(buffer) {
  const zip = readZip(buffer);
  const xml = zip.get("word/document.xml")?.toString("utf8") ?? "";
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const paragraphs = body.split(/<w:p[ >]/).slice(1);
  const fragments = [];
  let currentHeading = "正文";
  let buf = [];
  const flush = () => {
    if (buf.length) {
      fragments.push({ locator: currentHeading, text: buf.join("\n") });
      buf = [];
    }
  };
  for (const para of paragraphs) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(para)?.[1] ?? "";
    const text = clean(extractTags(para, "w:t").join(""));
    if (!text) continue;
    const headingMatch = /^Heading(\d)/i.exec(style) || /^(\d)$/i.exec(style);
    if (headingMatch) {
      flush();
      currentHeading = `${style.startsWith("Heading") ? "章节" : "标题"}：${text}`;
      fragments.push({ locator: "标题", text: `${text}`, heading: Number(headingMatch[1]) });
    } else {
      buf.push(text);
      if (buf.join("\n").length > 1200) flush();
    }
  }
  flush();
  const title = clean(extractTags(zip.get("docProps/core.xml")?.toString("utf8") ?? "", "dc:title")[0] ?? "") || fragments[0]?.text?.slice(0, 40) || "未命名文档";
  return { title, fragments, outline: fragments.filter((f) => f.heading).map((f) => f.text), quality: fragments.length ? "full" : "empty" };
}

// ---------------------------------------------------------------- XLSX

export function parseXlsx(buffer) {
  const zip = readZip(buffer);
  const shared = zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const strings = shared.split(/<si[ >]/).slice(1).map((s) => clean(extractTags(s, "t").join("")));
  const sheetNames = [...zip.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const fragments = [];
  sheetNames.forEach((name, i) => {
    const xml = zip.get(name).toString("utf8");
    const rows = xml.split(/<row[ >]/).slice(1).map((row) => {
      const cells = [];
      const re = /<c\b[^>]*?(?:t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g;
      let m;
      while ((m = re.exec(row))) {
        const [, type, inner] = m;
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        if (type === "s") cells.push(strings[Number(v)] ?? "");
        else if (type === "inlineStr") cells.push(stripXml(inner));
        else cells.push(v);
      }
      return cells.filter(Boolean).join(" | ");
    }).filter(Boolean);
    if (rows.length) {
      fragments.push({ locator: `工作表 ${i + 1}`, text: rows.slice(0, 400).join("\n") });
    }
  });
  return { title: "表格数据", fragments, outline: fragments.map((f) => f.locator), quality: fragments.length ? "full" : "empty" };
}

// ---------------------------------------------------------------- PDF（尽力而为的文本层提取）

function decodePdfStreams(buffer) {
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(buffer))) {
    const start = m.index + m[0].length;
    const end = buffer.indexOf("endstream", start);
    if (end < 0) break;
    const slice = buffer.subarray(start, end);
    try {
      chunks.push(inflateSync(slice));
    } catch {
      try { chunks.push(inflateRawSync(slice)); } catch { /* 非压缩流（图片等）跳过 */ }
    }
    re.lastIndex = end;
  }
  return chunks;
}

function pdfTextFromStream(content) {
  const text = content.toString("latin1");
  const out = [];
  // Tj 与 TJ 里的 () 字符串与 <hex> 字符串
  const re = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>/g;
  let m;
  let line = "";
  const push = (s) => { line += s; };
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      push(m[1].replace(/\\([nrt()\\])/g, (_, c) => ({ n: "\n", r: "\n", t: "\t" }[c] ?? c)));
    } else if (m[2] !== undefined) {
      const hex = m[2].replace(/\s+/g, "");
      let s = "";
      // UTF-16BE 常见于中文 PDF
      if (hex.length % 4 === 0) {
        for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      } else {
        for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      push(s);
    }
    // 换行操作符当作段落断点
    if (/T\*|Td|TD|ET\s/.test(text.slice(re.lastIndex, re.lastIndex + 6))) {
      if (line.trim()) out.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.filter((l) => /[\u4e00-\u9fff]|[A-Za-z0-9]/.test(l) && l.length > 1);
}

export function parsePdf(buffer) {
  const chunks = decodePdfStreams(buffer);
  const fragments = [];
  chunks.forEach((content, i) => {
    const lines = pdfTextFromStream(content);
    if (lines.length > 3) {
      fragments.push({ locator: `内容块 ${i + 1}`, text: lines.join("\n").slice(0, 6000) });
    }
  });
  const hasText = fragments.length > 0;
  return {
    title: "PDF 文档",
    fragments,
    outline: [],
    quality: hasText ? "partial" : "need-ocr",
    note: hasText ? "PDF 文本层提取为尽力解析，复杂排版可能缺失；建议抽检关键页" : "未发现文本层（扫描件），需要 OCR",
  };
}

// ---------------------------------------------------------------- 文本 / Markdown / HTML

const HTML_ENTITY = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®",
};

const decodeEntities = (s) => String(s ?? "").replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
  if (code[0] === "#") {
    const n = /^#[xX]/.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  const key = code.toLowerCase();
  return Object.prototype.hasOwnProperty.call(HTML_ENTITY, key) ? HTML_ENTITY[key] : m;
});

/**
 * 按 BOM / <meta charset> 解码，避免 GBK 导出的 HTML 变乱码。
 * 先看前 2KB 里的 charset 声明；没有声明时先按 UTF-8 解，出现大量替换字符再试 GB18030。
 */
export function decodeTextBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  const head = buf.subarray(0, 2048).toString("latin1");
  const charset = (/charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ?? "").toLowerCase();
  if (charset && !/^utf-?8$/.test(charset)) {
    try { return new TextDecoder(charset).decode(buf); } catch { /* 引擎不认这个编码就走下面的兜底 */ }
  }
  const utf8 = buf.toString("utf8");
  if ((utf8.match(/\uFFFD/g) ?? []).length > 8) {
    try { return new TextDecoder("gb18030").decode(buf); } catch { /* 保持 utf8 结果 */ }
  }
  return utf8;
}

/** 剥掉 BOM 与 YAML frontmatter：Obsidian 页面导出的 md 不能把 `id: xxx` 当正文。 */
export function splitFrontmatter(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { text, meta: {} };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { text: text.slice(m[0].length), meta };
}

export function parseText(utf8Text, name = "") {
  const { text, meta } = splitFrontmatter(utf8Text);
  const isMd = /\.(md|markdown)$/i.test(name);
  const fragments = [];
  const blocks = text.split(/\n{2,}/);
  let heading = "正文";
  let buf = [];
  const flush = () => {
    if (buf.length) { fragments.push({ locator: heading, text: buf.join("\n\n") }); buf = []; }
  };
  for (const block of blocks) {
    const h = isMd ? /^#{1,6}\s+(.*)$/.exec(block.trim()) : null;
    if (h) { flush(); heading = h[1].trim(); continue; }
    const t = block.trim();
    if (!t) continue;
    buf.push(t);
    if (buf.join("\n").length > 1500) flush();
  }
  flush();
  // 标题优先级：frontmatter.title > 一级标题 > 文件名
  const title = (isMd && meta.title) || (isMd ? /^#\s+(.*)$/m.exec(text)?.[1] : null) || name.replace(/\.\w+$/, "") || "文本片段";
  return { title, fragments, outline: fragments.map((f) => f.locator), quality: fragments.length ? "full" : "empty" };
}

/** 页面骨架 / 导航 / 脚本样式一律不进正文，否则摘要会被菜单项污染。 */
const HTML_DROP = /<(script|style|noscript|template|title|svg|iframe|canvas|nav|header|footer|aside|form|button|select|option)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * HTML 解析：按 h1~h6 切章节（locator 用标题，摘要摘取就能认「系统概述」这类章节），
 * 段落 / 列表 / 表格行压成正文行；标题 > 正文的结构与 PPT/Word 保持一致。
 */
export function parseHtml(html, name = "") {
  const raw = String(html ?? "").replace(/^\uFEFF/, "");
  const pageTitle = clean(decodeEntities(stripXml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "")));
  const firstH1 = clean(decodeEntities(stripXml(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(raw)?.[1] ?? "")));

  let body = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(HTML_DROP, "")
    // 标题先打标记，剩下按块级标签断行，最后统一去标签
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, level, inner) => `\n\n@@H${level}@@ ${clean(decodeEntities(stripXml(inner)))}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|blockquote|pre|dd|dt|figcaption|h[1-6]|table|ul|ol)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  body = decodeEntities(body).replace(/\r/g, "");

  const sections = [];
  let cur = { title: "", lines: [] };
  const push = (title) => {
    if (cur.title || cur.lines.length) sections.push(cur);
    cur = { title, lines: [] };
  };
  for (const rawLine of body.split("\n")) {
    const mark = /^@@H([1-6])@@\s*(.*)$/.exec(rawLine.trim());
    if (mark) { push(mark[2].trim()); continue; }
    const line = clean(rawLine.replace(/^\s*[|｜]\s*/, "").replace(/\s*[|｜]\s*$/, ""));
    if (!line || line === "|") continue;
    cur.lines.push(line);
  }
  push("");

  const fragments = [];
  for (const section of sections) {
    if (!section.lines.length && !section.title) continue;
    const text = section.lines.join("\n");
    if (!text) continue;
    // 单章节过长按 4000 字切开，保持 locator 可读
    for (let i = 0; i < text.length; i += 4000) {
      fragments.push({
        locator: section.title || "正文",
        text: text.slice(i, i + 4000),
      });
    }
  }
  const title = pageTitle || firstH1 || name.replace(/\.\w+$/, "") || "网页";
  return {
    title,
    fragments,
    outline: fragments.map((f) => f.locator),
    quality: fragments.length ? "full" : "empty",
    note: fragments.length ? "" : "HTML 里没有提取到正文（可能是纯脚本渲染的页面）",
  };
}

// ---------------------------------------------------------------- XMind（zip + content.json）

export function parseXmind(buffer) {
  const zip = readZip(buffer);
  const raw = zip.get("content.json")?.toString("utf8") ?? zip.get("content.txt")?.toString("utf8") ?? "";
  const fragments = [];
  let title = "思维导图";
  try {
    const sheets = JSON.parse(raw);
    const walk = (node, path, out) => {
      if (!node) return;
      const label = clean(node.title ?? "");
      const nextPath = [...path, label].filter(Boolean);
      if (label) out.push({ path: nextPath.join(" / "), text: `${nextPath.join(" / ")}${node.notes?.plain?.content ? `\n备注：${clean(node.notes.plain.content)}` : ""}` });
      for (const child of node.children?.attached ?? []) walk(child, nextPath, out);
    };
    for (const sheet of sheets) {
      const out = [];
      walk(sheet.rootTopic, [], out);
      if (out.length) fragments.push({ locator: `画布：${sheet.title ?? "未命名"}`, text: out.map((o) => o.text).join("\n") });
    }
    title = clean(sheets?.[0]?.rootTopic?.title ?? "") || "思维导图";
  } catch {
    // content.txt 老格式：按缩进行直接收
    if (raw) fragments.push({ locator: "大纲", text: raw });
  }
  return { title, fragments, outline: fragments.map((f) => f.locator), quality: fragments.length ? "full" : "empty" };
}

// ---------------------------------------------------------------- OCR 接入

/** tesseract 能读的位图格式（emf/wmf 矢量图不行，直接跳过）。 */
const OCRABLE_MEDIA = /\.(png|jpe?g|bmp|webp|gif)$/i;

/**
 * 纯图版 PPT 的逐页 OCR：从每页的 rels 里找引用的位图，交给注入的 ocr(buffer, ext) 识别。
 * 单页识别失败只跳过该页，不拖垮整个文件；单页图片取最大的一张（背景/拼版优先主体）。
 */
function ocrSlideImages(zip, slideNames, ocr) {
  const fragments = [];
  let ocrPages = 0;
  for (const slideName of slideNames) {
    const page = Number(slideName.match(/\d+/)[0]);
    const relsName = `ppt/slides/_rels/slide${page}.xml.rels`;
    const rels = zip.get(relsName)?.toString("utf8") ?? "";
    const targets = [...rels.matchAll(/Target="[^"]*?media\/([^"]+)"/g)]
      .map((m) => `ppt/media/${m[1]}`)
      .filter((n) => OCRABLE_MEDIA.test(n) && zip.has(n));
    if (!targets.length) continue;
    // 一页多图时按体积取最大的（一般是正文图，装饰小图会稀释识别质量）
    const best = targets.map((n) => zip.get(n)).sort((a, b) => b.length - a.length)[0];
    try {
      const result = ocr(best, extname(targets[0]));
      if (result?.text) {
        fragments.push({ locator: `第 ${page} 页（图片识别）`, text: result.text, page });
        ocrPages++;
      }
    } catch { /* 单页失败不阻断 */ }
  }
  if (!fragments.length) return { fragments: [], pages: 0, quality: "need-ocr" };
  const totalChars = fragments.reduce((sum, f) => sum + f.text.length, 0);
  return { fragments, pages: ocrPages, quality: totalChars / Math.max(fragments.length, 1) >= 30 ? "full" : "partial" };
}

// ---------------------------------------------------------------- 入口

export function detectKind(ext) {
  const e = ext.toLowerCase();
  if ([".pptx", ".ppt"].includes(e)) return "ppt";
  if ([".docx", ".doc"].includes(e)) return "doc";
  if ([".xlsx", ".xls"].includes(e)) return "sheet";
  if (e === ".pdf") return "pdf";
  if ([".xmind"].includes(e)) return "xmind";
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"].includes(e)) return "image";
  if ([".html", ".htm", ".xhtml", ".shtml"].includes(e)) return "html";
  if ([".md", ".markdown", ".mdown"].includes(e)) return "md";
  if ([".txt", ".csv", ".log"].includes(e)) return "text";
  return "binary";
}

/**
 * 统一解析入口。返回 { title, fragments, quality, note? }；
 * options.ocr：可选的 (buffer, ext) => { text, lang, quality }（本地 Tesseract 适配器注入）。
 * 不支持的类型（视频/音频按规格书首期不做）抛出带原因的错误。
 */
export function parseFile(buffer, name, { ocr } = {}) {
  const ext = extname(name || "");
  const kind = detectKind(ext);
  switch (kind) {
    case "ppt": return parsePptx(buffer, { ocr });
    case "doc": return parseDocx(buffer);
    case "sheet": return parseXlsx(buffer);
    case "pdf": return parsePdf(buffer);
    case "xmind": return parseXmind(buffer);
    case "md":
    case "text": return parseText(decodeTextBuffer(buffer), name);
    case "html": return parseHtml(decodeTextBuffer(buffer), name);
    case "image": {
      if (typeof ocr === "function") {
        try {
          const result = ocr(buffer, ext);
          if (result?.text) {
            return { title: name, fragments: [{ locator: "图片识别", text: result.text }], outline: [], quality: result.quality, note: `OCR（${result.lang}）识别完成` };
          }
          return { title: name, fragments: [], outline: [], quality: "need-ocr", note: "OCR 没有识别出有效文字（可能为装饰图或截图对比度不足）" };
        } catch (error) {
          return { title: name, fragments: [], outline: [], quality: "need-ocr", note: String(error.message || error) };
        }
      }
      return { title: name, fragments: [], outline: [], quality: "need-ocr", note: "图片已登记；安装 Tesseract OCR 后重新导入可识别文字" };
    }
    default:
      throw new Error(`暂不支持解析该类型（${ext || "未知格式"}）。支持 PPT/PDF/Word/Excel/XMind/Markdown/HTML/图片/文本。`);
  }
}

// ---------------------------------------------------------------- 去重建议（规格书 7.4）

/** 内容指纹：取词频 Top8 拼 Jaccard，识别高度相似；哈希相同即完全重复。 */
export function fingerprint(text) {
  const grams = new Set();
  const s = text.replace(/\s+/g, "");
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

export function similarity(a, b) {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (!fa.size || !fb.size) return 0;
  let inter = 0;
  for (const g of fa) if (fb.has(g)) inter++;
  return inter / (fa.size + fb.size - inter);
}

/**
 * 三种检查合并成一个建议：完全重复 / 高度相似 / 疑似新版本。
 * 返回 { action, reason, similarTo }，action ∈ skip|merge|new-version|import。
 */
export function dedupeSuggestion({ hash, text, name }, { existingByHash, candidates = [] }) {
  if (existingByHash?.has(hash)) {
    return { action: "skip", reason: "内容哈希完全一致，是同一份文件", similarTo: existingByHash.get(hash) };
  }
  let best = null;
  for (const c of candidates) {
    const score = similarity(text.slice(0, 4000), c.text.slice(0, 4000));
    if (!best || score > best.score) best = { score, ...c };
  }
  if (best && best.score > 0.75) {
    return { action: "merge", reason: `与「${best.name}」内容高度相似（${Math.round(best.score * 100)}%）`, similarTo: best.id, score: best.score };
  }
  if (best && best.score > 0.45) {
    return { action: "new-version", reason: `与「${best.name}」约 ${Math.round(best.score * 100)}% 相似，可能是新版本`, similarTo: best.id, score: best.score };
  }
  return { action: "import", reason: "未发现重复", similarTo: null };
}
