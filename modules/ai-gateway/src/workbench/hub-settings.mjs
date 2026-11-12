/**
 * AI 能力平台（skill-hub）的接入配置。
 *
 * 分两处存，和安全模型保持一致：
 *   gateway.config.json  -> hub.baseUrl / hub.autoMount / hub.autoPull
 *   hub-secrets.json     -> username / password（浏览器只看得到掩码）
 *
 * 账号密码不进前端、不进 URL、不进日志。saveHubSettings 是唯一写入路径。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const readJson = (file) => {
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const writeJsonAtomic = (file, data) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows 用 ACL，不认 mode */ }
};

/** 从配置文件与密钥文件组装出 hub 运行时配置。 */
export function loadHubSettings(configPath, fileConfig = {}, env = process.env) {
  const secretsFile = resolve(dirname(configPath), fileConfig.hubSecretsFile || "hub-secrets.json");
  const secrets = readJson(secretsFile);
  const file = fileConfig.hub && typeof fileConfig.hub === "object" ? fileConfig.hub : {};
  return {
    baseUrl: String(env.WORKBUDDY_HUB_URL || file.baseUrl || "http://8.138.91.205/hub/").trim(),
    username: String(env.WORKBUDDY_HUB_USER || secrets.username || "").trim(),
    password: String(env.WORKBUDDY_HUB_PASSWORD || secrets.password || ""),
    autoMount: file.autoMount !== false,
    secretsFile,
  };
}

const mask = (value) => {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 4) return "••••";
  return `${text.slice(0, 2)}${"•".repeat(Math.min(8, text.length - 2))}`;
};

/** 浏览器可见的形态：密码只给掩码，永远不回传原文。 */
export function describeHubSettings(hub) {
  return {
    baseUrl: hub.baseUrl || "",
    username: hub.username || "",
    passwordMasked: mask(hub.password),
    configured: Boolean(hub.baseUrl && hub.username && hub.password),
    autoMount: hub.autoMount !== false,
    secretsFile: hub.secretsFile ?? null,
  };
}

/**
 * 保存平台账号。只写传进来的字段，没传的保持原值——
 * 用户常常只想改地址，不该因为没重填密码就把密码清空。
 */
export function saveHubSettings(config, patch = {}) {
  if (!config.configPath) throw new Error("网关没有配置文件，无法保存平台设置");
  const fileConfig = readJson(config.configPath);
  const hubFile = fileConfig.hub && typeof fileConfig.hub === "object" ? { ...fileConfig.hub } : {};

  if ("baseUrl" in patch) {
    const raw = String(patch.baseUrl ?? "").trim();
    if (!raw) throw new Error("平台地址不能为空");
    // 已经写了协议就照它校验；完全没写才补 http://。否则 ftp://x 会被补成 http://ftp://x 混过去。
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
    let url;
    try { url = new URL(hasScheme ? raw : `http://${raw}`); } catch { throw new Error("平台地址不是合法网址"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("平台地址必须是 http 或 https");
    hubFile.baseUrl = url.toString();
    config.hub.baseUrl = hubFile.baseUrl;
  }
  if ("autoMount" in patch) {
    hubFile.autoMount = patch.autoMount !== false;
    config.hub.autoMount = hubFile.autoMount;
  }
  if (Object.keys(hubFile).length) {
    fileConfig.hub = hubFile;
    writeJsonAtomic(config.configPath, fileConfig);
  }

  const needSecrets = "username" in patch || "password" in patch || Boolean(patch.clearPassword);
  if (needSecrets) {
    const secrets = readJson(config.hub.secretsFile);
    if ("username" in patch) {
      const username = String(patch.username ?? "").trim();
      if (!username) throw new Error("平台账号不能为空");
      secrets.username = username;
      config.hub.username = username;
    }
    if (patch.clearPassword === true) {
      delete secrets.password;
      config.hub.password = "";
    } else if (typeof patch.password === "string" && patch.password.trim()) {
      secrets.password = patch.password.trim();
      config.hub.password = secrets.password;
    }
    writeJsonAtomic(config.hub.secretsFile, secrets);
  }

  return describeHubSettings(config.hub);
}
