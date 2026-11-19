const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
 const fixture = JSON.parse(fs.readFileSync(process.argv[2]));
 const output = process.argv[3] || '/tmp/qihbg-ai-v2-screens'; fs.mkdirSync(output,{recursive:true});
 const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || (process.platform==='darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),args:['--disable-dev-shm-usage']});
 const errors=[];
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.on('pageerror', e => errors.push(e.message));
  await page.goto(fixture.url+'/v2/#ai/worksite');
  await page.getByLabel('账号',{exact:true}).fill(fixture.admin.login);
  await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  const frame = page.frameLocator('iframe[title="AI 调度工作台"]');
  await frame.locator('#viewTitle').waitFor({timeout:40000});
  await page.getByRole('status').filter({hasText:'正在连接调度服务'}).waitFor({state:'hidden',timeout:40000});
  assert.equal(await frame.locator('#viewTitle').innerText(),'任务执行');
  await page.screenshot({path:output+'/01-worksite-light.png',fullPage:true});
  for(const [nav,title] of [['协作','协作'],['产出库','产出库'],['工作方法','工作方法'],['执行器','执行器'],['统计','统计'],['设置','设置'],['任务执行','任务执行']]){
   await page.getByRole('button',{name:nav,exact:true}).first().click();
   await assert.doesNotReject(()=>frame.locator('#viewTitle').filter({hasText:title}).waitFor());
  }
  await page.getByRole('button',{name:'设置',exact:true}).first().click();
  await frame.locator('#myModelNew').click();
  await frame.locator('#mdName').fill('界面合成模型');
  assert.equal(await frame.locator('#mdName').getAttribute('data-slot'),'input');
  await page.waitForTimeout(250);
  await page.screenshot({path:output+'/04-model-dialog.png',fullPage:true});
  await frame.locator('[data-slot="dialog-content"] [data-dlg-cancel]').first().click();
  await page.getByRole('button',{name:'任务执行',exact:true}).first().click();
  // Shared classes are applied to dynamic controls, preserving the same DOM node and draft.
  await frame.locator('#adhocPrompt').fill('隔离测试草稿：切换主题后保留');
  const aiFrame=page.frames().find(f=>f.url().includes('scheduler.html'));
  await aiFrame.evaluate(()=>{window.__draftNode=document.querySelector('#adhocPrompt')});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.waitForTimeout(200);
  assert.equal(await aiFrame.evaluate(()=>document.documentElement.classList.contains('dark')),true);
  assert.equal(await aiFrame.evaluate(()=>window.__draftNode===document.querySelector('#adhocPrompt')),true);
  assert.equal(await frame.locator('#adhocPrompt').inputValue(),'隔离测试草稿：切换主题后保留');
  assert.equal(await frame.locator('#adhocPrompt').getAttribute('data-slot'),'textarea');
  await page.screenshot({path:output+'/02-worksite-dark.png',fullPage:true});
  await frame.locator('#adhocPrompt').fill('');
  const req=context.request;
  async function api(path,method='GET',data){const r=await req.fetch(fixture.url+path,{method,data,headers:{Origin:fixture.url}});let body=await r.json();return {status:r.status(),body}}
  const me=await api('/ai/api/auth/me');assert.equal(me.status,200);assert.equal(me.body.account.role,'admin');assert.equal(me.body.integration,true);
  const draft=await api('/ai/api/tasks','POST',{prompt:'合成草稿，不执行模型',draft:true,title:'隔离验收草稿'});assert.equal(draft.status,201,JSON.stringify(draft.body));
  const saved=await api('/ai/api/tasks/'+draft.body.id);assert.equal(saved.body.ownerAccountId,me.body.account.id);
  const archive=await api('/ai/api/tasks/'+draft.body.id+'/archive','POST',{});assert.equal(archive.status,200);
  const research=await api('/ai/api/research/runtime');assert.equal(research.status,403); // Native research requires its own trusted key.
  assert.equal((await api('/ai/api/auth/accounts','POST',{username:'forbidden',name:'不应创建',password:'test-123'})).status,403);
  assert.equal((await api('/ai/api/auth/login','POST',{})).status,409);
  // A second platform user has an independent gateway and cannot inherit master-token admin.
  const user=await browser.newContext();
  await user.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.planner});
  const ur=await user.request.get(fixture.url+'/ai/api/auth/me');const um=await ur.json();assert.equal(ur.status(),200);assert.equal(um.account.role,'other');
  assert.equal((await user.request.get(fixture.url+'/ai/api/auth/accounts')).status(),401);
  assert.equal((await user.request.get(fixture.url+'/ai/api/tasks/'+draft.body.id)).status(),404);
  const up=await user.newPage();up.on('pageerror',e=>errors.push(e.message));await up.goto(fixture.url+'/v2/#ai/worksite');
  await up.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  await up.frameLocator('iframe').locator('#viewTitle').waitFor({timeout:40000});
  assert.equal(await up.getByRole('button',{name:'统计',exact:true}).count(),0);
  // Self-pairing reaches the user's private gateway without a portal cookie or master token.
  const pairResponse=await user.request.post(fixture.url+'/ai/api/runner/bootstrap-code',{headers:{Origin:fixture.url},data:{}});
  assert.equal(pairResponse.status(),200);const pair=await pairResponse.json();
  const packed=JSON.parse(Buffer.from(pair.packed.slice(4),'base64url'));
  assert.equal(packed.u,fixture.url+'/platform/runner/'+fixture.planner.id);
  const machine=await browser.newContext();
  const redeem=await machine.request.post(packed.u+'/api/runner/bootstrap',{data:{code:packed.c,server:packed.u}});
  assert.equal(redeem.status(),200);const runnerToken=(await redeem.json()).token;
  const tokenHeaders={Authorization:'Bearer '+runnerToken};
  const agentResponse=await user.request.post(fixture.url+'/ai/api/user-agents',{headers:{Origin:fixture.url},data:{name:'合成执行员'+Date.now().toString(36),kind:'builtin',ref:'codex'}});
  assert.equal(agentResponse.status(),201);const agent=await agentResponse.json();
  const remoteResponse=await user.request.post(fixture.url+'/ai/api/tasks',{headers:{Origin:fixture.url},data:{prompt:'合成协议验证，不运行CLI',userAgentId:agent.id,title:'执行器协议验收'}});
  assert.equal(remoteResponse.status(),201);const remote=await remoteResponse.json();
  const claim=await machine.request.post(packed.u+'/api/runner/claim',{headers:tokenHeaders,data:{version:'fixture'}});
  assert.equal(claim.status(),200);assert.equal((await claim.json()).task.id,remote.id);
  assert.equal((await machine.request.post(packed.u+'/api/runner/heartbeat',{headers:tokenHeaders,data:{taskId:remote.id,output:'合成进度'}})).status(),200);
  const finished=await machine.request.post(packed.u+'/api/runner/finish',{headers:tokenHeaders,data:{taskId:remote.id,ok:true,finalResponse:'合成回传结果'}});
  assert.equal(finished.status(),200);assert.equal((await finished.json()).status,'completed');
  assert.equal((await machine.request.post(packed.u+'/api/runner/bootstrap',{data:{code:packed.c}})).status(),400);
  assert.equal((await context.request.patch(fixture.url+'/platform/accounts/'+fixture.planner.id,{headers:{Origin:fixture.url},data:{active:false}})).status(),200);
  assert.equal((await machine.request.post(packed.u+'/api/runner/claim',{headers:tokenHeaders,data:{}})).status(),403);
  await machine.close();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:output+'/03-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await aiFrame.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  await user.close();await context.close();
  console.log('PASS: seven pages, shared dynamic controls, light/dark, draft/node retention, real proxy identity, draft/archive, native research guard, account mutation block, user isolation, admin visibility, 390px layout, model dialog, self-pairing, one-time redemption, synthetic remote claim/progress/completion; no model calls.');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
