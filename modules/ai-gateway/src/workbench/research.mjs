/** Planning research is metadata on the existing TaskManager, not another queue. */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WorkBuddyConnection } from "./workbuddy-connection.mjs";
export const digest = value => createHash("sha256").update(value).digest("hex");
export class ResearchFailure extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
// The service proof stays in gateway memory, outside model subprocess environments
// and serialized configuration. It is unrelated to a WorkBuddy OAuth credential.
const services = new WeakMap();
export function bindResearchService(config, env = process.env) {
  const owner = env.WORKBUDDY_RESEARCH_OWNER ?? "";
  services.set(config, { key: env.WORKBUDDY_RESEARCH_KEY ?? "", owner,
    workbuddy: new WorkBuddyConnection({ app: config.workbuddy, credentialRoot: config.workbuddyCredentialRoot,
      allowedRoots: config.allowedRoots, ownerId: owner }) });
  delete env.WORKBUDDY_RESEARCH_KEY; delete env.WORKBUDDY_RESEARCH_OWNER;
  delete env.WORKBUDDY_RESEARCH_AUTH_DIR;
}
export const researchOwner = config => services.get(config)?.owner;
export function bindLocalResearch(config, local) { services.get(config).local = local; }
export function bindCodexResearch(config, codex) { services.get(config).codex = codex; }
export const workbuddyConnection = config => services.get(config)?.workbuddy;
export function trustedResearch(req, config) {
  const { key: expected = "", owner } = services.get(config) ?? {};
  const given = String(req.headers["x-research-integration"] ?? "");
  if (!expected || !owner || !timingSafeEqual(Buffer.from(digest(expected)), Buffer.from(digest(given))) ||
      req.headers["x-research-account"] !== owner)
    throw new ResearchFailure("RESEARCH_SERVICE_FORBIDDEN", "研究通道仅供已鉴权的平台服务调用", 403);
}

export function runtimeResearch(config) {
  const connection = workbuddyConnection(config)?.info();
  const localPull = services.get(config)?.local?.info() ?? {enabled:false,oauthRequired:false};
  return { gatewayDiagnostics: { skillDir: config.skillDir, configPath: config.configPath,
      maxPromptChars: config.maxPromptChars, runnerMode: config.runnerMode }, enabled: false,
    researchExecutor: "workbuddy", workbuddyAdapterConnected: Boolean(connection?.connectionVerified),
    workbuddySkillDir: config.workbuddy?.skillRoot ?? null, skillLoadingVerified: false, retrievalVerified: false,
    connection: connection ?? null, localPull,
    skillInstallationAuthority: "workbuddy-runtime-not-gateway-skillDir",
    dimensions: connection?.dimensions ?? Array.from({length: 12}, (_, i) => ({ dimensionId: `DIM-${String(i+1).padStart(2, "0")}`,
      skillName: null, skillVersion: null, skillStatus: "unverified", enabled: false })),
    device: { id: null, executor: "workbuddy",
      authorized: false,
      transport: null, remoteRegistrationImplemented: false,
      heartbeat: "not-connected-to-workbuddy" },
    codexNative:services.get(config)?.codex?.info() ?? {enabled:false} };
}

export function prepareResearch(req, body, config, manager) {
  trustedResearch(req, config);
  const codex=services.get(config)?.codex;
  if (codex?.settings().enabled === true) return codex.admit(body,String(req.headers["x-idempotency-key"]??""));
  const local=services.get(config)?.local;
  if(!local?.settings().enabled)
    throw new ResearchFailure("LOCAL_RESEARCH_NOT_CONFIGURED", "本地领取尚未配置；未调用 OAuth 或其他执行器");
  return local.admit(body,String(req.headers["x-idempotency-key"]??""));
}

export function validDim03(value) {
  const fields = ["id", "name", "grade", "expiry", "owned", "difficulty", "barrier"];
  const count = s => Array.from(s).length;
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "format,rows" && value.format === "v5" &&
    Array.isArray(value.rows) && value.rows.length <= 2000 && new Set(value.rows.map(r => r?.id)).size === value.rows.length &&
    value.rows.every(r => r && Object.keys(r).sort().join(",") === [...fields].sort().join(",") &&
      fields.every(k => typeof r[k] === "string" && count(r[k]) <= (k === "id" ? 120 : 2000)) && count(r.id) > 0);
}

