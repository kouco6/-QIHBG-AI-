/**
 * AI 网关 · 安装初始化（由 安装.cmd 调用，在安装目录里执行）
 *
 * 职责：生成本机专属的三份文件，已存在的一律不动（重复安装/升级不丢数据）：
 *   secrets.json        网关访问密钥（每台电脑随机生成）
 *   agent-secrets.json  AI 员工密钥（空，用户在工作台里自行配置）
 *   gateway.config.json 运行配置（端口、工作目录等）
 * 最后一行输出本机 token，供安装脚本拼「免登录进入工作台」的链接。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// 1. 网关访问密钥
const secretsFile = join(root, "secrets.json");
let token = "";
if (existsSync(secretsFile)) {
  try { token = JSON.parse(readFileSync(secretsFile, "utf8")).token ?? ""; } catch { token = ""; }
}
if (!token) {
  token = randomUUID().replaceAll("-", "");
  writeFileSync(secretsFile, `${JSON.stringify({ token }, null, 2)}\n`);
}

// 2. AI 员工密钥：留空，员工在工作台「AI 员工」页自行配置
const agentSecretsFile = join(root, "agent-secrets.json");
if (!existsSync(agentSecretsFile)) {
  writeFileSync(agentSecretsFile, "{}\n");
}

// 3. 运行配置：工作目录锁定在安装目录的 workspace（loadConfig 要求目录真实存在）
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const configFile = join(root, "gateway.config.json");
if (!existsSync(configFile)) {
  writeFileSync(configFile, `${JSON.stringify({
    _comment: "本机运行配置，安装时生成。改动后重启网关生效。",
    port: 4317,
    host: "127.0.0.1",
    tokenFile: "secrets.json",
    agentSecretsFile: "agent-secrets.json",
    allowedRoots: [workspace.replaceAll("\\", "/")],
    maxConcurrency: 2,
  }, null, 2)}\n`);
}

console.log(token);
