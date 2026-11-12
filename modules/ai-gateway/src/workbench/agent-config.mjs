/**
 * Agent registry editing: create / update / delete, plus credential handling.
 *
 * Two files stay separate on purpose:
 *   gateway.config.json  -> name / summary / capabilities / enabled / model / baseUrl
 *   agent-secrets.json   -> apiKey
 *
 * A save rewrites the relevant file atomically, then patches the in-memory
 * config so the running gateway picks the new values up without a restart.
 * The API key never travels back to the browser: only a masked form does.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { findClaudeBinary } from "../claude-runner.mjs";
import { AGENTS, BUILTIN_AGENT_IDS, CAPABILITIES } from "./agents.mjs";
import { isAvatarKey, normalizeAvatar } from "./avatars.mjs";
import { MAX_PRICING_RATE, normalizePricing } from "./pricing.mjs";

const CAP_IDS = new Set(CAPABILITIES.map((item) => item.id));
const NAME_MAX = 20;
const SUMMARY_MAX = 40;
const MIN_TOKENS = 256;
const MAX_TOKENS = 65_536;
const MIN_KEY = 8;
const MAX_KEY = 512;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,120}$/;

const readJson = (file) => {
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`配置文件无法解析，已停止写入：${file}`);
  }
};

/** Write-then-rename so a crash can never leave a half-written config behind. */
const writeJsonAtomic = (file, data) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
  try { chmodSync(file, 0o600); } catch { /* windows: ACLs, not modes */ }
};

