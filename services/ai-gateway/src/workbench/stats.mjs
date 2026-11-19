/**
 * 数据看板的聚合逻辑（R1 总览 / R2 趋势 / R3 状态分布 / R4 员工表现 /
 * R5 运行效率 / R6 队列积压 / R7 流程表现 / R8 产出统计 / R9 成本观测）。
 *
 * 全部从任务列表推导，不新增存储：看板永远是当前事实的投影。
 * 口径（R1 定稿，token 只看 R9）：
 *   总数     = 除草稿外的全部任务
 *   已完成   = status === "completed"
 *   失败     = failed + interrupted（中断本质是没跑完）
 *   运行中   = running + waiting_approval（等确认也算在干活）
 *   排队中   = queued
 *   产出文件 = 所有任务登记的工件条目数
 * 趋势按「本地日期」分桶（createdAt），只统计已结束的任务的成功/失败。
 */

import { costOf, hasPricing, normalizeUsage } from "./pricing.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** ISO 时间串 → 本地日期 YYYY-MM-DD。空值返回 null。 */
export function localDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const isDone = (status) => ["completed", "failed", "interrupted", "cancelled", "archived"].includes(status);
const isFailed = (status) => ["failed", "interrupted"].includes(status);

/** 中位数：偶数个取中间两数平均，比平均值抗极端值（一个挂了 2 小时的任务不会带歪整体）。 */
function median(numbers) {
  if (!numbers.length) return null;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 任务的人类标题：任务记录里存的是 label，没有 label 就退回指令的第一行。
 * 别用 task.title，那个字段根本不存在，会全变成「无标题」。
 */
function taskTitle(task) {
  const label = String(task.label ?? "").trim();
  if (label) return label;
  const prompt = String(task.prompt ?? "").trim();
  if (prompt) return prompt.split("\n")[0].slice(0, 60);
  return "(无标题任务)";
}

/**
 * R5 运行效率：queuedAt → startedAt 是排队，startedAt → finishedAt 是真正在干。
 * 排队时长：只要有 startedAt 就能算（从 queuedAt 起算，缺了退回 createdAt），
 * 正在排队的任务没有 startedAt，不算进样本。
 * 执行时长：只统计真正跑完了的（有 finishedAt），运行中的还不知道要多久。
 */
function aggregateEfficiency(tasks) {
  let waitSample = 0;
  let runSample = 0;
  const waits = [];
  const runs = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if ((task.status ?? "") === "draft") continue;
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : NaN;
    if (!Number.isFinite(startedAt)) continue; // 还在排队，谈不上效率
    waitSample += 1;
    const queuedAt = task.queuedAt ?? task.createdAt ?? null;
    const queuedMs = queuedAt ? Date.parse(queuedAt) : NaN;
    const waitMs = startedAt - queuedMs;
    if (Number.isFinite(queuedMs) && waitMs >= 0) waits.push(Math.round(waitMs / 1000));
    const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : NaN;
    if (Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      runSample += 1;
      runs.push(Math.round((finishedAt - startedAt) / 1000));
    }
  }
  return {
    sample: waitSample,
    wait: { median: median(waits), sample: waits.length },
    run: { median: median(runs), sample: runs.length },
  };
}

/**
 * 状态分布（R3）：每个原始状态一格，图例点击后能精确筛到工作记录里的同一批。
 * 顺序固定，数量为 0 的状态不返回，前端不用再过滤。
 */
const DISTRIBUTION_ORDER = [
  ["completed", "干成"],
  ["failed", "失败"],
  ["interrupted", "中断"],
  ["cancelled", "取消"],
  ["running", "进行中"],
  ["waiting_approval", "等确认"],
  ["queued", "排队中"],
  ["archived", "已归档"],
];

/**
 * R6 队列积压：此刻还堵在「排队中 / 等确认」的任务等了多久。
 * 等待 = now - (queuedAt ?? createdAt)，跟 R5 的排队口径同源，只是分母换成「还没开跑的」。
 * 只留等得最久的前 5 条，积压多的时候看头部就够了。
 */
