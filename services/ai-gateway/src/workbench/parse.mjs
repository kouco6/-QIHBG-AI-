/**
 * Turns a free-form Codex answer into the structured shape the result page needs.
 *
 * The prompt contract (see templates.mjs OUTPUT_CONTRACT) asks for four fixed
 * sections. When the model follows it, parsing is trivial; when it doesn't, we
 * degrade to "whole answer + first paragraph as conclusion" instead of showing an
 * empty result page. No second model call, no guessing.
 */

const SECTION_ALIASES = {
  conclusions: ["结论", "核心结论", "结论与判断"],
  risks: ["风险与不确定", "风险", "不确定项", "风险与不确定项"],
  nextActions: ["建议下一步", "下一步", "建议动作", "后续动作"],
  artifacts: ["产出文件", "产出物", "生成文件", "交付文件"],
};

const headingOf = (line) => {
  const match = line.match(/^#{1,4}\s*(.+?)\s*$/);
  return match ? match[1] : null;
};

/** Slice the answer into {heading -> body} using level 2-4 headings as boundaries. */
function splitSections(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections = new Map();
  let current = "_preamble";
  let buffer = [];
  const flush = () => {
    if (!sections.has(current)) sections.set(current, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      flush();
      current = heading;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function pick(sections, aliases) {
  for (const alias of aliases) {
    for (const [heading, body] of sections) {
      const normalized = heading.replace(/\s+/g, "");
      if (normalized === alias.replace(/\s+/g, "") || normalized.endsWith(alias.replace(/\s+/g, ""))) {
        if (body) return body;
      }
    }
  }
  return "";
}

/** List items if the block is a list, otherwise sentences, capped. */
function asBullets(block, max) {
  if (!block) return [];
  const items = block
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line && !line.startsWith("```") && !line.startsWith("|"));
  if (items.length) return items.slice(0, max);
  return block
    .split(/(?<=[。！？；])\s*/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max);
}

const FILE_LINE = /^[-*•]\s*`?([^|`]+?)`?\s*[|｜]\s*`?([^|`]+?)`?\s*[|｜]\s*(.*)$/;

function parseFileList(block) {
  const files = [];
  for (const line of String(block ?? "").split("\n")) {
    const match = line.trim().match(FILE_LINE);
    if (!match) continue;
    const path = match[1].trim();
    if (!path || path === "无" || /^(none|n\/a)$/i.test(path)) continue;
    files.push({ path, type: match[2].trim(), note: match[3].trim() });
  }
  return files;
}

const looksStructured = (text) => /(^|\n)#{2,4}\s*(结论|核心结论)/.test(String(text ?? ""));

/**
 * @returns {{structured:boolean, conclusions:string[], risks:string[],
 *            nextActions:string[], declaredFiles:Array, plain:string}}
 */
export function parseResult(text) {
  const raw = String(text ?? "");
  const structured = looksStructured(raw);
  const sections = splitSections(raw);

  const declaredFiles = parseFileList(pick(sections, SECTION_ALIASES.artifacts));

  if (!structured) {
    // Degrade: first meaningful paragraph becomes the conclusion list.
    const firstBlock = (sections.get("_preamble") || raw)
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith("#")) ?? "";
    return {
      structured: false,
      conclusions: asBullets(firstBlock, 7),
      risks: [],
      nextActions: [],
      declaredFiles,
      plain: raw,
    };
  }

  return {
    structured: true,
    conclusions: asBullets(pick(sections, SECTION_ALIASES.conclusions), 7),
    risks: asBullets(pick(sections, SECTION_ALIASES.risks), 6),
    nextActions: asBullets(pick(sections, SECTION_ALIASES.nextActions), 4),
    declaredFiles,
    plain: raw,
  };
}

/** The 1-2 line summary shown on a task card. */
export function summarize(parsed) {
  const first = parsed.conclusions[0];
  if (first) return first.length > 90 ? `${first.slice(0, 90)}…` : first;
  const plain = parsed.plain.replace(/\s+/g, " ").trim();
  return plain.length > 90 ? `${plain.slice(0, 90)}…` : plain;
}
