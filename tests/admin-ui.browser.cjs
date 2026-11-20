/* Temporary accounts/data only. Runner status and statistics are synthetic; no model/CLI task execution. */
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
 const fixture=JSON.parse(fs.readFileSync(process.argv[2]));assert.ok(fixture.data.includes('v2-independent-'));
 const output=process.argv[3]||'/tmp/qihbg-admin-ui';fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  assert.ok((await context.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.admin})).ok());
  const api=async(url,method='GET',data)=>{const r=await context.request.fetch(fixture.url+'/ai/api/'+url,{method,data,headers:{Origin:fixture.url}});assert.ok(r.ok(),await r.text());return r.json()};
  await api('runner-prefs','PUT',{roots:[]});
  const me=(await api('auth/me')).account;const suffix=Date.now().toString(36),long='长文本验收'.repeat(20);
  const employee=await api('user-agents','POST',{name:'验收员工'+suffix,kind:'builtin',ref:'codex',role:long});
  const draft=await api('tasks','POST',{prompt:'合成任务，只读界面验收，不执行模型',draft:true,title:'运行任务'+long});await api('tasks/'+draft.id+'/cancel','POST',{});
  const stored=await api('tasks/'+draft.id), list=await api('tasks');
  const now=new Date().toISOString();const tasks=[{...stored,runner:'remote',status:'running',startedAt:now},...Array.from({length:12},(_,i)=>({...stored,id:'ui-stats-'+i,ownerAccountId:'synthetic-owner-'+i,ownerName:'合成人员'+i+long,status:i%2?'failed':'completed',usage:{totalTokens:1234},startedAt:'2026-11-20T00:00:00Z',finishedAt:'2026-11-20T00:02:00Z'}))];
  await page.route('**/ai/api/tasks',route=>route.request().method()==='GET'?route.fulfill({json:{...list,items:tasks}}):route.continue());
  await page.route('**/ai/api/tasks?range=all',route=>route.fulfill({json:{items:tasks}}));
  let runner=[];
  await page.route('**/ai/api/runner/status',route=>route.fulfill({json:{items:runner}}));
  await page.goto(fixture.url+'/#ai/runner');await page.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  const f=page.frameLocator('iframe');await f.locator('#viewTitle').filter({hasText:'执行器'}).waitFor();const frame=page.frames().find(f=>f.url().includes('scheduler.html'));
  const nav=async view=>{await frame.evaluate(view=>window.platformAiOpenView(view),view);await page.waitForTimeout(200)};
  const bounds=async label=>{
   assert.ok(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' document width');
   for(const selector of ['#runnerPage','#settings','[data-slot="dialog-content"]']) {
    const nodes=f.locator(selector);for(let i=0;i<await nodes.count();i++)if(await nodes.nth(i).isVisible()) assert.ok(await nodes.nth(i).evaluate(el=>el.scrollWidth<=el.clientWidth+1),label+' overflow '+selector);
   }
   assert.deepEqual(await frame.evaluate(()=>Array.from(document.querySelectorAll('#viewRunner button,#viewSettings button,[data-slot="dialog-content"] button')).filter(el=>el.getClientRects().length&&!el.closest('.native-control-source')).filter(el=>el.scrollHeight>el.clientHeight+1).map(el=>el.textContent)),[],label+' button text overflow');
  };
  assert.equal(await f.locator('#runnerPage [data-slot="card"]').count(),1);
  assert.equal(await f.locator('#runnerPage').getByText('设置 · 人员与账号 · 换 Token').count(),0);
  await f.locator('#runnerPage [data-runner-pair]').click();const dialog=f.locator('[data-slot="dialog-content"]');await dialog.waitFor();assert.equal(await dialog.locator('textarea[aria-label="执行器配置码"]').count(),1);
  await page.setViewportSize({width:390,height:844});await bounds('pair dialog');await page.screenshot({path:output+'/pair-mobile.png',animations:'disabled'});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  runner=[{accountId:me.id,accountName:'隔离管理员'+long,online:true,platform:'darwin-arm64',version:'1.0.0-test',host:'temporary-host',since:now,lastSeen:now,currentTaskId:stored.id,roots:['/temporary/'+long],rootsOverride:null,codex:{ok:true,version:'合成版本'},dsh:{ok:true,apiKey:false}}];
  await nav('worksite');await nav('runner');await f.locator('.rp-tasks [data-slot="action-card"]').waitFor();
  assert.equal(await f.locator('#runnerPage [data-slot="card"]').count(),4);
  const roots=f.locator('[data-runner-roots]');await roots.click();await dialog.waitFor();await f.locator('#rootsAdd').click();await dialog.locator('[data-root-input]').fill('/temporary/approved-test');
  await bounds('roots dialog');await dialog.locator('[data-dlg-ok]').click();await dialog.waitFor({state:'hidden'});assert.deepEqual((await api('runner-prefs')).roots.map(root=>root.replace(/\\/g,'/')),['/temporary/approved-test']);
  await f.locator('.rp-tasks [data-slot="action-card"]').press('Enter');await f.locator('[data-slot="sheet-content"]').waitFor();await page.waitForTimeout(4300);await page.keyboard.press('Escape');await f.locator('[data-slot="sheet-content"]').waitFor({state:'hidden'});await frame.waitForFunction(id=>document.activeElement?.dataset.nativeFocusKey==='action:'+id,stored.id);
  await nav('settings');await f.locator('#myAgentList [data-slot="card"]').first().waitFor();
  assert.equal(await f.locator('[data-fold="people"],[data-fold="service"],[data-fold="update"]').count(),0,'V2 lifecycle and identity have one platform entry');
  assert.equal(await f.locator('#settingsMetrics [data-slot="card"]').count(),4);
  await f.locator('#myModelNew').click();await dialog.waitFor();await f.locator('#mdName').fill('模型验收'+suffix);await f.locator('#mdBaseUrl').fill('http://127.0.0.1:1/v1');await f.locator('#mdKey').fill('temporary-synthetic-key');await f.locator('#mdModel').fill('synthetic-upstream-'+long);
  await f.locator('#mdKeyEye').click();assert.equal(await f.locator('#mdKey').getAttribute('type'),'text');await f.locator('#mdKeyEye').click();assert.equal(await f.locator('#mdKey').getAttribute('type'),'password');
  for(const width of [1440,727,390]) {await page.setViewportSize({width,height:844});await page.waitForTimeout(200);await bounds('model '+width);await page.screenshot({path:output+'/model-'+width+'.png',animations:'disabled'})}
  await dialog.locator('[data-dlg-ok]').click();await dialog.waitFor({state:'hidden'});await f.locator('#myModelList [data-slot="card"]').first().waitFor();
  const model=(await api('models')).items.find(m=>m.name==='模型验收'+suffix);assert.ok(model);assert.equal(model.model,'synthetic-upstream-'+long);
  await f.locator(`[data-model-action="${model.id}:停用"]`).click();await f.locator(`[data-model-action="${model.id}:启用"]`).waitFor();assert.equal((await api('models')).items.find(m=>m.id===model.id).enabled,false);
  await f.locator(`[data-employee-action="${employee.id}:编辑"]`).click();await dialog.waitFor();await f.locator('#uaName').fill('编辑员工'+suffix);
  assert.ok(await dialog.locator('[data-slot="select-trigger"]').count()>0);
  assert.ok(await dialog.locator('[data-slot="checkbox"]').count()>0);
  for(const width of [727,390]) {await page.setViewportSize({width,height:844});await page.waitForTimeout(200);await bounds('employee '+width);await page.screenshot({path:output+'/employee-'+width+'.png',animations:'disabled'})}
  await nav('settings');
  await dialog.locator('[data-dlg-ok]').click();await dialog.waitFor({state:'hidden'});assert.equal((await api('user-agents')).items.find(a=>a.id===employee.id).name,'编辑员工'+suffix);
  await frame.waitForFunction(id=>document.activeElement?.dataset.employeeAction===id+':编辑',employee.id);
  await f.locator('#myAgentNew').click();await dialog.waitFor();await bounds('new cloud employee');await page.screenshot({path:output+'/new-cloud-employee-mobile.png',animations:'disabled'});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  for(const dark of [false,true]) {
   await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   for(const width of [1440,727,390]) {
    await page.setViewportSize({width,height:900});
    for(const view of ['runner','stats','settings']) {
     await nav(view);await page.waitForTimeout(200);await bounds(view+' '+width+' '+dark);
     if(view==='stats') {assert.equal(await f.locator('#statsTable [data-slot="table"]').count(),1);assert.equal(await f.locator('#statsTable tbody tr').count(),10)}
     if(view==='settings') {await f.locator('[data-fold="runtime"] > summary').click();await bounds('runtime');await f.locator('[data-fold="runtime"] > summary').click()}
     await frame.evaluate(()=>document.querySelectorAll('.runner-page,.settings,.page-scroll').forEach(el=>el.scrollTop=0));
     await page.screenshot({path:output+'/'+view+'-'+width+'-'+(dark?'dark':'light')+'.png',animations:'disabled'});
    }
   }
  }
  await nav('stats');assert.ok((await f.locator('#statsTable tbody').innerText()).includes('2 分钟'));await f.locator('#statsTable').getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await f.locator('#statsTable tbody tr').count(),3);
  await f.locator('#statsTable').getByRole('button',{name:'排序：任务数',exact:true}).click();await f.getByRole('menuitem',{name:'降序',exact:true}).click();
  await nav('runner');runner[0].online=false;await nav('worksite');await nav('runner');await f.locator('.rp-state').filter({hasText:'离线'}).waitFor();
  await page.route('**/ai/api/tasks?range=all',route=>route.fulfill({status:503,json:{error:'临时合成读取失败'}}));await nav('stats');await f.locator('#statsTable').getByText(/读取任务数据失败/).waitFor();assert.ok(await f.locator('#statsTable [data-slot="table-empty"]').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}));await page.screenshot({path:output+'/stats-error-mobile.png',animations:'disabled'});
  await nav('settings');await page.unroute('**/ai/api/tasks?range=all');await page.route('**/ai/api/tasks?range=all',route=>route.fulfill({json:{items:[]}}));await nav('stats');await f.locator('#statsTable').getByText('还没有任务数据。',{exact:true}).waitFor();assert.ok(await f.locator('#statsTable [data-slot="table-empty"]').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}));await page.screenshot({path:output+'/stats-empty-mobile.png',animations:'disabled'});
  const user=await browser.newContext({viewport:{width:390,height:844}});try {
   assert.ok((await user.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.planner})).ok());
   const up=await user.newPage();up.on('pageerror',e=>errors.push(e.message));await up.goto(fixture.url+'/#ai/settings');await up.getByRole('radio',{name:'AI 调度中心',exact:true}).click();const uf=up.frameLocator('iframe');await uf.locator('#myAgentNew').waitFor();
   assert.equal(await uf.locator('#settingsMetrics').isVisible(),false);assert.equal(await uf.locator('[data-fold="runtime"]').isVisible(),false);
   assert.equal(await uf.locator('#settings > .native-content-card:visible').count(),3);
   const inner=up.frames().find(f=>f.url().includes('scheduler.html'));await inner.evaluate(()=>window.platformAiOpenView('stats'));await uf.locator('#viewTitle').filter({hasText:'任务执行'}).waitFor();
  } finally {await user.close()}
  assert.deepEqual(errors,[]);console.log('PASS: shared executor/settings Card/Badge/Avatar/ActionCard, statistics DataTable, light/dark 1440/727/390, long content, empty/online/offline runner, shared pairing/roots/model/employee dialogs; real temporary model/employee/roots persistence, synthetic statistics and runner status; no model/CLI task execution.');
 } catch(error) {await page.screenshot({path:output+'/failure.png',fullPage:true,animations:'disabled'});throw error}
 finally {await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
