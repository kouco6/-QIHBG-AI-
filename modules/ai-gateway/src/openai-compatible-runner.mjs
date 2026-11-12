import { MAX_ROUNDS, toolSchemasFor } from "./workbench/agent-tools.mjs";
import { mergeUsage, normalizeUsage } from "./workbench/pricing.mjs";

const DEFAULT_SYSTEM_PROMPT = `你是 WorkBuddy 中的一名 AI 员工。请直接完成用户交付的知识工作。

规则：
1. 只陈述你实际完成的内容，不虚构文件、联网结果、进度百分比或预计耗时。
2. 你不能直接访问本机文件系统；如果任务依赖未提供的本地文件，请明确指出缺少什么。
3. 输出应清晰、可执行。需要结构化交付时，优先使用 Markdown 标题与列表。
4. 如果存在风险、假设或不确定性，请明确标注。`;

const abortError = (message = "Task cancelled") => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const timeoutError = (timeoutMs) => {
  const error = new Error(`Cloud agent timed out after ${timeoutMs}ms`);
  error.code = "TASK_TIMEOUT";
  return error;
};

const providerError = (agentName, status, payload) => {
  const message = payload?.error?.message || payload?.message || payload?.error || `HTTP ${status}`;
  const error = new Error(`${agentName} API 请求失败：${String(message).slice(0, 500)}`);
  error.code = "AGENT_API_ERROR";
  error.status = status;
  return error;
};

const normalizeBaseUrl = (value) => String(value || "").replace(/\/+$/, "");

const readErrorPayload = async (response) => {
  const text = (await response.text()).slice(0, 20_000);
  try { return JSON.parse(text); }
  catch { return { message: text || response.statusText }; }
};

const eventBlocks = (buffer) => {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { blocks: parts.slice(0, -1), tail: parts.at(-1) || "" };
};

const dataForBlock = (block) => block
  .split("\n")
  .filter((line) => line.startsWith("data:"))
  .map((line) => line.slice(5).trimStart())
  .join("\n");

const kimiReasoningEffort = (effort) => ({ minimal: "low", low: "low", medium: "high", high: "max" })[effort] || "high";

const requestOverrides = (provider, task) => {
  if (provider === "kimi") {
    return { reasoning_effort: kimiReasoningEffort(task.reasoningEffort) };
  }
  if (provider === "doubao") {
    return { thinking: { type: "enabled" }, reasoning_effort: task.reasoningEffort || "medium" };
  }
  return {};
};

/** Accumulate streamed `delta.tool_calls` fragments into complete calls. */
const mergeToolDeltas = (calls, deltas) => {
  for (const delta of deltas ?? []) {
    const index = Number.isInteger(delta?.index) ? delta.index : calls.length;
    const current = calls[index] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
    if (delta?.id) current.id = delta.id;
    if (delta?.type) current.type = delta.type;
    if (delta?.function?.name) current.function.name += delta.function.name;
    if (delta?.function?.arguments) current.function.arguments += delta.function.arguments;
    calls[index] = current;
  }
  return calls;
};

const safeJson = (text) => {
  try { return JSON.parse(text || "{}"); }
  catch { return null; }
};

/**
 * Creates a runner for OpenAI-compatible Chat Completions APIs.
 * The public contract matches Codex runners: run(task, {signal, timeoutMs, emit, toolContext}).
 *
 * When a tool sandbox is supplied, the runner becomes a small agent loop:
 * model -> tool calls -> tool results -> model, until it answers without tools
 * or hits the round budget.
 */
