/**
 * AI 能力平台（skill-hub）客户端：登录 → 列包 → 下载 zip。
 *
 * 平台是 Flask + session cookie：
 *   POST /hub/login   form: username/password   → 302 + Set-Cookie: session=...
 *   GET  /hub/?q=&category=&sort=&type=skill    → HTML，里面是 /hub/package/<name> 链接
 *   GET  /hub/package/<name>                    → 详情页（含版本、说明、标签）
 *   GET  /hub/download/<name>                   → application/zip，文件名 <name>-<version>.zip
 *
 * 平台没有 JSON 列表接口，只有 HTML。所以这里用正则从列表页/详情页里抠信息：
 * 结构稳定（平台源码已在本地核对过），但平台改版时正则要跟着改 —— 抓不到就明确报错，
 * 不要静默返回空列表让用户以为「云端没货」。
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ZIP_BYTES = 120 * 1024 * 1024;

/** 平台返回的 HTML 里常见的 HTML 实体，列表标题/摘要会用到。 */
const decodeEntities = (text) =>
  String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export class HubError extends Error {
  constructor(message, { status = 0, kind = "hub" } = {}) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.kind = kind;
  }
}

export class HubClient {
  /**
   * @param {{ baseUrl: string, username: string, password: string }} options
   */
  constructor({ baseUrl, username, password }) {
    const { origin, prefix } = normalizeBase(baseUrl);
    this.origin = origin;
    this.prefix = prefix;
    this.baseUrl = `${origin}${prefix}`;
    this.username = username;
    this.password = password;
    this.cookie = "";
  }

