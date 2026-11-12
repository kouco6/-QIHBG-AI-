/**
 * Flow templates: linear AI-employee pipelines ("codex 设计 → 豆包 编码 → kimi 测试").
 *
 * A flow is a small ordered list of steps; each step names an employee (fixed or
 * auto-routed), a prompt template with placeholders, and the expected output type.
 * Templates persist in state/flows.json next to the task state; runs live in the
 * same file so a restart can pause in-flight runs instead of losing them.
 *
 * Placeholder grammar (validated at save time, resolved at run time):
 *   {{input}}            the flow-level task description
 *   {{previous.output}}  the finished output of the step right before this one
 *   {{previous.files}}   the artifact list (paths + line counts) of that step
 *   {{previous.summary}} the short summary of that step
 *   {{steps.<key>.output}}  output of any earlier step, by its stable key
 *   {{steps.<key>.files}}   artifact list of any earlier step
 *   {{<varName>}}        a declared flow variable
 *
 * Artifacts (工件化): a step's answer is turned into real files under
 * `<cwd>/.flows/<runId>/<NN-key>/`, and downstream steps receive the file list
 * instead of the whole text. `{{*.output}}` keeps its old full-text meaning so
 * existing flows behave exactly as before.
 *
 * Checkpoints (检查点): a step may carry `checkpoint: {enabled, agentId, criteria}`.
 * When enabled the run stops after that step: an employee (or nobody) inspects the
 * output, and a human must click "通过" before the next step starts. The old
 * `approval: "manual"` flag is read as "checkpoint with no AI inspector" so
 * flows saved before this feature keep working.
 *
 * Friendly defaults: `key` and variable `name` are internal identifiers. They are
 * optional now — missing or non-ASCII values get generated ones, so a non-technical
 * user only types names, prompts and check criteria.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const NAME_MAX = 30;
const DESCRIPTION_MAX = 200;
const STEP_NAME_MAX = 20;
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
const VAR_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
const MIN_STEPS = 2;
const MAX_STEPS = 12;
const MAX_FLOWS = 50;
const MAX_RUNS = 100;
const OUTPUT_TYPES = ["markdown", "code", "document", "json", "text"];
// 工件化开关：auto = 把产出落成文件并向下游传文件清单；none = 纯文本传递（讨论类步骤）。
const OUTPUT_FILE_MODES = ["auto", "none"];
// 工具开关（仅对云端员工生效，codex 自带工具不受影响）：
// auto = 读写文件 + 执行命令；files = 只读写文件；none = 只对话。
const TOOL_MODES = ["auto", "files", "none"];
// 节点类型：task = 派员工干活；condition = 派员工做判断，按选项走不同出线。
const STEP_KINDS = ["task", "condition"];
// 条件节点出线选项的边界：2~5 个，每个最多 20 字。
const CONDITION_OPTIONS_MIN = 2;
const CONDITION_OPTIONS_MAX = 5;
const CONDITION_OPTION_MAX = 20;
// 技能挂载：单个流程/步骤最多挂 8 个，名字最长 80 字（平台包名不会超过这个长度）。
const SKILLS_PER_TARGET = 8;
const SKILL_NAME_MAX = 80;
export const DEFAULT_CONDITION_OPTIONS = ["满足", "不满足"];
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const STEP_REF = /^steps\.([\w-]+)\.(output|files|summary)$/;
const PREV_REF = /^previous\.(output|files|summary)$/;
const RESERVED_VARS = ["input", "previous", "steps"];
// 小白只填「查什么」，这里给一份默认检查口径，免得他不知道该写什么。
export const DEFAULT_CHECK_CRITERIA = [
  "产出是否真的回答了这一步要的东西，没有跑题",
  "有没有明显缺漏、自相矛盾或没做完的地方",
  "下游能不能直接拿去用（文件、路径、结论是否齐全）",
].join("\n");

const readJson = (file) => {
  if (!file || !existsSync(file)) return { flows: [], runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      flows: Array.isArray(parsed.flows) ? parsed.flows : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    // A torn file must not brick the gateway: start empty, the next save rewrites it.
    return { flows: [], runs: [] };
  }
};

/** Write-then-rename, same contract as agent-config. */
const writeJsonAtomic = (file, data) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
  try { chmodSync(file, 0o600); } catch { /* windows: ACLs, not modes */ }
};

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Extract every placeholder name used in a prompt template. */
export function collectReferences(template) {
  const found = new Set();
  for (const match of String(template ?? "").matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found];
}