function durableFile(path, text) {
  const fd = openSync(path, "wx", 0o400);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
const resultDir = (config, task) => join(dirname(config.stateFile), "research", task.id, `v${task.research.version}`);

// Storage primitive only: no production WorkBuddy callback is connected yet.
export function finishResearch(config, task, response) {
  let value;
  try { value = JSON.parse(String(response).replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")); }
  catch { throw new ResearchFailure("RESEARCH_DELIVERY_INVALID", "真实执行已结束，但返回的 MD+JSON 技术封装不合法", 422); }
  if (Object.keys(value ?? {}).sort().join(",") !== "markdown,snapshot")
    throw new ResearchFailure("RESEARCH_DELIVERY_INVALID", "双成果封装字段无效", 422);
  return finishResearchFiles(config, task, value.markdown, JSON.stringify(value.snapshot, null, 2), response);
}

// Original file text is kept byte-for-byte (UTF-8); JSON parsing is validation,
// not a request to reformat or rewrite the returned business artifact.
export function finishResearchFiles(config, task, md, json, response = "") {
  let snapshot;
  try { snapshot = JSON.parse(json); }
  catch { throw new ResearchFailure("RESEARCH_DELIVERY_INVALID", "JSON 原件无法完整解析", 422); }
  if (typeof md !== "string" || !md.trim() || typeof json !== "string" || !validDim03(snapshot))
    throw new ResearchFailure("RESEARCH_DELIVERY_INVALID", "完整 MD 或 DIM-03 v5 JSON 原件无效", 422);
  if (Buffer.byteLength(md) + Buffer.byteLength(json) > 8 * 1024 * 1024)
    throw new ResearchFailure("RESEARCH_DELIVERY_TOO_LARGE", "成果超出存储限额；不截断、不标成功", 413);
  const directory = resultDir(config, task), parent = dirname(directory);
  if (existsSync(directory)) throw new ResearchFailure("RESEARCH_RESULT_IMMUTABLE", "不得覆盖既有原始研究版本", 409);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.delivery-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 });
  const manifest = { taskId: task.id, ...task.research, createdAt: new Date().toISOString(),
    markdown: { sha256: digest(md), bytes: Buffer.byteLength(md) },
    json: { sha256: digest(json), bytes: Buffer.byteLength(json) }, rawSha256: digest(response) };
  durableFile(join(staging, "research.md"), md);
  durableFile(join(staging, "research.json"), json);
  durableFile(join(staging, "raw-response.txt"), response);
  durableFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
  durableDirectory(staging);
  renameSync(staging, directory);
  durableDirectory(parent);
  task.research.delivery = { markdown: manifest.markdown, json: manifest.json, createdAt: manifest.createdAt };
  return manifest;
}

export function researchResult(config, task) {
  if (task.status !== "completed" || !task.research?.delivery || !nativeVerified(task))
    throw new ResearchFailure("RESEARCH_RESULT_NOT_READY", "研究尚未形成可交付的同版本 MD+JSON", 409);
  try {
    const dir = resultDir(config, task), md = readFileSync(join(dir, "research.md"), "utf8"), raw = readFileSync(join(dir, "research.json"), "utf8");
    if (digest(md) !== task.research.delivery.markdown.sha256 || digest(raw) !== task.research.delivery.json.sha256)
      throw new Error("integrity");
    return { ...researchView(task), readonly: true, markdown: md, jsonText: raw, json: JSON.parse(raw), snapshot: JSON.parse(raw),
      integrity: task.research.delivery };
  } catch { throw new ResearchFailure("RESEARCH_RESULT_INTEGRITY_FAILED", "原始成果缺失或完整性校验失败", 409); }
}

export function researchView(task) {
  const r = task.research;
  return { taskId: task.id, projectId: r.projectId, dimensionId: r.dimensionId, cycleId: r.cycleId,
    resultVersion: r.version, skillName: r.skillName, skillVersion: r.skillVersion,
    skillSha256: r.skillSha256, schemaVersion: r.schemaVersion,
    status: task.status === "completed" ? (r.delivery ? "succeeded" : "delivery_failed") : task.status,
    executor: { deviceId: r.deviceId, name: r.executor ?? "unverified", runtimeMode: task.runtimeMode ?? null },
    createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    phase: r.localPull?.phase ?? null,
    nativeInvocationVerified: nativeVerified(task),
    failure: task.error ? { code: r.deliveryError || "RESEARCH_FAILED", message: String(task.error) } : null,
    resultAvailable: task.status === "completed" && Boolean(r.delivery) && nativeVerified(task) };
}

const nativeVerified = task => task.research?.localPull?.nativeVerified === true ||
  (task.research?.executor === "codex-local" && task.research?.nativeEvidence?.verified === true);

export function researchRunner(config, runner) {
  return async (task, context) => {
    if (task.research?.executor === "codex-local") {
      const codex=services.get(config)?.codex;
      if (!codex) throw new ResearchFailure("CODEX_RESEARCH_NOT_CONFIGURED", "Codex专业研究未配置");
      return codex.run(task,context);
    }
    if (task.research)
      throw new ResearchFailure("RESEARCH_EXECUTOR_NOT_VERIFIED", "专业研究需通过对应执行适配的能力与成果验证；禁止回退到通用 Runner");
    return runner(task, context);
  };
}
