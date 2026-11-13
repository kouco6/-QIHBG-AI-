/**
 * Agent registry + explainable routing.
 *
 * Routing is rule-based on purpose: the reasons have to be showable in the UI,
 * and a model call to decide which model to call is both slower and unauditable.
 * Every capability is declared here. Runtime configuration supplies availability
 * and model names without ever exposing provider credentials to the browser.
 */

import { resolveAvatar } from "./avatars.mjs";

export const AGENTS = [
  {
    id: "codex",
    name: "Codex",
    summary: "改代码、跑命令、处理本地文件",
    provider: "local",
    transport: "gateway",
    capabilities: ["code", "files", "shell", "office-files"],
    strengths: "改代码、跑命令、读写本地文件、批量处理",
    limits: "不联网检索，长文写作偏弱",
    available: true,
  },
  {
    id: "claude",
    name: "Claude",
    summary: "本机 Claude Code：改代码、跑命令、读文件，带工具链与 Skill",
    provider: "local",
    transport: "gateway",
    // 有 WebFetch/WebSearch，所以比 Codex 多一个 web。
    // 同样不挂 longform / long-context：那是豆包、Kimi 的活，别让它通吃。
    capabilities: ["code", "files", "shell", "office-files", "web"],
    strengths: "长上下文推理、改代码、跑命令、读写本地文件、联网查资料",
    limits: "依赖本机 Claude Code 与它配置的上游（代理没开就不可用）",
    available: false,
  },
  {
    id: "workbuddy", name: "WorkBuddy", provider: "workbuddy-localassistant",
    transport: "workbuddy-localassistant-oauth",
    summary: "员工本地原生 Skill 专业研究；需独立 OAuth 接入",
    capabilities: [], strengths: "原生专业 Skill 与真实研究",
    limits: "须核实授权、在线、指定 Skill 执行与完整双成果回传", available: false,
  },
  {
    id: "doubao",
    name: "豆包",
    summary: "中文长文与文档归纳",
    provider: "cloud",
    transport: "ark-chat-completions",
    capabilities: ["longform", "chinese-writing", "doc", "summarize"],
    strengths: "中文长文、文档理解、归纳摘要",
    limits: "不能直接改本地文件",
    available: false,
  },
  {
    id: "kimi",
    name: "Kimi",
    summary: "超长上下文与资料归纳",
    provider: "cloud",
    transport: "moonshot-chat-completions",
    capabilities: ["longform", "long-context", "doc", "summarize"],
    strengths: "超长上下文、资料归纳、长文写作",
    limits: "不能直接改本地文件",
    available: false,
  },
];

/** 内置员工不可删除（Codex 是本机执行器，豆包/Kimi 是默认云端位）。 */
export const BUILTIN_AGENT_IDS = AGENTS.map((agent) => agent.id);

/** 可勾选的能力标签：既是卡片上的小标签，也是路由打分的依据。 */
export const CAPABILITIES = [
  { id: "code", label: "代码执行" },
  { id: "files", label: "本地文件" },
  { id: "shell", label: "命令行" },
  { id: "office-files", label: "Office 文件" },
  { id: "web", label: "联网检索" },
  { id: "longform", label: "长文写作" },
  { id: "chinese-writing", label: "中文写作" },
  { id: "long-context", label: "超长上下文" },
  { id: "doc", label: "文档理解" },
  { id: "summarize", label: "归纳摘要" },
];

