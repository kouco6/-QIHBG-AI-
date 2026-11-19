/**
 * One-shot connectivity probe for cloud agents.
 *
 * It sends the smallest possible chat completion (a few tokens) using the
 * values currently in the form, falling back to the saved key when the field is
 * left blank. Nothing is written: the result only tells the user whether the
 * endpoint + model + key combination actually works before they save.
 */

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_PROMPT = "只回复 OK";
const PROBE_MAX_TOKENS = 8;

const explainStatus = (status, detail = "") => {
  const tail = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) return `密钥无效或没有权限${tail}`;
  if (status === 404) return `模型或接口地址不存在${tail}`;
  if (status === 429) return `额度不足或被限流${tail}`;
  if (status >= 500) return `服务端错误（${status}）${tail}`;
  return `请求失败（${status}）${tail}`;
};

const readError = (text) => {
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    const message = body?.error?.message || body?.message || body?.error;
    return String(message || "").slice(0, 200);
  } catch {
    return String(text).slice(0, 200).replace(/\s+/g, " ");
  }
};

/** fetch 的原始信息只有 "fetch failed"，把底层错误码翻成人能读的原因。 */
const describeNetworkError = (error) => {
  const code = error?.cause?.code || error?.code || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败，检查 Base URL";
  if (code === "ECONNREFUSED") return "端口拒绝连接，检查 Base URL 与端口";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "证书校验失败";
  if (code === "ECONNRESET") return "连接被重置";
  return error?.cause?.message || error?.message || "未知错误";
};

/**
 * 测试表单里那一组「地址 + 模型 + Key」是否配套。
 * 独立导出：个人员工（/api/user-agents/test）与全局员工共用同一套判定与报错文案。
 * @returns {Promise<{ok:boolean, latencyMs:number, model:string, sample?:string, error?:string}>}
 */
export async function probeChatEndpoint({ model, baseUrl, apiKey } = {}, { fetchImpl = globalThis.fetch } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, latencyMs: 0, model: "", error: "还没有 API Key，先填写再测试" };

  const rawBase = String(baseUrl || "").trim();
  if (!rawBase) return { ok: false, latencyMs: 0, model: "", error: "还没有填写 Base URL" };
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    return { ok: false, latencyMs: 0, model: "", error: "Base URL 不是合法网址" };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, latencyMs: 0, model: "", error: "Base URL 必须是 http 或 https" };
  }

  const modelName = String(model || "").trim();
  if (!modelName) return { ok: false, latencyMs: 0, model: modelName, error: "还没有填写模型名" };

  const endpoint = `${rawBase.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    if (!response.ok) {
      return { ok: false, latencyMs, model: modelName, error: explainStatus(response.status, readError(text)) };
    }

    let sample = "";
    try {
      const body = JSON.parse(text);
      sample = String(body?.choices?.[0]?.message?.content ?? "").trim().slice(0, 40);
    } catch { /* 200 但没有 JSON 也算连通，只是拿不到样本 */ }

    return { ok: true, latencyMs, model: modelName, sample };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      return { ok: false, latencyMs, model: modelName, error: `超时（${PROBE_TIMEOUT_MS / 1000} 秒无响应）` };
    }
    return { ok: false, latencyMs, model: modelName, error: `无法连接：${describeNetworkError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 OpenAI 兼容网关拉取模型清单（GET {baseUrl}/models）。
 * 只读一次不落库：Key 只在这一个请求的内存里出现，浏览器永远拿不到明文。
 * 兼容两种返回形态：OpenAI 标准 `{ data: [{ id }] }` 与裸数组 `[{ id }]`。
 * @returns {Promise<{ok:boolean, latencyMs:number, models:string[], error?:string}>}
 */
export async function listModelsFromEndpoint({ baseUrl, apiKey } = {}, { fetchImpl = globalThis.fetch } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, latencyMs: 0, models: [], error: "还没有 API Key，先填写再拉取" };

  const rawBase = String(baseUrl || "").trim();
  if (!rawBase) return { ok: false, latencyMs: 0, models: [], error: "还没有填写 Base URL" };
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    return { ok: false, latencyMs: 0, models: [], error: "Base URL 不是合法网址" };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, latencyMs: 0, models: [], error: "Base URL 必须是 http 或 https" };
  }

  const endpoint = `${rawBase.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    if (!response.ok) {
      if (response.status === 404) {
        return { ok: false, latencyMs, models: [], error: "该地址没有 /models 接口，检查 Base URL 是否以 /v1 结尾" };
      }
      return { ok: false, latencyMs, models: [], error: explainStatus(response.status, readError(text)) };
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, latencyMs, models: [], error: "返回的不是 JSON，可能不是 OpenAI 兼容网关" };
    }
    const raw = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!raw) {
      return { ok: false, latencyMs, models: [], error: "响应里没有模型清单（期待 { data: [...] }）" };
    }
    const models = [...new Set(
      raw
        .map((item) => String(item?.id ?? item?.model ?? item?.name ?? "").trim())
        .filter(Boolean),
    )].sort((a, b) => a.localeCompare(b)).slice(0, 200);
    if (!models.length) return { ok: false, latencyMs, models: [], error: "网关返回了空的模型清单" };
    return { ok: true, latencyMs, models };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      return { ok: false, latencyMs, models: [], error: `超时（${PROBE_TIMEOUT_MS / 1000} 秒无响应）` };
    }
    return { ok: false, latencyMs, models: [], error: `无法连接：${describeNetworkError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} config live gateway config
 * @param {string|null} id agent id；新建时传 null，此时只能靠 patch 提供 model / baseUrl / apiKey
 * @param {{model?:string, baseUrl?:string, apiKey?:string}} patch values from the form
 * @returns {Promise<{ok:boolean, latencyMs:number, model:string, sample?:string, error?:string}>}
 */
export async function probeAgent(config, id, patch = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (id === "codex") throw new Error("Codex 是本机 CLI，不走网络，无需测试连接");
  // 没有 id 是「还没保存的新员工」：表单里给什么就用什么，不去查配置
  const entry = id ? config.agents?.[id] : {};
  if (!entry) throw new Error(`未知员工：${id}`);

  return probeChatEndpoint({
    model: patch.model || entry.model || "",
    baseUrl: patch.baseUrl || entry.baseUrl || "",
    apiKey: patch.apiKey || entry.apiKey || "",
  }, { fetchImpl });
}