/** 老流程兜底：没有连线信息时按数组顺序接成一条链。 */
export function chainEdges(steps) {
  return steps.slice(1).map((step, index) => ({ from: steps[index].key, to: step.key, branch: "" }));
}

/**
 * Classify references against a flow definition.
 * `edges` 给出时按连线判断「上一步」和「上游」：previous = 第一条入线的来源，
 * steps.<key> 只允许引用画布上真的连进来的上游节点；不传时按数组顺序视为链式（老流程）。
 * @returns {{errors: string[], unknown: string[]}} errors are human-readable blockers
 */
export function checkReferences(steps, variables, inputAllowed = true, edges = null) {
  const errors = [];
  const edgeList = edges ?? chainEdges(steps);
  const direct = new Map(steps.map((step) => [step.key, new Set()]));
  const firstIncoming = new Map();
  for (const edge of edgeList) {
    if (!direct.has(edge.to) || !direct.has(edge.from)) continue;
    direct.get(edge.to).add(edge.from);
    if (!firstIncoming.has(edge.to)) firstIncoming.set(edge.to, edge.from);
  }
  // 反向 BFS：一个节点能顺着连线摸到的所有上游
  const upstreamOf = (key) => {
    const seen = new Set();
    const stack = [...(direct.get(key) ?? [])];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(direct.get(current) ?? []));
    }
    return seen;
  };
  const legacy = edges === null;

  for (const [index, step] of steps.entries()) {
    const templates = [step.promptTemplate, step.question].filter(Boolean);
    const ups = upstreamOf(step.key);
    const previousKey = firstIncoming.get(step.key) ?? null;
    for (const template of templates) {
      for (const ref of collectReferences(template)) {
        if (ref === "input") {
          if (!inputAllowed) errors.push(`步骤 ${index + 1}：{{input}} 不可用`);
          continue;
        }
        if (ref.startsWith("previous.")) {
          const prevRef = ref.match(PREV_REF);
          if (!prevRef) {
            errors.push(`步骤 ${index + 1} 引用了未知的 {{${ref}}}，可用的是 previous.output / previous.files / previous.summary`);
            continue;
          }
          if (!previousKey) {
            errors.push(legacy
              ? `步骤 ${index + 1} 是第一步，没有「上一步产出」可引用`
              : `步骤「${step.name}」没有连线接入，没有「上一步产出」可引用`);
          }
          continue;
        }
        if (ref.startsWith("steps.")) {
          const stepsRef = ref.match(STEP_REF);
          if (!stepsRef) {
            errors.push(`步骤 ${index + 1} 引用了未知的 {{${ref}}}，可用的是 steps.<key>.output / steps.<key>.files / steps.<key>.summary`);
            continue;
          }
          const target = stepsRef[1];
          const reachable = ups.has(target);
          if (!reachable) {
            errors.push(legacy
              ? `步骤 ${index + 1} 引用了 {{${ref}}}，但步骤 ${target} 不在本步骤之前`
              : `步骤「${step.name}」引用了 {{${ref}}}，但「${target}」没有连线接到这一步`);
          }
          continue;
        }
        if (variables.some((variable) => variable.name === ref)) continue;
        errors.push(`步骤 ${index + 1} 引用了未定义的 {{${ref}}}`);
      }
    }
  }
  return { errors, unknown: [] };
}

/**
 * Fill a prompt template. Unknown variables resolve to "" only if not required;
 * callers validate required variables before starting the run.
 *
 * `files` and `summaries` are keyed by step key and hold pre-formatted strings —
 * the runner owns the formatting so the template engine stays dumb.
 */