const NEED_RULES = [
  {
    need: "code",
    label: "改文件或跑命令",
    test: ({ taskType }) => taskType === "adhoc-script",
  },
  {
    need: "office-files",
    label: "需要生成 Office 文件",
    test: ({ outputTypes }) => outputTypes.some((type) => ["word", "ppt", "excel"].includes(type)),
  },
  {
    need: "web",
    label: "需要联网检索",
    test: ({ domain, prompt }) =>
      ["research", "planning"].includes(domain) ||
      /检索|搜索|最新|动态|中标|招标|官网|新闻|行情/.test(prompt || ""),
  },
  {
    need: "long-context",
    label: "超长材料或多文档归纳",
    test: ({ prompt }) => (prompt || "").length > 8000 || /超长|长上下文|大量资料|多份文档|整套材料/.test(prompt || ""),
  },
  {
    need: "chinese-writing",
    label: "中文内容创作",
    test: ({ prompt }) => /撰写|文案|报告|方案|文章|润色|改写|中文写作/.test(prompt || ""),
  },
  {
    need: "longform",
    label: "长文写作或归纳",
    test: ({ prompt, outputTypes }) =>
      (prompt || "").length > 1500 || outputTypes.includes("word") || outputTypes.includes("ppt"),
  },
  {
    need: "doc",
    label: "需要读文档材料",
    test: ({ prompt }) => /文件|文档|pdf|word|excel|表格|资料/.test(prompt || ""),
  },
];

const capabilityName = {
  code: "代码执行",
  files: "本地文件",
  shell: "命令行",
  "office-files": "Office 文件",
  web: "联网检索",
  longform: "长文写作",
  doc: "文档理解",
  summarize: "归纳摘要",
  "long-context": "超长上下文",
  "chinese-writing": "中文写作",
};

export const agentName = (id) => AGENTS.find((agent) => agent.id === id)?.name ?? id;

/**
 * 员工名单 = 内置定义 + 配置里的自定义员工。
 * 配置可以覆盖内置员工的名称/概述/能力（例如把「豆包」改成某个业务助手的名字），
 * 但能力为空时仍然回落到内置值，避免路由突然失去依据。
 */
const resolveAgents = (runtimeAgents = {}) => {
  const builtins = new Map(AGENTS.map((agent) => [agent.id, agent]));
  const ids = [...AGENTS.map((agent) => agent.id), ...Object.keys(runtimeAgents).filter((id) => !builtins.has(id))];

  return ids.map((id) => {
    const base = builtins.get(id);
    const runtime = runtimeAgents[id] ?? {};
    // Codex 是本机 CLI：不走网络、没有 API Key，
    // 可用性由 CLI 是否装上来决定（runtime.available 由 config 侧探测结果注入）。
    if (base?.provider === "local") {
      const available = runtime.available ?? true;
      return {
        ...base,
        name: runtime.name?.trim() || base.name,
        available,
        configured: true,
        availabilityReason: available ? "ready" : runtime.availabilityReason ?? "missing_cli",
        model: null,
        builtin: true,
        custom: false,
      };
    }
    const fallback = base ?? {
      id,
      name: id,
      summary: "",
      // 自定义本机 CLI 员工（provider:"local"）也会走到这里，别把它标成云端
      provider: runtime.provider === "local" ? "local" : "cloud",
      transport: runtime.provider === "local" ? "gateway" : "openai-compatible-chat",
      capabilities: [],
      strengths: "",
      limits: "",
    };
    const capabilities = Array.isArray(runtime.capabilities) && runtime.capabilities.length
      ? runtime.capabilities
      : fallback.capabilities;
    const available = Boolean(runtime.available);
    return {
      ...fallback,
      name: runtime.name?.trim() || fallback.name,
      summary: runtime.summary?.trim() || fallback.summary || "",
      capabilities,
      available,
      configured: Boolean(runtime.configured),
      // config 侧已经算好了「缺哪一项」，直接用，别再退化成笼统的「缺 Key」
      availabilityReason: available
        ? "ready"
        : runtime.availabilityReason
          ?? (runtime.enabled === false ? "disabled" : "needs_api_key"),
      model: runtime.model ?? null,
      builtin: Boolean(base),
      custom: !base,
    };
  });
};

/**
 * @returns {{recommendedAgent:string, score:number, confidence:string,
 *            reasons:string[], missing:string[], alternatives:Array}}
 */
