/**
 * 成本观测的计量口径（token + 钱）。
 *
 * 三条原则：
 * 1. 只记事实。网关只落 token 数，钱是「按你填的单价算出来的估算值」，
 *    单价改了历史金额也跟着变——因为历史 token 没变，变的是单价，这是诚实的。
 * 2. 不猜单价。没填单价的员工只统计 token，成本显示「未填单价」，
 *    不内置任何厂商参考价（价格常改，猜错比没有更糟）。
 * 3. 各厂商字段不一样，统一在这里归一化：prompt_tokens / input_tokens、
 *    prompt_cache_hit_tokens / cached_tokens 都收敛成同一套字段。
 */

/** 单价上限：元 / 百万 tokens。超过基本是把「每千 tokens」当「每百万」填了。 */
const MAX_RATE = 10_000;

const toNumber = (value) => {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const readPath = (source, path) => path
  .split(".")
  .reduce((node, part) => (node == null ? undefined : node[part]), source);

/**
 * 把任意厂商的 usage 对象归一化成固定结构。
 * 全部字段缺失或为 0 时返回 null——「没有用量信息」和「用量是 0」不是一回事。
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...paths) => {
    for (const path of paths) {
      const n = toNumber(readPath(raw, path));
      if (n != null) return n;
    }
    return 0;
  };

  const promptTokens = Math.round(pick("promptTokens", "prompt_tokens", "input_tokens"));
  const completionTokens = Math.round(pick("completionTokens", "completion_tokens", "output_tokens"));
  const reportedTotal = Math.round(pick("totalTokens", "total_tokens"));
  const totalTokens = reportedTotal || promptTokens + completionTokens;
  // 缓存命中：OpenAI 放 prompt_tokens_details，Moonshot 用 prompt_cache_hit_tokens，豆包用 cached_tokens
  const cachedTokens = Math.round(pick(
    "cachedTokens",
    "cached_tokens",
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_info.cached_tokens",
  ));
  const reasoningTokens = Math.round(pick(
    "reasoningTokens",
    "reasoning_tokens",
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
  ));

  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    // 缓存命中不可能超过输入总量；厂商报错时截断，别让占比条画到 120%
    cachedTokens: Math.min(cachedTokens, promptTokens),
    reasoningTokens,
  };
}

/** 多轮（工具循环 / 多次 turn）累加。null 视为 0，两边都空返回 null。 */
export function mergeUsage(base, extra) {
  const a = base ?? null;
  const b = extra ?? null;
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * 单价校验：{ input, output, cachedInput } 单位是「元 / 百万 tokens」。
 * 返回 null 表示没填（不参与成本计算）；两个主价都为空也算没填。
 */
export function normalizePricing(input) {
  if (!input || typeof input !== "object") return null;
  const inputRate = toNumber(input.input);
  const outputRate = toNumber(input.output);
  if (inputRate == null && outputRate == null) return null;
  if ((inputRate ?? 0) > MAX_RATE || (outputRate ?? 0) > MAX_RATE) return null;
  const cachedRate = toNumber(input.cachedInput);
  return {
    input: inputRate ?? 0,
    output: outputRate ?? 0,
    // 没单独填缓存价就按输入价算（多数厂商缓存命中确实更便宜，但宁可算高不算低）
    cachedInput: cachedRate != null ? cachedRate : (inputRate ?? 0),
    currency: "CNY",
    unit: "per_million",
  };
}

export const MAX_PRICING_RATE = MAX_RATE;

export const hasPricing = (pricing) => Boolean(pricing) && (pricing.input > 0 || pricing.output > 0);

/**
 * 一笔用量的钱（元）。没填单价返回 null，绝不返回 0——0 会被当成「免费」。
 * 保留 6 位小数：单次调用常常不到 1 分钱，四舍五入到分就全看不出来了。
 */
export function costOf(usage, pricing) {
  const normalized = normalizeUsage(usage);
  if (!normalized || !hasPricing(pricing)) return null;
  const cached = Math.min(normalized.cachedTokens, normalized.promptTokens);
  const freshInput = Math.max(normalized.promptTokens - cached, 0);
  const amount = (
    freshInput * Number(pricing.input)
    + cached * Number(pricing.cachedInput ?? pricing.input)
    + normalized.completionTokens * Number(pricing.output)
  ) / 1_000_000;
  return Math.round(amount * 1_000_000) / 1_000_000;
}