  /** 登录拿 session cookie。失败时给的是人能看懂的原因，不是「登录失败」四个字。 */
  async login() {
    if (!this.username || !this.password) throw new HubError("还没填平台账号或密码", { kind: "config" });
    const response = await this.#fetch("/hub/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
      redirect: "manual",
    });
    // 登录成功 = 302 跳 /hub/ 且下发了 session。
    // 注意平台的真实行为（app.py:login）：密码错 / 账号停用时不会给 401，而是
    // flash 一句提示后直接 render_template("login.html")，也就是 HTTP 200 + 登录页。
    // 所以 200 必须读响应体判断，不能笼统说「登录没成功」。
    if (response.status !== 302) {
      let rejected = false;
      if (response.status === 200) {
        const body = await response.text().catch(() => "");
        rejected = /用户名或密码错误|账号已停用/.test(decodeEntities(body));
      }
      throw new HubError(
        response.status === 403
          ? "平台拒绝了这次访问（403），可能这个 IP 被限制或账号被停用"
          : rejected
            ? "账号或密码不对（或账号已停用），在「平台连接」里重填后重试"
            : response.status === 200
              ? "登录没通过：平台把登录页又发回来了，多半是账号或密码不对"
              : `登录没成功（HTTP ${response.status}），检查平台地址与账号`,
        { status: response.status, kind: "auth" },
      );
    }
    const cookies = response.headers.getSetCookie?.() ?? [];
    const session = cookies.map((item) => item.split(";")[0]).find((item) => item.startsWith("session="));
    if (!session) throw new HubError("登录接口没有返回会话，平台可能改版了", { kind: "auth" });
    this.cookie = session;
    return true;
  }

  async #fetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? DEFAULT_TIMEOUT_MS);
    try {
      return await fetch(`${this.origin}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(options.headers ?? {}) },
      });
    } catch (error) {
      if (error.name === "AbortError") throw new HubError("连平台超时了，检查网络或平台是否在线", { kind: "network" });
      // Node 的 fetch 只说 "fetch failed"，把底层原因带出来才有排查价值
      const cause = error.cause?.code || error.cause?.message || "";
      throw new HubError(
        `连不上平台（${this.baseUrl}）${cause ? `：${cause}` : `：${error.message}`}。检查地址、网络或平台是否在线`,
        { kind: "network" },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 带会话 GET；会话过期（302 跳登录页）时自动重登一次。 */
  async #getText(path) {
    if (!this.cookie) await this.login();
    let response = await this.#fetch(path, { redirect: "manual" });
    if (response.status === 302 || response.status === 401) {
      await this.login();
      response = await this.#fetch(path, { redirect: "manual" });
    }
    if (response.status !== 200) {
      throw new HubError(`平台返回 HTTP ${response.status}（${path}）`, { status: response.status });
    }
    return response.text();
  }

  /**
   * 列出广场上的技能与专家包。
   * @param {{ query?: string, category?: string, sort?: "new"|"hot"|"downloads", type?: "skill"|"tool" }} options
   */
  async list(options = {}) {
    const params = new URLSearchParams();
    if (options.query) params.set("q", options.query);
    if (options.category) params.set("category", options.category);
    params.set("sort", options.sort ?? "new");
    if (options.type) params.set("type", options.type);
    const html = await this.#getText(`/hub/?${params.toString()}`);
    return parseListPage(html);
  }

  /** 详情页：拿到版本号、说明、分类、标签，用来决定要不要拉。 */
  async detail(name) {
    const html = await this.#getText(`/hub/package/${encodeURIComponent(name)}`);
    return parseDetailPage(html, name);
  }

  /**
   * 下载包（zip 字节）。平台会给 302 跳回首页表示「不让下」（未发布/无版本/待审核），
   * 那种情况必须报错，不能把跳转页的 HTML 当成 zip 存下去。
   */
  async download(name) {
    if (!this.cookie) await this.login();
    let response = await this.#fetch(`/hub/download/${encodeURIComponent(name)}`, { redirect: "manual" });
    if (response.status === 302 || response.status === 401) {
      await this.login();
      response = await this.#fetch(`/hub/download/${encodeURIComponent(name)}`, { redirect: "manual" });
    }
    if (response.status !== 200) {
      throw new HubError(`下载「${name}」失败：平台返回 HTTP ${response.status}`, { status: response.status });
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/zip|octet-stream/i.test(type)) {
      throw new HubError(`「${name}」不是可下载的包（平台返回 ${type || "未知类型"}），可能还没发布或还在审核`, { kind: "content" });
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ZIP_BYTES) throw new HubError(`「${name}」太大了（${Math.round(declared / 1048576)}MB），超过上限`, { kind: "content" });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 4 || buffer.subarray(0, 2).toString("hex") !== "504b") {
      throw new HubError(`「${name}」下载到的不是 zip（内容开头不是 PK）`, { kind: "content" });
    }
    if (buffer.length > MAX_ZIP_BYTES) throw new HubError(`「${name}」超过大小上限`, { kind: "content" });
    const disposition = response.headers.get("content-disposition") ?? "";
    const version = disposition.match(/-(\d+\.\d+\.\d+[^.]*)\.zip/i)?.[1] ?? "";
    return { buffer, version, bytes: buffer.length };
  }
}

/**
 * 平台挂在 /hub 前缀下，但用户可能只粘 http://host，也可能粘 http://host/hub/。
 * 这里把 origin 和前缀拆开：所有请求路径都以 /hub 开头（与平台源码一致），
 * 用户填的前缀只用来校验/兜底，避免拼成 /hub/hub/login。
 */
function normalizeBase(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new HubError("还没填平台地址", { kind: "config" });
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new HubError(`平台地址填得不对：${raw}（例：http://8.138.91.205/hub/）`, { kind: "config" });
  }
  const path = url.pathname.replace(/\/+$/, ""); // "" 或 "/hub"
  return { origin: url.origin, prefix: path };
}

/**
 * 解析列表页。平台模板把每个包渲染成：
 *   <a class="card" href="/hub/package/<name>">
 *     <h3>显示名</h3>
 *     <div class="meta">分类 · v1.0.1</div>
 *     <span class="badge skill">技能</span>
 *     <p class="summary">一句话说明</p>
 *     <div class="tags"><span class="tag">标签</span>...</div>
 *     <span class="dl">… 下载数</span>
 *   </a>
 * 按卡片整块切，比「以链接为锚点向后截一段」准得多（后者会把下一页的标签抓进来）。
 */
