/* Temporary data only. Project/skill persistence is real; artifact responses are synthetic. No model runs. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
 const fixture = JSON.parse(fs.readFileSync(process.argv[2]));
 const output = process.argv[3] || '/tmp/qihbg-library-ui'; fs.mkdirSync(output,{recursive:true});
 assert.ok(fixture.data.includes('v2-independent-'),'Only temporary fixture data may be seeded');
 const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const suffix=Date.now().toString(36), skill='ui-method-'+suffix, projectName='协作布局验收项目'+suffix;
 const long='长文本验收：'.repeat(14);
 try {
  assert.ok((await context.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.admin})).ok());
  const api=async(url,method='GET',data)=>{const r=await context.request.fetch(fixture.url+'/ai/api/'+url,{method,data,headers:{Origin:fixture.url}});assert.ok(r.ok(),await r.text());return r.json()};
  const skills=await api('skills');assert.ok(skills.dir.startsWith(fixture.data));
  const dir=path.join(skills.dir,skill);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'SKILL.md'),'---\nname: '+skill+'\ndisplay_name: '+long+'\nsummary: 方法说明'+long+'\nversion: 1.0.0\ncategory: 验收分类\ntags:\n  - 测试\n  - 长文本\n---\n\n## 验收正文\n'+('仅隔离测试，不执行任何脚本。\n'.repeat(60)));
  const draft=await api('tasks','POST',{prompt:'合成产出布局验收，不执行模型',draft:true,title:'来源任务'+suffix});await api('tasks/'+draft.id+'/cancel','POST',{});
  const task=await api('tasks/'+draft.id);
  const files=Array.from({length:12},(_,i)=>({id:'file-'+i,name:(i===0?long:'验收文件'+i)+'.md',type:i%2?'text':'markdown',path:'/temporary/验收/'+i+'.md',relativePath:'验收/'+i+'.md',size:1024+i,exists:i!==11,createdAt:new Date().toISOString()}));
  const list=await api('tasks');const synthetic={...task,artifacts:files};
  await page.route('**/ai/api/tasks',route=>route.request().method()==='GET'?route.fulfill({json:{...list,items:[synthetic,...list.items.filter(t=>t.id!==task.id)]}}):route.continue());
  await page.route('**/ai/api/artifacts/**/content/**',route=>{const content='# 合成文件预览\n\n只检查显示与下载，不代表真实模型产出。\n'+long;return route.fulfill(route.request().url().includes('raw=1')?{contentType:'text/markdown',body:content}:{json:{content}})});
  await page.route('**/ai/api/collab/overview?*',async route=>{
   const response=await route.fetch();const data=await response.json();
   const pushes=['artifact','note'].map((kind,i)=>({id:'synthetic-push-'+i,kind,memberId:data.members[0]?.id,memberName:'验收成员'+long,agent:'Codex',title:'合成协作记录'+long,body:'合成正文\n'+long,taskId:task.id,taskLabel:task.label,createdAt:new Date().toISOString()}));
   const kind=new URL(route.request().url()).searchParams.get('kind');
   await route.fulfill({json:{...data,items:kind?pushes.filter(p=>p.kind===kind):pushes,totals:{...data.totals,artifact:1,note:1}}});
  });
  await page.goto(fixture.url+'/v2/#ai/worksite');await page.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  const f=page.frameLocator('iframe');await f.locator('#viewTitle').waitFor();const frame=page.frames().find(f=>f.url().includes('scheduler.html'));
  async function nav(name){const viewport=page.viewportSize();if(viewport.width<768)await page.setViewportSize({width:1440,height:viewport.height});await page.getByRole('button',{name,exact:true}).first().click();await f.locator('#viewTitle').filter({hasText:name}).waitFor();if(viewport.width<768)await page.setViewportSize(viewport)}
  async function bounds(label,selector){
   assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' page overflow');
   if(selector) assert.equal(await f.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,label+' horizontal overflow');
  }
  await nav('协作');await f.getByRole('button',{name:'＋ 新建项目',exact:true}).click();
  const dlg=f.locator('[data-slot="dialog-content"]');await dlg.waitFor();
  await dlg.locator('[data-dlg-field="name"]').fill(projectName);await dlg.locator('[data-dlg-field="goal"]').fill(long);
  assert.equal(await dlg.locator('[data-slot="select-trigger"]').count(),1);
  await page.setViewportSize({width:390,height:844});await bounds('new project','[data-slot="dialog-content"]');await page.screenshot({animations:"disabled",path:output+'/new-project-mobile.png'});
  await dlg.locator('[data-dlg-ok]').click();await f.locator('.pj-head-main h2').filter({hasText:projectName}).waitFor();
  const projects=await api('collab/projects');const project=projects.items.find(p=>p.name===projectName);assert.ok(project,'Project saved through existing API');
  await f.locator('.pj-agent-add').click();await dlg.waitFor();
  await dlg.locator('[data-f="name"]').fill('多行员工'+long);await dlg.locator('[data-f="role"]').fill('验收专员');await dlg.locator('[data-f="duty"]').fill(long);
  const source=dlg.locator(`.pj-skill-pick input[value="${skill}"]`);
  const check=dlg.locator(`.pj-skill-pick input[value="${skill}"] + [data-native-bridge] [data-slot="checkbox"]`);await check.click();
  assert.equal(await source.isChecked(),true);
  assert.equal(await check.evaluate(el=>el.getBoundingClientRect().height),20);
  await bounds('project employee','[data-slot="dialog-content"]');await page.screenshot({animations:"disabled",path:output+'/project-employee-mobile.png'});
  await dlg.locator('[data-dlg-ok]').click();await f.locator('#pjAgents [data-slot="card"]').waitFor();
  const stored=await api('collab/projects/'+project.id);assert.equal(stored.agents.length,1);assert.deepEqual(stored.agents[0].skills,[skill]);
  for(const width of [1440,727,390]) {await page.setViewportSize({width,height:900});await page.waitForTimeout(250);await bounds('project');await page.screenshot({animations:"disabled",path:output+'/project-'+width+'.png'})}
  await f.getByRole('button',{name:/返回项目/}).click();
  const projectCard=f.locator('#pjGrid [data-slot="card"]').filter({hasText:projectName});await projectCard.waitFor();
  await projectCard.locator('[data-slot="card-description"]').click();await f.locator('.pj-head-main h2').filter({hasText:projectName}).waitFor();await f.getByRole('button',{name:/返回项目/}).click();
  assert.equal(await projectCard.locator('[data-slot="button"]').count(),1);await projectCard.locator('button').press('Enter');await f.locator('.pj-head-main h2').filter({hasText:projectName}).waitFor();
  await f.locator('#cpTabs').getByRole('button',{name:'全部动态',exact:true}).click();
  const filter=f.locator('#cpFilters [data-role="member"] + [data-native-bridge] [data-slot="select-trigger"]');await filter.click();await f.getByRole('option',{name:'全部成员',exact:true}).click();
  await f.locator('#cpList .cp-card').first().waitFor();
  for(const width of [1440,727,390]) {await page.setViewportSize({width,height:900});await page.waitForTimeout(250);await bounds('stream');await page.screenshot({animations:"disabled",path:output+'/stream-'+width+'.png'})}
  await f.locator('#cpKind').getByRole('button',{name:'动态',exact:true}).click();await page.waitForTimeout(200);assert.equal(await f.locator('#cpList .cp-card').count(),1);
  await nav('工作方法');await f.locator('#skillList [data-slot="card"]').first().waitFor();
  assert.equal(await f.locator('#skillSort').isVisible(),false,'cloud sorting is hidden for local methods');
  await f.locator('#skillQuery').fill('不存在的测试关键字');await f.locator('#skillList .empty-state').waitFor();await f.locator('#skillQuery').fill('');
  await f.locator(`[data-skill-edit="${skill}"]`).click();await f.locator('#skillEditForm').waitFor({state:'visible'});
  assert.equal(await f.locator('#skillDialog').evaluate(el=>el.closest('[data-slot="dialog-content"]')!==null),true);
  await f.locator('#skillEditTitle').fill('已保存方法'+suffix);await f.locator('#skillEditSummary').fill(long);await f.locator('#skillEditBody').fill('## 真实临时文件保存验收\n'+long);
  for(const width of [1440,727,390]) {await page.setViewportSize({width,height:900});await page.waitForTimeout(250);await bounds('skill editor', '[data-slot="dialog-content"]');const height=(await f.locator('#skillEditBody').boundingBox()).height;assert.ok(height>=279,'body height '+height);await page.screenshot({animations:"disabled",path:output+'/skill-editor-'+width+'.png'})}
  await f.locator('#skillDlgSave').click();await f.locator('#skillDlgBody').waitFor({state:'visible'});
  assert.equal((await api('skills/'+skill)).meta.display_name,'已保存方法'+suffix);assert.ok(fs.readFileSync(path.join(dir,'SKILL.md'),'utf8').includes('真实临时文件保存验收'));
  await page.keyboard.press('Escape');await dlg.waitFor({state:'hidden'});
  await frame.waitForFunction(skill=>document.activeElement?.dataset.skillEdit===skill,skill,{timeout:5000});
  await f.locator('#skillHubConfig').click();await f.locator('#hubDialog').waitFor({state:'visible'});await bounds('hub dialog','[data-slot="dialog-content"]');
  await f.locator('#hubBaseUrl').fill('http://127.0.0.1:1/hub/');await page.screenshot({animations:"disabled",path:output+'/hub-mobile.png'});await f.locator('#hubCancel').click();await dlg.waitFor({state:'hidden'});
  await f.locator('#skillTabs').getByRole('button',{name:/云端工作方法/}).click();await f.locator('#skillSort + [data-native-bridge] [data-slot="select-trigger"]').waitFor();await f.locator('#skillTabs').getByRole('button',{name:/本机工作方法/}).click();
  // Every module is checked with populated content, both themes and three viewport widths.
  for(const dark of [false,true]) {
   await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   for(const width of [1440,727,390]) {
    await page.setViewportSize({width,height:900});
    for(const name of ['协作','产出库','工作方法']) {
     await nav(name);await page.waitForTimeout(150);await bounds(name);
     if(name==='产出库') assert.equal(await f.locator('#artifactList').evaluate(el=>Array.from(el.querySelectorAll('button')).every(button=>button.scrollHeight<=button.clientHeight+1)),true,'file/source/action text stays inside buttons');
     if(name==='工作方法') assert.equal(await f.locator('#skillList [data-slot="card"]').first().evaluate(el=>Array.from(el.querySelectorAll('button')).every(button=>button.scrollHeight<=button.clientHeight)),true,'method buttons fit');
     await page.screenshot({animations:"disabled",path:output+'/'+name+'-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
   }
  }
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));await page.setViewportSize({width:727,height:900});await nav('产出库');
  assert.equal(await f.locator('#artifactList [data-slot="table"]').count(),1);
  assert.equal(await f.locator('#artifactList tbody tr').count(),10);
  await f.locator('#artifactList').getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await f.locator('#artifactList tbody tr').count(),2);
  await f.locator('#artifactList').getByRole('button',{name:'第一页',exact:true}).click();
  await f.locator('#artifactList').getByRole('checkbox',{name:'选择当前页全部记录',exact:true}).click();await f.getByRole('region',{name:'已选记录操作'}).waitFor();
  await f.locator('#artifactTabs').getByRole('button',{name:/^文本/}).click();assert.equal(await f.locator('#artifactList tbody tr').count(),6);await f.locator('#artifactTabs').getByRole('button',{name:/^全部/}).click();
  const preview=f.locator('#artifactList').getByRole('button',{name:'预览',exact:true}).first();await preview.click();await f.locator('#apreviewBody').filter({hasText:'合成文件预览'}).waitFor();
  assert.equal(await f.locator('#artifactPreview').evaluate(el=>el.closest('[data-slot="dialog-content"]')!==null),true);
  for(const width of [727,390]) {await page.setViewportSize({width,height:844});await page.waitForTimeout(250);await bounds('artifact preview','[data-slot="dialog-content"]');assert.equal(await f.locator('#apreviewDownload').evaluate(el=>el.getBoundingClientRect().height),40);await page.screenshot({animations:"disabled",path:output+'/preview-'+width+'.png'})}
  const download=page.waitForEvent('download');await f.locator('#apreviewDownload').click();assert.ok((await download).suggestedFilename().endsWith('.md'));
  await f.locator('#apreviewClose').click();await dlg.waitFor({state:'hidden'});
  await f.locator('#artifactList').getByRole('button',{name:new RegExp('来源任务'+suffix)}).first().click();await f.locator('[data-slot="sheet-content"]').waitFor();await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);console.log('PASS: populated three-module light/dark 1440/727/390 layout; shared cards/metrics/segments/DataTable/Select/Checkbox/Dialog; real temporary project and employee/skill persistence; synthetic artifact preview/download/source Sheet, table pagination and selection. No cloud/model/executor calls.');
 } catch(error) {await page.screenshot({animations:"disabled",path:output+'/failure.png',fullPage:true});throw error}
 finally {await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
