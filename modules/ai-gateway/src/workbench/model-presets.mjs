/**
 * 主流模型厂商预设。
 *
 * 新增员工最麻烦的一步是「填对 Base URL + 模型名」，而这两件事对每个厂商都不同、
 * 又几乎不变。这里把它们固化下来：前端选一个厂商，地址与默认模型直接填好，
 * 用户只需要补 Key 和自己的名称/概述。
 *
 * 只收录提供 OpenAI 兼容 /chat/completions 的端点——网关的云端 runner 只认这一种协议。
 * 模型名是候选项，不是白名单：厂商下线或改名后用户仍可自己输入。
 */

export const MODEL_PRESETS = [
  {
    id: "doubao",
    label: "豆包",
    vendor: "火山方舟",
    region: "cn",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-2-1-turbo-260628", "doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250615"],
    summary: "中文长文、文档理解与归纳摘要",
    capabilities: ["longform", "chinese-writing", "doc", "summarize"],
    keyUrl: "https://console.volcengine.com/ark",
    keyHint: "方舟控制台 → API Key 管理 → 创建 API Key",
  },
  {
    id: "qwen",
    label: "通义千问",
    vendor: "阿里云百炼",
    region: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"],
    summary: "中文写作、长文档与超长上下文",
    capabilities: ["longform", "chinese-writing", "doc", "long-context", "summarize"],
    keyUrl: "https://bailian.console.aliyun.com",
    keyHint: "百炼控制台 → API-KEY 管理 → 创建我的 API-KEY",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    vendor: "深度求索",
    region: "cn",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    summary: "中文推理与代码，性价比高",
    capabilities: ["code", "chinese-writing", "longform", "summarize"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "开放平台 → API keys → 创建",
  },
  {
    id: "kimi",
    label: "Kimi",
    vendor: "月之暗面",
    region: "cn",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    summary: "超长上下文与整份资料归纳",
    capabilities: ["long-context", "longform", "doc", "summarize"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHint: "控制台 → API Key 管理 → 新建",
  },
  {
    id: "glm",
    label: "智谱 GLM",
    vendor: "智谱 AI",
    region: "cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-plus", "glm-4-flash"],
    summary: "中文通用写作与文档问答",
    capabilities: ["chinese-writing", "longform", "doc", "summarize"],
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
    keyHint: "控制台 → API Keys → 新建",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    vendor: "腾讯云",
    region: "cn",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-pro", "hunyuan-lite"],
    summary: "中文对话、方案撰写与归纳",
    capabilities: ["chinese-writing", "longform", "summarize"],
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    keyHint: "腾讯云 → 混元大模型 → API Key",
  },
  {
    id: "spark",
    label: "讯飞星火",
    vendor: "科大讯飞",
    region: "cn",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    models: ["4.0Ultra", "generalv3.5", "lite"],
    summary: "中文问答与文案生成",
    capabilities: ["chinese-writing", "summarize"],
    keyUrl: "https://console.xfyun.cn/services/bmx1",
    keyHint: "星火控制台 → 服务管理 → APIKey/APISecret",
  },
  {
    id: "ernie",
    label: "文心一言",
    vendor: "百度千帆",
    region: "cn",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.5-turbo-128k", "ernie-4.0-8k", "ernie-speed-128k"],
    summary: "中文文档理解与写作",
    capabilities: ["chinese-writing", "doc", "summarize"],
    keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
    keyHint: "百度智能云 → API Key → 新建（千帆 v2 用 Bearer Key）",
  },
  {
    id: "minimax",
    label: "MiniMax",
    vendor: "稀宇科技",
    region: "cn",
    baseUrl: "https://api.minimax.chat/v1",
    models: ["MiniMax-Text-01", "abab6.5s-chat"],
    summary: "长上下文与中文对话",
    capabilities: ["long-context", "chinese-writing", "summarize"],
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    keyHint: "控制台 → 账户信息 → 接口密钥",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    vendor: "国内聚合",
    region: "aggregate",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct"],
    summary: "聚合多种开源模型，一个 Key 换着用",
    capabilities: ["longform", "chinese-writing", "code", "summarize"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    keyHint: "控制台 → API 密钥 → 新建",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    vendor: "海外聚合",
    region: "aggregate",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-pro", "openai/gpt-4.1"],
    summary: "一个 Key 调用海外主流模型",
    capabilities: ["longform", "code", "doc", "long-context"],
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "Settings → Keys → Create Key",
  },
  {
    id: "openai",
    label: "OpenAI",
    vendor: "OpenAI",
    region: "global",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
    summary: "英文写作、代码与通用推理",
    capabilities: ["code", "longform", "doc"],
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Platform → API keys → Create new secret key",
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    region: "global",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    summary: "超长上下文与多模态理解",
    capabilities: ["long-context", "doc", "summarize"],
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AI Studio → Get API key",
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    vendor: "本机离线",
    region: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5:14b", "llama3.1:8b", "deepseek-r1:14b"],
    summary: "本机离线推理，数据不出机器",
    capabilities: ["chinese-writing", "summarize"],
    keyUrl: "https://ollama.com/download",
    keyHint: "Key 可随便填一个占位值（如 ollama），地址需本机服务已启动",
  },
];

/** 前端只需要这些字段，keyHint 一类的说明也一并给出去，省一次请求。 */
export const PRESET_VIEWS = MODEL_PRESETS.map(({ id, label, vendor, region, baseUrl, models, summary, capabilities, keyUrl, keyHint }) => ({
  id,
  label,
  vendor,
  region,
  baseUrl,
  models,
  summary,
  capabilities,
  keyUrl,
  keyHint,
}));

export const findPreset = (id) => MODEL_PRESETS.find((preset) => preset.id === id) ?? null;

/**
 * 本机 CLI 预设：不算「模型厂商」，是复用本机已装的命令行工具。
 * local: true 让前端切到「无 Key 表单」——不显示 API Key / 地址 / 模型，
 * cli 字段决定落到哪个执行器（目前只有 claude）。
 */
export const LOCAL_CLI_PRESETS = [
  {
    id: "local-claude",
    label: "Claude Code",
    vendor: "本机 CLI",
    local: true,
    cli: "claude",
    summary: "复用本机已装的 Claude Code，不需要 API Key、地址和模型名",
    capabilities: ["code", "files", "shell", "office-files", "web"],
  },
];
