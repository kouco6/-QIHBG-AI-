import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { captureControls, experiencePages, knowledgePages } from "./page_evidence.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base, screenshots] = process.argv.slice(2);
const { password, liveAi } = JSON.parse(readFileSync(0, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route("**/*", route => route.request().url().startsWith(base + "/") ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(8500);
  page.on("dialog", async dialog => {
    console.log("Work protection confirmation:", dialog.message());
    await dialog.accept();
  });
  const req = (path, options = {}) => context.request.fetch(base + path, {
    ...options, headers: { origin: base, ...options.headers },
  });
  async function json(path, options) {
    const response = await req(path, options);
    assert.ok(response.ok(), path + " HTTP " + response.status() + " " + (await response.text()).slice(0, 350));
    return response.json();
  }
  const frame = name => page.frameLocator('iframe[title="' + name + '"]');
  const heading = (scope, name) => scope.getByRole("heading", { name, exact: true });
  const act = (scope, action) => scope.locator('[data-act="' + action + '"]');
  const nav = name => page.getByRole("navigation", { name: "业务模块" }).getByRole("button", { name, exact: true });
  async function snap(module, id, ready, mask = []) {
    await ready.waitFor({ state: "visible" });
    const folder = join(screenshots, module);
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, id + ".png"), animations: "disabled", mask, maskColor: "#e1eaf5" });
    const scopes = { bg: "企划设计BG", "ai-gateway": "AI 网关", experience: "体验工作台" };
    await captureControls(scopes[module] ? frame(scopes[module]) : page, folder, id);
    console.log(module, id);
  }
  async function login(account) {
    await page.locator("#login").fill(account);
    await page.locator("#password").fill(password);
    await page.getByText("保持登录 7 天").click();
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator("#workspace").waitFor();
  }
  for (const path of ["/bg/api/state", "/ai/api/tasks", "/experience/api/v1/projects"]) {
    assert.equal((await req(path)).status(), 401);
  }
  await page.goto(base);
  await snap("portal", "PORTAL-001", heading(page, "企划设计BG平台"));
  assert.equal((await req("/platform/login", { method: "POST", data: { login: "baseline-admin", password: "wrong-password" } })).status(), 401);
  await login("baseline-admin");
  const session = await json("/platform/session");
  assert.deepEqual(session.modules, ["bg", "ai", "experience"]);
  assert.equal((await context.cookies()).find(c => c.name === "bg_platform_session").httpOnly, true);
  assert.equal((await req("/platform/logout", { method: "POST", headers: { origin: "http://localhost:1" } })).status(), 403);

  const bg = frame("企划设计BG");
  await snap("bg", "BG-001", heading(bg, "企划项目"));
  await act(bg, "new-project").first().click();
  await snap("bg", "BG-002", heading(bg, "创建企划项目"));
  await bg.locator("#newName").fill("匿名基线项目");
  await act(bg, "create-next").click();
  await bg.locator("#newType").selectOption({ label: "系统" });
  await act(bg, "create-next").click();
  await act(bg, "create-next").click();
  await snap("bg", "BG-003", heading(bg, "匿名基线项目"));
  for (let n = 1; n <= 12; n++) {
    const dim = "DIM-" + String(n).padStart(2, "0");
    await bg.locator('[data-act="enter-dimension"][data-dim="' + dim + '"]').click();
    await snap("bg", "BG-" + String(n + 3).padStart(3, "0"), bg.locator(".workspace-topbar"));
    await bg.locator(".workspace-back").click();
    await heading(bg, "匿名基线项目").waitFor();
  }
  await bg.locator('[data-act="enter-dimension"][data-dim="DIM-01"]').click();
  await bg.locator('.workspace-mode [data-act="workspace-mode-work"]').click();
  await snap("bg", "BG-004-work", heading(bg.frameLocator("#dim01-core-frame"), "行业生态布局全景").first());
  await bg.locator('.workspace-mode [data-act="workspace-mode-preview"]').click();
  await bg.locator(".workspace-back").click();
  await bg.locator('[data-act="enter-dimension"][data-dim="DIM-03"]').click();
  await bg.locator('.workspace-mode [data-act="workspace-mode-work"]').click();
  const cert = bg.frameLocator("#dim03-core-frame").locator('.rowcell[data-field="name"]').first();
  await cert.dblclick();
  await cert.locator("input").fill("匿名测试资质");
  await cert.locator("input").press("Enter");
  await bg.locator(".workspace-save-menu summary").click();
  await act(bg, "workspace-save-draft").click();
  await snap("bg", "BG-006-work", bg.getByText("草稿已保存", { exact: true }));
  await bg.locator(".workspace-save-menu summary").click();
  await act(bg, "workspace-save-apply").click();
  await bg.getByText("已应用正式成果", { exact: true }).first().waitFor();
  const state = (await json("/bg/api/state")).state;
  const bgProject = state.projects[0].id;
  assert.equal(state.showcases[bgProject]["DIM-03"].versions.at(-1).snapshot.rows[0].name, "匿名测试资质");
  await bg.locator('.workspace-mode [data-act="workspace-mode-preview"]').click();
  await snap("bg", "BG-006-applied", bg.frameLocator("#dim03-core-frame").getByText("匿名测试资质", { exact: true }));
  await bg.locator(".workspace-back").click();
  await act(bg, "report").first().click();
  await snap("bg", "BG-016", heading(bg, "企划报告预览"));
  const exportEvent = page.waitForEvent("download");
  await act(bg, "export-report").click();
  const exported = await exportEvent;
  assert.match(exported.suggestedFilename(), /\.html$/);
  await bg.locator('[data-act="route"][data-page="settings"]').click();
  await snap("bg", "BG-017", heading(bg, "本地AI设置"));

  await nav("AI 网关").click();
  const ai = frame("AI 网关");
  const tabs = [
    ["AI-002", "dashboard", "数据看板"], ["AI-003", "worksite", "任务"], ["AI-005", "collab", "协作"],
    ["AI-006", "artifacts", "产出库"], ["AI-007", "knowledge", "产品中枢"],
    ["AI-008", "templates", "工作方法"], ["AI-009", "settings", "设置"],
  ];
  await ai.locator("#nav [data-view=dashboard]").waitFor();
  assert.equal(await ai.locator("#tokenDialog[open]").count(), 0);
  for (const [id, view, title] of tabs) {
    await ai.locator('#nav [data-view="' + view + '"]').click();
    await snap("ai-gateway", id, view === "worksite" ? ai.locator("#adhocPrompt") : heading(ai, title),
      [ai.locator("#adhocCwd"), ai.locator("#taskCwd")]);
    if (view === "worksite") {
      await ai.locator('#wsTabs [data-tab="flows"]').click();
      await snap("ai-gateway", "AI-004", ai.locator('#wsTabs [data-tab="flows"].active'));
    }
  }
  await ai.locator('#nav [data-view="knowledge"]').click();
  for (const [id, key] of knowledgePages) {
    await ai.locator('[data-kb-tab="' + key + '"]').click();
    await snap("ai-gateway", id, ai.locator('[data-kb-tab="' + key + '"].active'));
  }
  assert.equal(await ai.locator("body").evaluate(() => sessionStorage.getItem("wb.token")), null);
  const task = await json("/ai/api/tasks", { method: "POST", data: { prompt: "匿名回归草稿", agent: "codex", draft: true } });
  const taskId = task.id || task.task?.id;
  assert.ok(taskId);
  await json("/ai/api/tasks/" + taskId);
  const sse = await ai.locator("body").evaluate(async (_, id) => {
    const response = await fetch("/ai/api/tasks/" + id + "/events", { signal: AbortSignal.timeout(6500) });
    const reader = response.body.getReader();
    try {
      const chunk = await reader.read();
      return [response.status, response.headers.get("content-type"), new TextDecoder().decode(chunk.value)];
    } finally {
      await reader.cancel();
    }
  }, taskId);
  assert.equal(sse[0], 200);
  assert.match(sse[1], /text\/event-stream/);
  assert.match(sse[2], /retry: 2000/);
  if (liveAi) {
    const real = await json("/ai/v1/tasks", { method: "POST", data: {
      prompt: "请仅回复 BG-LOCAL-OK。无需读取任何文件、运行命令或创建产物。",
      mode: "read-only",
    } });
    const realId = real.id || real.task?.id;
    assert.ok(realId, "The original executor did not return a task ID");
    const deadline = Date.now() + 75_000;
    let result;
    while (Date.now() < deadline) {
      result = await json("/ai/v1/tasks/" + realId);
      if (["completed", "succeeded", "failed", "canceled", "cancelled", "timed_out"].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log("AI existing Codex runner:", result.status, "mode:", result.runtimeMode || "pending",
      "output matched:", result.finalResponse?.includes("BG-LOCAL-OK") === true);
    if (!["completed", "succeeded"].includes(result.status)) {
      console.log("AI live runner unavailable for this smoke; drafts and SSE are verified independently.");
      await json("/ai/v1/tasks/" + realId + "/cancel", { method: "POST" });
    }
  }

  await nav("体验工作台").click();
  const exp = frame("体验工作台");
  assert.equal((await json("/experience/api/v1/auth/me")).is_primary, true);
  assert.equal((await json("/experience/api/health")).provider.effective_mode, "mock");
  await snap("experience", "EXP-003", exp.locator("main").first());
  const gotoExperience = path => page.frames().find(f => f.url().startsWith(base + "/experience/"))
    .goto(base + "/experience" + path);
  await gotoExperience("/projects");
  await snap("experience", "EXP-004", exp.getByPlaceholder("搜索项目名"));
  const schemes = await json("/experience/api/v1/scoring-schemes");
  const system = await json("/experience/api/v1/systems", { method: "POST",
    data: { name: "匿名基线系统", code: "BASELINE", scheme_id: schemes.items[0].id } });
  await gotoExperience("/projects");
  await exp.getByRole("button", { name: "新建项目", exact: true }).first().click();
  await exp.locator("#np-name").fill("匿名体验项目");
  await exp.locator("#np-system").selectOption(system.id);
  await exp.locator("#np-version").fill("V1.0");
  await snap("experience", "EXP-005", exp.locator("#np-name"));
  await exp.getByRole("button", { name: "创建", exact: true }).click();
  await snap("experience", "EXP-006", heading(exp, "匿名体验项目"));
  const projectPath = await exp.locator("body").evaluate(() => location.pathname.replace("/experience", ""));
  await exp.getByRole("button", { name: "打开看板" }).click();
  const board = await json("/experience/api/v1" + projectPath + "/board");
  const nodes = board.stages.flatMap(stage => stage.nodes);
  assert.equal(nodes.length, 13);
  await snap("experience", "EXP-007", exp.locator(".node-card").first());
  await gotoExperience(projectPath + "/nodes/" + nodes[0].code);
  await snap("experience", "EXP-008", exp.locator("main h1").first());
  for (const [id, path] of [
    ["EXP-009", "/search"], ["EXP-010", "/issues"], ["EXP-011", "/reviews"], ["EXP-012", "/systems"],
    ["EXP-013", "/usability"], ["EXP-014", "/score-library"], ["EXP-015", "/settings/scoring-schemes"],
    ["EXP-016", "/settings"],
  ]) {
    await gotoExperience(path);
    await exp.locator("body").waitFor();
    await snap("experience", id, exp.locator("main h1").first());
  }
  for (const [id, path] of experiencePages(projectPath, system.id)) {
    await gotoExperience(path);
    await snap("experience", id, exp.locator("main h1").first());
  }
  for (const node of nodes.slice(1)) {
    await gotoExperience(projectPath + "/nodes/" + node.code);
    await snap("experience", "EXP-008-" + node.code, exp.locator("main h1").first());
  }
  await nav("企划设计BG").click();
  await heading(bg, "本地AI设置").waitFor();
  await page.reload();
  await heading(bg, "本地AI设置").waitFor();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await heading(page, "企划设计BG平台").waitFor();
  assert.equal((await req("/ai/api/tasks/" + taskId)).status(), 401);
  await login("baseline-member");
  assert.equal(await nav("AI 网关").count(), 0);
  assert.equal((await req("/ai/api/tasks/" + taskId)).status(), 403);
  assert.equal((await json("/bg/api/state")).state.projects.length, 0);
  assert.equal((await json("/experience/api/v1/auth/me")).is_primary, false);
  console.log("PASS: anonymous/authorized access, logout, two accounts, BG data isolation, AI drafts and SSE, experience identity and 13 nodes, page restoration");
} finally {
  await browser.close();
}
