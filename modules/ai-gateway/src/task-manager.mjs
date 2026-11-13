import { randomUUID } from "node:crypto";
import { collectArtifacts } from "./workbench/artifacts.mjs";
import { parseResult, summarize } from "./workbench/parse.mjs";
import { mergeUsage, normalizeUsage } from "./workbench/pricing.mjs";

const PUBLIC_FIELDS = [
  "id", "label", "tags", "prompt", "cwd", "mode", "model", "threadId", "status",
  "createdAt", "acceptedAt", "queuedAt", "startedAt", "processStartedAt", "firstOutputAt",
  "lastOutputAt", "finishedAt", "updatedAt", "finalResponse", "error", "restored",
  "terminationReason", "exitCode", "exitSignal", "reconnectCount", "approvalWaitCount",
  "runtimeMode", "turnId", "pendingApprovals",
  // Workbench layer: which work line, who ran it, what came out.
  "domain", "taskType", "priority", "outputTypes", "agent", "agentChoice", "skills",
  "summary", "conclusions", "risks", "nextActions", "structured",
  "artifacts", "runs", "readAt", "archivedAt", "preview",
  // 成本观测：这次派活到底烧了多少 token（钱由单价算出，不落库）
  "usage", "research",
];

/**
 * Board column, derived so the client never has to re-implement the state machine.
 * "attention" means a run the user still has to deal with, so it belongs in
 * 进行中 rather than 历史.
 */
const COLUMN_BY_STATUS = {
  draft: "draft",
  queued: "running",
  running: "running",
  waiting_approval: "running",
  completed: "ready",
  failed: "attention",
  interrupted: "attention",
  cancelled: "history",
  archived: "history",
};

const columnOf = (task) => COLUMN_BY_STATUS[task.status] ?? "history";


const TAG_LIMIT = 8;
const TAG_CHARS = 24;

/** Tags are for the human scanning a task list, not a taxonomy: dedupe, cap, keep it cheap. */
const normalizeTags = (input) => {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, TAG_CHARS);
    if (tag) seen.add(tag);
    if (seen.size >= TAG_LIMIT) break;
  }
  return [...seen];
};

const elapsed = (start, end) => {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const taskMetrics = (task, now = new Date().toISOString()) => ({
  queueMs: elapsed(task.queuedAt ?? task.createdAt, task.startedAt),
  processStartMs: elapsed(task.startedAt, task.processStartedAt),
  firstOutputMs: elapsed(task.startedAt, task.firstOutputAt),
  runMs: elapsed(task.startedAt, task.finishedAt ?? (["running", "waiting_approval"].includes(task.status) ? now : null)),
  totalMs: elapsed(task.acceptedAt ?? task.createdAt, task.finishedAt ?? (["queued", "running", "waiting_approval"].includes(task.status) ? now : null)),
  silentMs: ["running", "waiting_approval"].includes(task.status) && task.lastOutputAt ? elapsed(task.lastOutputAt, now) : null,
  reconnectCount: task.reconnectCount ?? 0,
  approvalWaitCount: task.approvalWaitCount ?? 0,
});

const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const publicTask = (task, includeEvents = false) => {
  const result = Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, task[key] ?? null]));
  result.column = columnOf(task);
  result.unread = task.status === "completed" && !task.readAt;
  result.metrics = taskMetrics(task);
  if (includeEvents) result.events = task.events;
  return result;
};

