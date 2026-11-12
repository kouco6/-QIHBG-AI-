/**
 * 产品中枢知识库 · 摘要自动摘取（摘要层）。
 *
 * 目标（龙斌 2026-11-03 需求）：摘要不是「正文前 160 字」这种粗暴截断，
 * 而是按文档结构找「产品概述 / 系统概述 / 项目概述」这类总述章节，把它的正文提炼成 1 段摘要。
 *
 * 匹配顺序：
 * 1) 空间主序章节（企划：产品概述 / 系统概述 / 项目概述 …；调研：核心结论 / 摘要 …）；
 * 2) 次序章节（项目背景 / 建设目标 / 系统组成 …）；
 * 3) 兜底：首个非封面、非目录、非公司名的实质段落。
 * 找不到任何内容返回空摘要 + 空来源，由调用方决定是否提示人工补写。
 *
 * 输出同时带「摘取依据」(source)，用于详情页标注「自动摘取 · 产品概述 · 第 3 页」。
 */

const cleanLine = (s) => String(s ?? "")
  .replace(/[\u00a0\u3000]/g, " ")
  .replace(/^[\s•·・\-–—*>＞]+/, "")
  .replace(/\s+/g, " ")
  .trim();

/** 封面 / 页脚 / 目录这类行不参与摘要。 */
const BOILERPLATE = /^(目录|目\s*录|contents|agenda|汇报人|汇报日期|主讲人|演讲人|编制人?|审核人?|批准人?|拟制|日期|版本|版权|保密声明|声明|logo|谢谢|thank)/i;
const COMPANY_LINE = /(有限公司|股份有限公司|集团|研究院|科技有限公司)\s*$/;
const NUMERIC_LINE = /^[\d\s.,%+\-/年月日:：()（）]+$/;
const BULLET = /^[•·・\-–—*]\s*/;

