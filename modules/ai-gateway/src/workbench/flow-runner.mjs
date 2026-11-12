/**
 * Flow execution engine: walks the flow as a graph, creating one real task
 * per task-node through the existing TaskManager. Because every step IS a task,
 * the workbench keeps its queue, SSE stream, artifacts and history for free.
 *
 * 调度模型（图执行，按层并行的 BSP 风格）：
 *   - 每一轮把「所有入线来源都完成且至少一条线激活」的节点一起开跑；
 *   - 同一轮的节点互不等待，天然并行；下一轮等本轮全部结束（汇合点 = 所有入线齐活）；
 *   - 条件节点不产出，派员工判断该走哪个出线选项（默认「满足 / 不满足」，可配 2~5 个），
 *     只有匹配分支的出线被激活；
 *   - 被分支关掉的下游节点标记 skipped（跳过），不算失败也不占任务。
 *
 * Run states (决策 2/3/10 落地):
 *   running  at least one node is executing
 *   waiting  a finished node asked for manual approval (决策 3)
 *   paused   a node failed or a guard tripped; existing results are kept (决策 2/8/10)
 *   success | failed | cancelled  terminal
 *
 * Retry (决策 4) re-runs from the first failed node; earlier outputs are reused.
 */

import { dirname, join, relative, resolve, sep } from "node:path";

import { createToolSandbox } from "./agent-tools.mjs";
import { describeArtifact, writeRunManifest, writeStepArtifacts } from "./artifact-writer.mjs";
import { assertAgentUsable, recommendAgent } from "./agents.mjs";
import { stepPayload } from "./flow-events.mjs";
import { DEFAULT_CHECK_CRITERIA, resolvePrompt } from "./flows.mjs";
import { parseResult } from "./parse.mjs";
import { applyChanges, prepareWorkspace, removeWorkspace, summarizeChanges, workspaceMode } from "./run-workspace.mjs";

const TERMINAL_TASK_STATUS = ["completed", "failed", "interrupted", "cancelled", "archived"];
const POLL_INTERVAL_MS = 800;
const SUMMARY_MAX = 400;
const LIST_MAX = 40;
const CHECK_OUTPUT_MAX = 6000;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const CHECK_VERDICT_LABEL = { pass: "通过", fail: "不通过", unknown: "没给出明确结论" };

/**
 * 把子任务的当前状态翻译成一句人话。
 * 只从状态字段取，不读事件流里的 token —— 按产品口径，过程只到「步骤」这一层。
 */
export const taskProgressText = (task) => {
  if (!task) return "";
  const status = task.status;
  if (status === "queued") return "排队中，等前面的任务让出位置";
  if (status === "draft") return "还没派发";
  if (status === "approval_required") return "等你批准一个操作";
  if (status === "quota_exhausted") return "额度用完了，等你处理";
  if (status === "waiting_user") return "需要你补充信息";
  if (status !== "running") return "";
  // 有首字输出之后才算真的在产出；否则就是在准备
  if (!task.firstOutputAt && !task.lastOutputAt) return "已接手，正在准备";
  return "正在生成结果";
};

/**
 * 检查结论解析：先找「结论」那一行，避免把提示词里出现过的「不通过」当结论。
 * 员工不一定照格式写，所以整段兜底再判一次，最差也只是「没给出明确结论」。
 */