export class TaskManager {
  constructor({ concurrency, timeoutMs, runner, maxTasks = 200, persist = null, persistEvent = null, approvalResolver = null }) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
    this.maxTasks = maxTasks;
    this.persist = persist;
    this.persistEvent = persistEvent;
    this.approvalResolver = approvalResolver;
    this.tasks = new Map();
    this.queue = [];
    this.running = 0;
    this.idempotency = new Map();
    // Per-task tool sandboxes live here, never on the task record: they hold
    // closures and absolute paths that must not reach the API or the JSONL log.
    this.toolContexts = new Map();
  }

  /**
   * Rehydrate from the JSONL log. Tasks that were queued or running when the
   * gateway died cannot be resumed - the child process is long gone - so they
   * are surfaced as "interrupted" instead of silently vanishing or, worse,
   * sitting in the UI as "running" forever.
   */
  restore(records = [], idempotency = new Map(), eventsByTask = new Map()) {
    let restored = 0;
    let interrupted = 0;
    for (const record of records) {
      if (this.tasks.size >= this.maxTasks && !record?.research) continue;
      if (!record || typeof record.id !== "string" || this.tasks.has(record.id)) continue;
      const task = {
        id: record.id,
        label: record.label ?? "",
        tags: normalizeTags(record.tags),
        prompt: record.prompt ?? "",
        cwd: record.cwd ?? null,
        mode: record.mode ?? "read-only",
        model: record.model ?? null,
        threadId: record.threadId ?? null,
        status: record.status ?? "failed",
        createdAt: record.createdAt ?? null,
        acceptedAt: record.acceptedAt ?? record.createdAt ?? null,
        queuedAt: record.queuedAt ?? record.createdAt ?? null,
        startedAt: record.startedAt ?? null,
        processStartedAt: record.processStartedAt ?? null,
        firstOutputAt: record.firstOutputAt ?? null,
        lastOutputAt: record.lastOutputAt ?? null,
        finishedAt: record.finishedAt ?? null,
        updatedAt: record.updatedAt ?? record.finishedAt ?? record.createdAt ?? null,
        terminationReason: record.terminationReason ?? null,
        exitCode: record.exitCode ?? null,
        exitSignal: record.exitSignal ?? null,
        reconnectCount: record.reconnectCount ?? 0,
        approvalWaitCount: record.approvalWaitCount ?? 0,
        runtimeMode: record.runtimeMode ?? null,
        turnId: record.turnId ?? null,
        pendingApprovals: [],
        finalResponse: record.finalResponse ?? null,
        error: record.error ?? null,
        domain: record.domain ?? "adhoc",
        taskType: record.taskType ?? null,
        priority: record.priority ?? "normal",
        outputTypes: Array.isArray(record.outputTypes) ? record.outputTypes : [],
        agent: record.agent ?? "codex",
        agentChoice: record.agentChoice ?? "auto",
        summary: record.summary ?? null,
        conclusions: Array.isArray(record.conclusions) ? record.conclusions : [],
        risks: Array.isArray(record.risks) ? record.risks : [],
        nextActions: Array.isArray(record.nextActions) ? record.nextActions : [],
        structured: record.structured ?? false,
        research: record.research ?? null,
        skills: record.skills ?? [],
        artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
        runs: Array.isArray(record.runs) ? record.runs : [],
        usage: normalizeUsage(record.usage),
        readAt: record.readAt ?? null,
        archivedAt: record.archivedAt ?? null,
        preview: record.preview ?? null,
        idempotencyKey: record.idempotencyKey ?? null,
        events: (eventsByTask.get(record.id) ?? []).slice(-500),
        nextSequence: ((eventsByTask.get(record.id) ?? []).at(-1)?.sequence ?? 0) + 1,
        subscribers: new Set(),
        controller: new AbortController(),
        restored: true,
      };
      if (["queued", "running", "waiting_approval"].includes(task.status) &&
          !(task.status === "queued" && task.research?.transport === "local-pull")) {
        task.status = "interrupted";
        task.error = "Gateway restarted before this task finished";
        task.terminationReason = "gateway_restart";
        task.finishedAt = task.finishedAt ?? new Date().toISOString();
        interrupted += 1;
      }
      this.tasks.set(task.id, task);
      if (task.status === "queued" && task.research?.transport === "local-pull") this.queue.push(task.id);
      if (task.idempotencyKey) this.idempotency.set(task.idempotencyKey, task.id);
      restored += 1;
    }
    for (const [key, id] of idempotency) {
      if (!this.idempotency.has(key) && this.tasks.has(id)) this.idempotency.set(key, id);
    }
    return { restored, interrupted };
  }

  create(input, idempotencyKey = null, options = {}) {
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const existing = this.tasks.get(this.idempotency.get(idempotencyKey));
      if (existing) return { task: publicTask(existing), duplicate: true };
    }
    const draft = options.draft === true;
    const createdAt = new Date().toISOString();
    const task = {
      id: randomUUID(),
      ...input,
      idempotencyKey,
      status: draft ? "draft" : "queued",
      createdAt,
      acceptedAt: createdAt,
      queuedAt: draft ? null : createdAt,
      startedAt: null,
      processStartedAt: null,
      firstOutputAt: null,
      lastOutputAt: null,
      finishedAt: null,
      updatedAt: null,
      terminationReason: null,
      exitCode: null,
      exitSignal: null,
      reconnectCount: 0,
      approvalWaitCount: 0,
      runtimeMode: null,
      turnId: null,
      pendingApprovals: [],
      tags: normalizeTags(input.tags),
      domain: input.domain ?? "adhoc",
      taskType: input.taskType ?? null,
      priority: input.priority ?? "normal",
      outputTypes: Array.isArray(input.outputTypes) ? input.outputTypes : [],
      agent: input.agent ?? "codex",
      agentChoice: input.agentChoice ?? "auto",
      // 这次挂了哪些工作方法（技能）。只记名字，正文在提示词里。
      skills: Array.isArray(input.skills) ? input.skills.slice(0, 8) : [],
      summary: null,
      conclusions: [],
      risks: [],
      nextActions: [],
      structured: false,
      artifacts: [],
      runs: [],
      usage: null,
      readAt: null,
      archivedAt: null,
      finalResponse: null,
      error: null,
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      controller: new AbortController(),
    };
    // Research must have a durable draft before it is visible or dispatched.
    if (task.research) {
      if (!draft || !this.persist) throw new Error("Research requires a persistent draft");
      this.persist(task, idempotencyKey);
    }
    this.tasks.set(task.id, task);
    if (options?.toolContext) this.toolContexts.set(task.id, options.toolContext);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, task.id);
    if (draft) {
      this.#event(task, "gateway", { status: "draft" });
      this.#trim();
      this.#save(task);
      return { task: publicTask(task), duplicate: false };
    }
    this.queue.push(task.id);
    this.#event(task, "gateway", { status: "queued" });
    this.#trim();
    this.#save(task);
    queueMicrotask(() => this.#schedule());
    return { task: publicTask(task), duplicate: false };
  }

  list() {
    return [...this.tasks.values()].reverse().map((task) => publicTask(task));
  }

  // Internal WorkBuddy transport journal, stored on the existing research task.
  // Fail closed before any dispatch; never hide a failed durable checkpoint.
  researchCheckpoint(id, transport) {
    const task = this.tasks.get(id);
    if (!task?.research || !this.persist) throw new Error("Durable research task required");
    const previous = task.research.workbuddy;
    task.research.workbuddy = { ...transport };
    try { this.persist(task, task.idempotencyKey); }
    catch (error) { task.research.workbuddy = previous; throw error; }
  }

  /** External executors share this task record and queue; persist before exposing a transition. */
  researchTransition(id, patch) {
    const task = this.tasks.get(id);
    if (!task?.research || !this.persist) throw new Error("Durable research task required");
    const candidate = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.persist(candidate, candidate.idempotencyKey);
    Object.assign(task, candidate);
    if (task.status !== "queued") this.queue = this.queue.filter(value => value !== id);
    else if (!this.queue.includes(id)) this.queue.push(id);
    this.#event(task, "gateway", { status: task.status, executor: task.research.executor });
    return publicTask(task);
  }

  get(id, includeEvents = false) {
    const task = this.tasks.get(id);
    return task ? publicTask(task, includeEvents) : null;
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.research?.transport === "local-pull" && task.research.localPull?.claim)
      throw new Error("已领取研究须确认执行端停止，不能仅在平台取消或释放租约");
    if (task.research?.transport === "local-pull" && ["draft","queued"].includes(task.status))
      return this.researchTransition(id,{status:"cancelled",terminationReason:"cancelled",finishedAt:new Date().toISOString()});
    if (task.research?.workbuddy?.dispatchPhase)
      throw new Error("WorkBuddy 原生取消未核实，不能把本地取消当作研究已停止");
    if (task.status === "draft") {
      task.status = "cancelled";
      task.terminationReason = "cancelled";
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
      this.#event(task, "gateway", { status: "cancelled" });
      this.#save(task);
      return publicTask(task);
    }
    if (!["queued", "running", "waiting_approval"].includes(task.status)) return publicTask(task);
    task.controller.abort();
    if (task.status === "queued") {
      task.status = "cancelled";
      task.terminationReason = "cancelled";
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.#event(task, "gateway", { status: "cancelled" });
      this.#save(task);
    }
    return publicTask(task);
  }

  /** Edit the human-facing metadata of a task. Never touches the run state. */
  update(id, patch = {}) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.research) throw new Error("研究任务关联及执行配置只读；重新研究须创建新版本");
    if (typeof patch.label === "string") task.label = patch.label.trim().slice(0, 120);
    if (typeof patch.title === "string") task.label = patch.title.trim().slice(0, 120);
    if (patch.tags !== undefined) task.tags = normalizeTags(patch.tags);
    if (typeof patch.domain === "string") task.domain = patch.domain;
    if (typeof patch.priority === "string") task.priority = patch.priority;
    if (Array.isArray(patch.outputTypes)) task.outputTypes = patch.outputTypes;
    if (typeof patch.agent === "string") task.agent = patch.agent;
    if (typeof patch.agentChoice === "string") task.agentChoice = patch.agentChoice;
    task.updatedAt = new Date().toISOString();
    this.#save(task);
    return publicTask(task);
  }

  markRead(id, read = true) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.readAt = read ? new Date().toISOString() : null;
    this.#save(task);
    return publicTask(task);
  }

  archive(id, archived = true) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.research) {
      task.archivedAt = archived ? new Date().toISOString() : null;
      this.#save(task);
      return publicTask(task);
    }
    if (archived) {
      task.archivedAt = new Date().toISOString();
      task.status = "archived";
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
    } else {
      task.archivedAt = null;
      task.status = task.finalResponse ? "completed" : task.error ? "failed" : "cancelled";
    }
    task.updatedAt = new Date().toISOString();
    this.#event(task, "gateway", { status: task.status, archived: Boolean(archived) });
    this.#save(task);
    return publicTask(task);
  }

  /** Promote a draft into the queue. */
  dispatch(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.research?.transport === "local-pull") throw new Error("本地领取任务不能派给通用 Runner");
    if (task.status !== "draft") return publicTask(task);
    task.status = "queued";
    task.updatedAt = new Date().toISOString();
    task.queuedAt = task.updatedAt;
    this.queue.push(task.id);
    this.#event(task, "gateway", { status: "queued" });
    this.#save(task);
    queueMicrotask(() => this.#schedule());
    return publicTask(task);
  }

  /**
   * Run a task again. `resume: true` keeps threadId so Codex continues the old
   * conversation; `resume: false` starts a clean thread (the P0-07 default).
   */
  rerun(id, { resume = false } = {}) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.research) throw new Error("研究重试须经受理端创建新任务版本，不能覆盖原始版本");
    if (["queued", "running", "waiting_approval"].includes(task.status)) return publicTask(task);
    if (!resume) task.threadId = null;
    task.status = "queued";
    task.error = null;
    task.finalResponse = null;
    task.summary = null;
    task.conclusions = [];
    task.risks = [];
    task.nextActions = [];
    task.structured = false;
    task.readAt = null;
    task.archivedAt = null;
    task.artifacts = [];
    task.usage = null;
    task.startedAt = null;
    task.queuedAt = new Date().toISOString();
    task.processStartedAt = null;
    task.firstOutputAt = null;
    task.lastOutputAt = null;
    task.finishedAt = null;
    task.updatedAt = task.queuedAt;
    task.terminationReason = null;
    task.exitCode = null;
    task.exitSignal = null;
    task.reconnectCount = 0;
    task.approvalWaitCount = 0;
    task.runtimeMode = null;
    task.turnId = null;
    task.pendingApprovals = [];
    // Keep a single monotonic event sequence across reruns. Resetting it would
    // make persisted SSE cursors ambiguous after a gateway restart.
    task.controller = new AbortController();
    this.queue.push(task.id);
    this.#event(task, "gateway", { status: "queued", resume });
    this.#save(task);
    queueMicrotask(() => this.#schedule());
    return publicTask(task);
  }

  /** Queue position for a task that has not started yet, 1-based; null if running. */
  queuePosition(id) {
    const index = this.queue.indexOf(id);
    return index === -1 ? null : index + 1;
  }

  subscribe(id, listener) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.subscribers.add(listener);
    return () => task.subscribers.delete(listener);
  }

  /**
   * Atomically subscribe and capture the replay window. JavaScript cannot run
   * another event callback between these synchronous operations, so an event
   * can no longer land in the old snapshot-before-subscribe gap.
   */
  subscribeFrom(id, listener) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.subscribers.add(listener);
    const events = task.events.slice();
    return {
      status: task.status,
      events,
      earliestSequence: events[0]?.sequence ?? task.nextSequence,
      latestSequence: events.at(-1)?.sequence ?? task.nextSequence - 1,
      unsubscribe: () => task.subscribers.delete(listener),
    };
  }

  history(id) {
    return this.tasks.get(id)?.events ?? null;
  }

  eventWindow(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const events = task.events.slice();
    return {
      status: task.status,
      events,
      earliestSequence: events[0]?.sequence ?? task.nextSequence,
      latestSequence: events.at(-1)?.sequence ?? task.nextSequence - 1,
    };
  }

  resolveApproval(id, approvalId, decision) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const pending = (task.pendingApprovals ?? []).find((item) => item.approvalId === approvalId);
    if (!pending) throw new Error("Approval not found or already resolved");
    if (!this.approvalResolver?.(id, approvalId, decision)) {
      throw new Error("Approval is no longer active; refresh the task status");
    }
    task.pendingApprovals = task.pendingApprovals.filter((item) => item.approvalId !== approvalId);
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    this.#save(task);
    return publicTask(task);
  }

  metrics() {
    const tasks = [...this.tasks.values()];
    const now = new Date().toISOString();
    const snapshots = tasks.map((task) => taskMetrics(task, now));
    const byStatus = {};
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    const completed = tasks.filter((task) => task.status === "completed").length;
    const failed = tasks.filter((task) => ["failed", "interrupted"].includes(task.status)).length;
    return {
      generatedAt: now,
      total: tasks.length,
      byStatus,
      successRate: completed + failed > 0 ? completed / (completed + failed) : null,
      queueMs: { p50: percentile(snapshots.map((m) => m.queueMs), 0.5), p95: percentile(snapshots.map((m) => m.queueMs), 0.95) },
      firstOutputMs: { p50: percentile(snapshots.map((m) => m.firstOutputMs), 0.5), p95: percentile(snapshots.map((m) => m.firstOutputMs), 0.95) },
      runMs: { p50: percentile(snapshots.map((m) => m.runMs), 0.5), p95: percentile(snapshots.map((m) => m.runMs), 0.95) },
      reconnects: tasks.reduce((sum, task) => sum + (task.reconnectCount ?? 0), 0),
      approvalWaits: tasks.reduce((sum, task) => sum + (task.approvalWaitCount ?? 0), 0),
    };
  }

  #save(task) {
    if (!this.persist) return;
    try {
      this.persist(task, task.idempotencyKey);
    } catch (error) {
      if (task.research) {
        task.status = "interrupted";
        task.terminationReason = "research_persistence_failed";
        task.error = "RESEARCH_PERSISTENCE_FAILED";
      }
      process.stderr.write(`[task-manager] persist failed: ${error?.message || error}\n`);
    }
  }

  #event(task, type, data) {
    const at = new Date().toISOString();
    if (type === "process" && data?.phase === "started") task.processStartedAt = at;
    if (type === "runtime" && data?.phase === "ready") task.processStartedAt ??= at;
    if (type === "process" && data?.phase === "closed") {
      task.exitCode = data.exitCode ?? null;
      task.exitSignal = data.exitSignal ?? null;
    }
    if (["codex", "agent", "stdout", "stderr"].includes(type)) {
      task.firstOutputAt ??= at;
      task.lastOutputAt = at;
    }
    if (type === "stderr" && /reconnecting/i.test(String(data?.text ?? ""))) {
      task.reconnectCount = (task.reconnectCount ?? 0) + 1;
    }
    if (type === "codex" && /approval/i.test(String(data?.type ?? ""))) {
      task.approvalWaitCount = (task.approvalWaitCount ?? 0) + 1;
    }
    if (type === "runtime" && data?.mode) task.runtimeMode = data.mode;
    if (type === "codex" && data?.type === "turn.started") task.turnId = data.turn_id ?? data.turnId ?? task.turnId;
    // 云端员工在自己的回合结束时上报本轮用量；多轮工具循环已在 runner 里累加成一次
    if (type === "agent" && data?.type === "turn.completed") {
      const delta = normalizeUsage(data.usage);
      if (delta) task.usage = mergeUsage(task.usage, delta);
    }
    if (type === "approval") {
      task.approvalWaitCount = (task.approvalWaitCount ?? 0) + 1;
      task.pendingApprovals = [...(task.pendingApprovals ?? []), data];
      task.status = "waiting_approval";
      task.updatedAt = at;
      this.#save(task);
    }
    if (type === "approval.resolved") {
      task.pendingApprovals = (task.pendingApprovals ?? []).filter((item) => item.approvalId !== data?.approvalId);
      task.status = "running";
      task.updatedAt = at;
    }
    const event = { sequence: task.nextSequence++, at, type, data };
    task.events.push(event);
    if (task.events.length > 500) task.events.shift();
    if (this.persistEvent) {
      try { this.persistEvent(task.id, event); }
      catch (error) { process.stderr.write(`[task-manager] event persist failed: ${error?.message || error}\n`); }
    }
    for (const listener of task.subscribers) listener(event);
  }

  #schedule() {
    while (this.running < this.concurrency && this.queue.length) {
      const index = this.queue.findIndex(id => this.tasks.get(id)?.research?.transport !== "local-pull");
      if (index < 0) break;
      const [id] = this.queue.splice(index, 1);
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.#run(task);
    }
  }

  async #run(task) {
    this.running += 1;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    const runId = `${task.id.slice(0, 8)}-r${task.runs.length + 1}`;
    task.currentRunId = runId;
    this.#event(task, "gateway", { status: "running", runId });
    this.#save(task);
    if (task.research && task.status !== "running") {
      this.running -= 1; this.#schedule(); return;
    }
    try {
      const result = await this.runner(task, {
        signal: task.controller.signal,
        timeoutMs: this.timeoutMs,
        toolContext: this.toolContexts.get(task.id) ?? null,
        emit: (type, data) => {
          if (type === "codex" && data.type === "thread.started" && data.thread_id) {
            task.threadId = data.thread_id;
            // Persist as soon as the thread exists: a crashed task is still
            // resumable later via `codex exec resume <threadId>`.
            this.#save(task);
          }
          this.#event(task, type, data);
        },
      });
      task.threadId = result.threadId || task.threadId;
      task.finalResponse = result.finalResponse || "";

      // Structured result: parse the output contract, then register artifacts.
      const parsed = parseResult(task.finalResponse);
      task.summary = summarize(parsed);
      task.conclusions = parsed.conclusions;
      task.risks = parsed.risks;
      task.nextActions = parsed.nextActions;
      task.structured = parsed.structured;
      // 本机执行器才产生产物文件：Codex 靠目录扫描，Claude 靠它自己报的 Write/Edit 路径
      const declaredFiles = [
        ...(parsed.declaredFiles ?? []),
        ...(result.files ?? []).map((path) => ({ path, note: "执行器写入" })),
      ];
      const fresh = task.agent === "codex" || task.agent === "claude"
        ? collectArtifacts({
          declared: declaredFiles,
          cwd: task.cwd,
          since: task.startedAt,
          runId,
          agent: task.agent,
          scan: task.agent === "codex",
        })
        : [];
      const byPath = new Map((task.artifacts ?? []).map((item) => [item.path, item]));
      for (const item of fresh) byPath.set(item.path, item);
      task.artifacts = [...byPath.values()];

      task.status = "completed";
      task.terminationReason = "completed";
      task.pendingApprovals = [];
    } catch (error) {
      task.status = error?.name === "AbortError" ? "cancelled" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.pendingApprovals = [];
      task.terminationReason = error?.code === "TASK_TIMEOUT"
        ? "timeout"
        : error?.name === "AbortError"
          ? "cancelled"
          : error?.code === "CODEX_EXIT"
            ? "process_exit"
            : "error";
      task.summary = task.summary || task.error;
    } finally {
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
      task.currentRunId = null;
      task.runs = [
        ...(task.runs ?? []),
        {
          runId,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          status: task.status,
          terminationReason: task.terminationReason,
          threadId: task.threadId,
          error: task.error,
          summary: task.summary,
          metrics: taskMetrics(task, task.finishedAt),
          usage: task.usage ?? null,
          artifactIds: (task.artifacts ?? []).map((item) => item.id),
        },
      ].slice(-20);
      if (task.research) this.#save(task);
      this.#event(task, "gateway", { status: task.status, error: task.error, runId });
      if (!task.research) this.#save(task);
      this.toolContexts.delete(task.id);
      this.running -= 1;
      this.#schedule();
    }
  }

  #trim() {
    if (this.tasks.size <= this.maxTasks) return;
    for (const [id, task] of this.tasks) {
      if (task.research) continue;
      if (["queued", "running", "waiting_approval"].includes(task.status)) continue;
      this.tasks.delete(id);
      if (this.tasks.size <= this.maxTasks) break;
    }
  }
}