export function createOpenAICompatibleRunner(options, { fetchImpl = globalThis.fetch } = {}) {
  const {
    id,
    name,
    provider = id,
    apiKey,
    baseUrl,
    model,
    maxOutputTokens = 16_384,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = options || {};

  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!id || !name || !baseUrl || !model) throw new Error("agent id, name, baseUrl and model are required");
  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  return async function runCloudAgent(task, { emit = () => {}, signal, timeoutMs, toolContext } = {}) {
    if (!apiKey) {
      const error = new Error(`${name} 尚未配置 API Key`);
      error.code = "AGENT_NOT_CONFIGURED";
      throw error;
    }
    if (signal?.aborted) throw abortError();

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason || abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError(timeoutMs));
    }, timeoutMs);

    const activeModel = task.model || model;
    const startedAt = Date.now();
    const sandbox = toolContext?.sandbox && toolContext.sandbox.mode !== "none" ? toolContext.sandbox : null;
    const tools = sandbox ? toolSchemasFor(sandbox.mode) : [];
    const maxRounds = sandbox ? Math.min(Math.max(Number(toolContext?.maxRounds) || MAX_ROUNDS, 1), MAX_ROUNDS) : 0;

    const system = sandbox ? `${systemPrompt}\n\n${sandbox.systemRules()}` : systemPrompt;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: task.prompt },
    ];

    let finalResponse = "";
    let narrative = "";
    let reasoningChars = 0;
    // 工具循环里每次请求都各自计费，只留最后一轮的 usage 会漏掉前面所有轮次。
    let usageTotals = null;
    let usageRounds = 0;
    let finishReason = null;
    let toolRounds = 0;
    let lastContent = "";

    const runRequest = async () => {
      let content = "";
      let calls = [];
      let roundFinish = null;
      let roundUsage = null;
      let pendingDelta = "";
      let lastDeltaEmitAt = 0;
      let outputStarted = false;

      const flushDelta = (force = false) => {
        if (!pendingDelta) return;
        if (!force && pendingDelta.length < 240 && Date.now() - lastDeltaEmitAt < 700) return;
        emit("agent", { type: "output.delta", agent: id, model: activeModel, delta: pendingDelta });
        pendingDelta = "";
        lastDeltaEmitAt = Date.now();
      };

      const consumeChunk = (chunk) => {
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta || choice?.message || {};
        if (typeof delta.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
        if (typeof delta.content === "string" && delta.content) {
          if (!outputStarted) {
            outputStarted = true;
            emit("agent", { type: "item.started", agent: id, model: activeModel, item: { type: "agent_message", name } });
          }
          content += delta.content;
          pendingDelta += delta.content;
          flushDelta(false);
        }
        if (Array.isArray(delta.tool_calls)) calls = mergeToolDeltas(calls, delta.tool_calls);
        if (choice?.finish_reason) roundFinish = choice.finish_reason;
        if (chunk?.usage) roundUsage = chunk.usage;
      };

      const body = {
        model: activeModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(provider === "doubao" ? { max_tokens: maxOutputTokens } : { max_completion_tokens: maxOutputTokens }),
        ...(provider === "kimi" ? { prompt_cache_key: task.threadId || task.id } : {}),
        ...requestOverrides(provider, task),
      };
      if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(provider === "kimi" ? { "x-msh-request-nonce": task.id } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) throw providerError(name, response.status, await readErrorPayload(response));
      emit("runtime", { mode: `${id}-api`, phase: "streaming", transport: "https-sse", provider, model: activeModel });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const payload = await response.json();
        const message = payload?.choices?.[0]?.message || {};
        content = typeof message.content === "string" ? message.content : "";
        reasoningChars += typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
        if (Array.isArray(message.tool_calls)) calls = message.tool_calls;
        roundFinish = payload?.choices?.[0]?.finish_reason || null;
        roundUsage = payload?.usage || null;
        if (content) {
          emit("agent", { type: "output.delta", agent: id, model: activeModel, delta: content });
          emit("agent", { type: "item.started", agent: id, model: activeModel, item: { type: "agent_message", name } });
        }
      } else {
        const reader = response.body?.getReader();
        if (!reader) throw new Error(`${name} API 没有返回可读取的响应流`);
        const decoder = new TextDecoder();
        let buffer = "";
        let doneMarker = false;
        while (!doneMarker) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const parsed = eventBlocks(buffer);
          buffer = parsed.tail;
          for (const block of parsed.blocks) {
            const data = dataForBlock(block);
            if (!data) continue;
            if (data === "[DONE]") { doneMarker = true; break; }
            try { consumeChunk(JSON.parse(data)); }
            catch (error) {
              emit("stderr", { text: `${name} 流事件解析失败：${error.message}` });
            }
          }
          if (done) {
            if (buffer.trim()) {
              const data = dataForBlock(buffer);
              if (data && data !== "[DONE]") {
                try { consumeChunk(JSON.parse(data)); } catch {}
              }
            }
            break;
          }
        }
      }

      flushDelta(true);
      return {
        content,
        toolCalls: calls.filter((call) => call?.function?.name),
        finishReason: roundFinish,
        usage: roundUsage,
      };
    };

    try {
      emit("runtime", { mode: `${id}-api`, phase: "connecting", transport: "https-sse", provider, model: activeModel });
      emit("agent", { type: "turn.started", agent: id, model: activeModel });

      while (true) {
        const reply = await runRequest();
        finishReason = reply.finishReason;
        const roundUsage = normalizeUsage(reply.usage);
        if (roundUsage) {
          usageTotals = mergeUsage(usageTotals, roundUsage);
          usageRounds += 1;
        }
        if (reply.content) {
          narrative += `${narrative ? "\n\n" : ""}${reply.content}`;
          lastContent = reply.content;
        }

        if (!reply.toolCalls.length) break;
        if (toolRounds >= maxRounds) {
          emit("stderr", { text: `${name} 工具调用达到 ${maxRounds} 轮上限，已要求直接给出结论` });
          messages.push({ role: "user", content: "工具调用轮次已到上限。请立刻基于已有信息给出最终回答，不要再调用工具。" });
          const closing = await runRequest();
          const closingUsage = normalizeUsage(closing.usage);
          if (closingUsage) {
            usageTotals = mergeUsage(usageTotals, closingUsage);
            usageRounds += 1;
          }
          if (closing.content) {
            narrative += `${narrative ? "\n\n" : ""}${closing.content}`;
            lastContent = closing.content;
          }
          break;
        }

        toolRounds += 1;
        messages.push({
          role: "assistant",
          content: reply.content || null,
          tool_calls: reply.toolCalls.map((call) => ({
            id: call.id || `call_${toolRounds}_${call.function.name}`,
            type: "function",
            function: { name: call.function.name, arguments: call.function.arguments || "{}" },
          })),
        });

        for (const call of messages.at(-1).tool_calls) {
          const toolName = call.function.name;
          emit("agent", {
            type: "tool.started",
            agent: id,
            model: activeModel,
            tool: toolName,
            args: String(call.function.arguments).slice(0, 400),
          });
          let result;
          const args = safeJson(call.function.arguments);
          if (args == null) {
            result = "错误：工具参数不是合法 JSON，请重新调用并只传 JSON 对象";
          } else {
            try {
              result = await sandbox.execute(toolName, args);
            } catch (error) {
              result = `错误：工具执行异常（${error?.message || error}）`;
            }
          }
          const text = String(result ?? "");
          emit("agent", {
            type: "tool.completed",
            agent: id,
            model: activeModel,
            tool: toolName,
            ok: !text.startsWith("错误："),
            result: text.slice(0, 800),
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
        }
      }

      finalResponse = lastContent || narrative;
      if (!finalResponse.trim()) throw new Error(`${name} API 返回了空结果`);
      emit("agent", {
        type: "item.completed",
        agent: id,
        model: activeModel,
        item: { type: "agent_message", text: finalResponse.slice(0, 500) },
      });
      emit("agent", {
        type: "turn.completed",
        agent: id,
        model: activeModel,
        finishReason,
        durationMs: Date.now() - startedAt,
        reasoningChars,
        usage: usageTotals,
        usageRounds,
        toolRounds,
        toolCalls: sandbox ? sandbox.calls : 0,
      });
      return {
        threadId: task.threadId || null,
        finalResponse,
        toolRounds,
        usage: usageTotals,
        files: sandbox ? sandbox.files() : [],
      };
    } catch (error) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export { DEFAULT_SYSTEM_PROMPT };
