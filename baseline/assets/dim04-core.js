(() => {
  'use strict';
  const view = new URLSearchParams(location.search).get('view') || 'content';
  const origin = location.origin;
  const scroller = document.getElementById('documentScroller');
  const wall = document.getElementById('tech-wall');
  const mask = document.getElementById('dim04-edit-mask');
  const form = document.getElementById('edit-form');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const evidenceLabels = ['来源类型','发布方／对象','版本／条款','原文出处','核验状态'];
  const icons = ['原','熟','先','壁','价','对','策'];
  let seed = null, current = null, workMode = false, pending = false, editing = null, activeTopic = 'aes67';

  const editAttrs = (kind,topicId,meta={}) => `data-edit-kind="${kind}" data-topic="${topicId}" ${Object.entries(meta).map(([key,value])=>`data-${key}="${esc(value)}"`).join(' ')} ${workMode?'tabindex="0" role="button"':''}`;
  const heading = (number,text) => `<h3 class="section-heading"><span aria-hidden="true" class="heading-icon">${icons[number]}</span><span>${esc(text)}</span></h3>`;
  function renderTopic(topic) {
    const sections = topic.sections.map((section,sectionIndex) => `<section class="content-section">${heading(sectionIndex,section.heading)}${section.paragraphs.map((text,paragraphIndex)=>`<p class="body-copy" ${editAttrs('paragraph',topic.id,{section:sectionIndex,paragraph:paragraphIndex})}>${esc(text)}</p>`).join('')}</section>`).join('');
    const rows = topic.benchmark.map((row,rowIndex)=>`<tr ${editAttrs('benchmark',topic.id,{row:rowIndex})}><th scope="row">${esc(row.metric)}</th><td>${esc(row.company)}</td><td>${esc(row.industry)}</td><td>${esc(row.difference)} <button type="button" class="source-ref" data-source="${esc(row.evidenceId)}" aria-label="查看证据 ${esc(row.evidenceId.split('-').at(-1).toUpperCase())}">[E-${String(rowIndex+1).padStart(2,'0')}]</button></td></tr>`).join('');
    const evidence = topic.evidence.map((item,evidenceIndex)=>`<div class="evidence-entry" id="source-${esc(item.id)}" data-evidence-id="${esc(item.id)}" ${editAttrs('evidence',topic.id,{evidence:evidenceIndex})}><div class="evidence-head"><strong class="evidence-id">E-${String(evidenceIndex+1).padStart(2,'0')}</strong><strong>${esc(item.title)}</strong></div><dl class="evidence-fields">${evidenceLabels.map(label=>`<dt>${label}</dt><dd>${esc(item.fields[label])}</dd>`).join('')}</dl></div>`).join('');
    const recs = topic.recommendations.map((item,recommendationIndex)=>`<div class="recommendation" ${editAttrs('recommendation',topic.id,{recommendation:recommendationIndex})}><span class="recommendation-number">${String(recommendationIndex+1).padStart(2,'0')}</span><div><h4>${esc(item.title)}</h4><p class="body-copy">${esc(item.body)}</p><p class="confirm-note">${esc(item.confirm)}</p></div></div>`).join('');
    return `<article class="tech-article" id="tech-${esc(topic.id)}" data-tech="${esc(topic.id)}"><header class="tech-header" ${editAttrs('topic',topic.id)}><div class="tech-kicker">${esc(topic.kicker)}</div><h2>${esc(topic.title)}</h2><p class="tech-subtitle">${esc(topic.subtitle)}</p><div class="chapter-line"></div></header>${sections}<section class="content-section">${heading(5,'六、我司与行业技术对标')}<div class="table-scroll" role="region" tabindex="0" aria-label="技术对标表，可水平滚动"><table class="compare-table"><colgroup><col style="width:166px"><col style="width:270px"><col style="width:270px"><col style="width:255px"></colgroup><thead><tr><th scope="col">对标指标</th><th scope="col">我司技术情况</th><th scope="col">行业及竞品情况</th><th scope="col">技术差异及依据</th></tr></thead><tbody>${rows}</tbody></table></div><div class="difference-panel" ${editAttrs('difference',topic.id)}><strong>技术差异分析</strong><p class="body-copy">${esc(topic.difference)}</p></div><div class="evidence-panel" data-evidence-group="${esc(topic.id)}"><button type="button" class="evidence-toggle" aria-expanded="false" aria-controls="evidence-list-${esc(topic.id)}"><span class="ev-symbol">▤</span><span class="ev-toggle-label"><strong>证据来源清单</strong><small>${topic.evidence.length} 条来源索引</small></span><span class="chevron">⌄</span></button><div class="evidence-list" id="evidence-list-${esc(topic.id)}" hidden>${evidence}</div></div></section><section class="content-section">${heading(6,'七、技术企划建议')}<div class="recommendations">${recs}</div></section></article>`;
  }
  function renderContent() {
    if (!current) return;
    const scrollTop=scroller.scrollTop;
    const openGroups=[...wall.querySelectorAll('.evidence-panel.open')].map(panel=>panel.dataset.evidenceGroup);
    const highlighted=wall.querySelector('.evidence-entry.highlight')?.dataset.evidenceId;
    document.body.classList.toggle('work-mode',workMode);
    wall.className = 'document-inner';
    wall.innerHTML = current.topics.map(renderTopic).join('');
    openGroups.forEach(id=>{const panel=[...wall.querySelectorAll('.evidence-panel')].find(item=>item.dataset.evidenceGroup===id);if(panel)showEvidence(panel,true)});
    if(highlighted)wall.querySelectorAll('.evidence-entry').forEach(item=>item.classList.toggle('highlight',item.dataset.evidenceId===highlighted));
    scroller.scrollTop=scrollTop;
  }
  function renderText() {
    if (!current) return;
    document.body.classList.remove('work-mode');
    wall.className = 'text-page';
    wall.innerHTML = `<article><h1>技术先进</h1>${current.topics.map((topic,index)=>`<section><h2>${String(index+1).padStart(2,'0')} ${esc(topic.title)}</h2><p>${esc(topic.subtitle)}</p>${topic.sections.map(section=>`<h3>${esc(section.heading)}</h3>${section.paragraphs.map(text=>`<p>${esc(text)}</p>`).join('')}`).join('')}<h3>六、我司与行业技术对标</h3>${topic.benchmark.map(row=>`<div class="text-row"><h4>${esc(row.metric)}</h4><p>我司技术情况：${esc(row.company)}</p><p>行业及竞品情况：${esc(row.industry)}</p><p>技术差异及依据：${esc(row.difference)} [E-${String(topic.evidence.findIndex(item=>item.id===row.evidenceId)+1).padStart(2,'0')}]</p></div>`).join('')}<h4>技术差异分析</h4><p>${esc(topic.difference)}</p><h4>证据来源清单</h4>${topic.evidence.map((item,n)=>`<div class="text-evidence"><b>E-${String(n+1).padStart(2,'0')} ${esc(item.title)}</b>${evidenceLabels.map(label=>`<p>${label}：${esc(item.fields[label])}</p>`).join('')}</div>`).join('')}<h3>七、技术企划建议</h3>${topic.recommendations.map((item,n)=>`<h4>${String(n+1).padStart(2,'0')} ${esc(item.title)}</h4><p>${esc(item.body)}</p><p>${esc(item.confirm)}</p>`).join('')}</section>`).join('')}</article>`;
  }
  function render() { if (view==='text') renderText(); else renderContent(); }
  function scrollToTopic(id) {
    const target=document.getElementById('tech-'+id);if(!target)return;
    const top=scroller.scrollTop+target.getBoundingClientRect().top-scroller.getBoundingClientRect().top-10;
    scroller.scrollTo({top,behavior:reduced?'instant':'smooth'});
  }
  scroller.addEventListener('scroll',()=>{
    if(view!=='content')return;
    const articles=[...wall.querySelectorAll('.tech-article')];
    const threshold=scroller.getBoundingClientRect().top+Math.min(145,scroller.clientHeight*.26);
    const active=articles.filter(article=>article.getBoundingClientRect().top<=threshold).at(-1)?.dataset.tech||articles[0]?.dataset.tech;
    if(active&&active!==activeTopic){activeTopic=active;window.parent.postMessage({type:'bg-dim04-active',id:active},origin)}
  },{passive:true});
  function showEvidence(panel,on) {
    panel.classList.toggle('open',on);
    panel.querySelector('.evidence-toggle').setAttribute('aria-expanded',String(on));
    panel.querySelector('.evidence-list').hidden=!on;
  }
  function focusEvidence(id) {
    const entry=[...wall.querySelectorAll('.evidence-entry')].find(el=>el.dataset.evidenceId===id);
    if(!entry)return;
    showEvidence(entry.closest('.evidence-panel'),true);
    wall.querySelectorAll('.evidence-entry.highlight').forEach(el=>el.classList.remove('highlight'));
    entry.classList.add('highlight');
    requestAnimationFrame(()=>{const top=scroller.scrollTop+entry.getBoundingClientRect().top-scroller.getBoundingClientRect().top-35;scroller.scrollTo({top,behavior:reduced?'instant':'smooth'})});
  }
  function closeEdit(){if(pending)return;mask.hidden=true;editing=null}
  const input=(key,label,value,long=false)=>`<label class="edit-field"><span>${label}</span>${long?`<textarea data-field="${key}" maxlength="2000">${esc(value)}</textarea>`:`<input data-field="${key}" value="${esc(value)}" maxlength="2000">`}</label>`;
  function openEdit(kind,topicId,meta={}){
    if(!workMode||pending||view!=='content')return;
    const topic=current.topics.find(item=>item.id===topicId);if(!topic)return;
    let title='',fields='';
    if(kind==='topic'){title='编辑技术专题';fields=input('kicker','专题分类',topic.kicker)+input('title','技术名称',topic.title)+input('subtitle','技术定位',topic.subtitle,true)}
    if(kind==='paragraph'){const value=topic.sections[meta.sectionIndex]?.paragraphs[meta.paragraphIndex];if(value){title='编辑'+topic.sections[meta.sectionIndex].heading;fields=input('text','正文内容',value,true)}}
    if(kind==='benchmark'){const row=topic.benchmark[meta.rowIndex];if(row){title='编辑技术对标';fields=input('metric','对标指标',row.metric)+input('company','我司技术情况',row.company,true)+input('industry','行业及竞品情况',row.industry,true)+input('difference','技术差异及依据',row.difference,true)}}
    if(kind==='difference'){title='编辑技术差异分析';fields=input('text','差异分析',topic.difference,true)}
    if(kind==='evidence'){const item=topic.evidence[meta.evidenceIndex];if(item){title='编辑证据来源';fields=input('title','来源名称',item.title)+evidenceLabels.map((label,index)=>input('field'+index,label,item.fields[label],true)).join('')}}
    if(kind==='recommendation'){const item=topic.recommendations[meta.recommendationIndex];if(item){title='编辑技术企划建议';fields=input('title','建议标题',item.title)+input('body','建议内容',item.body,true)+input('confirm','内部确认项',item.confirm,true)}}
    if(!fields)return;
    editing={kind,topicId,...meta};
    document.getElementById('edit-title').textContent=title;
    form.innerHTML=fields+'<p class="edit-note">保存后写入当前项目，并形成可预览、可恢复的内容版本；章节、对标列和证据编号保持不变。</p>';
    document.getElementById('edit-error').textContent='';mask.hidden=false;form.querySelector('[data-field]')?.focus();
  }
  wall.addEventListener('click',event=>{
    const source=event.target.closest('.source-ref');if(source){event.stopPropagation();focusEvidence(source.dataset.source);return}
    const toggle=event.target.closest('.evidence-toggle');if(toggle){const panel=toggle.closest('.evidence-panel');showEvidence(panel,!panel.classList.contains('open'));return}
    const target=event.target.closest('[data-edit-kind]');if(!target||!workMode)return;
    event.preventDefault();
    openEdit(target.dataset.editKind,target.dataset.topic,{sectionIndex:Number(target.dataset.section),paragraphIndex:Number(target.dataset.paragraph),rowIndex:Number(target.dataset.row),evidenceIndex:Number(target.dataset.evidence),recommendationIndex:Number(target.dataset.recommendation)});
  });
  wall.addEventListener('keydown',event=>{
    if(!['Enter',' '].includes(event.key)||!workMode)return;
    const target=event.target.closest('[data-edit-kind]');if(!target||event.target!==target)return;
    event.preventDefault();openEdit(target.dataset.editKind,target.dataset.topic,{sectionIndex:Number(target.dataset.section),paragraphIndex:Number(target.dataset.paragraph),rowIndex:Number(target.dataset.row),evidenceIndex:Number(target.dataset.evidence),recommendationIndex:Number(target.dataset.recommendation)});
  });
  mask.addEventListener('click',event=>{if(event.target===mask)closeEdit()});
  document.getElementById('edit-close').onclick=closeEdit;
  document.getElementById('edit-cancel').onclick=closeEdit;
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!mask.hidden)closeEdit()});
  form.addEventListener('submit',event=>{
    event.preventDefault();if(!editing||pending)return;
    const fields=Object.fromEntries([...form.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value.trim()]));
    if(Object.values(fields).some(value=>!value)){document.getElementById('edit-error').textContent='字段内容不能为空；未取得的资料请明确写“待核实”。';return}
    pending=true;document.getElementById('edit-save').disabled=true;
    window.parent.postMessage({type:'bg-dim04-save',...editing,fields},origin);
  });
  window.addEventListener('message',event=>{
    if(event.origin!==origin||!event.data?.type)return;
    if(event.data.type==='bg-dim04-section'){scrollToTopic(event.data.id);return}
    if(event.data.type==='bg-dim04-save-error'){pending=false;document.getElementById('edit-save').disabled=false;document.getElementById('edit-error').textContent=event.data.error||'保存失败，请重试。';return}
    if(event.data.type!=='bg-dim04-state')return;
    current=clone(event.data.content||seed);
    workMode=!!event.data.workMode&&!event.data.preview&&view==='content';
    render();
    if(pending){pending=false;mask.hidden=true;editing=null;document.getElementById('edit-save').disabled=false}
  });
  fetch('/dimension-assets/dim04-seed.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('seed');return response.json()}).then(source=>{
    seed=clone(source);current=clone(seed);render();window.parent.postMessage({type:'bg-dim04-ready',seed:clone(seed)},origin);
  }).catch(()=>{wall.textContent='技术专题内容加载失败，请刷新页面。'});
})();
