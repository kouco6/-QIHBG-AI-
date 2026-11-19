import { randomUUID } from "node:crypto";
import { runCodexTask } from "./codex-runner.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

const turnError = (turn) => {
  const error = new Error(turn?.error?.message || `Codex turn ended with status ${turn?.status || "unknown"}`);
  error.code = turn?.status === "interrupted" ? "TURN_INTERRUPTED" : "TURN_FAILED";
  error.details = turn?.error ?? null;
  return error;
};

/** Maps durable gateway tasks onto a shared app-server process. */
export class AppServerRunner {
  constructor({ client, allowExecFallback = true, silenceWarnMs = 0 } = {}) {
    this.client = client;
    this.allowExecFallback = allowExecFallback;
    this.silenceWarnMs = silenceWarnMs;
    this.activeByThread = new Map();
    this.activeByTask = new Map();
    this.approvals = new Map();
    this.threadTails = new Map();
    this.fallbackCount = 0;
    client.on("notification", (message) => this.#notification(message));
    client.on("request", (message) => this.#serverRequest(message));
    client.on("exit", (error) => this.#clientExit(error));
  }

  status() {
    return {
      ...this.client.status(),
      activeTurns: this.activeByTask.size,
      pendingApprovals: this.approvals.size,
      execFallbackEnabled: this.allowExecFallback,
      execFallbackCount: this.fallbackCount,
    };
  }

  run = async (task, context) => {
    const release = await this.#acquireThread(task.threadId);
    try {
      return await this.#runAppServer(task, context);
    } catch (error) {
      if (error?.safeToFallback && this.allowExecFallback) {
        this.fallbackCount += 1;
        context.emit("runtime", {
          mode: "exec-fallback",
          reason: error?.message || String(error),
          safety: "turn_not_started",
        });
        return runCodexTask(task, context);
      }
      throw error;
    } finally {
      release();
    }
  };

  resolveApproval(taskId, approvalId, decision) {
    if (!DECISIONS.has(decision)) throw new Error(`decision must be one of: ${[...DECISIONS].join(", ")}`);
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.taskId !== taskId) return false;
    this.client.respond(pending.rpcId, { decision });
    this.approvals.delete(approvalId);
    pending.context.emit("approval.resolved", { approvalId, decision, method: pending.method });
    return true;
  }

  async #runAppServer(task, { emit, signal, timeoutMs }) {
    let threadId = task.threadId || null;
    let turnId = null;
    let turnRequested = false;
    let finalResponse = "";
    let settled = false;
    let timeout = null;
    let silenceTimer = null;
    let lastOutputAt = Date.now();
    let silenceNotified = 0;
    let finishResolve;
    let finishReject;
    const finished = new Promise((resolve, reject) => {
      finishResolve = resolve;
      finishReject = reject;
    });
    // 防呆：turn/start 就失败时这个 Promise 可能永远没人 await。
    // 先吞掉它的 rejection（真正的失败会由下面的 throw 带出去），
    // 否则中断晚到一步就成了 unhandledRejection —— 在 Node 里等于直接杀进程。
    finished.catch(() => {});
    const context = {
      taskId: task.id,
      emit,
      get threadId() { return threadId; },
      get turnId() { return turnId; },
      noteOutput: () => { lastOutputAt = Date.now(); silenceNotified = 0; },
      complete: (turn) => {
        if (settled) return;
        settled = true;
        if (turn?.status === "completed") finishResolve({ threadId, finalResponse });
        else finishReject(turnError(turn));
      },
      setFinal: (text) => { if (typeof text === "string") finalResponse = text; },
      fail: (error) => { if (!settled) { settled = true; finishReject(error); } },
    };

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(silenceTimer);
      signal?.removeEventListener("abort", onAbort);
      if (threadId) this.activeByThread.delete(threadId);
      this.activeByTask.delete(task.id);
      for (const [id, pending] of this.approvals) {
        if (pending.taskId === task.id) this.approvals.delete(id);
      }
    };

    const interrupt = async (error) => {
      // 立刻认领：await turn/interrupt 期间 settled 还是 false，
      // 中止信号和超时检查可能同时打到这儿，会重复 reject 同一个 Promise，
      // 第二次没人消费就直接变成 unhandledRejection 把网关进程带走。
      if (settled) return;
      settled = true;
      if (threadId && turnId) {
        try { await this.client.request("turn/interrupt", { threadId, turnId }); } catch {}
      }
      // settled 已置位，这里直接 reject（context.fail 会因 settled 跳过）
      finishReject(error);
    };
    const onAbort = () => {
      const error = new Error("Task cancelled");
      error.name = "AbortError";
      void interrupt(error);
    };

    try {
      emit("runtime", { mode: "app-server", phase: "connecting", transport: "stdio-jsonl" });
      try {
        await this.client.start();
      } catch (error) {
        error.safeToFallback = true;
        throw error;
      }

      const common = {
        cwd: task.cwd,
        model: task.model || null,
        sandbox: task.mode === "workspace-write" ? "workspace-write" : "read-only",
        approvalPolicy: task.mode === "workspace-write" ? "on-request" : "never",
        approvalsReviewer: "user",
      };
      let threadResult;
      try {
        threadResult = threadId
          ? await this.client.request("thread/resume", { threadId, ...common, excludeTurns: true })
          : await this.client.request("thread/start", { ...common, ephemeral: false });
      } catch (error) {
        error.safeToFallback = true;
        throw error;
      }
      threadId = threadResult?.thread?.id || threadId;
      if (!threadId) {
        const error = new Error("Codex app-server returned no thread id");
        error.code = "APP_SERVER_PROTOCOL";
        error.safeToFallback = true;
        throw error;
      }
      this.activeByThread.set(threadId, context);
      this.activeByTask.set(task.id, context);
      emit("codex", { type: "thread.started", thread_id: threadId, resumed: Boolean(task.threadId) });
      emit("runtime", { mode: "app-server", phase: "ready", pid: this.client.status().pid });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timeout = setTimeout(() => {
        const error = new Error(`Task timed out after ${timeoutMs} ms`);
        error.code = "TASK_TIMEOUT";
        void interrupt(error);
      }, timeoutMs);
      if (this.silenceWarnMs > 0) {
        silenceTimer = setInterval(() => {
          const silentMs = Date.now() - lastOutputAt;
          const multiples = Math.floor(silentMs / this.silenceWarnMs);
          if (multiples <= silenceNotified) return;
          silenceNotified = multiples;
          emit("silence", {
            silentSeconds: Math.round(silentMs / 1000),
            thresholdSeconds: Math.round(this.silenceWarnMs / 1000),
            lastOutputAt: new Date(lastOutputAt).toISOString(),
          });
        }, Math.min(15_000, this.silenceWarnMs));
      }

      turnRequested = true;
      const turnResult = await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: task.prompt }],
        effort: task.reasoningEffort || null,
        model: task.model || null,
        cwd: task.cwd,
      });
      turnId = turnResult?.turn?.id;
      if (!turnId) throw new Error("Codex app-server returned no turn id");
      emit("codex", { type: "turn.started", thread_id: threadId, turn_id: turnId });
      // 这里无条件 await：即使中止信号在 turn/start 之前就到达（settled 已置位、
      // finished 已被 reject），这里也能把那个 rejection 认领出来当作本次运行的结局。
      return await finished;
    } catch (error) {
      if (!turnRequested) error.safeToFallback = true;
      throw error;
    } finally {
      cleanup();
    }
  }

  #notification({ method, params = {} }) {
    const context = this.activeByThread.get(params.threadId);
    if (!context) return;
    context.noteOutput();
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      context.emit("codex", { type: "agent_message.delta", ...params });
      return;
    }
    if (method === "item/completed") {
      if (params.item?.type === "agentMessage") context.setFinal(params.item.text);
      context.emit("codex", { type: "item.completed", ...params });
      return;
    }
    if (method === "turn/completed") {
      context.emit("codex", { type: "turn.completed", ...params });
      context.complete(params.turn);
      return;
    }
    context.emit("codex", { type: method, ...params });
  }

  #serverRequest(message) {
    const { method, params = {}, id } = message;
    const context = this.activeByThread.get(params.threadId);
    if (!context || !APPROVAL_METHODS.has(method)) {
      this.client.respondError(id, -32601, `Unsupported server request: ${method}`);
      return;
    }
    const approvalId = randomUUID();
    this.approvals.set(approvalId, {
      rpcId: id,
      taskId: context.taskId,
      method,
      context,
    });
    context.emit("approval", {
      approvalId,
      method,
      requestedAt: new Date().toISOString(),
      params,
      decisions: [...DECISIONS],
    });
  }

  #clientExit(error) {
    for (const context of this.activeByTask.values()) {
      const wrapped = new Error(`Codex app-server stopped during an active turn: ${error?.message || error}`);
      wrapped.code = "APP_SERVER_EXIT";
      context.fail(wrapped);
    }
  }

  async #acquireThread(threadId) {
    if (!threadId) return () => {};
    const previous = this.threadTails.get(threadId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.threadTails.set(threadId, tail);
    await previous;
    return () => {
      release();
      if (this.threadTails.get(threadId) === tail) this.threadTails.delete(threadId);
    };
  }
}
