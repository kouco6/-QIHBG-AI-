const fs=require('node:fs');const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
(async()=>{const fixture=JSON.parse(fs.readFileSync(process.argv[2]));const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await context.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.admin});await page.goto(fixture.url+'/');
await page.getByRole('button',{name:'模版管理',exact:true}).first().click();const select=page.getByRole('combobox',{name:'选择预览维度'});await select.waitFor();
const response=await context.request.get(fixture.url+'/platform/v2/planning-templates');assert.equal(response.status(),200);const catalog=await response.json();const v=catalog.items.find(v=>v.id===catalog.active);
for(const [id,dim] of Object.entries(v.dimensions)){await select.click();await page.getByRole('option',{name:id.slice(-2)+' '+dim.name,exact:true}).click();const iframe=page.locator('iframe[title="'+dim.name+'示例预览"]');await iframe.waitFor();await page.waitForTimeout(180);const content=await iframe.contentFrame().locator('body').innerText();assert.ok(content.trim().length>20,id);}
assert.deepEqual(errors,[]);console.log('PASS: independent V2 templates, 12 dimensions rendered from new backend; no legacy project server');await context.close();}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