export function resolvePrompt(
  template,
  { input = "", variables = {}, outputs = {}, files = {}, summaries = {}, previousKey = null } = {},
) {
  return String(template ?? "").replace(PLACEHOLDER, (_, ref) => {
    if (ref === "input") return input;
    const prevRef = ref.match(PREV_REF);
    if (prevRef) {
      if (previousKey == null) return "";
      const [, field] = prevRef;
      if (field === "files") return files[previousKey] ?? "";
      if (field === "summary") return summaries[previousKey] ?? "";
      return outputs[previousKey] ?? "";
    }
    const stepsRef = ref.match(STEP_REF);
    if (stepsRef) {
      const [, key, field] = stepsRef;
      if (field === "files") return files[key] ?? "";
      if (field === "summary") return summaries[key] ?? "";
      return outputs[key] ?? "";
    }
    return variables[ref] ?? "";
  });
}

/** 校验并归一化一份流程定义；创建和更新共用。 */
export function normalizeFlowPayload(config, payload = {}, existing = null) {
  const name = String(payload.name ?? "").trim();
  if (!name) throw new Error("先给流程起个名字");
  if (name.length > NAME_MAX) throw new Error(`流程名称最多 ${NAME_MAX} 个字`);
  const description = String(payload.description ?? "").trim();
  if (description.length > DESCRIPTION_MAX) throw new Error(`流程说明最多 ${DESCRIPTION_MAX} 个字`);

  // 技能名只是引用：装没装由本地库决定，这里只收敛形状（去空、去重、限长、限个数）。
  const normalizeSkills = (rawList) => {
    const list = [];
    for (const raw of Array.isArray(rawList) ? rawList : []) {
      const skillName = String(raw ?? "").trim();
      if (!skillName || skillName.length > SKILL_NAME_MAX || list.includes(skillName)) continue;
      list.push(skillName);
      if (list.length >= SKILLS_PER_TARGET) break;
    }
    return list;
  };

  if (!Array.isArray(payload.steps)) throw new Error("流程至少要有步骤列表");
  if (payload.steps.length < MIN_STEPS) throw new Error(`流程至少需要 ${MIN_STEPS} 个步骤`);
  if (payload.steps.length > MAX_STEPS) throw new Error(`流程最多 ${MAX_STEPS} 个步骤`);

  const knownAgents = new Set(
    (config.flowAgentIds ? config.flowAgentIds() : ["codex", ...Object.keys(config.agents ?? {})])
  );
  const seenKeys = new Set();
  const steps = payload.steps.map((raw, index) => {
    const source = raw && typeof raw === "object" ? raw : {};
    // key 只是给占位符用的内部标识：没填或写了中文就自动补一个，不拦人。
    let key = String(source.key ?? "").trim();
    if (!KEY_PATTERN.test(key) || seenKeys.has(key)) {
      let n = index + 1;
      while (seenKeys.has(`step${n}`)) n += 1;
      key = `step${n}`;
    }
    seenKeys.add(key);
    const stepName = String(source.name ?? "").trim();
    if (!stepName) throw new Error(`第 ${index + 1} 步还没写名称`);
    if (stepName.length > STEP_NAME_MAX) throw new Error(`步骤 ${index + 1} 名称最多 ${STEP_NAME_MAX} 个字`);

    const kind = STEP_KINDS.includes(source.kind) ? source.kind : "task";

    // 画布上的摆放位置（编排器用），纯展示字段，不影响执行。
    const rawUi = source.ui && typeof source.ui === "object" ? source.ui : {};
    const uiX = Number(rawUi.x);
    const uiY = Number(rawUi.y);
    const ui = Number.isFinite(uiX) && Number.isFinite(uiY)
      ? { x: Math.max(0, Math.round(uiX)), y: Math.max(0, Math.round(uiY)) }
      : null;

    // 条件节点：只派一个员工判断走哪个出线，不走产出流水线那套字段。
    if (kind === "condition") {
      const agentId = String(source.agentId ?? "").trim();
      if (!agentId) throw new Error(`条件节点「${stepName}」需要指定谁来判断`);
      if (!knownAgents.has(agentId)) throw new Error(`条件节点「${stepName}」指定的员工 ${agentId} 不存在`);
      const question = String(source.question ?? "").trim();
      if (!question) throw new Error(`条件节点「${stepName}」需要写一句判断问题，比如「方案里有没有包含报价」`);
      if (question.length > 4000) throw new Error(`条件节点「${stepName}」的判断问题超过 4000 字`);
      // 出线选项：空项剔除、去重；没写或只剩一个就退回「满足/不满足」双出口（老行为）。
      const rawOptions = Array.isArray(source.options) ? source.options : [];
      const options = [];
      for (const raw of rawOptions) {
        const option = String(raw ?? "").trim().slice(0, CONDITION_OPTION_MAX);
        if (option && !options.includes(option)) options.push(option);
      }
      const finalOptions = options.length >= CONDITION_OPTIONS_MIN
        ? options.slice(0, CONDITION_OPTIONS_MAX)
        : [...DEFAULT_CONDITION_OPTIONS];
      const stepSkills = normalizeSkills(source.skills);
      return {
        key,
        name: stepName,
        kind,
        agentMode: "fixed",
        agentId,
        question,
        options: finalOptions,
        ...(stepSkills.length ? { skills: stepSkills } : {}),
        ...(ui ? { ui } : {}),
      };
    }

    const agentMode = source.agentMode === "auto" ? "auto" : "fixed";
    const agentId = String(source.agentId ?? "").trim();
    if (agentMode === "fixed") {
      if (!agentId) throw new Error(`步骤「${stepName}」需要指定员工，或改为自动路由`);
      if (!knownAgents.has(agentId)) throw new Error(`步骤「${stepName}」指定的员工 ${agentId} 不存在`);
    }

    const promptTemplate = String(source.promptTemplate ?? "").trim();
    if (!promptTemplate) throw new Error(`步骤「${stepName}」需要提示词`);
    if (promptTemplate.length > 20_000) throw new Error(`步骤「${stepName}」的提示词超过 2 万字`);

    const outputType = OUTPUT_TYPES.includes(source.outputType) ? source.outputType : "markdown";
    const outputFiles = OUTPUT_FILE_MODES.includes(source.outputFiles) ? source.outputFiles : "auto";
    const tools = TOOL_MODES.includes(source.tools) ? source.tools : "auto";
    // 这一步自己挂的工作方法：比流程级的更精确，能和流程级叠加。
    const stepSkills = normalizeSkills(source.skills);

    // 检查点：新结构优先；老流程里的 approval=manual 等价于「只让我自己确认」。
    const rawCheck = source.checkpoint && typeof source.checkpoint === "object" ? source.checkpoint : {};
    const legacyManual = source.approval === "manual" && source.checkpoint === undefined;
    const checkpointEnabled = rawCheck.enabled === true || (rawCheck.enabled === undefined && legacyManual);
    const checkAgentId = String(rawCheck.agentId ?? "").trim();
    if (checkpointEnabled && checkAgentId && !knownAgents.has(checkAgentId)) {
      throw new Error(`步骤「${stepName}」的检查员工 ${checkAgentId} 不存在`);
    }
    const checkpoint = {
      enabled: checkpointEnabled,
      // 空字符串 = 不派员工，只等人打开看。
      agentId: checkpointEnabled ? checkAgentId : "",
      criteria: String(rawCheck.criteria ?? "").trim().slice(0, 600),
    };

    return {
      key,
      name: stepName,
      kind: "task",
      agentMode,
      agentId,
      promptTemplate,
      outputType,
      outputFiles,
      tools,
      checkpoint,
      ...(stepSkills.length ? { skills: stepSkills } : {}),
      ...(ui ? { ui } : {}),
    };
  });
  // 连线：画布上真正的执行顺序。老流程没存连线，按数组顺序接成一条链，行为不变。
  const stepByKey = new Map(steps.map((step) => [step.key, step]));
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : null;
  const edges = (rawEdges ? rawEdges.map((raw, index) => {
    const source = raw && typeof raw === "object" ? raw : {};
    const from = String(source.from ?? "").trim();
    const to = String(source.to ?? "").trim();
    if (!stepByKey.has(from)) throw new Error(`第 ${index + 1} 条连线的起点 ${from || "(空)"} 不是流程里的节点`);
    if (!stepByKey.has(to)) throw new Error(`第 ${index + 1} 条连线的终点 ${to || "(空)"} 不是流程里的节点`);
    if (from === to) throw new Error(`连线不能从「${stepByKey.get(from).name}」连回它自己`);
    const branch = String(source.branch ?? "").trim();
    const sourceKind = stepByKey.get(from).kind;
    if (sourceKind === "condition") {
      const sourceStep = stepByKey.get(from);
      const options = Array.isArray(sourceStep.options) && sourceStep.options.length
        ? sourceStep.options
        : [...DEFAULT_CONDITION_OPTIONS];
      if (!branch) {
        throw new Error(`条件节点「${sourceStep.name}」的每条出线都要标明走哪个选项（${options.join(" / ")}）`);
      }
      let want = branch;
      if (!options.includes(want)) {
        // 老流程/老编辑器的 yes/no 出线映射到等价选项文案
        if (branch === "yes") want = options.includes("满足") ? "满足" : options[0];
        else if (branch === "no") want = options.includes("不满足") ? "不满足" : options[options.length - 1];
      }
      if (!options.includes(want)) {
        throw new Error(`条件节点「${sourceStep.name}」没有「${branch}」这个出线选项，可用的是：${options.join(" / ")}`);
      }
      return { from, to, branch: want };
    }
    if (branch) {
      throw new Error(`只有条件节点的出线才能带分支，「${stepByKey.get(from).name}」的不用`);
    }
    return { from, to, branch };
  })
    // 老流程没存连线：按数组顺序接成一条链；链上的条件出线默认走第一个选项（等价于老的「满足」）。
    : chainEdges(steps).map((edge) => {
      const sourceStep = stepByKey.get(edge.from);
      if (sourceStep?.kind !== "condition") return edge;
      const options = Array.isArray(sourceStep.options) && sourceStep.options.length
        ? sourceStep.options
        : [...DEFAULT_CONDITION_OPTIONS];
      return { ...edge, branch: edge.branch || options[0] };
    }));

  const edgeSeen = new Set();
  for (const edge of edges) {
    const signature = `${edge.from}>${edge.to}`;
    if (edgeSeen.has(signature)) {
      throw new Error(`「${stepByKey.get(edge.from).name}」到「${stepByKey.get(edge.to).name}」之间已经有连线了`);
    }
    edgeSeen.add(signature);
  }
  // 有环就永远跑不完：从每个节点出发做一遍 DFS。
  for (const step of steps) {
    const visiting = new Set();
    const stack = [step.key];
    while (stack.length) {
      const current = stack.pop();
      if (current === step.key && visiting.has(current)) {
        throw new Error(`流程连线绕成了圈，从「${step.name}」出发会回到它自己；先解开环再保存`);
      }
      if (visiting.has(current)) continue;
      visiting.add(current);
      for (const edge of edges) if (edge.from === current) stack.push(edge.to);
    }
  }
  // 条件节点至少要有一条出线，否则判断结果哪儿也去不了。
  for (const step of steps) {
    if (step.kind !== "condition") continue;
    if (!edges.some((edge) => edge.from === step.key)) {
      throw new Error(`条件节点「${step.name}」还没有拉出任何连线，判断结果没人接`);
    }
  }

  const rawVariables = Array.isArray(payload.variables) ? payload.variables : [];
  const variableNames = new Set();
  const variables = rawVariables.map((raw, index) => {
    const source = raw && typeof raw === "object" ? raw : {};
    const typed = String(source.name ?? "").trim();
    // 变量名同样降级为内部标识：留空或写中文时自动编号，展示用的是 label。
    let varName = typed;
    if (!VAR_PATTERN.test(varName) || variableNames.has(varName)) {
      let n = index + 1;
      while (variableNames.has(`var${n}`) || RESERVED_VARS.includes(`var${n}`)) n += 1;
      varName = `var${n}`;
    }
    variableNames.add(varName);
    const description = String(source.description ?? "").trim().slice(0, 60);
    const looksHuman = typed && !VAR_PATTERN.test(typed);
    const label = (String(source.label ?? "").trim() || (looksHuman ? typed : "") || description || varName).slice(0, 20);
    return {
      name: varName,
      label,
      description,
      required: source.required === true,
      defaultValue: String(source.defaultValue ?? ""),
    };
  });

  const { errors } = checkReferences(steps, variables, true, edges);
  if (errors.length) throw new Error(errors[0]);

  // 流程级技能：所有步骤都会带上；步骤自己挂的会再加在前面。
  const skills = normalizeSkills(payload.skills);

  return {
    name,
    description,
    variables,
    steps,
    edges,
    skills,
    status: payload.status === "disabled" ? "disabled" : "active",
  };
}