export function recommendAgent({ domain, taskType, prompt = "", outputTypes = [], model = null }, runtimeAgents = {}) {
  const context = { domain, taskType, prompt, outputTypes };
  const needs = NEED_RULES.filter((rule) => rule.test(context)).map((rule) => ({
    need: rule.need,
    label: rule.label,
  }));

  const scored = resolveAgents(runtimeAgents).map((agent) => {
    const covered = needs.filter((item) => agent.capabilities.includes(item.need));
    const missing = needs.filter((item) => !agent.capabilities.includes(item.need));
    const base = needs.length ? covered.length / needs.length : 0.6;
    return {
      agent,
      score: Number((base * (agent.available ? 1 : 0.35)).toFixed(2)),
      covered,
      missing,
    };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const usable = scored.filter((item) => item.agent.available);
  const winner = usable[0] ?? best;

  const reasons = [];
  if (needs.length) {
    for (const item of winner.covered) {
      reasons.push(`${item.label} → ${capabilityName[item.need]}由${winner.agent.name}覆盖`);
    }
  } else {
    reasons.push("任务没有特殊能力要求，任一可用智能体均可执行");
  }
  if (winner.agent.limits) reasons.push(`已知限制：${winner.agent.limits}`);

  const missing = winner.missing.map((item) => item.label);
  if (missing.length) {
    reasons.push(`未覆盖：${missing.join("、")}，这些环节需要你补充或换人`);
  }

  const alternatives = scored
    .filter((item) => item.agent.id !== winner.agent.id)
    .map((item) => ({
      agent: item.agent.id,
      name: item.agent.name,
      score: item.score,
      available: item.agent.available,
      reason: item.agent.available
        ? `覆盖 ${item.covered.length}/${needs.length || 1} 项能力`
        : "尚未配置 API Key，选中后无法执行",
    }));

  const gap = scored.length > 1 ? scored[0].score - scored[1].score : 1;
  const confidence = !winner.agent.available
    ? "none"
    : winner.score >= 0.8 && gap >= 0.2
      ? "high"
      : winner.score >= 0.5
        ? "medium"
        : "low";

  return {
    recommendedAgent: winner.agent.id,
    score: winner.score,
    confidence,
    reasons,
    missing,
    needs: needs.map((item) => item.need),
    alternatives,
    model,
  };
}

/** Plan-level guard: refuse to dispatch to an agent that cannot execute. */
export function assertAgentUsable(agentId, runtimeAgents = {}) {
  const agent = resolveAgents(runtimeAgents).find((item) => item.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (!agent.available) {
    // Codex 是唯一还留在本机的执行器，它的「不可用」是找不到程序，不是缺 Key
    if (agent.provider === "local") {
      throw new Error(`${agent.name} 当前不可用：本机没有找到它的命令行程序`);
    }
    const hint = {
      needs_api_key: "还没有填 API Key",
      needs_base_url: "还没有填 API 地址",
      needs_model: "还没有填模型名",
      disabled: "已被停用",
    }[agent.availabilityReason] ?? "配置不完整";
    throw new Error(`${agent.name} 当前不可用：${hint}。到员工页点「填 API」补齐后再派活`);
  }
  return agent;
}

export const listAgents = (runtimeAgents = {}) =>
  resolveAgents(runtimeAgents).map(({ id, name, summary, provider, transport, capabilities, strengths, limits, available, configured, availabilityReason, model, builtin, custom }) => ({
    id,
    name,
    summary,
    provider,
    transport,
    capabilities,
    strengths,
    limits,
    available,
    configured,
    availabilityReason,
    model,
    builtin,
    custom,
    // 前端直接用这个 key 去取 /assets/avatars/<key>.svg；null 表示退回首字圆形
    avatar: resolveAvatar(id, runtimeAgents?.[id]?.avatar),
  }));
