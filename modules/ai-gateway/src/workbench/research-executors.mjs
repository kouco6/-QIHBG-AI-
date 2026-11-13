/** One immutable Skill package and one task/result contract for all executors. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "./skill-store.mjs";

export const EXECUTOR_IDS = ["workbuddy-local", "codex-local", "model-api", "workbuddy-api"];
// Minimum future adapter contract (only local-pull is implemented this round):
// capabilities() -> configured/authorized/nativeSkill/retrieval/evidenceVerified
// prepare(task, skillManifest, dataPolicy) -> bound taskId + complete package hashes
// startOrClaim(taskId) -> executorRunId/claimId; status(taskId) -> actual state
// collect(taskId) -> original MD+JSON + hashes + source/tool/native-call evidence
// verify(taskId, resultManifest) -> completion decision on the SAME TaskManager task
// No adapter may create a parallel task store or choose a paid fallback itself.
export class ExecutorError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new ExecutorError(code, message, status); };
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function loadResearchSkill(settings) {
  const binding = settings?.skill;
  if (!binding || !isAbsolute(settings.skillRoot ?? "") || !/^[A-Za-z0-9_-]{1,100}$/.test(binding.name ?? "") ||
      typeof binding.version !== "string" || !binding.version || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? ""))
    fail("PROFESSIONAL_SKILL_BINDING_REQUIRED", "需配置同一正式专业 Skill 的名称、版本和文件摘要");
  const directory = join(settings.skillRoot, binding.name), file = join(directory, "SKILL.md");
  if (!existsSync(file)) fail("PROFESSIONAL_SKILL_MISSING", "正式专业 Skill 文件缺失");
  const files = [];
  const read = (path, relative) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024)
      fail("SKILL_PACKAGE_UNSAFE", "Skill 文件无效、越界或过大，不截断");
    const raw = readFileSync(path);
    new TextDecoder("utf-8", {fatal:true}).decode(raw);
    files.push({path:relative,sha256:sha256(raw),bytes:raw.length});
    return raw;
  };
  if (lstatSync(settings.skillRoot).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
    fail("SKILL_PACKAGE_UNSAFE", "Skill 根目录不得使用符号链接");
  const raw = read(file,"SKILL.md"), {meta} = parseFrontmatter(raw.toString("utf8"));
  if (meta.name !== binding.name || sha256(raw) !== binding.sha256 || (meta.version && meta.version !== binding.version))
    fail("SKILL_VERSION_MISMATCH", "正式 Skill 名称、版本或摘要与批准配置不符",409);
  const walk = (path, relative) => {
    if (!existsSync(path)) return;
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) fail("SKILL_PACKAGE_UNSAFE","Skill references 目录无效");
    for (const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) fail("SKILL_PACKAGE_UNSAFE","Skill references 不得使用符号链接");
      if (entry.isDirectory()) walk(join(path,entry.name),relative+"/"+entry.name);
      else read(join(path,entry.name),relative+"/"+entry.name);
      if (files.length>64) fail("SKILL_PACKAGE_TOO_LARGE","Skill 资源过多，不截断");
    }
  };
  // Include every resource, not only references, and reject oversized packages
  // instead of clipping rules. SKILL.md itself was already included above.
  for (const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(entry.name==="SKILL.md")continue;
    if(entry.isSymbolicLink())fail("SKILL_PACKAGE_UNSAFE","Skill 资源不得使用符号链接");
    if(entry.isDirectory())walk(join(directory,entry.name),entry.name);
    else read(join(directory,entry.name),entry.name);
  }
  if(files.length>64 || files.reduce((n,f)=>n+f.bytes,0)>4*1024*1024)
    fail("SKILL_PACKAGE_TOO_LARGE","完整 Skill 包超限，不截断");
  const packageSha256=sha256(JSON.stringify(files));
  if(files.length>1&&!binding.packageSha256)
    fail("PROFESSIONAL_SKILL_BINDING_REQUIRED","含附属资源的 Skill 必须批准完整包摘要");
  if (binding.packageSha256 && binding.packageSha256!==packageSha256)
    fail("SKILL_VERSION_MISMATCH","Skill references 包摘要发生变化",409);
  // The package manifest is evidence of integrity, not evidence of native invocation.
  return {dimensionId:"DIM-03",name:binding.name,version:binding.version,schemaVersion:"v5",
    sha256:sha256(raw),packageSha256,files,nativeInvocationVerified:false};
}
export function executorCatalog(settings = {}) {
  return EXECUTOR_IDS.map(id => ({ id, configured:id==="workbuddy-local" && settings.enabled===true,
    authorized:id==="workbuddy-local" && settings.enabled===true,
    capabilityVerified:id==="workbuddy-local" && settings.capabilityVerified===true && settings.verifierReady===true,
    transport:id==="workbuddy-local"?"local-pull":null,
    paidFallbackAllowed:false, internalDataTransferAllowed:false }));
}
export function selectExecutor(settings, {selectionMode="manual",executorId="workbuddy-local"} = {}) {
  if (!["manual","auto"].includes(selectionMode)) fail("INVALID_EXECUTOR_SELECTION","执行器选择模式无效",422);
  const available=executorCatalog(settings);
  const selected=selectionMode==="auto"
    ? available.find(e=>e.configured&&e.authorized&&e.capabilityVerified)
    : available.find(e=>e.id===executorId);
  if (!selected?.configured || !selected.authorized ||
      (!selected.capabilityVerified && !(selectionMode==="manual" && settings.verificationMode===true)))
    fail("RESEARCH_EXECUTOR_NOT_VERIFIED","没有满足配置、授权及能力验证条件的执行器；未切换其他执行路径");
  return selected;
}