export function parseListPage(html) {
  const items = [];
  // 每张卡片从 <a class="card" 开始，到配对的 </a> 结束；卡片内部没有嵌套 <a>
  const cardRe = /<a class="card" href="\/hub\/package\/([^"?#]+)">([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(cardRe)) {
    const name = decodeURIComponent(match[1]);
    const block = match[2];
    const title = stripTags(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "") || name;
    const meta = stripTags(block.match(/<div class="meta"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    // meta 形如「市场调研 · v1.0.1」或「未分类 · v2.0.0」
    const [rawCategory, rawVersion] = meta.split("·").map((part) => part.trim());
    const version = (rawVersion ?? "").match(/v?(\d+\.\d+\.\d+[a-z0-9.-]*)/i)?.[1] ?? "";
    const summary = stripTags(block.match(/<p class="summary"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
    const tagsBlock = block.match(/<div class="tags"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const tags = [...tagsBlock.matchAll(/<span class="tag"[^>]*>([\s\S]*?)<\/span>/g)]
      .map((tag) => stripTags(tag[1]))
      .filter(Boolean);
    const downloadCount = Number(block.match(/<span class="dl"[^>]*>[\s\S]*?<\/svg>\s*(\d+)/)?.[1] ?? 0);
    const type = /badge tool/.test(block) ? "tool" : "skill";
    if (items.some((item) => item.name === name)) continue;
    items.push({
      name,
      title,
      summary,
      category: rawCategory && rawCategory !== "未分类" ? rawCategory : "",
      tags: tags.slice(0, 10),
      version,
      type,
      downloads: downloadCount,
    });
  }
  return items;
}

/**
 * 解析详情页。关键结构（平台源码核对过）：
 *   <span class="badge skill">技能</span><h2>显示名</h2>
 *   <div class="meta">tender-analysis · v1.0.1 · 市场调研 · 作者 系统管理员</div>
 *   <a class="btn primary lg" href="/hub/download/<name>">下载 v1.0.1</a>
 *   <p class="summary-lg">一句话说明</p>
 *   <span class="tag tag-cat">市场调研</span>  + 普通 <span class="tag">标签</span>
 *   <h4>📝 说明</h4><p>…详细说明…</p>
 */
export function parseDetailPage(html, fallbackName) {
  const meta = stripTags(html.match(/<div class="meta"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
  const metaParts = meta.split("·").map((part) => part.trim());
  const name = metaParts[0] || fallbackName;
  const version = (metaParts.find((part) => /^v\d+\.\d+\.\d+/i.test(part)) ?? meta.match(/v(\d+\.\d+\.\d+[a-z0-9.-]*)/i)?.[0] ?? "")
    .replace(/^v/i, "");
  const category = metaParts.find((part) => part && !/^v\d/i.test(part) && !part.startsWith("作者") && part !== name) ?? "";
  const title = stripTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "") || name;
  const summary = stripTags(html.match(/<p class="summary-lg"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
  // 分类用 tag-cat 标出来，别混进普通标签里
  const tagsBlock = html.match(/<div class="block meta-block">([\s\S]*?)<\/div>\s*<\/div>/)?.[1]
    ?? html.match(/<div class="tags"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    ?? "";
  const tags = [...tagsBlock.matchAll(/<span class="tag(?![^"]*tag-cat)[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((tag) => stripTags(tag[1]))
    .filter((tag) => tag && tag.length <= 20 && tag !== category)
    .slice(0, 10);
  const description = stripTags(
    html.match(/<h4[^>]*>[^<]*说明[^<]*<\/h4>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "",
  ).slice(0, 4000);
  const downloadCount = Number(html.match(/id="count"[^>]*>[^0-9]*(\d+)/)?.[1] ?? 0);
  const type = /badge tool/.test(html) ? "tool" : "skill";
  return {
    name: fallbackName || name,
    title,
    version,
    category,
    tags,
    summary,
    description,
    type,
    downloads: downloadCount,
    author: (meta.match(/作者\s*(\S+)/)?.[1] ?? ""),
    downloadUrl: `/hub/download/${encodeURIComponent(fallbackName || name)}`,
  };
}
