/**
 * AI 查价：把「查模型最新公开单价」做成一条可复用的流水线。
 * 网关只负责出题（prompt）和收卷（解析 + 校验），查价本身交给能联网的员工跑。
 *
 * 设计要点：
 * - 结果只回填表单，不直接落盘——查错价时用户在保存前还看得见、拦得住。
 * - 单位口径与 pricing.mjs 一致：元 / 百万 tokens；超上限按「单位没换算」拒绝。
 */

import { MAX_PRICING_RATE } from "./pricing.mjs";

/** 给查价员工的题目：口径、换算、输出格式一次说死，省得来回追问。 */
export function buildPricingPrompt({ name, model } = {}) {
  const target = String(model || "").trim() || String(name || "").trim();
  if (!target) throw new Error("缺少查询目标：先填模型名");
  return [
    `请查询 AI 模型「${target}」当前的官方公开价格。`,
    `查价手段（按优先级）：`,
    `a. 优先用 Bash 执行 curl 抓官方定价页，例如：curl -sL --max-time 20 "https://api-docs.deepseek.com/quick_start/pricing" 。URL 凭你对这家厂商的了解来猜（DeepSeek 是 api-docs.deepseek.com/quick_start/pricing，OpenAI 是 openai.com/api/pricing/，阿里百炼在 help.aliyun.com 的模型定价页），猜错了换一个再试；`,
    `b. 抓回来的是 HTML，用 grep / head 过滤出价格表附近的内容再读，别整页硬啃；`,
    `c. WebFetch / WebSearch 在本环境可能不可用（返回空），失败了不要纠缠，直接换 curl。`,
    `要求：`,
    `1. 以厂商官方定价页 / 官方文档为准；聚合站只能用来交叉核对，不能当唯一来源。`,
    `2. 单位必须换算成「元 / 百万 tokens」（人民币）。官方只有美元价时按 1 美元 ≈ 7.2 元换算，并在 note 里注明汇率与查询日期。`,
    `3. 只查「${target}」这个型号本身；同系列其它型号的价格不要拿来凑数。`,
    `4. 输入价和输出价分开；有缓存命中价（cache hit）也一并给出。`,
    `5. 最终回复只输出一个 JSON 对象，不要代码块围栏、不要任何多余文字。字段：`,
    `{"input": 输入单价, "output": 输出单价, "cachedInput": 缓存命中单价（没有就省略）, "source": "价格页网址", "note": "一句话备注：币种、口径、查询日期"}`,
    `6. 你的回复会被程序直接解析，任何解释性文字都会导致解析失败。确实查不到可靠价格时，输出 {"error": "一句话原因"}，绝不编造数字。`,
  ].join("\n");
}

/** 宽松转数字：容忍「$3.5」「3.5 元」「1,000」这类写法。 */
const toRate = (value) => {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[,\s¥￥$元]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 从回复里抠出价格 JSON：容忍代码围栏、前后废话，也容忍常见字段别名。
 * 返回 { pricing, source, note }；解析不了返回 { error: 人话 }。
 */
export function parsePricingReply(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { error: "员工没有按约定返回 JSON，无法解析价格" };
  }
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: "员工返回的 JSON 解析失败" };
  }

  const input = toRate(data.input ?? data.inputPrice ?? data.prompt);
  const output = toRate(data.output ?? data.outputPrice ?? data.completion);
  if (input == null && output == null) {
    // 员工按第 6 条约定报了「查不到」：把它的原话递给用户，比笼统的解析失败有用
    if (typeof data.error === "string" && data.error.trim()) {
      return { error: `员工查价未果：${data.error.trim().slice(0, 200)}` };
    }
    return { error: "回复里没有可用的单价（input / output 都缺失）" };
  }
  // 单位纠错线：元/百万 tokens 超过上限，基本是把「每千 tokens」当「每百万」报了
  if ((input ?? 0) > MAX_PRICING_RATE || (output ?? 0) > MAX_PRICING_RATE) {
    return { error: `单价超出合理范围（上限 ${MAX_PRICING_RATE} 元/百万 tokens），疑似单位没换算，已拒绝` };
  }
  const cachedInput = toRate(data.cachedInput ?? data.cacheRead ?? data.cached_input);
  return {
    pricing: {
      input: input ?? 0,
      output: output ?? 0,
      // 没给缓存价就按输入价算：宁可算高不算低
      cachedInput: cachedInput != null ? cachedInput : (input ?? 0),
      currency: "CNY",
      unit: "per_million",
    },
    source: String(data.source ?? "").trim(),
    note: String(data.note ?? "").trim(),
  };
}
