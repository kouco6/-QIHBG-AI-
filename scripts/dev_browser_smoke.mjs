import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const options = JSON.parse(readFileSync(0, "utf8"));
const { chromium } = createRequire(options.playwright)("playwright");
const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
const checks = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === options.base || ["data:", "blob:"].includes(url.protocol)
      ? route.continue() : route.abort();
  });
  const login = await context.request.post(options.base + "/platform/login", {
    headers: { Origin: options.base },
    data: { login: "dev-001", password: options.password },
  });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(options.base);
  await page.locator("#workspace").waitFor({ state: "visible" });
  for (const module of ["bg", "ai", "experience"]) {
    await page.locator(`[data-module="${module}"]`).click();
    const frameElement = page.locator(`iframe[src^="/${module}/"]`);
    await frameElement.waitFor({ state: "visible" });
    const frame = await (await frameElement.elementHandle()).contentFrame();
    await frame.waitForFunction(() => document.body?.innerText.trim().length > 80);
    const text = await frame.locator("body").innerText();
    assert(!text.includes("体验账号不可用"));
    assert(!text.includes("业务服务未启动"));
    checks.push({ check: `${module} browser module rendered and switched`, pass: true });
    if (module === "experience" && options.probe) {
      assert.equal(await frame.evaluate(() => document.documentElement.dataset.dev001Probe), options.probe);
      checks.push({ check: "React source overlay executed in browser", pass: true });
    }
  }
  await context.close();
  process.stdout.write(JSON.stringify({ status: "PASS", checks }));
} catch (error) {
  // Avoid echoing request bodies, cookies, password, screenshot text or URLs with tickets.
  process.stdout.write(JSON.stringify({ status: "FAIL", checks, error: error.name }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