/** 去掉「一、」「1.2」「第3章」这类编号，便于和章节关键词比对。 */
export function normalizeHeading(line) {
  return cleanLine(line)
    .replace(/^[（(【[]?\s*(\d+(\.\d+)*|[一二三四五六七八九十]{1,3})\s*[)）】\]、.．]\s*/, "")
    .replace(/^第\s*[一二三四五六七八九十\d]+\s*[章节部]\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

/** 短、无句末标点、不像列表项 → 当作小标题（PPT 页标题、Word 大纲都是这个特征）。 */
export function isHeadingLine(line) {
  const raw = cleanLine(line);
  if (!raw) return false;
  if (BULLET.test(raw)) return false;
  if (NUMERIC_LINE.test(raw)) return false;
  const heading = normalizeHeading(raw);
  if (heading.length < 2 || heading.length > 22) return false;
  if (/[。！？；，、…]$/.test(heading)) return false;
  if ((heading.match(/[，。；：、]/g) ?? []).length > 0) return false;
  return true;
}

/** 页码/单元格类定位不是章节标题（Markdown 的 `## 系统概述` 才是）。 */
const PAGE_LOCATOR = /^(第\s*\d+\s*页|内容块\s*\d+|工作表\s*\d+|画布：|图片识别|正文$|文本片段$)/;

/**
 * 片段数组 → 章节数组。
 * 识别三种标题：解析器给的 heading 标记（docx）、Markdown 的定位（`## 产品概述`）、
 * 正文里独立成行的小标题（PPT 页标题）。
 */
export function sectionsOf(fragments = []) {
  const sections = [];
  let cur = null;
  const open = (title, locator) => { cur = { title: title ?? "", locator: locator ?? "", lines: [] }; sections.push(cur); };
  for (const frag of fragments) {
    const locator = frag?.locator ?? "";
    let lines = String(frag?.text ?? "").split(/\r?\n/).map(cleanLine).filter(Boolean);
    // Markdown 的二级标题被解析成定位：它就是章节名
    if (locator && !PAGE_LOCATOR.test(locator)) {
      const head = normalizeHeading(locator);
      if (lines.length && normalizeHeading(lines[0]) === head) lines = lines.slice(1);
      open(head, locator);
    }
    for (const line of lines) {
      // docx 解析器会给标题片段打 heading 标记，直接用
      if (frag?.heading) { open(normalizeHeading(line), locator); continue; }
      if (isHeadingLine(line)) { open(normalizeHeading(line), locator); continue; }
      if (!cur) open("", locator);
      if (!cur.locator) cur.locator = locator;
      cur.lines.push(line);
    }
  }
  return sections.filter((s) => s.title || s.lines.length);
}

/** Markdown 正文（工作台已入库的 body）→ 片段 → 章节。`## 第 3 页` 当定位，不当标题。 */
export function sectionsOfMarkdown(body) {
  const fragments = [];
  let locator = "";
  let buf = [];
  const flush = () => {
    if (buf.length) fragments.push({ locator, text: buf.join("\n") });
    buf = [];
  };
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); locator = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();
  return sectionsOf(fragments);
}

/** 空间主序 / 次序章节关键词。顺序即优先级。 */
export const HEADING_RULES = {
  planning: {
    first: [
      "产品概述", "系统概述", "项目概述", "方案概述", "产品简介", "系统简介", "项目简介", "方案简介",
      "产品定义", "产品定位", "总体概述", "方案总述", "概述", "简介",
    ],
    second: ["项目背景", "需求背景", "建设目标", "项目目标", "设计目标", "系统组成", "总体设计", "功能架构", "应用场景"],
  },
  research: {
    first: ["核心结论", "研究结论", "主要结论", "结论与建议", "核心发现", "关键发现", "执行摘要", "摘要", "结论", "总结"],
    second: ["研究背景", "市场概况", "行业现状", "趋势判断", "竞争格局"],
  },
  product: {
    first: ["产品定位", "产品定义", "产品概述", "功能概述", "产品简介", "产品说明"],
    second: ["应用场景", "核心功能", "技术参数", "差异化优势"],
  },
  idea: {
    first: ["灵感描述", "核心想法", "核心价值", "一句话说明"],
    second: ["背景", "机会点", "应用设想"],
  },
};

/** 命中返回优先级序号（越小越优先），未命中 -1。 */
function matchHeading(heading, list) {
  if (!heading) return -1;
  const h = heading.replace(/\s+/g, "");
  for (let i = 0; i < list.length; i++) {
    const kw = list[i];
    if (h === kw) return i;
    // 「XX系统产品概述」这种带前缀的长标题也算命中，限制长度避免误吃正文
    if (h.includes(kw) && h.length <= kw.length + 6) return i;
  }
  return -1;
}

function pickSection(sections, list) {
  let best = null;
  sections.forEach((section, index) => {
    const rank = matchHeading(section.title, list);
    if (rank < 0) return;
    if (!section.lines.some((l) => cleanLine(l).length >= 6)) return; // 只有标题没正文，跳过
    if (!best || rank < best.rank) best = { section, rank, index };
  });
  return best?.section ?? null;
}

function isBoilerplate(line) {
  const t = cleanLine(line);
  if (!t) return true;
  if (BOILERPLATE.test(t)) return true;
  if (NUMERIC_LINE.test(t)) return true;
  if (COMPANY_LINE.test(t) && t.length <= 30) return true;
  return false;
}

/** 章节正文 → 一段话：按句合并，过滤页脚/目录/超短行。 */
function compose(section, maxLength) {
  const parts = [];
  for (const raw of section.lines) {
    const line = cleanLine(raw);
    if (isBoilerplate(line)) continue;
    if (line.length < 6) continue;
    // 表格行（单元格用 | 分隔）压成一句，避免摘要里出现一堆竖线
    const text = line.replace(/\s*\|\s*/g, "，").replace(/，{2,}/g, "，")
      .replace(/[，、,；;：:\s]+$/, "")
      .trim();
    if (!text) continue;
    parts.push(/[。！？.!?]$/.test(text) ? text : `${text}。`);
    if (parts.join("").length >= maxLength * 1.4) break;
  }
  return truncate(parts.join(""), maxLength);
}

function truncate(text, maxLength) {
  const t = String(text ?? "").trim();
  if (t.length <= maxLength) return t;
  const cut = t.slice(0, maxLength);
  let lastStop = -1;
  for (const p of ["。", "！", "？", "；"]) lastStop = Math.max(lastStop, cut.lastIndexOf(p));
  if (lastStop >= maxLength * 0.5) return cut.slice(0, lastStop + 1);
  return `${cut.slice(0, maxLength - 1).replace(/[，、,;；\s]+$/, "")}…`;
}

/** 模板 / 原则 / 索引类章节，不是知识内容，不参与兜底摘取。 */
const TEMPLATE_HEADING = /(工作原则|分析结构|填写说明|使用说明|字段说明|模板|目录|导航|索引|说明)$/;
/** 像「正文」的段落至少要有这些语义动词之一，避免把清单项当摘要。 */
const PROSE_HINT = /(是|为|由|采用|支持|提供|实现|面向|通过|用于|包括|包含|负责|具备|解决|覆盖|提升|降低|完成)/;

/**
 * 兜底：文档里第一段像正文的话。
 * 宁可为空也不摘模板清单——空摘要会提示人工补，垃圾摘要会污染摘要索引。
 */
function firstSubstantive(sections, maxLength) {
  for (const section of sections) {
    if (TEMPLATE_HEADING.test(String(section.title ?? "").trim())) continue;
    const lines = section.lines
      .map(cleanLine)
      .filter((l) => !isBoilerplate(l) && l.length >= 40 && PROSE_HINT.test(l));
    if (!lines.length) continue;
    const text = truncate(lines.slice(0, 2).join("。").replace(/。。+/g, "。"), maxLength);
    if (text.length >= 40) return { text, section };
  }
  return null;
}

function labelOf(section, prefix) {
  // 去重：有的解析器把页标题直接当定位（标题与定位相同）
  const parts = [prefix, section?.title, section?.locator]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  return [...new Set(parts)].join(" · ");
}

/**
 * 主入口：从解析片段或已有正文里摘出摘要。
 * @returns {{ summary: string, source: string, section: string }}
 */
export function extractSummary({ fragments, body, space = "research", type = "", maxLength = 200 } = {}) {
  const sections = body ? sectionsOfMarkdown(body) : sectionsOf(fragments ?? []);
  if (!sections.length) return { summary: "", source: "", section: "" };
  const rules = HEADING_RULES[space] ?? HEADING_RULES.research;

  const primary = pickSection(sections, rules.first);
  if (primary) {
    const text = compose(primary, maxLength);
    if (text) return { summary: text, source: labelOf(primary, "自动摘取"), section: primary.title ?? "" };
  }
  const secondary = pickSection(sections, rules.second);
  if (secondary) {
    const text = compose(secondary, maxLength);
    if (text) return { summary: text, source: labelOf(secondary, "自动摘取"), section: secondary.title ?? "" };
  }
  const fallback = firstSubstantive(sections, maxLength);
  if (fallback?.text) {
    return { summary: fallback.text, source: labelOf(fallback.section, "首段正文"), section: fallback.section?.title ?? "" };
  }
  return { summary: "", source: "", section: "" };
}

/** 摘要是否「明显是截断垃圾」：用于识别历史遗留的「前 160 字」摘要，重算时替换。 */
export function looksTruncated(summary) {
  const t = String(summary ?? "").trim();
  if (!t) return true;
  if (/[…]$/.test(t) && t.length < 40) return true;
  // 以「第 3 页」「目录」这类非正文开头
  if (/^(第\s*\d+\s*页|目录|封面|汇报人)/.test(t)) return true;
  return false;
}
