import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL task log.
 *
 * One line per task state change; the last line for a given id wins on replay.
 * That keeps writes O(1) and crash-safe (a torn final line is simply skipped)
 * without dragging in a database for what is, at most, a few thousand rows.
 *
 * Task snapshots and event frames use separate logs. Keeping them separate lets
 * task compaction stay cheap while SSE replay survives a gateway restart.
 */

const VERSION = 1;
const PROMPT_LIMIT = 2000;
const RESPONSE_LIMIT = 20_000;

const clip = (value, limit) => {
  if (typeof value !== "string") return value ?? null;
  return value.length > limit ? `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]` : value;
};

const toRecord = (task, idempotencyKey) => ({
  v: VERSION,
  id: task.id,
  label: task.label ?? "",
  tags: task.tags ?? [],
  prompt: task.research ? task.prompt : clip(task.prompt, PROMPT_LIMIT),
  cwd: task.cwd ?? null,
  mode: task.mode ?? null,
  model: task.model ?? null,
  threadId: task.threadId ?? null,
  status: task.status,
  createdAt: task.createdAt ?? null,
  acceptedAt: task.acceptedAt ?? task.createdAt ?? null,
  queuedAt: task.queuedAt ?? null,
  startedAt: task.startedAt ?? null,
  processStartedAt: task.processStartedAt ?? null,
  firstOutputAt: task.firstOutputAt ?? null,
  lastOutputAt: task.lastOutputAt ?? null,
  finishedAt: task.finishedAt ?? null,
  updatedAt: task.updatedAt ?? null,
  terminationReason: task.terminationReason ?? null,
  exitCode: task.exitCode ?? null,
  exitSignal: task.exitSignal ?? null,
  reconnectCount: task.reconnectCount ?? 0,
  approvalWaitCount: task.approvalWaitCount ?? 0,
  runtimeMode: task.runtimeMode ?? null,
  turnId: task.turnId ?? null,
  finalResponse: task.research ? task.finalResponse : clip(task.finalResponse, RESPONSE_LIMIT),
  research: task.research ?? null,
  skills: task.skills ?? [],
  error: task.error ?? null,
  domain: task.domain ?? null,
  taskType: task.taskType ?? null,
  priority: task.priority ?? null,
  outputTypes: task.outputTypes ?? [],
  agent: task.agent ?? null,
  agentChoice: task.agentChoice ?? null,
  summary: clip(task.summary, 400),
  conclusions: task.conclusions ?? [],
  risks: task.risks ?? [],
  nextActions: task.nextActions ?? [],
  structured: task.structured ?? false,
  artifacts: (task.artifacts ?? []).slice(-50),
  runs: (task.runs ?? []).slice(-20),
  // 用量要跟着任务一起活过重启，否则看板上的成本每次开机都从零开始
  usage: task.usage ?? null,
  readAt: task.readAt ?? null,
  archivedAt: task.archivedAt ?? null,
  idempotencyKey: idempotencyKey ?? null,
  savedAt: new Date().toISOString(),
});

export class TaskStore {
  constructor({ file, eventFile = null, maxRecords = 5000 }) {
    this.file = file;
    this.eventFile = eventFile;
    this.maxRecords = maxRecords;
    this.lines = 0;
    this.eventLines = 0;
    this.enabled = Boolean(file);
    if (this.enabled) mkdirSync(dirname(file), { recursive: true });
    if (this.eventFile) mkdirSync(dirname(this.eventFile), { recursive: true });
  }

  load() {
    if (!this.enabled || !existsSync(this.file)) return { latest: [], idempotency: new Map(), eventsByTask: this.#loadEvents(), lines: 0 };
    const raw = readFileSync(this.file, "utf8");
    const byId = new Map();
    const idempotency = new Map();
    let lines = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      lines += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // torn or truncated write - drop it, the previous snapshot stands
      }
      if (!record || record.v !== VERSION || typeof record.id !== "string") continue;
      byId.set(record.id, record);
      if (record.idempotencyKey) idempotency.set(record.idempotencyKey, record.id);
    }
    this.lines = lines;
    return { latest: [...byId.values()], idempotency, eventsByTask: this.#loadEvents(), lines };
  }

  #loadEvents() {
    const byTask = new Map();
    if (!this.eventFile || !existsSync(this.eventFile)) return byTask;
    let lines = 0;
    for (const line of readFileSync(this.eventFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      lines += 1;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.v !== VERSION || typeof record.taskId !== "string" || !record.event) continue;
      const list = byTask.get(record.taskId) ?? [];
      list.push(record.event);
      if (list.length > 500) list.shift();
      byTask.set(record.taskId, list);
    }
    this.eventLines = lines;
    return byTask;
  }

  append(task, idempotencyKey) {
    if (!this.enabled) {
      if (task.research) throw new Error("Research persistence is required");
      return;
    }
    try {
      const body = `${JSON.stringify(toRecord(task, idempotencyKey))}\n`;
      if (task.research) {
        const fd = openSync(this.file, "a", 0o600);
        try { writeFileSync(fd, body, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      } else appendFileSync(this.file, body, "utf8");
      this.lines += 1;
    } catch (error) {
      if (task.research) throw new Error("RESEARCH_PERSISTENCE_FAILED");
      // Persistence must never take the gateway down: a full disk should degrade
      // to "memory only", not to "no dispatch at all".
      process.stderr.write(`[store] append failed: ${error?.message || error}\n`);
    }
  }

  appendEvent(taskId, event) {
    if (!this.eventFile) return;
    const data = JSON.stringify(event.data ?? null);
    const safeEvent = data.length <= 32_000
      ? event
      : { ...event, data: { truncated: true, preview: data.slice(0, 32_000) } };
    try {
      appendFileSync(this.eventFile, `${JSON.stringify({ v: VERSION, taskId, event: safeEvent })}\n`, "utf8");
      this.eventLines += 1;
    } catch (error) {
      process.stderr.write(`[store] event append failed: ${error?.message || error}\n`);
    }
  }

  /** Bound the event log while preserving each task's resumable 500-event window. */
  compactEvents(eventsByTask) {
    if (!this.eventFile) return {};
    const lines = [];
    for (const [taskId, events] of eventsByTask) {
      for (const event of events.slice(-500)) lines.push(JSON.stringify({ v: VERSION, taskId, event }));
    }
    const temp = `${this.eventFile}.tmp`;
    const before = this.eventLines;
    try {
      writeFileSync(temp, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
      renameSync(temp, this.eventFile);
      this.eventLines = lines.length;
      return { before, after: lines.length };
    } catch (error) {
      process.stderr.write(`[store] event compact failed: ${error?.message || error}\n`);
      return {};
    }
  }

  /** Rewrite the log down to one snapshot per task. Called at startup only. */
  compact(tasks) {
    if (!this.enabled || tasks.length === 0) return {};
    const sorted = tasks
      .filter((task) => task && typeof task.id === "string")
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    const body = sorted.map((task) => JSON.stringify(task)).join("\n");
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, `${body}\n`, "utf8");
      renameSync(temp, this.file);
      this.lines = sorted.length;
      return { before: tasks.length, after: sorted.length };
    } catch (error) {
      process.stderr.write(`[store] compact failed: ${error?.message || error}\n`);
      return {};
    }
  }
}

export { toRecord };
