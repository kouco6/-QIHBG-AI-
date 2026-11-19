(function(){
  'use strict';
  const core=window.dim02Core;
  if(!core)return;
  const view=new URLSearchParams(location.search).get('view')||'content';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const parentOrigin=location.origin;
  let current=clone(core.seed);
  let workMode=false;
  let pending=false;
  let editContext=null;

  const style=document.createElement('style');
  style.textContent=`
    body.dim02-work-mode #macro-scene .scene-title,body.dim02-work-mode .macro-group-head,body.dim02-work-mode .macro-prod-item,body.dim02-work-mode [data-hotspot],body.dim02-work-mode #scene-detail .scene-title,body.dim02-work-mode .analysis-card .entry,body.dim02-work-mode .goal-card{cursor:pointer}
    body.dim02-work-mode #macro-scene .scene-title:hover,body.dim02-work-mode .macro-group-head:hover,body.dim02-work-mode .macro-prod-item:hover,body.dim02-work-mode [data-hotspot]:hover,body.dim02-work-mode #scene-detail .scene-title:hover,body.dim02-work-mode .analysis-card .entry:hover,body.dim02-work-mode .goal-card:hover{outline:2px solid #3b82f6;outline-offset:2px}
    .dim02-device-status{display:inline-block;padding:2px 5px;border-radius:4px}.dim02-device-status.status-plan{background:#fff0f0;color:#b34149}.dim02-device-status.status-have{background:#e8f1ff;color:#245fa8}.dim02-device-status.status-none{background:#f1f3f6;color:#66778a}.dim02-device-status.status-unknown{background:#f1f3f6;color:#66778a}
    .dim02-edit-mask[hidden]{display:none}.dim02-edit-mask{position:fixed;inset:0;z-index:10000;background:#12223885;display:flex;justify-content:flex-end}.dim02-edit-drawer{width:min(520px,94vw);height:100%;background:#fff;box-shadow:-12px 0 40px #071e3a32;overflow:auto;display:flex;flex-direction:column}.dim02-edit-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 23px;border-bottom:1px solid #e2e8f0}.dim02-edit-head h2{margin:0;font-size:19px;color:#1e3d60}.dim02-edit-head button{border:0;background:#f1f5f9;border-radius:7px;padding:5px 10px;color:#475569}.dim02-edit-form{padding:22px 23px;flex:1}.dim02-edit-field{display:block;margin-bottom:17px}.dim02-edit-field span{display:block;font-size:12px;color:#526781;font-weight:750;margin-bottom:6px}.dim02-edit-field input,.dim02-edit-field textarea,.dim02-edit-field select{width:100%;border:1px solid #d6e1ec;border-radius:8px;background:#fff;color:#253f5e;padding:10px 11px;font:inherit;line-height:1.6}.dim02-edit-field textarea{min-height:100px;resize:vertical}.dim02-edit-actions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;padding:14px 23px;border-top:1px solid #e2e8f0;background:#fff}.dim02-edit-actions button{border:1px solid #cbd7e5;background:#fff;color:#35516f;border-radius:8px;padding:9px 15px}.dim02-edit-actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}.dim02-edit-error{color:#b91c1c;font-size:12px;padding:0 23px 10px}.dim02-edit-note{font-size:11px;color:#8291a3;line-height:1.7;margin:15px 0 0}
  `;
  document.head.appendChild(style);

  function renderText(snapshot){
    const d=snapshot||current;
    const lines=d.systems.map(group=>`<section><h3>${esc(group.title)}</h3><p>${esc(group.note)}</p><p>${group.devices.map(item=>`${esc(item.name)}（${esc(item.status)}）`).join('、')}</p></section>`).join('');
    const scenes=d.scenes.map(scene=>`<section><h3>${esc(scene.name)}广播应用场景</h3><p>${esc(scene.intro)}</p>${[['场景特点',scene.characteristics],['场景需求',scene.needs],['场景痛点',scene.pains]].map(([label,rows])=>`<h4>${label}</h4>${rows.map(row=>`<p><b>${esc(row.keyword)}：</b>${esc(row.detail)}</p>`).join('')}`).join('')}<h4>关键功能设计目标</h4>${scene.goals.map(goal=>`<p><b>${esc(goal.name)}：</b>${esc(goal.description)}</p>`).join('')}</section>`).join('');
    document.body.innerHTML=`<article class="text-page"><h1>行业应用场景</h1><h2>01 大场景应用分析</h2><h3>${esc(d.macroTitle)}</h3><p>${esc(d.macroIntro)}</p>${lines}<h2>02 业务场景应用分析</h2>${scenes}</article>`;
  }

  if(view==='text')renderText(current);
  else{
    const mask=document.createElement('div');
    mask.className='dim02-edit-mask';mask.hidden=true;mask.id='dim02-edit-mask';
    mask.innerHTML='<aside class="dim02-edit-drawer" role="dialog" aria-modal="true" aria-label="编辑维度内容"><div class="dim02-edit-head"><h2 id="dim02-edit-title">编辑内容</h2><button type="button" id="dim02-edit-close" aria-label="关闭编辑侧栏">✕</button></div><form id="dim02-edit-form" class="dim02-edit-form"></form><div class="dim02-edit-error" id="dim02-edit-error" aria-live="polite"></div><div class="dim02-edit-actions"><button type="button" id="dim02-edit-cancel">取消</button><button type="submit" form="dim02-edit-form" class="primary" id="dim02-edit-save">保存为新版本</button></div></aside>';
    document.body.appendChild(mask);
    const close=()=>{if(pending)return;mask.hidden=true;editContext=null};
    mask.addEventListener('click',event=>{if(event.target===mask)close()});
    document.getElementById('dim02-edit-close').onclick=close;
    document.getElementById('dim02-edit-cancel').onclick=close;
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!mask.hidden)close()});

    function input(key,label,value,type='text'){
      const body=type==='textarea'?`<textarea data-field="${key}" maxlength="2000">${esc(value)}</textarea>`:`<input data-field="${key}" value="${esc(value)}" maxlength="2000">`;
      return `<label class="dim02-edit-field"><span>${label}</span>${body}</label>`;
    }
    function selectText(key,label,value,options){return `<label class="dim02-edit-field"><span>${label}</span><select data-field="${key}">${options.map(option=>`<option value="${esc(option)}" ${option===value?'selected':''}>${esc(option)}</option>`).join('')}</select></label>`}
    function selectGroup(value){return `<label class="dim02-edit-field"><span>关联子系统</span><select data-field="group">${current.systems.map((group,index)=>`<option value="${index}" ${index===value?'selected':''}>${esc(group.title)}</option>`).join('')}</select></label>`}
    function open(kind,meta={}){
      if(!workMode||pending)return;
      const scene=current.scenes.find(item=>item.id===meta.sceneId);
      const system=current.systems[meta.groupIndex];
      let title='',fields='';
      if(kind==='macro'){title='编辑大场景';fields=input('macroTitle','场景名称',current.macroTitle)+input('macroIntro','场景说明',current.macroIntro,'textarea')}
      if(kind==='system'&&system){title='编辑子系统';fields=input('title','子系统名称',system.title)+input('note','组成说明',system.note,'textarea')}
      if(kind==='device'&&system?.devices[meta.deviceIndex]){const item=system.devices[meta.deviceIndex];title='编辑设备条目';fields=input('name','设备名称',item.name)+selectText('status','产品状态',item.status,['待核实','企划产品','已有产品','未有产品'])}
      if(kind==='hotspot'&&current.hotspots[meta.hotspotKey]){const item=current.hotspots[meta.hotspotKey];title='编辑设备部署点';fields=input('title','设备标签',item[1])+input('description','部署说明',item[2],'textarea')+selectGroup(item[0])}
      if(kind==='scene'&&scene){title='编辑业务场景';fields=input('name','场景名称',scene.name)+input('intro','场景简介',scene.intro,'textarea')}
      if(kind==='analysis'&&scene?.[meta.field]?.[meta.rowIndex]){const item=scene[meta.field][meta.rowIndex];title='编辑'+({'characteristics':'场景特点','needs':'场景需求','pains':'场景痛点'}[meta.field]);fields=input('keyword','关键词',item.keyword)+input('detail','说明',item.detail,'textarea')}
      if(kind==='goal'&&scene?.goals[meta.rowIndex]){const item=scene.goals[meta.rowIndex];title='编辑关键功能目标';fields=input('name','目标名称',item.name)+input('description','目标说明',item.description,'textarea')}
      if(!fields)return;
      editContext={kind,...meta};
      document.getElementById('dim02-edit-title').textContent=title;
      document.getElementById('dim02-edit-form').innerHTML=fields+'<p class="dim02-edit-note">保存后写入当前项目，并生成可预览、可恢复的内容版本。</p>';
      document.getElementById('dim02-edit-error').textContent='';
      mask.hidden=false;mask.querySelector('[data-field]')?.focus();
    }

    document.addEventListener('click',event=>{
      if(!workMode||!mask.hidden)return;
      const target=event.target;
      let kind=null,meta={};
      const hotspot=target.closest('#macro-scene [data-hotspot]');
      const groupHead=target.closest('.macro-group-head');
      const device=target.closest('.macro-prod-item');
      const macro=target.closest('#macro-scene .scene-title');
      const sceneTitle=target.closest('#scene-detail .scene-title');
      const entry=target.closest('#scene-detail .analysis-card .entry');
      const goal=target.closest('#scene-detail .goal-card');
      if(hotspot){kind='hotspot';meta.hotspotKey=hotspot.dataset.hotspot}
      else if(device){kind='device';meta.groupIndex=Number(device.closest('.macro-group').id.split('-').at(-1));meta.deviceIndex=Number(device.dataset.device)}
      else if(groupHead){kind='system';meta.groupIndex=Number(groupHead.dataset.group)}
      else if(macro){kind='macro'}
      else if(sceneTitle){kind='scene';meta.sceneId=current.scenes[core.selectedScene()].id}
      else if(entry){const cards=[...document.querySelectorAll('#scene-detail .analysis-card')];const card=entry.closest('.analysis-card');const fields=['characteristics','needs','pains'];kind='analysis';meta.sceneId=current.scenes[core.selectedScene()].id;meta.field=fields[cards.indexOf(card)];meta.rowIndex=[...card.querySelectorAll('.entry')].indexOf(entry)}
      else if(goal){kind='goal';meta.sceneId=current.scenes[core.selectedScene()].id;meta.rowIndex=[...goal.parentElement.querySelectorAll('.goal-card')].indexOf(goal)}
      if(!kind)return;
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();open(kind,meta);
    },true);

    document.getElementById('dim02-edit-form').addEventListener('submit',event=>{
      event.preventDefault();if(!editContext||pending)return;
      const fields={};document.querySelectorAll('#dim02-edit-form [data-field]').forEach(el=>fields[el.dataset.field]=el.value);
      if(Object.values(fields).some(value=>!String(value).trim())){document.getElementById('dim02-edit-error').textContent='字段内容不能为空';return}
      pending=true;document.getElementById('dim02-edit-save').disabled=true;
      window.parent.postMessage({type:'bg-dim02-save',...editContext,fields},parentOrigin);
    });
  }

  window.addEventListener('message',event=>{
    if(event.origin!==parentOrigin||!event.data?.type)return;
    if(event.data.type==='bg-dim02-section'){
      document.getElementById(event.data.id)?.scrollIntoView({behavior:'smooth',block:'start'});return;
    }
    if(event.data.type==='bg-dim02-save-error'){
      pending=false;const save=document.getElementById('dim02-edit-save');if(save)save.disabled=false;
      const error=document.getElementById('dim02-edit-error');if(error)error.textContent='保存失败，请重试。';return;
    }
    if(event.data.type!=='bg-dim02-state')return;
    current=clone(event.data.content||core.seed);
    workMode=!!event.data.workMode&&!event.data.preview&&view==='content';
    if(view==='text')renderText(current);else{core.apply(current);document.body.classList.toggle('dim02-work-mode',workMode)}
    if(pending){pending=false;const mask=document.getElementById('dim02-edit-mask');if(mask)mask.hidden=true;editContext=null;const save=document.getElementById('dim02-edit-save');if(save)save.disabled=false}
  });
  window.parent.postMessage({type:'bg-dim02-ready',seed:clone(core.seed)},parentOrigin);
})();