const BACKLOG_STATUSES = ["queued", "waiting_approval"];

function aggregateBacklog(tasks, now) {
  const items = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const status = task.status ?? "";
    if (!BACKLOG_STATUSES.includes(status)) continue;
    const since = task.queuedAt ?? task.createdAt ?? null;
    const sinceMs = since ? Date.parse(since) : NaN;
    const waitMs = now.getTime() - sinceMs;
    if (!Number.isFinite(sinceMs) || waitMs < 0) continue;
    items.push({
      id: task.id ?? "",
      title: taskTitle(task),
      status,
      agent: String(task.agent ?? "").trim(),
      waitSeconds: Math.round(waitMs / 1000),
    });
  }
  items.sort((a, b) => b.waitSeconds - a.waitSeconds);
  return {
    count: items.length,
    longestSeconds: items[0]?.waitSeconds ?? 0,
    over10m: items.filter((item) => item.waitSeconds >= 600).length,
    top: items.slice(0, 5),
  };
}

/**
 * R7 流程表现：按流程汇总运行结果。
 * 运行状态只有五种：success 跑完 / cancelled 取消 / paused 卡住（某步失败或网关重启中断）/
 * running|waiting|checking 还在跑。成功率的分母只算已结束的（前三类）。
 */
export function computeFlowStats(runs = []) {
  const groups = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue;
    const flowId = String(run.flowId ?? "").trim();
    if (!flowId) continue;
    const row = groups.get(flowId) ?? {
      flowId, name: flowId, named: false, total: 0, success: 0, cancelled: 0, stuck: 0,
      inFlight: 0, finished: 0, durationSumMs: 0, durationCount: 0,
    };
    row.total += 1;
    // 列表按新到旧传进来，只认第一条非空名字（流程改过名就用最新的）
    const runName = String(run.flowName ?? "").trim();
    if (!row.named && runName) {
      row.name = runName;
      row.named = true;
    }
    const status = run.status ?? "";
    if (status === "success") {
      row.success += 1;
      row.finished += 1;
    } else if (status === "cancelled") {
      row.cancelled += 1;
      row.finished += 1;
    } else if (status === "paused") {
      row.stuck += 1;
      row.finished += 1;
    } else if (["running", "waiting", "checking"].includes(status)) {
      row.inFlight += 1;
    }
    const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      row.durationSumMs += end - start;
      row.durationCount += 1;
    }
    groups.set(flowId, row);
  }
  return [...groups.values()]
    .map((row) => ({
      flowId: row.flowId,
      name: row.name,
      total: row.total,
      success: row.success,
      cancelled: row.cancelled,
      stuck: row.stuck,
      inFlight: row.inFlight,
      successRate: row.finished ? Math.round((row.success / row.finished) * 100) : null,
      avgSeconds: row.durationCount ? Math.round(row.durationSumMs / row.durationCount / 1000) : null,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * R8 产出统计：所有任务登记的工件，按文件类型和工作域数一遍。
 * 产出率 = 有产出的任务 ÷ 派出去的任务（草稿不算），单位是「单」不是「文件」，
 * 避免一个任务交 20 张图把比例撑到失真。
 */
const ARTIFACT_RECENT_LIMIT = 5;

export function computeArtifactStats(tasks) {
  const byType = new Map();
  const byDomain = new Map();
  const recent = [];
  let total = 0;
  let taskCount = 0;
  let withArtifacts = 0;
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if ((task.status ?? "") === "draft") continue;
    taskCount += 1;
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts.filter(Boolean) : [];
    if (artifacts.length) withArtifacts += 1;
    const domain = String(task.domain ?? "").trim() || "adhoc";
    for (const artifact of artifacts) {
      total += 1;
      const type = String(artifact.type ?? "").trim() || "file";
      byType.set(type, (byType.get(type) ?? 0) + 1);
      byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
      recent.push({
        name: String(artifact.name ?? "").trim() || "(未命名)",
        type,
        taskId: task.id ?? "",
        taskTitle: taskTitle(task),
        createdAt: artifact.createdAt ?? task.finishedAt ?? task.createdAt ?? null,
      });
    }
  }
  const types = [...byType.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const domains = [...byDomain.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  recent.sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0));
  return {
    total,
    taskCount,
    withArtifacts,
    // 有产出的任务占多少（百分比取整），以及平均每单几个文件
    rate: taskCount ? Math.round((withArtifacts / taskCount) * 100) : null,
    perTask: taskCount ? Math.round((total / taskCount) * 10) / 10 : null,
    types,
    domains,
    recent: recent.slice(0, ARTIFACT_RECENT_LIMIT),
  };
}

/**
 * R9 成本观测：token 是事实，钱是按单价算出来的估算。
 *
 * 口径：
 *   - 只统计有 usage 的任务（本机 Codex 不上报，云端员工才有），草稿不算；
 *   - 单价按「员工」取，改了单价历史金额跟着变——因为 token 没变，变的是价；
 *   - 没填单价的员工单独点名（unpricedAgents），别让「总花费」看起来是全量；
 *   - 按天分桶用 finishedAt（用量是跑完才结算的），没有就退回 createdAt。
 */
const COST_TOP_LIMIT = 5;

function aggregateCost(tasks, pricingOf) {
  const totals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    currency: "CNY",
  };
  const byDay = new Map();
  const items = [];
  const unpricedAgents = new Set();
  let tasksWithUsage = 0;
  let pricedTasks = 0;
  let unpricedTasks = 0;

  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if ((task.status ?? "") === "draft") continue;
    const usage = normalizeUsage(task.usage);
    if (!usage) continue;

    tasksWithUsage += 1;
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.totalTokens += usage.totalTokens;
    totals.cachedTokens += usage.cachedTokens;
    totals.reasoningTokens += usage.reasoningTokens;

    const agent = String(task.agent ?? "").trim();
    const pricing = agent ? pricingOf(agent) : null;
    const cost = hasPricing(pricing) ? costOf(usage, pricing) : null;
    if (cost == null) {
      unpricedTasks += 1;
      if (agent) unpricedAgents.add(agent);
    } else {
      pricedTasks += 1;
      totals.cost += cost;
    }

    const dayKey = localDate(task.finishedAt ?? task.createdAt);
    if (dayKey) {
      const day = byDay.get(dayKey) ?? { tokens: 0, cost: 0, priced: false };
      day.tokens += usage.totalTokens;
      if (cost != null) {
        day.cost += cost;
        day.priced = true;
      }
      byDay.set(dayKey, day);
    }

    items.push({
      id: task.id ?? "",
      title: taskTitle(task),
      agent,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cost,
      at: task.finishedAt ?? task.createdAt ?? null,
    });
  }

  items.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.totalTokens - a.totalTokens);
  return {
    totals: {
      ...totals,
      cost: Math.round(totals.cost * 1_000_000) / 1_000_000,
      // 有成本数据才算「有价」，否则给 null，前端显示「未填单价」而不是 ¥0
      costKnown: pricedTasks > 0,
    },
    tasksWithUsage,
    pricedTasks,
    unpricedTasks,
    unpricedAgents: [...unpricedAgents],
    top: items.filter((item) => item.cost != null).slice(0, COST_TOP_LIMIT),
    byDay,
  };
}