export function maskApiKey(key) {
  const text = String(key || "");
  if (!text) return "";
  if (text.length <= 8) return "••••••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

/** 本机 CLI 执行器注册表：cli 字段 → 探测安装状态的函数。 */
const LOCAL_CLI_DETECTORS = {
  claude: () => existsSync(findClaudeBinary(process.env)),
};
const isLocalCli = (cli) => typeof cli === "string" && cli in LOCAL_CLI_DETECTORS;

/** 新增员工弹窗的磁贴要在建之前就知道装没装，给前端一个只读探测口。 */
export function probeLocalCli(cli) {
  return LOCAL_CLI_DETECTORS[cli]?.() === true;
}

/** Browser-safe view of one agent's configuration. */
export function describeAgent(config, id) {
  if (id === "codex") {
    const entry = config.agents?.[id] ?? {};
    return {
      id,
      name: entry.name || "",
      summary: "",
      capabilities: null,
      provider: "local",
      local: true,
      editable: false,
      deletable: false,
      builtin: true,
      enabled: true,
      configured: true,
      // Codex 的 available 表示「CLI 能不能起来」，不是「填没填 Key」
      available: entry.available ?? true,
      availabilityReason: entry.availabilityReason ?? "ready",
      model: "",
      baseUrl: "",
      maxOutputTokens: 0,
      // 本机执行器不计费：留空，界面显示「本机 · 不计费」
      pricing: null,
      avatar: null,
      apiKeyMasked: "",
      secretsFile: null,
    };
  }
  const entry = config.agents?.[id];
  if (!entry) return null;
  return {
    id,
    name: entry.name || "",
    summary: entry.summary || "",
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : null,
    provider: entry.provider ?? null,
    // 本机 CLI 员工（Claude）：没有 Key、没有 Base URL，界面不该问这些
    local: entry.provider === "local",
    editable: true,
    deletable: !BUILTIN_AGENT_IDS.includes(id),
    builtin: BUILTIN_AGENT_IDS.includes(id),
    enabled: entry.enabled !== false,
    // 本机员工的 configured 是「CLI 装没装」，云端员工才是「Key 填没填」
    configured: entry.provider === "local" ? Boolean(entry.configured) : Boolean(entry.apiKey),
    available: Boolean(entry.available),
    availabilityReason: entry.availabilityReason ?? describeAvailability(entry),
    model: entry.model || "",
    baseUrl: entry.baseUrl || "",
    maxOutputTokens: Number(entry.maxOutputTokens) || 16_384,
    // 元 / 百万 tokens；null 表示没填，看板上这类员工的成本显示「未填单价」
    pricing: normalizePricing(entry.pricing),
    // 用户手动选的头像；null = 没选过（内置位会回落到自己的固定头像）
    avatar: normalizeAvatar(entry.avatar),
    apiKeyMasked: maskApiKey(entry.apiKey),
    secretsFile: config.agentSecretsPath ?? null,
  };
}

/**
 * 单价解析：单位统一是「元 / 百万 tokens」。
 * 返回 undefined = 这次不改；null = 清空；对象 = 新单价。
 * 三个都留空按「清空」处理，用户想删掉单价时不用另外找开关。
 */
const buildPricing = (input) => {
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("单价格式不对");
  const readRate = (value, label) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label}要填不小于 0 的数字`);
    if (n > MAX_PRICING_RATE) throw new Error(`${label}像是填错单位了（上限 ${MAX_PRICING_RATE} 元/百万 tokens）`);
    return n;
  };
  const inputRate = readRate(input.input, "输入单价");
  const outputRate = readRate(input.output, "输出单价");
  const cachedRate = readRate(input.cachedInput, "缓存单价");
  if (inputRate == null && outputRate == null && cachedRate == null) return null;
  if (!((inputRate ?? 0) > 0 || (outputRate ?? 0) > 0)) {
    throw new Error("输入单价或输出单价至少填一个");
  }
  return normalizePricing({ input: inputRate, output: outputRate, cachedInput: cachedRate });
};

/** 校验并归一化可编辑字段；创建和更新共用同一套规则。 */
const buildPatch = (patch = {}) => {
  const next = {};

  if ("name" in patch) {
    const name = String(patch.name ?? "").trim();
    if (!name) throw new Error("员工名称不能为空");
    if (name.length > NAME_MAX) throw new Error(`名称最多 ${NAME_MAX} 个字`);
    next.name = name;
  }
  if ("summary" in patch) {
    const summary = String(patch.summary ?? "").trim();
    if (summary.length > SUMMARY_MAX) throw new Error(`概述最多 ${SUMMARY_MAX} 个字`);
    next.summary = summary;
  }
  if ("capabilities" in patch) {
    if (!Array.isArray(patch.capabilities)) throw new Error("能力标签必须是数组");
    const caps = [...new Set(patch.capabilities.map((item) => String(item).trim()).filter(Boolean))];
    const unknown = caps.filter((item) => !CAP_IDS.has(item));
    if (unknown.length) throw new Error(`未知能力标签：${unknown.join("、")}`);
    next.capabilities = caps;
  }
  if ("enabled" in patch) next.enabled = patch.enabled === true;
  if ("model" in patch) {
    const model = String(patch.model ?? "").trim();
    if (!model) throw new Error("先填写模型名");
    if (!MODEL_PATTERN.test(model)) throw new Error("模型名只能包含字母、数字与 . _ : / -");
    next.model = model;
  }
  if ("baseUrl" in patch) {
    const raw = String(patch.baseUrl ?? "").trim();
    if (!raw) throw new Error("先填写 Base URL");
    let url;
    try { url = new URL(raw); } catch { throw new Error("Base URL 不是合法网址"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL 必须是 http 或 https");
    next.baseUrl = raw.replace(/\/+$/, "");
  }
  if ("maxOutputTokens" in patch) {
    const value = Number(patch.maxOutputTokens);
    if (!Number.isFinite(value) || value < MIN_TOKENS || value > MAX_TOKENS) {
      throw new Error(`最大输出 tokens 需在 ${MIN_TOKENS}–${MAX_TOKENS} 之间`);
    }
    next.maxOutputTokens = Math.round(value);
  }
  if ("pricing" in patch) {
    const pricing = buildPricing(patch.pricing);
    // undefined 不该出现在这里：只要 key 存在就一定要落一个值（null 表示清空）
    next.pricing = pricing ?? null;
  }
  if ("avatar" in patch) {
    const avatar = String(patch.avatar ?? "").trim();
    if (!avatar) next.avatar = null; // 空串 = 回到默认（首字 / 内置头像）
    else if (!isAvatarKey(avatar)) throw new Error("这个头像不存在，请从列表里选");
    else next.avatar = avatar;
  }
  return next;
};

const buildKey = (patch = {}) => {
  if (patch.clearApiKey === true) return "";
  if (typeof patch.apiKey !== "string" || !patch.apiKey.trim()) return undefined;
  const apiKey = patch.apiKey.trim();
  if (/\s/.test(apiKey)) throw new Error("API Key 不能包含空格");
  if (apiKey.length < MIN_KEY || apiKey.length > MAX_KEY) throw new Error("API Key 长度异常");
  return apiKey;
};

const writeConfigPatch = (config, id, next) => {
  const fileConfig = readJson(config.configPath);
  if (!fileConfig.agents || typeof fileConfig.agents !== "object") fileConfig.agents = {};
  fileConfig.agents[id] = { ...(fileConfig.agents[id] ?? {}), ...next };
  writeJsonAtomic(config.configPath, fileConfig);
};

const writeSecret = (config, id, apiKey) => {
  if (!config.agentSecretsPath) throw new Error("网关没有配置密钥文件路径");
  const secrets = readJson(config.agentSecretsPath);
  secrets[id] = { ...(secrets[id] ?? {}), apiKey };
  writeJsonAtomic(config.agentSecretsPath, secrets);
};

/**
 * @param {object} config live gateway config (mutated in place on success)
 * @param {string} id agent id
 * @param {object} patch editable fields + optional apiKey / clearApiKey
 */
export function updateAgentConfig(config, id, patch = {}) {
  if (id === "codex") throw new Error("Codex 是本机执行器，请到设置页调整运行参数");
  const entry = config.agents?.[id];
  if (!entry) throw new Error(`未知员工：${id}`);
  if (!config.configPath) throw new Error("网关没有配置文件，无法保存在线配置");

  const next = buildPatch(patch);
  const apiKey = buildKey(patch);
  if (!Object.keys(next).length && apiKey === undefined) throw new Error("没有需要保存的改动");

  if (Object.keys(next).length) {
    // 本机员工的 provider 必须落盘，否则下次读配置会被当成云端员工（然后开始要 Key）
    writeConfigPatch(config, id, entry.provider === "local" ? { ...next, provider: "local" } : next);
  }
  if (apiKey !== undefined) writeSecret(config, id, apiKey);

  Object.assign(entry, next);
  if (apiKey !== undefined) entry.apiKey = apiKey;
  entry.enabled = entry.enabled !== false;
  if (entry.provider === "local") {
    // 本机 CLI 员工：可用性只看命令装没装，Key / 地址 / 模型一概不参与。
    // 之前这里无差别按「三项齐」重算，把 Claude 一保存就打成「缺 Key」。
    entry.available = entry.enabled && entry.configured === true;
    entry.availabilityReason = entry.enabled ? (entry.available ? "ready" : "missing_cli") : "disabled";
  } else {
    entry.configured = Boolean(entry.apiKey);
    // 三项齐了才算能用：只有 Key 没有地址、或没有模型名，派活照样失败
    entry.available = entry.enabled && entry.configured && Boolean(entry.baseUrl) && Boolean(entry.model);
    entry.availabilityReason = describeAvailability(entry);
  }

  return describeAgent(config, id);
}

/** 一句话说清「为什么不可用」，前端直接显示，不用再猜。 */
const describeAvailability = (entry) => {
  if (entry.enabled === false) return "已停用";
  if (!entry.apiKey) return "needs_api_key";
  if (!entry.baseUrl) return "needs_base_url";
  if (!entry.model) return "needs_model";
  return "ready";
};

/** 新增一个 OpenAI 兼容的云端员工；id 由服务端生成，前端不需要关心。 */
export function createAgent(config, patch = {}) {
  if (patch.provider === "local") return createLocalAgent(config, patch);
  if (!config.configPath) throw new Error("网关没有配置文件，无法新增员工");

  const next = buildPatch(patch);
  if (!next.name) throw new Error("先给员工起个名字");
  if (!next.model) throw new Error("先填写模型名");
  if (!next.baseUrl) throw new Error("先填写 Base URL");
  const apiKey = buildKey(patch);

  // 内置员工的名称不存在配置文件里，得连内置定义一起查重
  const taken = new Set([
    ...AGENTS.map((agent) => agent.name),
    ...Object.values(config.agents ?? {}).map((entry) => String(entry.name ?? "").trim()).filter(Boolean),
  ]);
  if (taken.has(next.name)) throw new Error(`已经有叫「${next.name}」的员工`);

  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const enabled = next.enabled !== false;
  const record = {
    provider: "openai",
    name: next.name,
    summary: next.summary ?? "",
    capabilities: next.capabilities ?? [],
    enabled,
    baseUrl: next.baseUrl,
    model: next.model,
    maxOutputTokens: next.maxOutputTokens ?? 16_384,
    pricing: next.pricing ?? null,
    avatar: next.avatar ?? null,
  };

  writeConfigPatch(config, id, record);
  if (apiKey !== undefined && apiKey !== "") writeSecret(config, id, apiKey);

  config.agents[id] = {
    ...record,
    id,
    apiKey: apiKey ?? "",
    configured: Boolean(apiKey),
    available: enabled && Boolean(apiKey),
  };

  return describeAgent(config, id);
}

/**
 * 新增一个本机 CLI 员工：没有 Key、地址、模型——能不能用只看命令装没装。
 * 与云端员工的差别在 provider:"local"，读取配置时按同一条规则还原。
 */
export function createLocalAgent(config, patch = {}) {
  if (!config.configPath) throw new Error("网关没有配置文件，无法新增员工");

  const next = buildPatch(patch);
  if (!next.name) throw new Error("先给员工起个名字");
  const cli = typeof patch.cli === "string" && patch.cli.trim() ? patch.cli.trim() : "claude";
  if (!isLocalCli(cli)) throw new Error(`暂不支持的本机 CLI：${cli}`);

  const taken = new Set([
    ...AGENTS.map((agent) => agent.name),
    ...Object.values(config.agents ?? {}).map((entry) => String(entry.name ?? "").trim()).filter(Boolean),
  ]);
  if (taken.has(next.name)) throw new Error(`已经有叫「${next.name}」的员工`);

  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const enabled = next.enabled !== false;
  const installed = LOCAL_CLI_DETECTORS[cli]();
  const record = {
    provider: "local",
    cli,
    name: next.name,
    summary: next.summary ?? "",
    capabilities: next.capabilities ?? [],
    enabled,
    pricing: next.pricing ?? null,
    avatar: next.avatar ?? null,
  };

  writeConfigPatch(config, id, record);

  config.agents[id] = {
    ...record,
    id,
    apiKey: "",
    baseUrl: "",
    model: "",
    maxOutputTokens: 16_384,
    configured: installed,
    available: enabled && installed,
    availabilityReason: !enabled ? "disabled" : installed ? "ready" : "missing_cli",
  };

  return describeAgent(config, id);
}

/** 只允许删除自定义员工；内置位可以停用，但不该被移除。 */
export function deleteAgent(config, id) {
  if (id === "codex") throw new Error("Codex 是本机执行器，不能删除");
  if (BUILTIN_AGENT_IDS.includes(id)) throw new Error("内置员工不能删除，可以改成停用");
  const entry = config.agents?.[id];
  if (!entry) throw new Error(`未知员工：${id}`);

  const fileConfig = readJson(config.configPath);
  if (fileConfig.agents?.[id]) {
    delete fileConfig.agents[id];
    writeJsonAtomic(config.configPath, fileConfig);
  }
  const secrets = readJson(config.agentSecretsPath);
  if (secrets?.[id]) {
    delete secrets[id];
    writeJsonAtomic(config.agentSecretsPath, secrets);
  }
  delete config.agents[id];

  return { id, deleted: true };
}
