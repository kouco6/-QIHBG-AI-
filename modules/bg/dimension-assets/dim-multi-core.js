(() => {
  'use strict';
  const args = new URLSearchParams(location.search);
  const dim = args.get('dim');
  const view = args.get('view') || 'content';
  const origin = location.origin;
  const wall = document.getElementById('wall');
  const scroller = document.getElementById('scroll');
  const mask = document.getElementById('edit-mask');
  const form = document.getElementById('edit-form');
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let seed, current, workMode = false, pending = false, editing = null;
  let moduleId = 'F2', performanceMode = 'table', selectedId = 'W01', returnId = null;
  const perfKeys = [['具体功能点','point'],['性能指标分类','category'],['功能性能','functional'],['设计指标','design'],['测试指标','test'],['竞品指标','competitor'],['体验性指标','experience']];
  const send = payload => parent.postMessage(payload, origin);
  const editAttr = (kind,index,extra='') => workMode ? `class="edit-target" tabindex="0" role="button" data-edit="${kind}" data-index="${index}" ${extra}` : '';
  const tagClass = value => value.includes('不支持') ? 'no' : value.includes('部分') || value.includes('选配') ? 'partial' : value.includes('待核实') || value.includes('未知') ? 'unknown' : 'yes';
  function heading(number,title){return `<header class="section-head"><small>${String(number).padStart(2,'0')} / 功能强</small><h2>${esc(title)}</h2></header>`}
  function render05(){
    const data=current;
    const module=data.inventory.find(x=>x.internal_id===moduleId)||data.inventory[0];
    const featureRows=module.features.map((feature,index)=>`<tr><td ${editAttr('feature-name',index,`data-module="${module.internal_id}"`)}>${esc(feature.feature_name)}</td>${data.scope.products.map(product=>{const p=feature.products[product.key];return `<td ${editAttr('product-cell',index,`data-module="${module.internal_id}" data-product="${product.key}"`)}><span class="tag ${tagClass(p.display_label)}">${esc(p.display_label)}</span><div class="cell-detail">${esc(p.detail)}</div><div class="hint">${esc(p.delivery_state)}</div></td>`}).join('')}</tr>`).join('');
    wall.className='page';
    wall.innerHTML=`<section class="section" id="page01">${heading(1,'产品功能架构')}<div class="section-body"><div class="arch-top">会议协作终端功能体系</div><div class="arch-grid">${data.architecture.pillars.map(p=>`<div class="arch-pillar"><h3>${esc(p.title)}</h3>${p.module_internal_ids.map(id=>{const m=data.inventory.find(x=>x.internal_id===id);return `<div class="arch-module">${esc(m.module_name)}</div>`}).join('')}</div>`).join('')}</div></div></section>
      <section class="section" id="page02">${heading(2,'完整功能清单')}<div class="section-body"><div class="module-tabs" role="tablist" aria-label="选择功能模块">${data.inventory.map(m=>`<button type="button" class="module-tab ${m.internal_id===module.internal_id?'active':''}" role="tab" aria-selected="${m.internal_id===module.internal_id}" data-module-tab="${m.internal_id}">${esc(m.module_name)} <span class="hint">${m.features.length} 项</span></button>`).join('')}</div><div class="table-frame"><div class="table-scroll" role="region" tabindex="0" aria-label="功能清单，可双向滚动"><table class="data-table"><colgroup><col style="width:23%"><col style="width:25.7%"><col style="width:25.7%"><col style="width:25.6%"></colgroup><thead><tr><th>功能项</th>${productLabels.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${featureRows}</tbody></table></div></div><p class="hint">支持状态以具体型号、许可、选配和固件条件为准；“待核实”保留原样。</p></div></section>
      <section class="section" id="page03">${heading(3,'核心功能与亮点')}<div class="section-body"><div class="highlight-grid">${data.highlight_features.map((item,index)=>`<article class="highlight" ${editAttr('highlight',index)}><div class="highlight-art" aria-hidden="true">${['◉','◎','◈','▣','◇'][index]}</div><div class="highlight-copy"><small>${esc(item.category)} · ${esc(item.product_scope)}</small><h3>${esc(item.title)}</h3><p>${esc(item.behavior)}</p><p class="value">${esc(item.value)}</p><p class="boundary">适用边界：${esc(item.boundary)}</p></div></article>`).join('')}</div></div></section>
      <section class="section" id="page04">${heading(4,'竞品功能对标')}<div class="section-body"><div class="compare-grid"><div class="compare-product"><small>上一代</small><h3>MeetingBoard 一代</h3><p class="hint">房间会议平板的基础功能体系</p></div><div class="compare-product pro"><small>新一代</small><h3>MeetingBoard Pro</h3><p class="hint">多摄和拾音扩展能力变化</p></div></div><div class="table-frame"><div class="table-scroll" role="region" tabindex="0" aria-label="代际功能对比，可双向滚动"><table class="data-table compare-table"><colgroup><col style="width:20%"><col style="width:26%"><col style="width:26%"><col style="width:28%"></colgroup><thead><tr><th>对比功能</th><th>MeetingBoard 一代</th><th>MeetingBoard Pro</th><th>变化与判断</th></tr></thead><tbody>${data.comparisons.map((row,index)=>`<tr ${editAttr('comparison',index)}><td>${esc(row.feature)}</td><td>${esc(row.legacy)}</td><td>${esc(row.pro)}</td><td>${esc(row.comparison)}</td></tr>`).join('')}</tbody></table></div></div><div class="compare-grid" style="margin-top:17px"><div class="compare-product" ${editAttr('competitor-note',0)}><h3>外部竞品核验边界</h3><p class="hint">${esc(data.scope.external_competitor)}</p></div><div class="compare-product" ${editAttr('comparison-caveat',0)}><h3>清单统计口径</h3><p class="hint">${esc(data.stats.caveat)}</p></div></div></div></section>`;
  }
  function render06(){
    const categories=[...new Set(current.rows.map(x=>x.category))];
    const selected=current.rows.find(x=>x.id===selectedId)||current.rows[0];
    wall.className='page';
    const top=`<div class="simple-heading"><div><h1>性能指标规划</h1><p>无线会议双形态系统 · 七字段完整记录</p></div><span class="simple-note">示例指标，非正式验收标准</span></div><div class="view-tabs"><button data-perf-mode="table" class="${performanceMode==='table'?'active':''}">标准表格</button><button data-perf-mode="detail" class="${performanceMode==='detail'?'active':''}">分类详情</button></div>`;
    if(performanceMode==='table'){
      const tableRows=categories.map(cat=>`<tr class="group-row"><td colspan="7" data-group="${esc(cat)}">${esc(cat)}</td></tr>${current.rows.filter(r=>r.category===cat).map(row=>`<tr class="perf-row ${row.id===returnId?'selected':''}" tabindex="0" role="button" data-record="${row.id}">${perfKeys.map(([,key])=>`<td>${esc(row[key])}</td>`).join('')}</tr>`).join('')}`).join('');
      wall.innerHTML=top+`<div class="view-tabs">${categories.map(cat=>`<button data-jump="${esc(cat)}">${esc(cat)}</button>`).join('')}</div><div class="table-frame"><div class="table-scroll" id="perf-table-scroll" role="region" tabindex="0" aria-label="性能指标表，可双向滚动"><table class="data-table" style="min-width:1770px"><colgroup><col style="width:170px"><col style="width:150px"><col style="width:240px"><col style="width:300px"><col style="width:350px"><col style="width:275px"><col style="width:285px"></colgroup><thead><tr>${current.fields.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></div>`;
      if(returnId){const row=wall.querySelector(`[data-record="${returnId}"]`);row?.scrollIntoView({block:'center'});row?.classList.add('flash');returnId=null}
    }else{
      const nav=categories.map(cat=>`<div><button type="button" class="${selected.category===cat?'active':''}" data-category="${esc(cat)}">${esc(cat)}</button>${current.rows.filter(r=>r.category===cat).map(row=>`<button type="button" class="${selected.id===row.id?'active':''}" data-detail="${row.id}">　${esc(row.point)} · ${esc(row.title)}</button>`).join('')}</div>`).join('');
      wall.innerHTML=top+`<div class="perf-layout"><nav class="perf-side" aria-label="性能分类与具体功能点">${nav}</nav><article class="perf-detail"><button class="back" data-back="${selected.id}">← 返回表格对应行</button><div class="category">${esc(selected.category)} / ${esc(selected.point)}</div><h2>${esc(selected.title)}</h2>${perfKeys.map(([label,key])=>`<div class="perf-field"><strong>${esc(label)}</strong><p>${esc(selected[key])}</p></div>`).join('')}${workMode?`<button class="back" data-edit="perf-row" data-index="${current.rows.indexOf(selected)}">编辑此记录</button>`:''}</article></div>`;
    }
    send({type:'bg-showcase-active',dim,id:performanceMode});
  }
  function render07(){
    wall.className='page';
    wall.innerHTML=`<div class="simple-heading"><div><h1>AI功能规划表</h1><p>AI 智慧力 · 六字段完整内容</p></div><span class="simple-note">18 项演示数据 · 非公司产品事实</span></div><section class="table-frame" aria-label="AI功能规划表"><div class="table-scroll" style="max-height:min(78vh,900px);min-height:400px" role="region" tabindex="0" aria-label="AI功能规划表，可横向及纵向滚动"><table class="data-table" style="min-width:1680px"><colgroup><col style="width:180px"><col style="width:210px"><col style="width:310px"><col style="width:285px"><col style="width:255px"><col style="width:440px"></colgroup><thead><tr>${current.fields.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${current.rows.map((row,index)=>`<tr ${editAttr('ai-row',index)}>${current.fields.map(label=>`<td>${esc(row[label])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  }
  function renderText(){
    wall.className='text-page';
    if(dim==='05'){
      wall.innerHTML=`<h1>功能强｜亿联 Yealink</h1><h2>01 产品功能架构</h2>${current.architecture.pillars.map(p=>`<h3>${esc(p.title)}</h3><p>${p.module_internal_ids.map(id=>esc(current.inventory.find(m=>m.internal_id===id).module_name)).join('、')}</p>`).join('')}<h2>02 完整功能清单</h2>${current.inventory.map(m=>`<h3>${esc(m.module_name)}</h3>${m.features.map(f=>`<div class="item"><b>${esc(f.feature_name)}</b>${current.scope.products.map(product=>{const p=f.products[product.key];return `<p>${esc(product.label)}：${esc(p.display_label)}；${esc(p.detail)}；${esc(p.delivery_state)}</p>`}).join('')}</div>`).join('')}`).join('')}<h2>03 核心功能与亮点</h2>${current.highlight_features.map(x=>`<div class="item"><h3>${esc(x.title)}</h3><p>适用：${esc(x.product_scope)}</p><p>功能：${esc(x.behavior)}</p><p>价值：${esc(x.value)}</p><p>边界：${esc(x.boundary)}</p></div>`).join('')}<h2>04 竞品功能对标</h2>${current.comparisons.map(x=>`<div class="item"><h3>${esc(x.feature)}</h3><p>一代：${esc(x.legacy)}</p><p>Pro：${esc(x.pro)}</p><p>变化：${esc(x.comparison)}</p></div>`).join('')}<p>外部竞品核验边界：${esc(current.scope.external_competitor)}</p><p>清单统计口径：${esc(current.stats.caveat)}</p>`;
    }else if(dim==='06'){
      wall.innerHTML=`<h1>性能稳｜性能指标</h1>${current.rows.map(r=>`<div class="item"><h2>${esc(r.category)} · ${esc(r.title)}</h2>${perfKeys.map(([label,key])=>`<p><b>${esc(label)}：</b>${esc(r[key])}</p>`).join('')}</div>`).join('')}`;
    }else{
      wall.innerHTML=`<h1>AI 智慧力｜AI功能规划表</h1>${current.rows.map(r=>`<div class="item"><h2>${esc(r['AI功能名称'])}</h2>${current.fields.slice(1).map(label=>`<p><b>${esc(label)}：</b>${esc(r[label])}</p>`).join('')}</div>`).join('')}`;
    }
  }
  function render(){if(!current)return;const y=scroller.scrollTop;document.body.classList.toggle('work-mode',workMode&&view==='content');if(view==='text')renderText();else if(dim==='05')render05();else if(dim==='06')render06();else render07();scroller.scrollTop=y}
  function editSpec(el){
    const index=Number(el.dataset.index),kind=el.dataset.edit;
    if(dim==='05'){
      if(kind==='feature-name'){
        const m=current.inventory.find(x=>x.internal_id===el.dataset.module);return {title:'编辑功能项',fields:[['功能项名称',['inventory',current.inventory.indexOf(m),'features',index,'feature_name']]]};
      }
      if(kind==='product-cell'){
        const m=current.inventory.find(x=>x.internal_id===el.dataset.module),base=['inventory',current.inventory.indexOf(m),'features',index,'products',el.dataset.product];
        return {title:'编辑产品功能状态与条件',fields:[['功能状态',base.concat('display_label')],['支持能力',base.concat('ability_state')],['交付状态',base.concat('delivery_state')],['功能条件与说明',base.concat('detail')],['研究状态',base.concat('source_state')],['原始研究表述',base.concat('raw_research_statement')]]};
      }
      if(kind==='highlight')return {title:'编辑核心功能亮点',fields:[['标题',['highlight_features',index,'title']],['类别',['highlight_features',index,'category']],['适用产品',['highlight_features',index,'product_scope']],['功能行为',['highlight_features',index,'behavior']],['用户价值',['highlight_features',index,'value']],['适用边界',['highlight_features',index,'boundary']]]};
      if(kind==='comparison')return {title:'编辑代际功能对比',fields:[['对比功能',['comparisons',index,'feature']],['一代',['comparisons',index,'legacy']],['Pro',['comparisons',index,'pro']],['变化与判断',['comparisons',index,'comparison']]]};
      if(kind==='competitor-note')return {title:'编辑外部竞品核验边界',fields:[['核验边界',['scope','external_competitor']]]};
      if(kind==='comparison-caveat')return {title:'编辑清单统计口径',fields:[['统计口径',['stats','caveat']]]};
    }
    if(dim==='06'&&kind==='perf-row')return {title:'编辑性能指标记录',fields:[['功能名称',['rows',index,'title']],...perfKeys.map(([label,key])=>[label,['rows',index,key]])]};
    if(dim==='07'&&kind==='ai-row')return {title:'编辑 AI 功能记录',fields:current.fields.map(label=>[label,['rows',index,label]])};
    return null;
  }
  function atPath(root,path){return path.reduce((value,key)=>value?.[key],root)}
  function openEdit(el){if(!workMode||view!=='content'||pending)return;editing=editSpec(el);if(!editing)return;document.getElementById('edit-title').textContent=editing.title;form.innerHTML=editing.fields.map(([label,path],index)=>`<label class="edit-field">${esc(label)}<textarea required maxlength="5000" name="field${index}">${esc(atPath(current,path))}</textarea></label>`).join('');document.getElementById('edit-error').textContent='';mask.hidden=false;form.querySelector('textarea')?.focus()}
  function closeEdit(){mask.hidden=true;editing=null;pending=false;document.getElementById('edit-save').disabled=false}
  document.addEventListener('click',event=>{
    if(event.target===mask||event.target.closest('#edit-close,#edit-cancel')){closeEdit();return}
    const tab=event.target.closest('[data-module-tab]');if(tab){moduleId=tab.dataset.moduleTab;const y=scroller.scrollTop;render();scroller.scrollTop=y;return}
    const mode=event.target.closest('[data-perf-mode]');if(mode){performanceMode=mode.dataset.perfMode;render();return}
    const jump=event.target.closest('[data-jump]');if(jump){const group=[...wall.querySelectorAll('[data-group]')].find(x=>x.dataset.group===jump.dataset.jump);group?.scrollIntoView({block:'start'});return}
    const category=event.target.closest('[data-category]');if(category){const first=current.rows.find(x=>x.category===category.dataset.category);if(first){selectedId=first.id;render()}return}
    const detail=event.target.closest('[data-detail]');if(detail){selectedId=detail.dataset.detail;render();return}
    const back=event.target.closest('[data-back]');if(back){returnId=back.dataset.back;performanceMode='table';render();return}
    const record=event.target.closest('[data-record]');if(record){selectedId=record.dataset.record;if(workMode)openEdit({dataset:{edit:'perf-row',index:current.rows.findIndex(x=>x.id===selectedId)}});else{performanceMode='detail';render()}return}
    const target=event.target.closest('[data-edit]');if(target)openEdit(target);
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!mask.hidden)closeEdit();if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-record],[data-edit]')){event.preventDefault();event.target.click()}});
  form.addEventListener('submit',event=>{event.preventDefault();if(!editing||pending)return;const patches=editing.fields.map(([,path],index)=>({path,value:form.elements[`field${index}`].value.trim()}));if(patches.some(x=>!x.value)){document.getElementById('edit-error').textContent='所有字段都需要填写。';return}pending=true;document.getElementById('edit-save').disabled=true;send({type:'bg-showcase-save',dim,patches,label:editing.title})});
  window.addEventListener('message',event=>{
    if(event.origin!==origin||!event.data||event.data.dim!==dim)return;
    const msg=event.data;
    if(msg.type==='bg-showcase-state'){current=clone(msg.content||seed);workMode=!!msg.workMode;if(msg.saved)closeEdit();render();return}
    if(msg.type==='bg-showcase-save-error'){pending=false;document.getElementById('edit-save').disabled=false;document.getElementById('edit-error').textContent=msg.error||'保存失败，请重试。';return}
    if(msg.type==='bg-showcase-section'){
      if(dim==='05')document.getElementById(msg.id)?.scrollIntoView({block:'start'});
      if(dim==='06'){performanceMode=msg.id==='detail'?'detail':'table';render()}
    }
  });
  if(dim==='05')scroller.addEventListener('scroll',()=>{const sections=[...document.querySelectorAll('.section')];if(!sections.length)return;const active=[...sections].reverse().find(x=>x.getBoundingClientRect().top<130)||sections[0];send({type:'bg-showcase-active',dim,id:active.id})},{passive:true});
  fetch(`/dimension-assets/dim${dim}-seed.json`).then(r=>{if(!r.ok)throw Error('样例文件无法加载');return r.json()}).then(json=>{seed=json;current=clone(seed);if(dim==='05')moduleId='F2';if(dim==='06')selectedId=seed.rows[0].id;render();send({type:'bg-showcase-ready',dim,seed})}).catch(error=>{wall.innerHTML=`<div class="page"><p class="hint">${esc(error.message)}</p></div>`});
})();