export const readCheckVerdict = (text) => {
  const body = String(text ?? "");
  const line = body
    .split("\n")
    .map((item) => item.replace(/^[#*\-\s>]+/, "").trim())
    .find((item) => /^(结论|判定|结果|verdict|result)(?![a-z])/i.test(item));
  const probe = (line ?? body.slice(0, 400)).toLowerCase();
  if (/不通过|未通过|不合格|不达标|有问题|fail|reject/.test(probe)) return "fail";
  if (/通过|合格|达标|可以继续|pass/.test(probe)) return "pass";
  return "unknown";
};

/**
 * 条件节点的判断词汇是「满足 / 不满足」，和检查点的「通过 / 不通过」不是一个词表，
 * 不能复用 readCheckVerdict——「结论：满足」会被它判成 unknown。
 */
export const readConditionVerdict = (text) => {
  const body = String(text ?? "");
  const line = body
    .split("\n")
    .map((item) => item.replace(/^[#*\-\s>]+/, "").trim())
    .find((item) => /^(结论|判定|结果|verdict|result)(?![a-z])/i.test(item));
  const probe = (line ?? body.slice(0, 400)).toLowerCase();
  if (/不满足|不成立|不符合|no\b|not\s+yes|fail/.test(probe)) return "fail";
  if (/满足|成立|符合|yes\b|pass/.test(probe)) return "pass";
  return "unknown";
};

/**
 * 多路分支的结论解析：从回答里找命中的选项文案。
 * 先看「结论：」那一行，再全文兜底；长选项优先——「不满足」包含「满足」，
 * 先比长的才不会被短选项吃掉。都没有命中返回 ""，由调用方按最后一项兜底。
 */
export const readConditionOption = (text, options) => {
  const body = String(text ?? "");
  const line = body
    .split("\n")
    .map((item) => item.replace(/^[#*\-\s>]+/, "").trim())
    .find((item) => /^(结论|判定|结果|verdict|result)(?![a-z])/i.test(item));
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const space of [line, body]) {
    if (!space) continue;
    for (const option of sorted) {
      if (option && space.includes(option)) return option;
    }
  }
  return "";
};

/** 从「问题：」小节里抽取条目，给前端渲染成清单。 */
export const readCheckIssues = (text) => {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => /^(问题|待改|需要改|issue|issues)(?![a-z])/i.test(line.replace(/^[#*\-\s>]+/, "")));
  if (start === -1) return [];
  const issues = [];
  for (let index = start + 1; index < lines.length && issues.length < 8; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    if (/^(结论|理由|建议|#{1,4}\s)/.test(raw)) break;
    const item = raw.replace(/^[-*•]\s*|^\d+[.、)]\s*/, "").trim();
    if (!item || /^无[。.]?$/.test(item)) continue;
    issues.push(item.slice(0, 200));
  }
  return issues;
};

/**
 * 检查的「理由」比「结论：通过」本身有用。先取理由行，再去掉标签前缀；
 * 员工没按格式写时退回第一行有内容的文字。
 */
const pickCheckSummary = (text) => {
  const lines = String(text ?? "")
    .split("\n")
    .map((item) => item.replace(/^[#*\-\s>]+/, "").trim())
    .filter(Boolean);
  const reason = lines.find((item) => /^(理由|说明|原因|reason)(?![a-z])/i.test(item));
  const fallback = lines.find((item) => item.length >= 4 && !/^(结论|判定|结果|verdict|result)(?![a-z])/i.test(item));
  const picked = (reason ?? fallback ?? "").replace(/^(理由|说明|原因|reason)\s*[：:]\s*/i, "").trim();
  if (!picked) return "";
  return picked.length > 240 ? `${picked.slice(0, 240)}…` : picked;
};

const pickLine = (text) => {
  const line = String(text ?? "")
    .split("\n")
    .map((item) => item.replace(/^[#*\-\s>]+/, "").trim())
    .find((item) => item.length >= 4);
  return line ? (line.length > 240 ? `${line.slice(0, 240)}…` : line) : "";
};

const publicRun = (run) => ({ ...run });
const stepDirName = (index, key) => `${String(index + 1).padStart(2, "0")}-${key}`;

/** Is `target` inside `dir`? Used to tell "archived copy" from "real project file". */
const insideDir = (dir, target) => {
  const base = resolve(dir);
  const absolute = resolve(target);
  return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
};

/**
 * 摘要要能被人读懂，所以跳过围栏内容、标题和列表符号。
 * 全是代码的回答没有可用摘要时，就说清楚产出了几个文件。
 */
const pickSummary = (parsed, fallbackText) => {
  const lines = [...(parsed.conclusions ?? []), ...String(fallbackText ?? parsed.plain ?? "").split("\n")];
  const usable = lines
    .map((line) => String(line).replace(/\s+/g, " ").trim())
    .find(
      (line) =>
        line.length >= 4 &&
        !line.startsWith("```") &&
        !line.startsWith("~~~") &&
        !line.startsWith("#") &&
        !line.startsWith("|") &&
        !/^[-*•]\s/.test(line),
    );
  if (!usable) return "";
  return usable.length > SUMMARY_MAX ? `${usable.slice(0, SUMMARY_MAX)}…` : usable;
};

/** One line per artifact: path + line count. Paths are relative to the run cwd. */const formatFileList = (files = [], cwd) =>
  files
    .filter((file) => file.source !== "missing")
    .slice(0, LIST_MAX)
    .map((file) => {
      const shown = cwd ? relative(cwd, file.absolute ?? file.path).replace(/\\/g, "/") : file.path;
      const lines = Number.isFinite(file.lines) ? ` · ${file.lines} 行` : "";
      const note = file.note ? ` — ${file.note}` : "";
      return `- \`${shown}\`${lines}${note}`;
    })
    .join("\n");

export class FlowRunner {
  constructor({ store, manager, config, skillStore = null, events = null }) {
    this.store = store;
    this.manager = manager;
    this.config = config;
    // 本地技能库（工作方法库）。为空时流程照旧跑，只是不挂技能。
    this.skillStore = skillStore;
    // 流程事件总线：只推步骤状态与产物清单，用来替代前端 3 秒全量轮询。
    // 为空时流程照常跑，只是前端拿不到推送。
    this.events = events;
    // 原地运行会写用户真实目录，同一目录同时只允许一个运行占着。
    this.inplaceLocks = new Map();
    // 重启后内存锁会丢，从还没结束的运行里重建，避免两个原地运行踩同一目录。
    for (const run of this.store.listRuns()) {
      if (run.workspace?.mode !== "inplace") continue;
      if (!["running", "waiting", "paused"].includes(run.status)) continue;
      const key = resolve(run.workspace.source);
      if (!this.inplaceLocks.has(key)) this.inplaceLocks.set(key, run.id);
    }
    // 已经结束的运行里不该还留着「在跑」的步骤：旧版本取消时漏收口，
    // 数据会一直存在磁盘上，重开面板就还是转圈，必须在启动时认一次。
    this.settleFinishedRuns();
  }

  /**
   * 终态运行的收口：把还挂着 pending / waiting / running / checking 的步骤
   * 归成「已取消」，并清掉取消造成的失败红字。返回修了几条，方便日志排查。
   * 只碰 success / failed / cancelled 的运行——暂停中的不能动，那是等人工继续的。
   */
  settleFinishedRuns() {
    const finished = ["success", "failed", "cancelled"];
    let repaired = 0;
    for (const run of this.store.listRuns()) {
      if (!finished.includes(run.status)) continue;
      let changed = false;
      for (const step of run.stepStates ?? []) {
        // 取消连带产生的「失败」也一起归零：不是步骤出错，是人叫停的
        if (run.status === "cancelled" && step.status === "failed" && /取消/.test(step.error ?? "")) {
          step.status = "cancelled";
          step.error = null;
          changed = true;
        }
        if (!["pending", "waiting", "running", "checking"].includes(step.status)) continue;
        step.status = "cancelled";
        step.progress = null;
        step.finishedAt = step.finishedAt ?? run.finishedAt ?? new Date().toISOString();
        if (step.check?.status === "running") step.check = { ...step.check, status: "cancelled" };
        changed = true;
      }
      if (run.status === "cancelled" && run.error) {
        run.error = null;
        changed = true;
      }
      if (!changed) continue;
      run.activeStepKeys = [];
      run.currentStepKey = null;
      repaired += 1;
    }
    // 批量改完再落一次盘：修一条写一次文件，重启会慢在无谓的 IO 上
    if (repaired) this.store.save();
    return repaired;
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * 发一条流程事件。事件只是「该重画了」的信号 + 折叠态要显示的计数，
   * 正文和完整产物清单仍由快照接口给，避免事件体膨胀。
   */
  #emit(run, type, data = {}) {
    this.events?.publish(run.id, type, data);
  }

  /** 步骤状态变化统一出口：先落库，再发事件。顺序不能反，否则前端重画时读到旧状态。 */
  #saveAndEmitStep(run, type, step) {
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    this.#emit(run, type, stepPayload(run, step));
  }

  /** 校验输入、冻结流程快照，然后异步开跑。立即返回 run 供前端渲染。 */
  start(flowId, { input = "", variables = {}, cwd: cwdOverride, mode: rawMode } = {}) {
    const flow = this.store.getFlow(flowId);
    if (!flow) throw new Error(`未知流程：${flowId}`);
    if (flow.status === "disabled") throw new Error(`流程「${flow.name}」已停用，先到流程编辑里启用`);

    const task = String(input ?? "").trim();
    if (!task) throw new Error("先写一句流程输入，告诉员工们要做什么");
    if (task.length > this.config.maxPromptChars) {
      throw new Error(`流程输入超过 ${this.config.maxPromptChars} 字`);
    }

    const resolvedVariables = {};
    for (const variable of flow.variables ?? []) {
      const value = String(variables?.[variable.name] ?? "").trim() || variable.defaultValue || "";
      if (variable.required && !value) throw new Error(`变量「${variable.name}」必填：${variable.description || ""}`);
      resolvedVariables[variable.name] = value;
    }

    const sourceCwd = cwdOverride || this.config.allowedRoots[0];
    const mode = workspaceMode(rawMode);
    this.#assertWorkspaceFree(sourceCwd, mode);

    const runId = newId("run");
    // 默认每次运行一份作业副本：源目录保持干净，并发/重试都不互相踩。
    const workspace = prepareWorkspace({
      runId,
      source: sourceCwd,
      mode,
      fallbackBase: this.config.stateFile ? join(dirname(this.config.stateFile), "workspaces") : null,
    });
    workspace.runId = runId;
    const cwd = workspace.path;
    // 工件目录放在 cwd 内部：Codex 的 workspace-write 沙盒只能写工作目录内的文件。
    const runDir = join(cwd, ".flows", runId);
    const run = {
      id: runId,
      flowId: flow.id,
      flowVersion: flow.version,
      flowName: flow.name,
      // 决策 7：运行实例冻结当时的节点/连线定义，之后模板怎么改都不影响本次运行。
      stepsSnapshot: (flow.steps ?? []).map((step) => ({ ...step })),
      edgesSnapshot: (flow.edges ?? []).map((edge) => ({ ...edge })),
      // 流程级技能也一起冻结，运行中改模板不影响本次已挂的方法。
      skillsSnapshot: [...(flow.skills ?? [])],
      input: task,
      variables: resolvedVariables,
      cwd,
      runDir,
      workspace,
      status: "running",
      stepStates: (flow.steps ?? []).map((step) => ({
        key: step.key,
        name: step.name,
        kind: step.kind ?? "task",
        agentId: step.agentMode === "fixed" ? step.agentId : null,
        status: "pending",
        taskId: null,
        output: null,
        summary: null,
        files: [],
        artifactWarnings: [],
        // 这一步实际挂了哪些工作方法（步骤级 + 流程级合并后），便于回溯「为什么这样产出」。
        skills: [...new Set([...(step.skills ?? []), ...(flow.skills ?? [])])],
        // 条件节点专用：pass = 走「满足」出线，fail = 走「不满足」出线。
        branchResult: null,
        check: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })),
      currentStepKey: null,
      // 并行执行时「同时在跑哪几步」是多个，currentStepKey 只能表达一个。
      // 新代码优先读 activeStepKeys，currentStepKey 仅作兼容保留。
      activeStepKeys: [],
      error: null,
      note: null,
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.#lockWorkspace(run);
    this.store.upsertRun(run);
    this.#emit(run, "run.started", {
      status: run.status,
      flowName: run.flowName,
      totalSteps: run.stepStates.length,
      currentStepKey: null,
    });
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  // ------------------------------------------------------- workspace guard

  #assertWorkspaceFree(source, mode) {
    if (mode !== "inplace") return;
    const holder = this.inplaceLocks.get(resolve(source));
    if (!holder) return;
    const run = this.store.getRun(holder);
    throw new Error(
      `这个目录正被「${run?.flowName ?? holder}」原地占用（${holder}）。等它结束、取消它，或改用「独立副本」运行`,
    );
  }

  #lockWorkspace(run) {
    if (run.workspace?.mode !== "inplace") return;
    this.inplaceLocks.set(resolve(run.workspace.source), run.id);
  }

  #unlockWorkspace(run) {
    if (run.workspace?.mode !== "inplace") return;
    const key = resolve(run.workspace.source);
    if (this.inplaceLocks.get(key) === run.id) this.inplaceLocks.delete(key);
  }

  /**
   * 副本模式下算一次「相对源目录改了什么」。
   * 归档在步骤目录里的产出要剥掉 `01-步骤/` 前缀，才算回项目内路径。
   */
  #recordChanges(run) {
    const workspace = run.workspace;
    if (!workspace || workspace.mode !== "isolated") {
      run.changes = null;
      return;
    }
    const paths = [];
    for (const step of run.stepStates) {
      for (const file of step.files ?? []) {
        if (file.source === "tool") {
          paths.push(file.path);
        } else if (file.source === "fence") {
          const parts = String(file.path ?? "").split("/").filter(Boolean);
          const restored = parts.length > 1 ? parts.slice(1).join("/") : "";
          if (restored) paths.push(restored);
        }
      }
    }
    try {
      run.changes = summarizeChanges(workspace, paths);
    } catch (error) {
      run.changes = {
        total: 0, added: 0, modified: 0, unchanged: 0, files: [],
        error: `改动统计失败：${error?.message || error}`,
      };
    }
  }

  /** 终态收尾：统计改动、释放原地占用的锁。 */
  #finalize(run) {
    this.#recordChanges(run);
    this.#unlockWorkspace(run);
  }

  /** 人工放行：把 waiting 的那一步标记成功，继续往下走。 */
  continueRun(runId) {
    const run = this.#mutable(runId);
    const gate = run.stepStates.find((step) => step.status === "waiting");
    if (!gate) throw new Error("当前没有等待确认的步骤");
    gate.status = "success";
    gate.finishedAt = gate.finishedAt ?? new Date().toISOString();
    run.status = "running";
    run.note = null;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  /**
   * 人工打回：检查点没通过时，把这一步清空重做。
   * 前序步骤的产出保留，重做只针对当前这一步。
   */
  rejectRun(runId) {
    const run = this.#mutable(runId);
    if (run.status !== "waiting") throw new Error("只有等待确认的步骤才能打回重做");
    const index = run.stepStates.findIndex((step) => step.status === "waiting");
    if (index === -1) throw new Error("当前没有等待确认的步骤");
    const step = run.stepStates[index];
    step.status = "pending";
    step.taskId = null;
    step.output = null;
    step.summary = null;
    step.files = [];
    step.artifactWarnings = [];
    step.error = null;
    step.startedAt = null;
    step.finishedAt = null;
    step.attempt = (step.attempt ?? 1) + 1;
    // 旧的检查结论已经没有意义，重做完再查一遍。
    step.check = null;
    run.status = "running";
    run.error = null;
    run.note = `已打回「${step.name}」重做（第 ${step.attempt} 次）`;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  /**
   * 把一个节点复位成「没跑过」。
   * 重跑的节点会清空自己的工件目录，文件索引也要一起清，否则下游会看到旧文件。
   */
  #resetStep(step) {
    step.status = "pending";
    step.taskId = null;
    step.output = null;
    step.error = null;
    step.startedAt = null;
    step.finishedAt = null;
    step.branchResult = null;
    step.files = [];
    step.summary = null;
    step.artifactWarnings = [];
    step.check = null;
    step.progress = null;
    step.ignored = false;
  }

  /**
   * 从某个节点起，沿出线把所有「还没成功」的下游一起圈进来。
   * 分支选择可能因为重跑而改变，所以下游不能只看直接相连的那一层。
   */
  #downstreamOf(run, keys) {
    const scope = new Set(keys);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of run.edgesSnapshot ?? []) {
        if (!scope.has(edge.from) || scope.has(edge.to)) continue;
        const target = run.stepStates.find((step) => step.key === edge.to);
        if (target && target.status !== "success") {
          scope.add(edge.to);
          changed = true;
        }
      }
    }
    return scope;
  }

  /** 决策 4：从第一个失败节点重跑；之前的产出原样复用，下游节点一并复位重算。 */
  retry(runId) {
    const run = this.#mutable(runId);
    if (run.status !== "paused") throw new Error("只有已暂停的流程才能重试");
    const failed = run.stepStates.find((step) => step.status === "failed");
    if (!failed) throw new Error("没有失败节点，可以直接重新发起运行");
    const toReset = this.#downstreamOf(run, [failed.key]);
    for (const step of run.stepStates) {
      if (!toReset.has(step.key) || step.status === "success") continue;
      this.#resetStep(step);
    }
    run.status = "running";
    run.error = null;
    run.attemptCount = (run.attemptCount ?? 1) + 1;
    run.note = `第 ${run.attemptCount} 次尝试：从「${failed.name}」重跑`;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  /**
   * 单步重跑：只重跑指定的那一个节点，下游的成功产出原样留着。
   *
   * 和 retry 的分工：
   *   retry      —— 失败后整条下游一起重算，用于「这一步没过，后面必然也要重做」；
   *   retryStep  —— 只补这一步，用于「下游其实已经用旧产出跑完了，我只想把这一步做好」，
   *                 或者并行分支里只挂了一路、另一路已经出结果的情况。
   *
   * 允许在流程停下时调用（paused / waiting / success / failed / cancelled）：
   * 「跑完了但某一步不满意，只重做那一步」是最常见的诉求，不能要求整条重跑。
   * 运行中不给：`#advance` 还在跑，单步复位会和它抢同一份 stepStates。
   */
  retryStep(runId, stepKey) {
    const run = this.#mutable(runId);
    // 先判步骤存不存在：不然「写错 key」会被后面的状态校验挡住，报成风马牛不相及的原因
    const step = run.stepStates.find((item) => item.key === stepKey);
    if (!step) throw new Error(`流程里没有这个步骤：${stepKey}`);
    if (["running", "checking"].includes(run.status)) {
      throw new Error("流程正在运行，等它停下或先取消再单步重跑");
    }
    if (step.status === "running" || step.status === "checking") {
      throw new Error(`「${step.name}」正在执行，等它跑完再重跑`);
    }
    // 没跑过的等调度就行；跑过没成的、成功的、检查点卡住的，都可以重跑
    if (step.status === "pending") throw new Error("这一步还没跑过，等流程走到它就行");
    // 复位后回到 pending，重新走一遍产出 + 检查
    this.#resetStep(step);
    step.attempt = (step.attempt ?? 1) + 1;
    // 下游已成功的节点不动：它们用的是旧产出，这是单步重跑明确接受的代价。
    // 下游里还没成功的（skipped / cancelled）要放开重排，否则流程会卡在「没有就绪节点」。
    const scope = this.#downstreamOf(run, [step.key]);
    for (const item of run.stepStates) {
      if (item.key === step.key || !["skipped", "cancelled"].includes(item.status)) continue;
      if (scope.has(item.key)) this.#resetStep(item);
    }
    run.status = "running";
    run.error = null;
    // 已经跑完的流程被重开：结束时间和取消标记都要清掉，否则前端还当它结束了
    run.finishedAt = null;
    run.cancelRequested = false;
    run.note = `单步重跑「${step.name}」（第 ${step.attempt} 次）`;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    // 前端要立刻看到这一步被清空，不能等下一轮调度
    this.#emit(run, "step.started", stepPayload(run, step));
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  /**
   * 忽略失败继续跑：把失败节点标成「已忽略」（skipped + ignored），下游照常开跑。
   * 和重试的区别：重试是把失败节点重新跑一遍；忽略是承认这步做不成了，
   * 让后面的步骤拿不到它的产出（当空）也照样执行，流程能走完。
   */
  ignoreRun(runId) {
    const run = this.#mutable(runId);
    if (run.status !== "paused") throw new Error("只有已暂停的流程才能忽略失败继续");
    const failed = run.stepStates.filter((step) => step.status === "failed");
    if (!failed.length) throw new Error("没有失败节点，可以直接重新发起运行");
    for (const step of failed) {
      step.status = "skipped";
      step.ignored = true;
      step.finishedAt = new Date().toISOString();
      step.summary = `已忽略失败：${step.error || "未知原因"}`;
    }
    run.status = "running";
    run.error = null;
    run.note = `已忽略「${failed.map((step) => step.name).join("」「")}」，后面的步骤继续执行`;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    // 失败节点改判为「已忽略」，前端要跟着把红色卡片收掉
    for (const step of failed) this.#emit(run, "step.skipped", { ...stepPayload(run, step), ignored: true });
    this.#advance(run).catch((error) => this.#pause(run, `流程调度异常：${error?.message || error}`));
    return publicRun(run);
  }

  cancel(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`未知运行实例：${runId}`);
    if (["success", "failed", "cancelled"].includes(run.status)) return publicRun(run);
    run.cancelRequested = true;
    const finishedAt = new Date().toISOString();
    // 并行分支可能同时有多个节点在跑，一个都不漏；检查中的任务也要停，否则它会继续跑完。
    for (const step of run.stepStates) {
      if (["running", "checking"].includes(step.status) && step.taskId) this.manager.cancel(step.taskId);
      if (step.check?.taskId && step.check.status === "running") this.manager.cancel(step.check.taskId);
      // 正在跑的步骤必须一起收口：底层任务停掉之后 #advance 会直接 return，
      // 没人再来把 running 写成终态，界面就会永远挂着「执行中 + 正在生成结果」。
      if (["pending", "waiting", "running", "checking"].includes(step.status)) {
        step.status = "cancelled";
        step.progress = null;
        step.finishedAt = finishedAt;
      }
      if (step.check?.status === "running") step.check = { ...step.check, status: "cancelled" };
    }
    run.status = "cancelled";
    // 取消不是失败：上一次失败信息（含「流程已取消」这种）不该继续挂在面板底部报红。
    run.error = null;
    run.currentStepKey = null;
    run.activeStepKeys = [];
    run.finishedAt = finishedAt;
    run.updatedAt = run.finishedAt;
    this.#finalize(run);
    this.store.upsertRun(run);
    this.#emit(run, "run.finished", {
      status: run.status,
      finishedAt: run.finishedAt,
      currentStepKey: null,
      totalSteps: run.stepStates.length,
      doneSteps: run.stepStates.filter((item) => ["success", "failed", "skipped"].includes(item.status)).length,
    });
    this.#writeManifest(run);
    return publicRun(run);
  }

  // ------------------------------------------------------- workspace ops

  /**
   * 把副本里的改动写回源目录。
   * 默认只回写「本运行登记过、且内容确实变了」的文件，不做整目录覆盖。
   */
  applyRun(runId, paths = null) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`未知运行实例：${runId}`);
    if (!["success", "paused"].includes(run.status)) throw new Error("等运行结束或暂停后再回写改动");
    if (run.workspace?.mode !== "isolated") throw new Error("这是原地运行，改动已经在源目录里了");

    const list = Array.isArray(paths) && paths.length
      ? paths
      : (run.changes?.files ?? []).filter((file) => file.status === "added" || file.status === "modified").map((file) => file.path);
    if (!list.length) {
      // 重复点「应用」不算错，直接告诉他已经同步过了。
      if ((run.appliedFiles ?? []).length) {
        return { applied: [], skipped: [], backupDir: null, alreadyApplied: true, run: publicRun(run) };
      }
      throw new Error("这次运行没有产生可回写的改动");
    }

    const result = applyChanges(run.workspace, list, { backupDir: join(run.runDir, "backup") });
    run.appliedAt = new Date().toISOString();
    run.appliedFiles = [...new Set([...(run.appliedFiles ?? []), ...result.applied])];
    run.updatedAt = run.appliedAt;
    // 回写后源目录已经追平副本，重新算一遍，界面就不会继续显示「待回写」。
    this.#recordChanges(run);
    this.store.upsertRun(run);
    return { ...result, run: publicRun(run) };
  }

  /** 删除副本作业目录。副本里含工件，删了之后运行详情的文件预览会失效。 */
  dropWorkspace(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`未知运行实例：${runId}`);
    if (["running", "waiting"].includes(run.status)) throw new Error("运行还在进行，先取消再清理副本");
    if (run.workspace?.mode !== "isolated") throw new Error("原地运行没有副本可清理");
    if (run.workspace.cleanedAt) return { removed: false, path: run.workspace.path, run: publicRun(run) };

    const result = removeWorkspace(run.workspace);
    run.workspace.cleanedAt = new Date().toISOString();
    run.updatedAt = run.workspace.cleanedAt;
    this.store.upsertRun(run);
    return { ...result, run: publicRun(run) };
  }

  // ------------------------------------------------------------- internals

  #mutable(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`未知运行实例：${runId}`);
    if (run.cancelRequested) throw new Error("本次运行已取消");
    return run;
  }

  #pause(run, message, stepEventType = null) {
    run.status = "paused";
    run.error = message;
    run.updatedAt = new Date().toISOString();
    // 暂停时同层可能还有别的步骤在跑：重新算一遍，别让界面显示「还在做」的假象
    this.#refreshActiveSteps(run);
    this.store.upsertRun(run);
    // 失败时先推步骤自己的终态，再推整体暂停，前端才能把「哪一步挂了」定位到卡片上。
    if (stepEventType) {
      const failed = run.stepStates?.find((step) => step.status === "failed");
      if (failed) this.#emit(run, stepEventType, stepPayload(run, failed));
    }
    this.#emit(run, "run.status", {
      status: run.status,
      error: run.error,
      currentStepKey: run.currentStepKey,
      activeStepKeys: run.activeStepKeys,
      totalSteps: run.stepStates?.length ?? 0,
      doneSteps: (run.stepStates ?? []).filter((item) => ["success", "failed", "skipped"].includes(item.status)).length,
    });
    this.#writeManifest(run);
  }

  /** 运行目录里留一份人和工具都能读的索引；写失败不影响流程。 */
  #writeManifest(run) {
    if (!run.runDir) return;
    try {
      writeRunManifest(run.runDir, {
        runId: run.id,
        flowId: run.flowId,
        flowName: run.flowName,
        flowVersion: run.flowVersion,
        status: run.status,
        input: run.input,
        variables: run.variables,
        cwd: run.cwd,
        workspace: run.workspace
          ? { mode: run.workspace.mode, source: run.workspace.source, path: run.workspace.path }
          : null,
        changes: run.changes ? { total: run.changes.total, added: run.changes.added, modified: run.changes.modified } : null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        steps: run.stepStates.map((step) => ({
          key: step.key,
          name: step.name,
          kind: step.kind ?? "task",
          agentId: step.agentId,
          status: step.status,
          branchResult: step.branchResult ?? null,
          outputFiles: (step.files ?? []).filter((file) => file.source !== "missing").map((file) => file.path),
          check: step.check
            ? { status: step.check.status, agentId: step.check.agentId, verdict: step.check.verdict, summary: step.check.summary }
            : null,
        })),
      });
    } catch {
      /* manifest 是便利文件，不是产出本身 */
    }
  }

  // ------------------------------------------------------------- graph helpers

  #stepDef(run, key) {
    return run.stepsSnapshot.find((step) => step.key === key) ?? {};
  }

  #inEdges(run, key) {
    return (run.edgesSnapshot ?? []).filter((edge) => edge.to === key);
  }

  #outEdges(run, key) {
    return (run.edgesSnapshot ?? []).filter((edge) => edge.from === key);
  }

  /** 一条入线是否放行：来源成功（或失败被人工忽略），且（条件节点时）分支匹配判断结果。 */
  #edgeOpen(run, edge) {
    const source = run.stepStates.find((step) => step.key === edge.from);
    if (!source) return false;
    // 忽略失败：线放行，下游照常跑，只是拿不到这个节点的产出（注入为空）。
    if (source.status === "skipped" && source.ignored) return true;
    if (source.status !== "success") return false;
    const definition = this.#stepDef(run, edge.from);
    if (definition.kind === "condition") {
      // 新流程：branchResult 直接存命中的选项文案，出线带着同一个文案才放行。
      const options = Array.isArray(definition.options) && definition.options.length >= 2 ? definition.options : null;
      if (options) return (edge.branch || "") === String(source.branchResult ?? "");
      // 老运行快照（冻结于多路分支上线前）：pass = 走「满足」出线，fail = 走「不满足」出线。
      const want = source.branchResult === "pass" ? "yes" : "no";
      return (edge.branch || "yes") === want;
    }
    return true;
  }

  /**
   * 一次调度回合：
   * 1) 把被分支关死的 pending 节点标成 skipped，反复传播到不动点；
   * 2) 返回这一轮可以开跑的节点（所有入线来源都到了终态）。
   */
  #scheduleRound(run) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of run.stepStates) {
        if (step.status !== "pending") continue;
        const ins = this.#inEdges(run, step.key);
        if (!ins.length) continue; // 入口节点直接跑
        const sources = ins.map((edge) => run.stepStates.find((item) => item.key === edge.from));
        if (sources.some((item) => ["pending", "running", "checking", "waiting"].includes(item.status))) continue;
        const open = ins.some((edge) => this.#edgeOpen(run, edge));
        if (!open) {
          step.status = "skipped";
          step.finishedAt = new Date().toISOString();
          changed = true;
          // 跳过的节点也要推：前端要把卡片从「等待」改成「跳过」，否则会一直挂着转圈。
          this.#saveAndEmitStep(run, "step.skipped", step);
        }
      }
    }
    return run.stepStates
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.status === "pending")
      .filter(({ step }) => {
        const sources = this.#inEdges(run, step.key).map((edge) => run.stepStates.find((item) => item.key === edge.from));
        return sources.every((item) => ["success", "skipped"].includes(item.status));
      });
  }

  /**
   * 图调度主循环（按层并行的 BSP 风格）：
   * 每轮把所有就绪节点一起开跑，全部落幕后进入下一轮；直到没有可跑的节点。
   */
  async #advance(run) {
    while (true) {
      if (run.cancelRequested || run.status === "cancelled") return;
      const ready = this.#scheduleRound(run);
      const alive = run.stepStates.some((step) => ["pending", "running", "checking"].includes(step.status));
      if (!ready.length) {
        if (alive) {
          this.#pause(run, "流程卡住了：有节点等不到上游产出，检查画布连线是否有断口");
          return;
        }
        run.status = "success";
        run.currentStepKey = null;
        run.activeStepKeys = [];
        run.finishedAt = new Date().toISOString();
        run.updatedAt = run.finishedAt;
        this.#finalize(run);
        this.store.upsertRun(run);
        this.#emit(run, "run.finished", {
          status: run.status,
          finishedAt: run.finishedAt,
          currentStepKey: null,
          totalSteps: run.stepStates.length,
          doneSteps: run.stepStates.filter((item) => ["success", "failed", "skipped"].includes(item.status)).length,
        });
        this.#writeManifest(run);
        return;
      }

      run.status = "running";
      run.note = null;
      run.updatedAt = new Date().toISOString();
      this.store.upsertRun(run);

      // 同一轮互不等待，一起开跑；Promise.all 会等这一整层落幕。
      const outcomes = await Promise.all(ready.map(({ step, index }) => this.#runNode(run, step, index)));
      if (run.cancelRequested || run.status === "cancelled") return;
      // 这一层全跑完了：活动集合清空，下一轮重新累积
      this.#refreshActiveSteps(run);

      let failure = null;
      let gate = null;
      for (const outcome of outcomes) {
        if (outcome.status === "failed" && !failure) failure = outcome;
        if (outcome.checkpointHit && !gate) gate = outcome;
      }
      if (failure) {
        const { step } = failure;
        step.status = "failed";
        step.error = failure.error || "执行失败";
        step.finishedAt = new Date().toISOString();
        // 决策 2：立即暂停，已完成节点的产出保留，供人工检查后从失败处重试。
        this.#pause(run, `步骤「${step.name}」失败：${failure.error || "未知原因"}`, "step.failed");
        return;
      }
      if (gate) {
        const { step } = gate;
        step.status = "waiting";
        run.status = "waiting";
        run.note = this.#checkpointNote(step);
        run.updatedAt = new Date().toISOString();
        this.store.upsertRun(run);
        this.#emit(run, "run.status", {
          status: run.status,
          note: run.note,
          stepKey: step.key,
          currentStepKey: run.currentStepKey,
          totalSteps: run.stepStates.length,
          doneSteps: run.stepStates.filter((item) => ["success", "failed", "skipped"].includes(item.status)).length,
        });
        this.#writeManifest(run);
        return;
      }
      this.store.upsertRun(run);
    }
  }

  /**
   * 同层并行的节点会同时处于 executing/checking，但 run 上只有一个 currentStepKey。
   * 这里把「真正在跑的全部步骤」算出来，作为并行状态的权威字段；
   * currentStepKey 保留为兼容字段（老数据、老前端仍读它）。
   */
  #refreshActiveSteps(run) {
    const active = (run.stepStates ?? []).filter((item) =>
      ["running", "checking"].includes(item.status),
    );
    run.activeStepKeys = active.map((item) => item.key);
    // 兼容字段取第一个活动的：语义仍是「当前主步骤」
    run.currentStepKey = active[0]?.key ?? null;
    return active;
  }

  /** 跑一个节点：任务节点走产出流水线，条件节点走判断，完成后各自决定是否停。 */
  async #runNode(run, step, index) {
    const definition = this.#stepDef(run, step.key);
    // 先把本节点标成 running 再算活动集合，否则并行时这一步会被自己漏掉
    step.status = "running";
    this.#refreshActiveSteps(run);
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);
    this.#emit(run, "step.started", stepPayload(run, step));

    if (definition.kind === "condition") {
      return this.#executeCondition(run, step, index, definition);
    }

    const outcome = await this.#executeStep(run, step, index, definition);
    if (outcome.status !== "success") {
      return { status: "failed", error: outcome.error, step, checkpointHit: false };
    }

    step.status = "success";
    step.output = outcome.output ?? "";
    step.finishedAt = new Date().toISOString();
    step.artifactCount = outcome.artifactCount ?? 0;
    // 跑完了就不该再挂着「正在生成结果」
    step.progress = null;

    // 工件化：回答变文件，下游只拿清单。
    const parsed = parseResult(step.output);
    // 工具真写出来的文件优先：它们已经在真实路径上，不再往步骤目录里抄一份。
    const toolFiles = (outcome.toolFiles ?? []).map((file) => ({
      path: file.path,
      absolute: file.absolute,
      bytes: file.bytes,
      lines: file.lines,
      note: "",
      source: "tool",
      // 前端按 kind 决定用图片还是文字渲染，不再靠扩展名二次猜测。
      ...describeArtifact(file),
    }));
    step.toolCalls = outcome.toolCalls ?? 0;
    if (definition?.outputFiles === "none") {
      step.files = toolFiles;
      step.artifactWarnings = [];
    } else {
      const stepDir = join(run.runDir, stepDirName(index, definition.key));
      const skip = toolFiles
        .filter((file) => insideDir(stepDir, file.absolute))
        .map((file) => relative(stepDir, file.absolute).replace(/\\/g, "/"));
      const persisted = this.#persistArtifacts(run, definition, index, {
        text: step.output,
        declared: parsed.declaredFiles,
        skip,
        fallback: toolFiles.length === 0,
      });
      const already = new Set(toolFiles.map((file) => file.absolute));
      step.files = [...toolFiles, ...persisted.files.filter((file) => !already.has(file.absolute))];
      step.artifactWarnings = persisted.warnings;
    }
    const produced = (step.files ?? []).filter((file) => file.source !== "missing").length;
    const summary = pickSummary(parsed, step.output) || (produced ? `产出 ${produced} 个文件` : "");
    step.summary = summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary;
    this.#writeManifest(run);
    // 步骤跑完立刻推一次：前端据此展开这一步、显示结论和产物缩略图，
    // 不用等 3 秒轮询，也不等整层并行结束。
    this.#saveAndEmitStep(run, "step.completed", step);

    // 检查点：这一步做完先停，员工检查 + 人工确认，缺一不放行。
    if (definition?.checkpoint?.enabled) {
      await this.#runCheckpoint(run, step, index, definition);
      if (run.cancelRequested) return { status: "cancelled", step, checkpointHit: true };
      return { status: "success", step, checkpointHit: true };
    }
    return { status: "success", step, checkpointHit: false };
  }

  /**
   * 条件节点：不产出，只判断。派一个员工回答该走哪个出线选项，
   * 结论决定哪些出线放行；没给出明确结论时按最后一个选项兜底（建议把兜底项放最后）并留痕。
   */
  async #executeCondition(run, step, index, definition) {
    const ins = this.#inEdges(run, step.key);
    const previousKey = ins.length ? ins[0].from : null;
    const done = run.stepStates.filter((item) => item.status === "success");
    const outputs = Object.fromEntries(done.map((item) => [item.key, item.output ?? ""]));
    const summaries = Object.fromEntries(done.map((item) => [item.key, item.summary ?? ""]));
    const files = Object.fromEntries(done.map((item) => [item.key, formatFileList(item.files, run.cwd)]));
    const question = resolvePrompt(definition.question, {
      input: run.input,
      variables: run.variables,
      outputs,
      summaries,
      files,
      previousKey,
    });
    // 新流程走多路选项；老运行快照没有 options，退回「满足 / 不满足」双出口。
    const options = Array.isArray(definition.options) && definition.options.length >= 2 ? definition.options : null;
    const prompt = [
      "你是一个判断节点：只做判断，不要执行任务，也不要改任何文件。",
      "",
      `整条流程要交付的东西：${run.input}`,
      "",
      "## 判断问题",
      question || "（未填写）",
      "",
      "按下面格式回答，不要用代码块，不要写额外内容：",
      options
        ? `结论：必须是这几个之一（原样写一个）：${options.map((item) => `「${item}」`).join("、")}`
        : "结论：满足 或 不满足",
      "理由：一句话",
    ].join("\n");

    const agentId = definition.agentId;
    try {
      assertAgentUsable(agentId, this.config.agents);
    } catch (error) {
      return { status: "failed", error: `判断员工不可用：${error?.message || error}`, step };
    }
    step.agentId = agentId;

    const total = run.stepStates.length;
    let created;
    try {
      created = this.manager.create({
        prompt,
        cwd: run.cwd,
        mode: "workspace-read",
        model: null,
        label: `${run.flowName} · 判断 ${index + 1}/${total} ${step.name}`,
        tags: [`流程:${run.flowName}`, "条件判断", `步骤${index + 1}/${total}`],
        domain: "flow",
        taskType: null,
        priority: "normal",
        outputTypes: ["text"],
        agent: agentId,
        agentChoice: "manual",
      });
    } catch (error) {
      return { status: "failed", error: error?.message || "创建判断任务失败", step };
    }

    step.taskId = created.task.id;
    step.status = "running";
    step.startedAt = new Date().toISOString();
    run.updatedAt = step.startedAt;
    this.store.upsertRun(run);

    const outcome = await this.#waitForTask(created.task.id, run, step);
    if (outcome.status !== "success") {
      return { status: "failed", error: outcome.error || "判断任务失败", step };
    }
    const text = outcome.output ?? "";
    const reason = pickCheckSummary(text) || "";
    step.status = "success";
    step.output = text;
    step.progress = null;
    if (options) {
      const chosen = readConditionOption(text, options);
      const fallback = options[options.length - 1];
      step.branchResult = chosen || fallback;
      step.summary = chosen
        ? `判断：${chosen}${reason ? `，${reason}` : ""}`
        : `判断：没给出明确结论，按「${fallback}」处理${reason ? `，${reason}` : ""}`;
    } else {
      const verdict = readConditionVerdict(text);
      step.branchResult = verdict === "pass" ? "pass" : "fail";
      step.summary = verdict === "pass"
        ? `判断：满足${reason ? `，${reason}` : ""}`
        : `判断：不满足${verdict === "unknown" ? "（没给出明确结论，按不满足处理）" : ""}${reason ? `，${reason}` : ""}`;
    }
    step.finishedAt = new Date().toISOString();
    this.#writeManifest(run);
    return { status: "success", step, checkpointHit: false };
  }

  /**
   * 检查点：可派一个员工来查，也可以不派（那就只剩人工确认）。
   * 检查本身的失败不算流程失败——产出还在，人可以自己看、自己放行。
   */
  async #runCheckpoint(run, step, index, definition) {
    const checkpoint = definition.checkpoint ?? {};
    const inspector = String(checkpoint.agentId ?? "").trim();
    step.check = {
      enabled: true,
      status: inspector ? "running" : "manual",
      agentId: inspector || null,
      agentName: inspector ? this.#agentName(inspector) : null,
      verdict: null,
      summary: inspector ? "正在检查…" : "没有安排员工检查，等你亲自看",
      issues: [],
      output: "",
      taskId: null,
      checkedAt: null,
    };

    if (!inspector) {
      step.check.checkedAt = new Date().toISOString();
      this.store.upsertRun(run);
      return step.check;
    }

    step.status = "checking";
    run.status = "checking";
    run.note = `${step.check.agentName} 正在检查「${step.name}」`;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);

    const prompt = this.#checkpointPrompt(run, step, index, definition);
    let created;
    try {
      created = this.manager.create({
        prompt,
        cwd: run.cwd,
        // 检查只读不写：给它 workspace-read 就够，避免它顺手改产出。
        mode: "workspace-read",
        model: null,
        label: `${run.flowName} · 检查 ${index + 1}/${run.stepStates.length} ${step.name}`,
        tags: [`流程:${run.flowName}`, "检查点", `步骤${index + 1}/${run.stepStates.length}`],
        domain: "flow",
        taskType: null,
        priority: "normal",
        outputTypes: ["markdown"],
        agent: inspector,
        agentChoice: "manual",
      });
    } catch (error) {
      step.check.status = "failed";
      step.check.summary = `检查没跑起来：${error?.message || error}`;
      step.check.checkedAt = new Date().toISOString();
      return step.check;
    }

    step.check.taskId = created.task.id;
    run.updatedAt = new Date().toISOString();
    this.store.upsertRun(run);

    const outcome = await this.#waitForTask(created.task.id, run, step);
    step.check.checkedAt = new Date().toISOString();
    if (outcome.status !== "success") {
      step.check.status = "failed";
      step.check.summary = `检查没跑完：${outcome.error || "未知原因"}`;
      return step.check;
    }

    const text = outcome.output ?? "";
    step.check.status = "done";
    step.check.verdict = readCheckVerdict(text);
    step.check.summary = pickCheckSummary(text) || "检查没有给出文字结论";
    step.check.issues = readCheckIssues(text);
    step.check.output = text.length > CHECK_OUTPUT_MAX ? `${text.slice(0, CHECK_OUTPUT_MAX)}…` : text;
    return step.check;
  }

  #agentName(agentId) {
    if (!agentId) return "系统";
    return this.config?.agents?.[agentId]?.name ?? (agentId === "codex" ? "codex" : agentId);
  }

  #checkpointPrompt(run, step, index, definition) {
    const criteria = String(definition.checkpoint?.criteria ?? "").trim() || DEFAULT_CHECK_CRITERIA;
    const files = formatFileList(step.files, run.cwd);
    const output = String(step.output ?? "");
    const body = output.length > 8000 ? `${output.slice(0, 8000)}\n…（产出较长，已截断；完整内容在下面的文件里）` : output;
    return [
      "你是这一步的把关人：只检查、只挑问题，不要重写产出，也不要改任何文件。",
      "",
      `被检查的是第 ${index + 1} 步「${step.name}」。`,
      `整条流程要交付的东西：${run.input}`,
      "",
      "## 检查标准",
      criteria,
      "",
      files ? `## 这一步产出的文件\n${files}` : "## 这一步没有产出文件",
      "",
      "## 这一步的回答",
      '"""',
      body || "（空）",
      '"""',
      "",
      "按下面格式回答，不要用代码块，不要写额外内容：",
      "结论：通过 或 不通过",
      "理由：一句话",
      "问题：",
      "1. 必须改的点；没有问题就写「无」",
    ].join("\n");
  }

  #checkpointNote(step) {
    const check = step.check;
    if (!check) return `「${step.name}」做完，等你确认后继续`;
    if (check.status === "manual") return `「${step.name}」做完了，没有安排员工检查，你看过之后确认继续`;
    if (check.status === "failed") return `${check.summary || "检查没跑起来"}　—　你看过产出后决定放行还是打回`;
    const verdict = CHECK_VERDICT_LABEL[check.verdict] ?? CHECK_VERDICT_LABEL.unknown;
    // 摘要和结论重复时（「通过 · 通过」）就别写两遍
    const reason = check.summary && check.summary !== verdict ? `：${check.summary}` : "";
    return `${check.agentName} 检查${verdict}${reason}　—　你确认后才继续`;
  }

  /**
   * 工件索引：把已完成步骤的文件清单附在提示词末尾。
   * 只给路径和行数，不给正文——模型按需读取，2 万字上限就不再是硬墙。
   * 清单本身也吃预算，放不下就先退化成纯路径，再放不下就不加：
   * 便利功能不该把主流程挤到超限。
   */
  #attachFileIndex(prompt, done, cwd, budget = Infinity) {
    const withFiles = done.filter((step) => (step.files ?? []).some((file) => file.source !== "missing"));
    if (!withFiles.length || budget <= 0) return prompt;
    if (prompt.includes("## 上游产出文件")) return prompt;

    const header = "\n\n---\n## 上游产出文件（需要细节时请直接读取，不要凭记忆猜测）\n";
    const build = (compact) => {
      const sections = [];
      for (const step of withFiles) {
        const list = compact
          ? (step.files ?? [])
              .filter((file) => file.source !== "missing")
              .slice(0, LIST_MAX)
              .map((file) => `- \`${relative(cwd, file.absolute).replace(/\\/g, "/")}\``)
              .join("\n")
          : formatFileList(step.files, cwd);
        if (list) sections.push(compact ? list : `### ${step.name}\n${list}`);
      }
      return sections.length ? `${prompt}${header}${sections.join("\n\n")}` : prompt;
    };

    const full = build(false);
    if (full.length - prompt.length <= budget) return full;
    const compact = build(true);
    if (compact.length - prompt.length <= budget) return compact;
    return prompt;
  }

  /** 把一步的回答落成文件，返回可下游使用的精简索引。 */
  #persistArtifacts(run, definition, index, { text, declared, skip = [], fallback = true }) {
    try {
      const stepDir = join(run.runDir, stepDirName(index, definition.key));
      const result = writeStepArtifacts({
        text,
        stepDir,
        runDir: run.runDir,
        outputType: definition.outputType ?? "markdown",
        declared,
        reset: true,
        skipPaths: skip,
        fallback,
      });
      return {
        files: result.files.map((file) => ({
          path: relative(run.runDir, file.absolute).replace(/\\/g, "/"),
          absolute: file.absolute,
          bytes: file.bytes,
          lines: file.lines,
          note: file.note,
          source: file.source,
          // 落盘产物同样要带类型：前端靠它决定用图片还是文字渲染。
          // 这里不能漏，否则 output.md 会被当成 binary 只显示文件名。
          ...describeArtifact({ path: file.absolute, bytes: file.bytes }),
        })),
        warnings: result.warnings,
      };
    } catch (error) {
      return { files: [], warnings: [`产出落盘失败：${error?.message || error}`] };
    }
  }

  async #executeStep(run, step, index, definition) {
    // 「上一步」= 画布上第一条连进来的线的来源；没有连线就没有 previous。
    const ins = this.#inEdges(run, step.key);
    const previousKey = ins.length ? ins[0].from : null;
    // 流程级技能对每一步都生效；步骤级（definition.skills）在下面优先拼。
    const runSkills = Array.isArray(run.skillsSnapshot) ? run.skillsSnapshot : [];
    const done = run.stepStates.filter((item) => item.status === "success");
    const outputs = Object.fromEntries(done.map((item) => [item.key, item.output ?? ""]));
    const summaries = Object.fromEntries(done.map((item) => [item.key, item.summary ?? ""]));
    const files = Object.fromEntries(done.map((item) => [item.key, formatFileList(item.files, run.cwd)]));
    let prompt = resolvePrompt(definition.promptTemplate, {
      input: run.input,
      variables: run.variables,
      outputs,
      summaries,
      files,
      previousKey,
    });
    // 即使提示词里一个占位符都没写，下游也该知道上游产出了哪些文件。
    prompt = this.#attachFileIndex(prompt, done, run.cwd, this.config.maxPromptChars - prompt.length);

    // 技能挂载：步骤自己挂的工作方法 + 流程级挂的，步骤级优先（更精确）。
    // 去重后按 6 千字预算拼进提示词；判断节点不挂，它只回答问题。
    const mountedSkills = definition.kind === "condition"
      ? []
      : [...new Set([...(definition.skills ?? []), ...(runSkills ?? [])])];
    const mount = mountedSkills.length && this.skillStore
      ? this.skillStore.mountBlock(mountedSkills, { budget: 6000 })
      : "";
    if (mount) prompt = `${prompt}\n\n${mount}`;

    // 决策 8：注入产出后超长就停下来，绝不静默截断。
    if (prompt.length > this.config.maxPromptChars) {
      return {
        status: "failed",
        error: `提示词注入前序产出后达到 ${prompt.length} 字，超过上限 ${this.config.maxPromptChars}。请缩短提示词或改用更早步骤的精简产出`,
      };
    }

    let agentId = definition.agentId;
    if (definition.agentMode === "auto") {
      const recommendation = recommendAgent({ domain: "flow", prompt, outputTypes: [definition.outputType] }, this.config.agents);
      agentId = recommendation.recommendedAgent;
    }
    try {
      assertAgentUsable(agentId, this.config.agents);
    } catch (error) {
      return { status: "failed", error: `员工不可用：${error?.message || error}` };
    }
    step.agentId = agentId;

    // 云端员工（豆包/Kimi/DeepSeek…）本身只会说话，工具得由平台注入；
    // codex 自带读写与执行能力，不重复注入。作用域绑在本次运行的工作目录上。
    const toolMode = definition.tools === "none" ? "none" : definition.tools === "files" ? "files" : "auto";
    const sandbox = agentId !== "codex" && toolMode !== "none"
      ? createToolSandbox({ cwd: run.cwd, runDir: run.runDir, mode: toolMode })
      : null;

    // 没有出线的节点就是最终产出；并行分支下可能有多个。
    const isFinal = this.#outEdges(run, step.key).length === 0;
    const tags = [`流程:${run.flowName}`, `步骤${index + 1}/${run.stepStates.length}`];
    if (isFinal) tags.push("最终产出");
    let created;
    try {
      created = this.manager.create({
        prompt,
        cwd: run.cwd,
        mode: "workspace-write",
        model: null,
        label: `${run.flowName} · ${index + 1}/${run.stepStates.length} ${step.name}`,
        tags,
        domain: "flow",
        taskType: null,
        priority: "normal",
        outputTypes: [definition.outputType],
        agent: agentId,
        agentChoice: definition.agentMode === "auto" ? "auto" : "manual",
      }, null, sandbox ? { toolContext: { sandbox } } : {});
    } catch (error) {
      return { status: "failed", error: error?.message || "创建任务失败" };
    }

    step.taskId = created.task.id;
    step.status = "running";
    step.startedAt = new Date().toISOString();
    run.updatedAt = step.startedAt;
    this.store.upsertRun(run);

    const outcome = await this.#waitForTask(created.task.id, run, step);
    return {
      status: outcome.status,
      output: outcome.output,
      error: outcome.error,
      artifactCount: outcome.artifactCount,
      toolFiles: sandbox ? sandbox.files() : [],
      toolCalls: sandbox ? sandbox.calls : 0,
    };
  }

  /** 轮询任务直到终态；取消请求会把任务一并取消。 */
  #waitForTask(taskId, run, step = null) {
    const deadline = Date.now() + this.config.taskTimeoutMs;
    // 步骤内的一句话进展：只在文字真的变了才推事件，避免把 800ms 轮询变成事件洪水。
    let lastProgress = "";
    const reportProgress = (text) => {
      if (!step || !text || text === lastProgress) return;
      lastProgress = text;
      step.progress = text;
      run.updatedAt = new Date().toISOString();
      this.store.upsertRun(run);
      this.#emit(run, "step.progress", { ...stepPayload(run, step), progress: text });
    };
    return new Promise((resolve) => {
      const tick = () => {
        if (run.cancelRequested) {
          this.manager.cancel(taskId);
          resolve({ status: "failed", error: "流程已取消", output: null });
          return;
        }
        const task = this.manager.get(taskId);
        if (!task) {
          resolve({ status: "failed", error: "任务记录丢失", output: null });
          return;
        }
        if (TERMINAL_TASK_STATUS.includes(task.status)) {
          resolve({
            status: task.status === "completed" ? "success" : "failed",
            output: task.status === "completed" ? (task.finalResponse ?? "") : null,
            error: task.status === "completed" ? null : (task.error || `任务状态：${task.status}`),
            artifactCount: task.artifacts?.length ?? 0,
          });
          return;
        }
        if (Date.now() > deadline) {
          this.manager.cancel(taskId);
          resolve({ status: "failed", error: "步骤执行超时", output: null });
          return;
        }
        reportProgress(taskProgressText(task));
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      setTimeout(tick, 300);
    });
  }
}
