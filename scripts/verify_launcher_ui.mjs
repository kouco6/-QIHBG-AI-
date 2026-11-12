import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { captureControls, acceptanceOutput } from "./page_evidence.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2];
const { entry, reopened, password } = JSON.parse(readFileSync(0, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route("**/*", route => route.request().url().startsWith(base + "/") ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(entry);
  await page.locator("#workspace").waitFor();
  await page.frameLocator('iframe[title="企划设计BG"]').getByRole("heading", { name: "企划项目", exact: true }).waitFor();
  assert.equal(await page.locator("#account-name").textContent(), "BGgly");
  assert.equal(new URL(page.url()).pathname, "/work/bg");
  const cookie = (await context.cookies()).find(cookie => cookie.name === "bg_platform_session");
  assert.equal(cookie.httpOnly, true);
  assert.equal((await context.request.get(entry, { maxRedirects: 0 })).status(), 403);
  assert.equal((await context.request.post(base + "/platform/control/open")).status(), 403);
  const output = resolve(acceptanceOutput, "screenshots/after/portal");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "PORTAL-001-auto-entry.png"), animations: "disabled" });
  await captureControls(page, output, "PORTAL-001-auto-entry");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.locator("#signin").waitFor();
  assert.equal((await context.request.get(base + "/bg/api/state")).status(), 401);
  const login = await context.request.post(base + "/platform/login", {
    headers: { Origin: base }, data: { login: "BGgly", password, remember: true },
  });
  assert.equal(login.status(), 200);
  const session = await context.request.get(base + "/platform/session");
  assert.deepEqual((await session.json()).modules, ["bg", "ai", "experience"]);
  await page.goto(reopened);
  await page.locator("#workspace").waitFor();
  assert.equal(await page.locator("#account-name").textContent(), "BGgly");
  console.log("PASS: direct default entry, supplied password, one-use launch links, logout and repeated launch");
} finally {
  await browser.close();
}
