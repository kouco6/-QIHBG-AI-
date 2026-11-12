/**
 * 产品中枢知识库 · 本地 OCR 适配器（规格书 7.3）。
 *
 * 引擎：本机 Tesseract（Win 常见安装路径 + PATH + TESSERACT_CMD 环境变量），零 npm 依赖。
 * 没装引擎时 detectOcr() 返回 null，导入层照旧把图片/纯图 PPT 标成 need-ocr，
 * 界面提示怎么装——绝不假装识别过。
 *
 * 语言包约定：需要 chi_sim（简体中文），最好同时有 eng；没有 chi_sim 时退化用第一个可用语言。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.TESSERACT_CMD,
  "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
  "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Tesseract-OCR", "tesseract.exe"),
  "tesseract",
].filter(Boolean);

let cached;

/** 探测本机 OCR 引擎。结果缓存（进程生命周期内只探测一次）。 */
export function detectOcr() {
  if (cached !== undefined) return cached;
  for (const cmd of CANDIDATES) {
    try {
      const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 6000, windowsHide: true });
      if (!r.error && /tesseract/i.test(String(r.stdout) + String(r.stderr))) {
        cached = { cmd, langs: listLangs(cmd) };
        return cached;
      }
    } catch { /* 下一个候选 */ }
  }
  cached = null;
  return cached;
}

function listLangs(cmd) {
  try {
    const r = spawnSync(cmd, ["--list-langs"], { encoding: "utf8", timeout: 6000, windowsHide: true });
    return String(r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("List"));
  } catch { return []; }
}

export const OCR_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"];

/**
 * 识别一张图片里的文字。返回 { text, lang, quality }；
 * quality：full（内容充实）/ thin（只有零星文字）/ empty（没认出东西）。
 */
export function ocrImage(buffer, ext = ".png") {
  const engine = detectOcr();
  if (!engine) throw new Error("本机未安装 Tesseract OCR，无法识别图片文字。安装 tesseract-ocr（含 chi_sim 语言包）后重启网关即可。");
  const dir = mkdtempSync(join(tmpdir(), "kb-ocr-"));
  const file = join(dir, `in${ext || ".png"}`);
  try {
    writeFileSync(file, buffer);
    const langs = engine.langs;
    const lang = langs.includes("chi_sim") ? (langs.includes("eng") ? "chi_sim+eng" : "chi_sim") : (langs[0] ?? "eng");
    const r = spawnSync(engine.cmd, [file, "stdout", "-l", lang, "--psm", "3"], {
      encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error && !String(r.stdout ?? "").length) throw new Error(`OCR 执行失败：${r.error.message}`);
    const text = String(r.stdout ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, lang, quality: text.length > 40 ? "full" : text ? "thin" : "empty" };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }
  }
}

/** 给界面/接口用的状态描述。 */
export function ocrStatus() {
  const engine = detectOcr();
  if (!engine) return { available: false, note: "未检测到 Tesseract OCR。安装 tesseract-ocr（记得勾选中文 chi_sim 语言包）并重启网关后，图片与纯图 PPT 可自动识别文字。" };
  const hasCn = engine.langs.includes("chi_sim");
  return {
    available: true,
    langs: engine.langs,
    note: hasCn ? "Tesseract OCR 就绪（中文 + 英文可用）" : `Tesseract 就绪，但缺少中文语言包 chi_sim（当前：${engine.langs.join("、") || "无"}），中文识别会不准`,
  };
}

/** OCR 是否可用（导入管线用，避免每张图重复探测）。 */
export const ocrAvailable = () => detectOcr() !== null;

/** 方便测试注入：清掉探测缓存。 */
export function resetOcrCache() { cached = undefined; }
