/**
 * 把本地技能（工作方法）挂到任务提示词上。
 *
 * 为什么不是「让 AI 自己去读 SKILL.md」：云端员工根本没有文件系统，
 * Codex 有但要额外一轮往返。直接把入口正文拼进提示词最稳，代价是字数额度，
 * 所以 mountBlock 按预算裁剪，超了只留摘要+路径，让有手有脚的员工自己去读。
 *
 * 拼在提示词**前面**而不是后面：指令在前、任务在后，模型更容易遵守。
 */

import { SkillStore } from "./skill-store.mjs";

const CACHE = new Map();

/**
 * 一个进程里只建一个 SkillStore（它无状态，除了磁盘）。目录变了才重建。
 * @returns {SkillStore}
 */
export function skillStoreFor(config) {
  const dir = config.skillDir;
  if (!dir) throw new Error("网关没有配置技能目录");
  const cached = CACHE.get(dir);
  if (cached) return cached;
  const store = new SkillStore({ dir });
  CACHE.set(dir, store);
  return store;
}

/**
 * @param {object} config 网关运行时配置
 * @param {string[]} names 客户端勾选的技能名
 * @param {string} prompt 用户原始需求
 * @param {{ budget?: number }} options
 * @returns {{ prompt: string, mounted: string[], missing: string[] }}
 */
export function applySkills(config, names, prompt, { budget = 6000 } = {}) {
  const wanted = (Array.isArray(names) ? names : []).map((item) => String(item ?? "").trim()).filter(Boolean);
  const text = String(prompt ?? "");
  if (!wanted.length || !config.skillDir) return { prompt: text, mounted: [], missing: [] };

  const store = skillStoreFor(config);
  const installed = new Set(store.list().map((item) => item.name));
  const mounted = wanted.filter((name) => installed.has(name));
  const missing = wanted.filter((name) => !installed.has(name));
  if (!mounted.length) return { prompt: text, mounted, missing };

  const block = store.mountBlock(mounted, { budget });
  if (!block) return { prompt: text, mounted: [], missing };
  const body = text.includes(block) ? text : `${block}\n\n---\n\n${text}`;
  return { prompt: body, mounted, missing };
}

/** 自动挂载：任务里提到的技能名直接带上，用户不用每次手点。 */
export function autoSkillNames(config, prompt) {
  if (!config.hub?.autoMount || !config.skillDir) return [];
  const text = String(prompt ?? "");
  if (!text) return [];
  let skills = [];
  try { skills = skillStoreFor(config).list(); } catch { return []; }
  // 长名字优先匹配，避免「调研」把「公司调研」也吞掉；太短的名字不参与，误伤概率太高。
  return skills
    .filter((skill) => skill.name.length >= 3 || /[\u4e00-\u9fa5]/.test(skill.name))
    .filter((skill) => (skill.title && skill.title.length >= 3 && text.includes(skill.title)) || text.includes(skill.name))
    .map((skill) => skill.name)
    .slice(0, 4);
}
