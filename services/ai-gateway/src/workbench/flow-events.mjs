/**
 * 流程运行事件总线。
 *
 * 为什么单独做一套：流程状态原来只靠前端每 3 秒 GET 一次 `/api/flows` 全量快照，
 * 延迟高、请求重。但流程并不需要传输正文增量——按产品口径，界面只要
 * 「步骤状态 + 产物清单」。所以这里只推轻量事件，不复用 task SSE 的 delta 通道。
 *
 * 语义与 task SSE 保持一致，前端可以用同一套续传逻辑：
 *   - 每个 run 一条单调递增的 sequence，重跑不重置；
 *   - subscribeFrom 在同一个同步方法内完成「挂监听 + 取历史」，不留漏事件的窗口；
 *   - 环形窗口只留最近 RETENTION 条，cursor 落后就给 reset，让前端重新拉快照。
 *
 * 事件形态：{ sequence, at, type, data }
 *   type 取值见 FLOW_EVENT_TYPES，data 至少带 runId，步骤相关事件带 stepKey。
 */

/** 保留条数。流程事件比 token 流稀疏得多，200 条足够覆盖一次正常运行的断线重连。 */
const RETENTION = 200;

export const FLOW_EVENT_TYPES = [
  "run.started",
  "run.status",
  "step.started",
  "step.progress",
  "step.completed",
  "step.failed",
  "step.skipped",
  "run.finished",
];

export class FlowEventBus {
  constructor({ retention = RETENTION } = {}) {
    this.retention = retention;
    /** runId -> { events: [], nextSequence: number, subscribers: Set } */
    this.channels = new Map();
  }

  #channel(runId, create = false) {
    let channel = this.channels.get(runId);
    if (!channel && create) {
      channel = { events: [], nextSequence: 1, subscribers: new Set() };
      this.channels.set(runId, channel);
    }
    return channel ?? null;
  }

  /**
   * 发布一条事件。没人订阅时也要记进窗口——前端可能在步骤跑完之后才打开详情，
   * 那时需要重放它错过的状态变化。
   */
  publish(runId, type, data = {}) {
    if (!runId) return null;
    const channel = this.#channel(runId, true);
    const event = {
      sequence: channel.nextSequence++,
      at: new Date().toISOString(),
      type,
      data: { runId, ...data },
    };
    channel.events.push(event);
    if (channel.events.length > this.retention) {
      channel.events.splice(0, channel.events.length - this.retention);
    }
    for (const listener of channel.subscribers) {
      try {
        listener(event);
      } catch {
        // 单个 SSE 连接写失败不能拖垮流程执行
      }
    }
    return event;
  }

  /**
   * 原子地「挂监听 + 取窗口」。JavaScript 不会在这两行之间插入别的事件回调，
   * 所以不存在「先快照后订阅」导致漏事件的缝隙。
   */
  subscribeFrom(runId, listener) {
    const channel = this.#channel(runId);
    if (!channel) {
      // 还没有任何事件：允许订阅，等第一条事件进来就能收到（例如刚点开详情）。
      const created = this.#channel(runId, true);
      created.subscribers.add(listener);
      return {
        events: [],
        earliestSequence: created.nextSequence,
        latestSequence: created.nextSequence - 1,
        unsubscribe: () => created.subscribers.delete(listener),
      };
    }
    channel.subscribers.add(listener);
    const events = channel.events.slice();
    return {
      events,
      earliestSequence: events[0]?.sequence ?? channel.nextSequence,
      latestSequence: events.at(-1)?.sequence ?? channel.nextSequence - 1,
      unsubscribe: () => channel.subscribers.delete(listener),
    };
  }

  eventWindow(runId) {
    const channel = this.#channel(runId);
    if (!channel) return null;
    const events = channel.events.slice();
    return {
      events,
      earliestSequence: events[0]?.sequence ?? channel.nextSequence,
      latestSequence: events.at(-1)?.sequence ?? channel.nextSequence - 1,
    };
  }

  /** 运行结束后清掉通道，避免长跑一整天攒下几百个无用的 Map 条目。 */
  drop(runId) {
    this.channels.delete(runId);
  }

  get size() {
    return this.channels.size;
  }
}

/**
 * 步骤状态事件的载荷。只带界面要用的东西：状态、耗时、产物清单摘要。
 * 不塞 output 正文——正文由快照接口给，事件只负责「什么时候该去重画」。
 */
export const stepPayload = (run, step) => ({
  stepKey: step.key,
  stepName: step.name,
  kind: step.kind ?? "task",
  status: step.status,
  taskId: step.taskId ?? null,
  startedAt: step.startedAt ?? null,
  finishedAt: step.finishedAt ?? null,
  // 产物清单：前端据此显示「N 图 / N 文件」，不需要展开就知道有没有东西
  files: (step.files ?? []).map((file) => ({
    path: file.path,
    kind: file.kind ?? "binary",
    bytes: file.bytes ?? null,
  })),
  artifactCount: (step.files ?? []).length,
  summary: step.summary ?? null,
  // 执行中的一句话进展（「正在生成结果」这类），只来自状态字段，不含正文
  progress: step.progress ?? null,
  error: step.error ?? null,
  // 进度之外顺带把整体计数带上，前端不用自己算「第几步 / 共几步」
  runStatus: run.status,
  currentStepKey: run.currentStepKey ?? null,
  // 并行时可能有多个步骤同时在跑，前端要能如实列出，而不是只显示一个
  activeStepKeys: run.activeStepKeys ?? [],
  totalSteps: run.stepStates?.length ?? 0,
  doneSteps: (run.stepStates ?? []).filter((item) =>
    ["success", "failed", "skipped"].includes(item.status),
  ).length,
});
