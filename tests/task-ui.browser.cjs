/* Temporary fixture only. Drafts and flow definitions are saved; no task is dispatched. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
 const suffix=Date.now().toString(36);const agentName='样式验收执行员'+suffix;const flowName='共享组件回归流程'+suffix;
 const fixture=JSON.parse(fs.readFileSync(process.argv[2]));
 const output=process.argv[3] || '/tmp/qihbg-task-fix/task';fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  const login=await context.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.admin});assert.equal(login.status(),200);
  const api=async(path,data)=>{const r=await context.request.post(fixture.url+'/ai/api/'+path,{headers:{Origin:fixture.url},data});assert.ok(r.ok(),await r.text());return r.json()};
  await api('user-agents',{name:agentName,kind:'builtin',ref:'codex'});
  const task=await api('tasks',{prompt:'这是临时数据里的合成草稿，不执行模型。用于检查多行摘要和详情焦点。',draft:true,title:'多行任务记录样式验收'});
  await api('tasks/'+task.id+'/cancel',{}); // Make a visible cancelled record without dispatching it.
  await page.goto(fixture.url+'/v2/#ai/worksite');
  await page.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  const f=page.frameLocator('iframe');await f.locator('#viewTitle').waitFor();
  const frame=page.frames().find(f=>f.url().includes('scheduler.html'));
  const checkbox=f.locator('#adhocWrite + [data-native-bridge] [role="checkbox"]');
  await checkbox.waitFor();assert.equal(await checkbox.getAttribute('data-state'),'checked');
  await checkbox.click();assert.equal(await f.locator('#adhocWrite').isChecked(),false);
  await f.getByText('允许写文件',{exact:true}).click();assert.equal(await checkbox.getAttribute('data-state'),'checked');
  // Shared select supports keyboard navigation; native source remains the same node/value.
  const agent=f.locator('#adhocAgent + [data-native-bridge] [data-slot="select-trigger"]');
  await agent.click();await f.getByRole('option',{name:new RegExp(agentName)}).click();
  const selected=await f.locator('#adhocAgent').inputValue();assert.ok(selected);
  await f.locator('#adhocPrompt').fill('切换主题时保留这份草稿');
  const row=f.locator(`[data-task="${task.id}"]`);await row.waitFor();
  assert.ok((await row.boundingBox()).height>40,'multi-line task row must retain content height');
  await row.click();await f.locator('[data-slot="sheet-content"]').waitFor();
  await f.locator('#drawerTitle').filter({hasText:'多行任务记录样式验收'}).waitFor();
  assert.equal(await f.locator('#closeDrawer').evaluate(el=>el===document.activeElement),true);
  await f.locator('#drawerActions').getByRole('button',{name:'更多',exact:true}).press('ArrowDown');
  await f.getByRole('menuitem',{name:'重命名',exact:true}).waitFor();
  await page.waitForTimeout(120);await f.getByRole('menuitem',{name:'重命名',exact:true}).press('Escape');await f.getByRole('menu').waitFor({state:'hidden'});
  assert.equal(await f.locator('[data-slot="sheet-content"]').isVisible(),true,'menu Escape must keep Sheet open');
  await f.locator('#drawerActions').getByRole('button',{name:'更多',exact:true}).click();
  await f.getByRole('menuitem',{name:'重命名',exact:true}).focus();
  await page.keyboard.press('Enter');
  await f.locator('[data-slot="dialog-content"]').waitFor();
  await f.locator('[data-slot="dialog-content"] input').press('Escape');await f.locator('[data-slot="dialog-content"]').waitFor({state:'hidden'});
  assert.equal(await f.locator('[data-slot="sheet-content"]').isVisible(),true,'nested dialog Escape must keep Sheet open');
  await f.locator('#drawerActions').getByRole('button',{name:'更多',exact:true}).click();
  await f.getByRole('menuitem',{name:'重命名',exact:true}).click();
  await f.locator('[data-slot="dialog-content"] input').fill('重命名后的合成草稿');
  await f.locator('[data-slot="dialog-content"]').locator('[data-dlg-ok]').click();
  await f.locator('#drawerTitle').filter({hasText:'重命名后的合成草稿'}).waitFor();
  await page.keyboard.press('Escape');await f.locator('[data-slot="sheet-content"]').waitFor({state:'hidden'});
  assert.equal(await frame.evaluate(()=>document.activeElement?.dataset.task),task.id);
  assert.equal(await f.locator('#adhocPrompt').inputValue(),'切换主题时保留这份草稿');
  assert.equal(await f.locator('#adhocAgent').inputValue(),selected);
  await page.screenshot({path:output+'/01-adhoc-light.png',fullPage:true});
  await f.getByRole('tab',{name:/流程编排/}).click();
  assert.ok((await f.locator('#flowLaunchInput').boundingBox()).height>=128);
  assert.equal(await f.locator('#adhocTabs').evaluate(el=>getComputedStyle(el).borderBottomWidth),'0px');
  await f.locator('#flowNew').click();await f.locator('#flowName').fill(flowName);
  const node=f.locator('.flow-node-card').first();await node.waitFor();
  assert.equal(await node.evaluate(el=>getComputedStyle(el).backgroundImage),'none');
  assert.ok((await node.locator('[data-act="del"]').boundingBox()).height<=24,'canvas delete control must remain compact');
  const cp=f.locator('#flowInspector [data-native-bridge="checkbox"] [role="checkbox"]');
  await cp.waitFor();assert.equal((await cp.boundingBox()).height,20,'legacy form rules must not resize shared Checkbox');const checked=await cp.getAttribute('data-state');await cp.click();
  assert.notEqual(await cp.getAttribute('data-state'),checked);
  // Per-card text containment: page/dialog overflow alone misses text outside a short button.
  const palette=f.locator('#flowPalette');
  for (const dark of [false,true]) {
   await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   for (const width of [1440,727,390]) {
    await page.setViewportSize({width,height:900});await page.waitForTimeout(150);
    await palette.scrollIntoViewIfNeeded();
    assert.equal(await palette.evaluate(el=>Array.from(el.querySelectorAll('[data-slot="action-card"]')).every(card=>{
     const box=card.getBoundingClientRect();return card.scrollHeight<=card.clientHeight && getComputedStyle(card.children[0]).borderBottomWidth === "0px" && Array.from(card.children).every(text=>{
      const rect=text.getBoundingClientRect();return rect.top>=box.top && rect.bottom<=box.bottom && rect.left>=box.left && rect.right<=box.right;
     });
    })),true,'all palette text must fit the shared card in every viewport/theme');
    if(width===727) await page.screenshot({path:output+'/palette-'+(dark?'dark':'light')+'.png'});
   }
  }
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.setViewportSize({width:1440,height:1000});
  const card=palette.locator('[data-action-id]').nth(1);
  const agentId=await card.getAttribute('data-action-id');
  await card.press('Enter');
  assert.equal(await f.locator('.flow-node-card').count(),3,'shared card keyboard activation adds a step');
  await f.locator('.flow-node-card').last().locator('[data-act="del"]').click();
  await card.evaluate((el)=>{
   const transfer=new DataTransfer();el.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
   document.querySelector('#flowCanvasWrap').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer,clientX:400,clientY:600}));
   el.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));
  });
  assert.equal(await f.locator('.flow-node-card').count(),3,'shared card drag/drop preserves controller protocol');
  assert.equal(await f.locator('#flowInspector .flow-step-agent').inputValue(),agentId);
  await f.locator('.flow-node-card').last().locator('[data-act="del"]').click();
  await node.click();
  await page.setViewportSize({width:727,height:682});
  const worker=f.locator('#flowInspector .flow-step-agent + [data-native-bridge] [data-slot="select-trigger"]');
  await worker.click();await f.getByRole('option',{name:/新建.*员工/}).click();
  const dialog=f.locator('[data-slot="dialog-content"]');await dialog.waitFor();
  await f.locator('#uaName').fill('临时组件验收员工');
  assert.equal(await dialog.locator('[data-slot="dialog-header"]').count(),1);
  const perms=f.locator('#uaDefaultMode + [data-native-bridge] [data-slot="select-trigger"]');
  await perms.click();await f.getByRole('option',{name:/只读/}).click();
  assert.equal(await f.locator('#uaDefaultMode').inputValue(),'read-only');
  await dialog.locator('[data-kind="openai"]').click();
  const tool=f.locator('#uaTools + [data-native-bridge] [role="checkbox"]');await tool.click();
  assert.equal(await f.locator('#uaTools').isChecked(),false);
  for(const width of [727,390]) {
   await page.setViewportSize({width,height:682});await page.waitForTimeout(200);
   assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'employee dialog has no horizontal overflow');
   const cards=dialog.locator('.ua-seg-btn');for(const card of await cards.all()) assert.equal(await card.evaluate(el=>el.scrollHeight<=el.clientHeight),true,'employee type text fits');
   assert.ok(await dialog.locator('[data-dlg-ok]').isVisible());
   const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width,'dialog stays within viewport');
   await dialog.locator('.native-dialog-body').evaluate(el=>el.scrollTop=0);
   await page.screenshot({path:output+'/employee-'+width+'.png',fullPage:true});
  }
  await dialog.locator('[data-dlg-cancel]').click();await dialog.waitFor({state:'hidden'});
  assert.equal(await f.locator('#flowName').inputValue(),flowName);
  await page.setViewportSize({width:727,height:682});
  await page.screenshot({path:output+'/02-editor-light.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await f.locator('#flowSave').click();await f.locator('#viewWorksite').waitFor({state:'visible'});
  const flows=f.locator('#flowLaunchSelect + [data-native-bridge] [data-slot="select-trigger"]');
  await flows.click();await f.getByRole('option',{name:new RegExp(flowName)}).waitFor();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.ok(await f.locator('#flowLaunchSelect').inputValue());
  const response=await context.request.get(fixture.url+'/ai/api/flows');const stored=await response.json();
  const saved=stored.items.find(item=>item.name===flowName);assert.ok(saved);assert.equal(saved.steps[0].checkpoint.enabled,checked!=='checked');
  assert.equal((stored.runs||[]).length,0,'saving definitions must not execute flows');
  // Synthetic read responses exercise record/detail layout without creating a real execution.
  const run={id:'ui-run-'+suffix,flowId:saved.id,flowName:flowName,status:'success',flowVersion:1,createdAt:new Date().toISOString(),input:'合成界面快照，不执行流程',stepStates:[]};
  await page.route('**/ai/api/flows',route=>route.fulfill({json:{...stored,runs:[run]}}));
  await page.route('**/ai/api/flows/runs/'+run.id,route=>route.fulfill({json:run}));
  await page.route('**/ai/api/flows/runs/'+run.id+'/events*',route=>route.fulfill({contentType:'text/event-stream',body:': synthetic terminal run\n\n'}));
  await frame.evaluate(()=>window.platformAiOpenView('worksite'));
  const record=f.locator('.run-tab[data-run="'+run.id+'"]');await record.waitFor();
  assert.ok((await record.boundingBox()).height>36,'two-line run record retains content height');
  await f.locator('#runBoardName').filter({hasText:flowName}).waitFor();
  await page.screenshot({path:output+'/02-flows-light.png',fullPage:true});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.waitForTimeout(150);await page.screenshot({path:output+'/03-flows-dark.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok((await f.locator('#flowRunPanel').boundingBox()).width>=300,'mobile execution detail must not be squeezed beside the record column');
  await page.screenshot({path:output+'/04-flows-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: native/shared checkbox label sync, select change, content-height task row, Sheet focus/return, keyboard menu and nested rename dialog, draft retention, compact canvas actions, checkpoint persistence, shared flow select, employee Dialog/Select/Checkbox and 727/390px bounds, cancelled employee form preserves flow, light/dark/mobile; no models or flow execution.');
 } catch(error) {await page.screenshot({path:output+'/failure.png',fullPage:true});throw error}
 finally {await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