export class FlowStore {
  constructor({ file }) {
    this.file = file;
    const data = readJson(file);
    this.flows = data.flows;
    this.runs = data.runs;
  }

  save() {
    writeJsonAtomic(this.file, { flows: this.flows.slice(0, MAX_FLOWS), runs: this.runs.slice(-MAX_RUNS) });
  }

  listFlows() {
    return this.flows.filter((flow) => flow.status !== "deleted");
  }

  getFlow(id) {
    return this.flows.find((flow) => flow.id === id && flow.status !== "deleted") ?? null;
  }

  createFlow(config, payload) {
    const normalized = normalizeFlowPayload(config, payload);
    if (this.listFlows().some((flow) => flow.name === normalized.name)) {
      throw new Error(`已经有叫「${normalized.name}」的流程`);
    }
    const flow = {
      id: newId("flow"),
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...normalized,
    };
    this.flows.push(flow);
    this.save();
    return flow;
  }

  updateFlow(config, id, payload) {
    const flow = this.getFlow(id);
    if (!flow) throw new Error(`未知流程：${id}`);
    const normalized = normalizeFlowPayload(config, payload, flow);
    const others = this.listFlows().filter((item) => item.id !== id);
    if (others.some((item) => item.name === normalized.name)) {
      throw new Error(`已经有叫「${normalized.name}」的流程`);
    }
    // 决策 7：实质修改自动产生新版本；运行实例里存了当时的步骤快照，所以旧运行可追溯。
    const changed = JSON.stringify({ s: flow.steps, v: flow.variables }) !==
      JSON.stringify({ s: normalized.steps, v: normalized.variables });
    Object.assign(flow, normalized, {
      version: changed ? flow.version + 1 : flow.version,
      updatedAt: new Date().toISOString(),
    });
    this.save();
    return flow;
  }

