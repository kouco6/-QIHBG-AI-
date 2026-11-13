import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHubSettings } from "./workbench/hub-settings.mjs";
import { normalizePricing } from "./workbench/pricing.mjs";
import { normalizeAvatar } from "./workbench/avatars.mjs";
import { findClaudeBinary } from "./claude-runner.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const int = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const bool = (value, fallback = true) => {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
};

const readJsonIfPresent = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const splitRoots = (value) => {
  if (!value) return [ROOT];
  // Use semicolons on Windows so drive letters are never split.
  const separator = process.platform === "win32" ? ";" : delimiter;
  return value.split(separator).map((part) => part.trim()).filter(Boolean);
};

const canonicalDirectory = (input) => {
  const absolute = resolve(input);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Directory does not exist: ${absolute}`);
  }
  return realpathSync(absolute);
};

const comparable = (input) => process.platform === "win32" ? input.toLowerCase() : input;

/**
 * The token lives in its own file (default secrets.json) so gateway.config.json
 * can be committed, shared, or read over someone's shoulder without leaking the
 * credential. Both the gateway and the MCP bridge read it from there, so
 * rotating it is a one-file operation.
 */
const readSecret = (configPath, fileConfig) => {
  const relativePath = fileConfig.tokenFile || "secrets.json";
  const secretsPath = resolve(dirname(configPath), relativePath);
  const secrets = readJsonIfPresent(secretsPath);
  const token = typeof secrets?.token === "string" ? secrets.token.trim() : "";
  if (!token) {
    throw new Error(
      `Token file is missing or has no "token": ${secretsPath}. Run scripts\\rotate-token.ps1 to create one.`
    );
  }
  return { token, secretsPath };
};

const readAgentSecrets = (configPath, fileConfig, env) => {
  const agentSecretsPath = resolve(dirname(configPath), fileConfig.agentSecretsFile || "agent-secrets.json");
  const secrets = readJsonIfPresent(agentSecretsPath) ?? {};
  const keys = {};
  for (const [id, entry] of Object.entries(secrets)) {
    if (id.startsWith("_")) continue;
    if (typeof entry?.apiKey === "string" && entry.apiKey.trim()) keys[id] = entry.apiKey.trim();
  }
  // 旧格式（顶层 doubaoApiKey / kimiApiKey）继续兼容
  if (typeof secrets.doubaoApiKey === "string" && secrets.doubaoApiKey.trim()) keys.doubao ??= secrets.doubaoApiKey.trim();
  if (typeof secrets.kimiApiKey === "string" && secrets.kimiApiKey.trim()) keys.kimi ??= secrets.kimiApiKey.trim();
  if (env.ARK_API_KEY?.trim()) keys.doubao = env.ARK_API_KEY.trim();
  if (env.MOONSHOT_API_KEY?.trim()) keys.kimi = env.MOONSHOT_API_KEY.trim();
  return { agentSecretsPath, keys };
};

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"];

/**
 * Codex ships its real binaries under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\
 * which is NOT on PATH, so spawning the bare name only works when the launcher
 * happened to prepend that directory. Mirror scripts/resolve-codex.ps1 so the
 * gateway finds Codex no matter how it was started:
 *   1. explicit codexHome (dir containing codex.exe, or the exe itself)
 *   2. whatever "codex" resolves to on PATH (exe / cmd / extensionless shim)
 *   3. versioned installs under LOCALAPPDATA, preferring the copy that still
 *      has codex-code-mode-host.exe (the sandbox copy lacks it and fails closed)
 *   4. ~/.codex/.sandbox-bin as a last resort
 */
export function findCodexBinary(hint, env = process.env) {
  if (hint) {
    const asExe = join(hint, "codex.exe");
    if (existsSync(asExe)) return asExe;
    if (existsSync(hint) && statSync(hint).isFile()) return hint;
  }

  for (const dir of (env.PATH || env.Path || "").split(delimiter)) {
    if (!dir) continue;
    for (const name of ["codex.exe", "codex.cmd", "codex"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }

  const candidates = [];
  const binRoot = join(env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (existsSync(binRoot)) {
    for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(binRoot, entry.name);
      const exe = join(dir, "codex.exe");
      if (!existsSync(exe)) continue;
      candidates.push({
        path: exe,
        hasCodeMode: existsSync(join(dir, "codex-code-mode-host.exe")),
        mtime: statSync(dir).mtimeMs,
      });
    }
  }

  const sandbox = join(env.USERPROFILE ?? homedir(), ".codex", ".sandbox-bin", "codex.exe");
  if (existsSync(sandbox)) {
    candidates.push({
      path: sandbox,
      hasCodeMode: existsSync(join(dirname(sandbox), "codex-code-mode-host.exe")),
      mtime: statSync(sandbox).mtimeMs,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(b.hasCodeMode) - Number(a.hasCodeMode)) || (b.mtime - a.mtime));
  return candidates[0].path;
}

export const normalizeReasoningEffort = (value, fallback = "medium") => {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REASONING_EFFORTS.includes(effort) ? effort : fallback;
};

/**
 * 把监听地址/端口写回 gateway.config.json，服务重启后保持设置页选的模式。
 * 只动 host/port 两个字段，注释键（_comment 等）原样保留。
 */
export function saveServerBind(configPath, host, port) {
  const raw = readFileSync(configPath, "utf8");
  const data = JSON.parse(raw);
  data.host = host;
  data.port = port;
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadConfig(env = process.env) {
  const configPath = env.WORKBUDDY_CONFIG_FILE
    ? resolve(env.WORKBUDDY_CONFIG_FILE)
    : join(ROOT, "gateway.config.json");
  const fileConfig = readJsonIfPresent(configPath) ?? {};

  // env wins, then the secrets file. Never silently mint a token when a
  // configuration exists - a gateway and bridge holding different tokens looks
  // identical to "everything is configured correctly but every call is 401".
  let token = env.WORKBUDDY_GATEWAY_TOKEN?.trim() || "";
  let tokenSource = token ? "WORKBUDDY_GATEWAY_TOKEN" : "";
  let secretsPath = null;
  if (!token) {
    const secret = readSecret(configPath, fileConfig);
    token = secret.token;
    secretsPath = secret.secretsPath;
    tokenSource = secret.secretsPath;
  }

  const { agentSecretsPath, keys } = readAgentSecrets(configPath, fileConfig, env);
  const fileAgents = fileConfig.agents && typeof fileConfig.agents === "object" ? fileConfig.agents : {};

  // 内置两个云端位的默认端点；自定义员工完全由配置提供。
  // env 覆盖只对内置位生效，避免自定义员工被同名环境变量意外改写。
  const presets = {
    doubao: {
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-seed-2-1-lite-260915",
      enabledEnv: env.WORKBUDDY_DOUBAO_ENABLED,
      baseUrlEnv: env.WORKBUDDY_DOUBAO_BASE_URL?.trim(),
      modelEnv: env.WORKBUDDY_DOUBAO_MODEL?.trim(),
      tokensEnv: env.WORKBUDDY_DOUBAO_MAX_OUTPUT_TOKENS,
    },
    kimi: {
      provider: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
      enabledEnv: env.WORKBUDDY_KIMI_ENABLED,
      baseUrlEnv: env.WORKBUDDY_KIMI_BASE_URL?.trim(),
      modelEnv: env.WORKBUDDY_KIMI_MODEL?.trim(),
      tokensEnv: env.WORKBUDDY_KIMI_MAX_OUTPUT_TOKENS,
    },
    // WorkBuddy localassistant uses OAuth and a dedicated adapter, never an
    // OpenAI-compatible endpoint/model/API-key preset.
  };

  const agents = {};
  const claudeBinary = findClaudeBinary(env);
  const claudeInstalled = existsSync(claudeBinary);
  for (const id of [...new Set([...Object.keys(presets), ...Object.keys(fileAgents)])]) {
    if (id.startsWith("_")) continue;
    const raw = fileAgents[id] && typeof fileAgents[id] === "object" ? fileAgents[id] : {};
    const preset = presets[id] ?? {};
    const apiKey = keys[id] ?? "";
    const enabled = bool(preset.enabledEnv ?? raw.enabled, true);
    const baseUrl = preset.baseUrlEnv || raw.baseUrl || preset.baseUrl || "";
    const model = preset.modelEnv || raw.model || preset.model || "";

    // 本机 CLI 员工（内置 claude 和界面新建的自定义位）：可用性只看 exe 在不在，
    // 不进下面「地址+模型+Key 三项齐」的语义，否则一重启就被打成「缺 Key」。
    if ((raw.provider || preset.provider || id) === "local") {
      agents[id] = {
        id,
        provider: "local",
        cli: typeof raw.cli === "string" && raw.cli.trim() ? raw.cli.trim() : "claude",
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : (id === "claude" ? "Claude" : ""),
        summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
        capabilities: Array.isArray(raw.capabilities)
          ? raw.capabilities.filter((item) => typeof item === "string")
          : null,
        enabled,
        configured: claudeInstalled,
        available: enabled && claudeInstalled,
        availabilityReason: !enabled
          ? "disabled"
          : claudeInstalled
            ? "ready"
            : "missing_cli",
        apiKey: "",
        baseUrl: "",
        model: "",
        maxOutputTokens: int(raw.maxOutputTokens, 16_384, 256, 65_536),
        pricing: normalizePricing(raw.pricing),
        avatar: normalizeAvatar(raw.avatar),
        command: claudeBinary,
      };
      continue;
    }

    agents[id] = {
      id,
      provider: raw.provider || preset.provider || id,
      name: typeof raw.name === "string" ? raw.name.trim() : "",
      summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
      capabilities: Array.isArray(raw.capabilities)
        ? raw.capabilities.filter((item) => typeof item === "string")
        : null,
      enabled,
      configured: Boolean(apiKey),
      // 地址 / 模型 / Key 少任何一项都派不了活，别让卡片挂着「就绪」然后一点就错
      available: enabled && Boolean(apiKey) && Boolean(baseUrl) && Boolean(model),
      availabilityReason: !enabled
        ? "disabled"
        : !apiKey
          ? "needs_api_key"
          : !baseUrl
            ? "needs_base_url"
            : !model
              ? "needs_model"
              : "ready",
      apiKey,
      baseUrl,
      model,
      maxOutputTokens: int(preset.tokensEnv ?? raw.maxOutputTokens, 16_384, 256, 65_536),
      // 单价只用来把 token 折算成钱；没填就是 null，成本栏显示「未填单价」而不是 0
      pricing: normalizePricing(raw.pricing),
      // 头像只存预设 key；没选就是 null，卡片退回首字圆形
      avatar: normalizeAvatar(raw.avatar),
    };
  }

  // 兜底：配置文件里还没有 claude 条目（全新配置）时补一个默认位。
  // 已有条目的情况上面循环的 local 分支已经处理过了，不要在这里覆盖。
  if (!agents.claude) {
    agents.claude = {
      id: "claude",
      provider: "local",
      cli: "claude",
      name: "Claude",
      summary: "",
      capabilities: null,
      enabled: true,
      configured: claudeInstalled,
      available: claudeInstalled,
      availabilityReason: claudeInstalled ? "ready" : "missing_cli",
      apiKey: "",
      baseUrl: "",
      model: "",
      maxOutputTokens: 16_384,
      pricing: null,
      avatar: null,
      command: claudeBinary,
    };
  }

  // Native WorkBuddy is represented in the existing employee registry, but
  // cannot become a generic model runner, even if legacy keys are present.
  agents.workbuddy = { id: "workbuddy", provider: "workbuddy-localassistant", name: "WorkBuddy",
    enabled: fileConfig.workbuddy?.enabled === true,
    configured: Boolean(fileConfig.workbuddy?.clientId && fileConfig.workbuddy?.redirectUri),
    available: false, availabilityReason: "workbuddy_authorization_required",
    apiKey: "", baseUrl: "", model: "", maxOutputTokens: 0 };

  const rootsSource = env.WORKBUDDY_ALLOWED_ROOTS
    ?? (Array.isArray(fileConfig.allowedRoots) ? fileConfig.allowedRoots.join(process.platform === "win32" ? ";" : delimiter) : "");
  const allowedRoots = splitRoots(rootsSource).map(canonicalDirectory);

  // Resolve Codex once at startup. Falls back to the bare name so behavior is
  // unchanged when PATH already works (start.ps1 / watchdog prepend it).
  const codexCommand = findCodexBinary(env.WORKBUDDY_CODEX_HOME || fileConfig.codexHome || "", env) ?? "codex";

  return {
    root: ROOT,
    configPath,
    host: env.WORKBUDDY_HOST?.trim() || fileConfig.host || "127.0.0.1",
    port: int(env.WORKBUDDY_PORT ?? fileConfig.port, 4317, 1, 65535),
    token,
    tokenSource,
    secretsPath,
    agentSecretsPath,
    generatedToken: false,
    agents,
    allowedRoots,
    maxConcurrency: int(env.WORKBUDDY_MAX_CONCURRENCY ?? fileConfig.maxConcurrency, 2, 1, 16),
    taskTimeoutMs: int(env.WORKBUDDY_TASK_TIMEOUT_MS ?? fileConfig.taskTimeoutMs, 30 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000),
    maxPromptChars: int(env.WORKBUDDY_MAX_PROMPT_CHARS, 20_000, 100, 200_000),
    // Reasoning effort is a latency/quality trade-off, not a transport fix.
    // Medium is the balanced default; callers can override it per task and the
    // benchmark harness can compare settings with transport held constant.
    codexReasoningEffort: normalizeReasoningEffort(
      env.WORKBUDDY_CODEX_REASONING ?? fileConfig.codexReasoningEffort
    ),
    // Absolute path to the codex executable (or the bare name as fallback).
    codexCommand,
    // 本机 Claude Code 的 exe（探测结果，供运行状态页显示）
    claudeCommand: claudeBinary,
    runnerMode: env.WORKBUDDY_RUNNER_MODE?.trim() || fileConfig.runnerMode || "app-server",
    allowExecFallback: (env.WORKBUDDY_ALLOW_EXEC_FALLBACK ?? String(fileConfig.allowExecFallback ?? true)) === "true",
    // Codex runs as a long-lived child and may inherit the host app's loopback
    // HTTP(S)_PROXY. Off by default for a deterministic environment; switch on
    // only when the network requires it. Benchmarks, not assumptions, decide
    // whether either mode is faster on a particular machine.
    codexUseSystemProxy: (env.WORKBUDDY_CODEX_USE_SYSTEM_PROXY ?? String(fileConfig.codexUseSystemProxy ?? false)) === "true",
    // A quiet Codex turn is normal, so this never kills anything — it only tells
    // the UI how long the output has been silent. 0 disables the report.
    codexSilenceWarnMs: int(
      env.WORKBUDDY_CODEX_SILENCE_WARN_MS ?? fileConfig.codexSilenceWarnMs,
      5 * 60 * 1000,
      0,
      60 * 60 * 1000
    ),
    stateFile: resolve(dirname(configPath), env.WORKBUDDY_STATE_FILE ?? fileConfig.stateFile ?? "state/tasks.jsonl"),
    eventFile: resolve(dirname(configPath), env.WORKBUDDY_EVENT_FILE ?? fileConfig.eventFile ?? "state/events.jsonl"),
    taskRetention: int(env.WORKBUDDY_TASK_RETENTION ?? fileConfig.taskRetention, 2000, 50, 100_000),
    // AI 能力平台：从云端把技能拉进本地工作方法库。账号密码在 hub-secrets.json。
    hub: loadHubSettings(configPath, fileConfig, env),
    skillDir: resolve(dirname(configPath), env.WORKBUDDY_SKILL_DIR ?? fileConfig.skillDir ?? "skills"),
    // Nonsecret operator configuration only; no environment credential discovery.
    workbuddy: fileConfig.workbuddy && typeof fileConfig.workbuddy === "object" ? fileConfig.workbuddy : {},
    workbuddyCredentialRoot: env.WORKBUDDY_RESEARCH_AUTH_DIR ?? fileConfig.workbuddyCredentialRoot ?? null,
  };
}

export function resolveAllowedDirectory(input, allowedRoots) {
  const candidate = canonicalDirectory(input || allowedRoots[0]);
  const normalizedCandidate = comparable(candidate);
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = comparable(root);
    const rel = relative(normalizedRoot, normalizedCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) {
    throw new Error(
      `Working directory is outside the allowed roots: ${candidate}. Add it to allowedRoots in gateway.config.json.`
    );
  }
  return candidate;
}

export function validateTaskInput(input, config) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Request body must be a JSON object");
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > config.maxPromptChars) {
    throw new Error(`prompt exceeds ${config.maxPromptChars} characters`);
  }

  const mode = input.mode ?? "workspace-write";
  if (!new Set(["read-only", "workspace-write"]).has(mode)) {
    throw new Error("mode must be read-only or workspace-write");
  }

  const model = input.model == null || input.model === "" ? null : String(input.model);
  if (model && !/^[A-Za-z0-9._:-]{1,80}$/.test(model)) throw new Error("model is invalid");

  const threadId = input.threadId == null || input.threadId === "" ? null : String(input.threadId);
  if (threadId && !/^[A-Za-z0-9._:-]{1,128}$/.test(threadId)) throw new Error("threadId is invalid");

  const agent = input.agent == null || input.agent === "" ? "codex" : String(input.agent).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(agent)) throw new Error("agent is invalid");

  return {
    prompt,
    cwd: resolveAllowedDirectory(input.cwd, config.allowedRoots),
    mode,
    model,
    threadId,
    agent,
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, config.codexReasoningEffort ?? "medium"),
    label: typeof input.label === "string" ? input.label.trim().slice(0, 120) : "",
  };
}
