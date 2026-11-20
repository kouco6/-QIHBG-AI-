/* Read-only UI regression using a temporary fixture; no tasks or cloud requests. */
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
 const fixture=JSON.parse(fs.readFileSync(process.argv[2]));
 const output=process.argv[3] || '/tmp/qihbg-segments';fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try {
  const context=await browser.newContext({viewport:{width:727,height:682}});
  assert.ok((await context.request.post(fixture.url+'/platform/login',{headers:{Origin:fixture.url},data:fixture.admin})).ok());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.url+'/#ai/templates');await page.getByRole('radio',{name:'AI 调度中心',exact:true}).click();
  const f=page.frameLocator('iframe');await f.locator('#skillTabs button').first().waitFor();
  const frame=page.frames().find(frame=>frame.url().includes('scheduler.html'));
  // Reproduce the retained, unlayered host rule that previously turned selected text dark.
  await frame.evaluate(()=>document.styleSheets[0].insertRule('button { color: inherit; font: inherit; cursor: pointer; }',document.styleSheets[0].cssRules.length));
  async function verify(group,label){
   assert.equal(await group.evaluate(el=>Array.from(el.querySelectorAll('button')).every(button=>{
    const token=button.getAttribute('aria-pressed')==='true'?'--primary-foreground':'--foreground';
    const probe=document.createElement('span');probe.style.color=`var(${token})`;document.body.append(probe);
    const expected=getComputedStyle(probe).color;probe.remove();
    const actual=getComputedStyle(button).color;
    return actual===expected && Array.from(button.children).every(child=>getComputedStyle(child).color===actual);
   })),true,label+' must keep theme foreground and inherited count color despite legacy CSS');
  }
  for(const dark of [false,true]) {
   await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   for(const width of [1440,727,390]) {
    await page.setViewportSize({width,height:682});
    for(const [view,id] of [['collab','cpTabs'],['artifacts','artifactTabs'],['templates','skillTabs']]) {
     await frame.evaluate(view=>window.platformAiOpenView(view),view);
     const group=f.locator('#'+id);await group.waitFor({state:'visible'});await group.locator('button[aria-pressed="true"]').waitFor();
     await page.mouse.move(0,0);await page.waitForTimeout(150);await verify(group,view+' initial');
     const selected=group.locator('button[aria-pressed="true"]');await selected.hover();await page.waitForTimeout(250);await verify(group,view+' hover');
     await page.keyboard.press('Tab');await selected.focus();await page.waitForTimeout(250);await verify(group,view+' keyboard focus');
     assert.equal(await selected.evaluate(el=>getComputedStyle(el).outlineStyle),'none','shared Button owns the focus ring without a second outline');
     if(await group.locator('button').count()>1){
      await group.locator('button[aria-pressed="false"]').first().click();await page.waitForTimeout(200);await verify(group,view+' changed');
      await group.locator('button').first().click();await page.waitForTimeout(200);await verify(group,view+' restored');
     }
     if(width===727) {await group.scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:output+'/'+view+'-'+(dark?'dark':'light')+'.png'})}
    }
   }
  }
  assert.deepEqual(errors,[]);await context.close();console.log('PASS: three shared filter groups, light/dark, 1440/727/390, selected/unselected/count colors, hover, keyboard focus, switching, and retained legacy CSS override; no business writes.');
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
