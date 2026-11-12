import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { captureControls, experiencePages, knowledgePages } from "./page_evidence.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [module, base, output] = process.argv.slice(2);
const { token } = JSON.parse(readFileSync(0, 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route('**/*', route => route.request().url().startsWith(base + '/')
    ? route.continue()
    : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const snap = async (id, ready) => {
    await ready.waitFor({ state: 'visible' });
    const mask = module === 'ai-gateway' ? [page.locator('#adhocCwd'), page.locator('#taskCwd')] : [];
    await page.screenshot({ path: join(output, id + '.png'), animations: 'disabled', mask, maskColor: '#172536' });
    await captureControls(page, output, id);
    console.log(module, id, new URL(page.url()).pathname, 'screenshot');
  };
  const heading = name => page.getByRole('heading', { name, exact: true });
  const json = async (path, options) => {
    const response = await context.request.fetch(base + path, options);
    assert.ok(response.ok(), path + ' HTTP ' + response.status());
    return response.json();
  };
  await page.goto(base + '/');
  if (module === 'bg') {
    const action = name => page.locator('[data-act="' + name + '"]');
    await snap('BG-001', heading('企划项目'));
    await action('new-project').first().click();
    await snap('BG-002', heading('创建企划项目'));
    await page.locator('#newName').fill('匿名基线项目');
    await action('create-next').click();
    await page.locator('#newType').selectOption({ label: '系统' });
    await action('create-next').click();
    await action('create-next').click();
    await snap('BG-003', heading('匿名基线项目'));
    const state = await json('/api/state');
    assert.equal(state.state.projects.length, 1);
    const project = state.state.projects[0];
    assert.equal(project.name, '匿名基线项目');
    await action('report').first().click();
    await snap('BG-016', heading('企划报告预览'));
    await action('route-overview').first().click();
    for (let dimension = 1; dimension <= 12; dimension++) {
      const dim = 'DIM-' + String(dimension).padStart(2, '0');
      const item = page.locator('[data-act="enter-dimension"][data-dim="' + dim + '"]');
      await item.click();
      await snap('BG-' + String(dimension + 3).padStart(3, '0'), page.locator('.workspace-topbar'));
      await page.locator('.workspace-back').click();
      await heading('匿名基线项目').waitFor();
    }
    await page.locator('[data-act="enter-dimension"][data-dim="DIM-01"]').click();
    await page.locator('.workspace-mode').locator('[data-act="workspace-mode-work"]').click();
    await snap('BG-004-work', page.frameLocator('#dim01-core-frame').getByRole('heading', { name: '行业生态布局全景', exact: true }).first());
    await action('workspace-mode-preview').click();
    await page.locator('.workspace-back').click();
    await page.locator('[data-act="enter-dimension"][data-dim="DIM-03"]').click();
    await page.locator('.workspace-mode').locator('[data-act="workspace-mode-work"]').click();
    const cert = page.frameLocator('#dim03-core-frame').locator('.rowcell[data-field="name"]').first();
    await cert.dblclick();
    await cert.locator('input').fill('匿名测试资质');
    await cert.locator('input').press('Enter');
    await page.waitForFunction(() => document.querySelector('.workspace-save-state')?.textContent === '已自动暂存');
    await page.locator('.workspace-save-menu summary').click();
    await action('workspace-save-draft').click();
    await page.waitForFunction(() => document.querySelector('.workspace-save-state')?.textContent === '草稿已保存');
    const stored = await json('/api/state');
    assert.equal(stored.state.showcases[project.id]['DIM-03'].draft.rows[0].name, '匿名测试资质');
    await snap('BG-006-work', page.locator('.workspace-save-state'));
    await page.locator('.workspace-save-menu summary').click();
    await action('workspace-save-apply').click();
    await page.waitForFunction(() => document.querySelector('.workspace-save-state')?.textContent === '已应用正式成果');
    const published = (await json('/api/state')).state.showcases[project.id]['DIM-03'];
    assert.equal(published.versions.at(-1).kind, 'applied');
    assert.equal(published.versions.at(-1).snapshot.rows[0].name, '匿名测试资质');
    await action('workspace-mode-preview').click();
    await snap('BG-006-applied', page.frameLocator('#dim03-core-frame').getByText('匿名测试资质', { exact: true }));
    await page.reload();
    await action('enter-project').click();
    await heading('匿名基线项目').waitFor();
    const reportOutcome = Promise.race([
      page.waitForEvent('pageerror', { timeout: 8000 }),
      heading('企划报告预览').waitFor({ state: 'visible' }).then(() => null),
    ]);
    await action('report').first().click();
    const reportError = await reportOutcome;
    if (reportError) {
      assert.match(reportError.message, /Cannot read properties of undefined.*text/);
      console.log('BG-BASE-02: original report raises TypeError after applying a structured dimension without Markdown');
    }
    await page.reload();
    await page.locator('[data-act="route"][data-page="settings"]').click();
    await snap('BG-017', heading('本地AI设置'));
    console.log('BG: created and reopened a project, navigated all 12 dimensions, saved and applied DIM-03; report checked separately');
  } else if (module === 'ai-gateway') {
    assert.equal((await context.request.get(base + '/api/tasks')).status(), 401);
    const health = await context.request.get(base + '/health');
    console.log('AI: /health HTTP ' + health.status() + ', ' + (await health.json()).status);
    await snap('AI-001', page.locator('#tokenDialog[open]'));
    await page.locator('#tokenInput').fill(token);
    await page.locator('#tokenForm button').click();
    await page.locator('#tokenDialog').waitFor({ state: 'hidden' });
    await json('/api/tasks', { headers: { authorization: 'Bearer ' + token } });
    const tabs = [
      ['AI-002', 'dashboard', '数据看板'],
      ['AI-003', 'worksite', '任务'],
      ['AI-005', 'collab', '协作'],
      ['AI-006', 'artifacts', '产出库'],
      ['AI-007', 'knowledge', '产品中枢'],
      ['AI-008', 'templates', '工作方法'],
      ['AI-009', 'settings', '设置'],
    ];
    for (const [id, view, name] of tabs) {
      await page.locator('#nav [data-view="' + view + '"]').click();
      await snap(id, view === 'worksite' ? page.locator('#adhocPrompt') : heading(name));
      if (id === 'AI-003') {
        await page.locator('#wsTabs [data-tab="flows"]').click();
        await snap('AI-004', page.locator('#wsTabs [data-tab="flows"].active'));
      }
    }
    await page.locator('#nav [data-view="knowledge"]').click();
    for (const [id, key] of knowledgePages) {
      await page.locator('[data-kb-tab="' + key + '"]').click();
      await snap(id, page.locator('[data-kb-tab="' + key + '"].active'));
    }
    console.log('AI: anonymous task API rejected; native Token accepted; seven primary menu entries opened');
  } else if (module === 'experience') {
    await snap('EXP-001', page.locator('#confirm'));
    const password = 'Local!' + randomBytes(16).toString('hex');
    for (const [key, value] of Object.entries({ name: '基线测试员', account: 'baseline', password, confirm: password })) {
      await page.locator('#' + key).fill(value);
    }
    await page.getByRole('button', { name: '创建并登录' }).click();
    await page.waitForURL(base + '/');
    await json('/api/v1/auth/me');
    const health = await json('/api/health');
    assert.equal(health.provider.effective_mode, 'mock');
    await snap('EXP-003', page.locator('main').first());
    await page.goto(base + '/projects');
    await snap('EXP-004', page.getByPlaceholder('搜索项目名'));
    const schemes = await json('/api/v1/scoring-schemes');
    const system = await json('/api/v1/systems', {
      method: 'POST', data: { name: '匿名基线系统', code: 'BASELINE', scheme_id: schemes.items[0].id },
    });
    await page.reload();
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
    await page.locator('#np-name').fill('匿名体验项目');
    await page.locator('#np-system').selectOption(system.id);
    await page.locator('#np-version').fill('V1.0');
    await snap('EXP-005', page.locator('#np-name'));
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.waitForURL(/\/projects\/[^/]+/);
    const projectUrl = page.url();
    const projectPath = new URL(projectUrl).pathname;
    await snap('EXP-006', heading('匿名体验项目'));
    await page.getByRole('button', { name: '打开看板' }).click();
    await page.waitForURL('**/board');
    const board = await json('/api/v1' + projectPath + '/board');
    const nodes = board.stages.flatMap(stage => stage.nodes);
    assert.equal(nodes.length, 13);
    await snap('EXP-007', page.locator('.node-card').first());
    await page.goto(projectUrl + '/nodes/' + nodes[0].code);
    await snap('EXP-008', page.locator('main h1').first());
    for (const [id, path] of [
      ['EXP-009', '/search'], ['EXP-010', '/issues'], ['EXP-011', '/reviews'],
      ['EXP-012', '/systems'], ['EXP-013', '/usability'], ['EXP-014', '/score-library'],
      ['EXP-015', '/settings/scoring-schemes'], ['EXP-016', '/settings'],
    ]) {
      await page.goto(base + path);
      await page.waitForURL(base + path);
      await snap(id, page.locator('main h1').first());
    }
    for (const [id, path] of experiencePages(projectPath, system.id)) {
      await page.goto(base + path);
      await snap(id, page.locator("main h1").first());
    }
    for (const node of nodes.slice(1)) {
      await page.goto(projectUrl + "/nodes/" + node.code);
      await snap("EXP-008-" + node.code, page.locator("main h1").first());
    }
    await json('/api/v1/auth/logout', { method: 'POST' });
    assert.equal((await context.request.get(base + '/api/v1/auth/me')).status(), 401);
    await page.goto(base + '/login');
    await snap('EXP-002', page.locator('input[type=password]'));
    console.log('EXP: first account setup, anonymous project creation, 13-node board, Mock Provider and logout verified');
  } else {
    throw new Error('Unknown module: ' + module);
  }
} finally {
  await browser.close();
}