/**
 * @param {Array<{status:string, createdAt:string|null, finishedAt:string|null, artifacts?:Array, usage?:object}>} tasks
 * @param {{days?: number, now?: Date, pricingOf?: (agentId:string) => object|null}} options
 */
export function computeStats(tasks, { days = 7, now = new Date(), pricingOf = () => null } = {}) {
  const totals = { total: 0, completed: 0, failed: 0, running: 0, queued: 0, artifactFiles: 0 };
  const counts = new Map();
  const trendDays = Math.min(Math.max(days, 1), 90);

  // 先建好完整的日期序列：没任务的天也要有格子，折线才是连续的
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = new Map();
  for (let i = trendDays - 1; i >= 0; i -= 1) {
    const key = localDate(new Date(startOfDay.getTime() - i * DAY_MS).toISOString());
    buckets.set(key, { date: key, total: 0, succeeded: 0, failed: 0, tokens: 0, cost: null });
  }

  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const status = task.status ?? "";
    if (status === "draft") continue; // 草稿没真正派过活，不进任何口径
    totals.total += 1;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (status === "completed") totals.completed += 1;
    else if (isFailed(status)) totals.failed += 1;
    else if (["running", "waiting_approval"].includes(status)) totals.running += 1;
    else if (status === "queued") totals.queued += 1;
    if (Array.isArray(task.artifacts)) totals.artifactFiles += task.artifacts.length;

    const key = localDate(task.createdAt);
    const bucket = key ? buckets.get(key) : null;
    if (!bucket || !isDone(status)) continue; // 趋势只看已结束的
    bucket.total += 1;
    if (status === "completed") bucket.succeeded += 1;
    else if (isFailed(status)) bucket.failed += 1;
  }

  const distribution = DISTRIBUTION_ORDER
    .map(([status, label]) => ({ status, label, count: counts.get(status) ?? 0 }))
    .filter((item) => item.count > 0);

  const { byDay, ...cost } = aggregateCost(tasks, pricingOf);
  for (const [date, day] of byDay) {
    const bucket = buckets.get(date);
    if (!bucket) continue; // 落在窗口外的老账不进折线
    bucket.tokens = day.tokens;
    bucket.cost = day.priced ? Math.round(day.cost * 1_000_000) / 1_000_000 : null;
  }

  return {
    totals,
    distribution,
    agents: aggregateAgents(tasks, now, pricingOf),
    efficiency: aggregateEfficiency(tasks),
    backlog: aggregateBacklog(tasks, now),
    production: computeArtifactStats(tasks),
    cost,
    trend: [...buckets.values()],
  };
}