  deleteFlow(id) {
    const flow = this.getFlow(id);
    if (!flow) throw new Error(`未知流程：${id}`);
    flow.status = "deleted";
    flow.updatedAt = new Date().toISOString();
    this.save();
    return { id, deleted: true };
  }

  listRuns() {
    return [...this.runs].reverse();
  }

  getRun(id) {
    return this.runs.find((run) => run.id === id) ?? null;
  }

  upsertRun(run) {
    const index = this.runs.findIndex((item) => item.id === run.id);
    if (index === -1) this.runs.push(run);
    else this.runs[index] = run;
    this.save();
  }

  /** 决策 10：重启后把没跑完的流程统一恢复为「已暂停」，等人工继续。 */
  recoverOnBoot() {
    let recovered = 0;
    for (const run of this.runs) {
      if (!["running", "waiting", "checking"].includes(run.status)) continue;
      // 正在检查的步骤本身跑完了，回到「等确认」比判失败更贴近事实。
      const wasChecking = run.status === "checking";
      run.status = "paused";
      run.note = wasChecking ? "网关重启，检查中断；这一步的产出已保留，可人工确认或重试" : "网关重启，运行已暂停";
      const running = run.stepStates?.find((step) => step.status === "running" || step.status === "checking");
      if (running) {
        running.status = "pending";
        running.error = "任务因网关重启中断，可从本步重试";
        if (running.check) running.check = { ...running.check, status: "interrupted" };
      }
      recovered += 1;
    }
    if (recovered) this.save();
    return recovered;
  }
}