/**
 * R4 员工表现：按 agent 分组。成功率只看已结束的活（排队/运行中不算分母），
 * 平均耗时只统计有起止时间的任务，跟任务详情里的 runMs 一个口径。
 * token / 花费也按员工归集：贵不贵要跟「干成多少」一起看才有意义。
 */
function aggregateAgents(tasks, now, pricingOf = () => null) {
  const groups = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if ((task.status ?? "") === "draft") continue;
    const agent = String(task.agent ?? "").trim();
    if (!agent) continue;
    const row = groups.get(agent) ?? {
      agent, total: 0, completed: 0, failed: 0, running: 0, finished: 0,
      durationSumMs: 0, durationCount: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, costSum: 0, costCount: 0,
    };
    const status = task.status ?? "";
    row.total += 1;
    if (status === "completed") {
      row.completed += 1;
      row.finished += 1;
    } else if (isFailed(status) || status === "cancelled") {
      if (isFailed(status)) row.failed += 1;
      row.finished += 1;
    } else if (["running", "waiting_approval", "queued"].includes(status)) {
      row.running += 1;
    }
    const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
    const end = task.finishedAt ? Date.parse(task.finishedAt) : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      row.durationSumMs += end - start;
      row.durationCount += 1;
    }
    const usage = normalizeUsage(task.usage);
    if (usage) {
      row.promptTokens += usage.promptTokens;
      row.completionTokens += usage.completionTokens;
      row.totalTokens += usage.totalTokens;
      const cost = costOf(usage, pricingOf(agent));
      if (cost != null) {
        row.costSum += cost;
        row.costCount += 1;
      }
    }
    groups.set(agent, row);
  }
  return [...groups.values()]
    .map((row) => ({
      agent: row.agent,
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      running: row.running,
      successRate: row.finished ? Math.round((row.completed / row.finished) * 100) : null,
      avgSeconds: row.durationCount ? Math.round(row.durationSumMs / row.durationCount / 1000) : null,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      // null 表示「这一列的账算不出来」，跟「花了 0 元」区分开
      cost: row.costCount ? Math.round(row.costSum * 1_000_000) / 1_000_000 : null,
    }))
    .sort((a, b) => b.total - a.total);
}
