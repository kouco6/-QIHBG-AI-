(() => {
  'use strict';
  const params=new URLSearchParams(location.search),dim=params.get('dim'),view=params.get('view')||'content',origin=location.origin;
  const scroll=document.getElementById('scroll'),wall=document.getElementById('wall'),mask=document.getElementById('edit-mask'),form=document.getElementById('edit-form');
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone=value=>JSON.parse(JSON.stringify(value));
  const send=message=>parent.postMessage(message,origin);
  let seed=null,current=null,workMode=false,pending=false,editing=null,search11='',selected11=null,nav12=0,navForced=null,autoNextFrom=null,imageDraft='sample';
  const symbols={yes:'√',no:'×',pending:'—'},statusNames={yes:'规划纳入',no:'不纳入',pending:'未选择'};
  const image=p=>p.imageUrl==='sample'?p.svg:`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}外观图">`;
  const fieldPath=(product,field)=>['products',product,'fields',field,'value'];
  function render11(){
    const editable=workMode&&view==='content';
    const products=current.products.filter(p=>[p.name,p.model,p.kind].some(value=>value.toLowerCase().includes(search11)));
    const selected=current.products.find(p=>p.id===selected11);
    wall.className='page dim11';
    wall.innerHTML=`<div class="titlebar"><div><h1>竞品外观视觉对比</h1><p>以产品外观为中心，对照不同设计方案的造型语言与整体气质。</p></div><span class="badge">示意外观 · 非真实竞品事实</span></div><section class="panel"><div class="panelbar"><div><h2>外观设计画廊　${products.length} / ${current.products.length}</h2><p>统一比例展示 · 单图独立对比 · ${editable?'点击图片编辑内容':'点击图片查看设计信息'}</p></div><input id="gallery-search" class="search" type="search" aria-label="搜索竞品名称或型号" placeholder="搜索竞品名称 / 型号" value="${esc(search11)}"></div><div class="gallery-stage"><div class="gallery">${products.length?products.map(p=>{const i=current.products.indexOf(p);return `<article class="product ${selected11===p.id?'selected':''}"><button type="button" class="visual-button ${editable?'editable':''}" ${editable?`data-edit-product="${i}"`:`data-open-design="${esc(p.id)}"`} aria-label="${editable?'编辑':'查看'}${esc(p.name)}的设计信息"><div class="visual"><span class="ordinal">${esc(p.index)} / 06</span>${image(p)}</div></button><div class="product-copy"><div><h3>${esc(p.name)}</h3><p>${esc(p.model)}</p></div><span>›</span></div></article>`}).join(''):'<div class="empty">没有匹配的竞品</div>'}</div><div class="detail-shade ${selected&&!editable?'on':''}" data-close-design></div><aside class="design-drawer ${selected&&!editable?'open':''}" aria-label="竞品外观设计详情" aria-hidden="${!(selected&&!editable)}"><div class="design-head"><div class="design-head-top"><span>DESIGN PROFILE / 设计详情</span><button type="button" class="close-btn" data-close-design aria-label="关闭设计详情">✕</button></div>${selected?`<div class="design-identity"><div class="mini-picture">${image(selected)}</div><div><h3>${esc(selected.name)}</h3><p>${esc(selected.model)}</p></div></div>`:''}</div><div class="design-body"><p>外观设计信息</p><div class="detail-grid">${selected?selected.fields.map((f,i)=>`<section class="detail"><small>0${i+1} / 04</small><h4>${esc(f.label)}</h4><p>${esc(f.value)}</p></section>`).join(''):''}</div><p style="margin-top:15px">图片用于直观观察外观差异；描述与图片信息一一对应。</p></div></aside></div></section><p class="hint" style="text-align:center;margin-top:16px">竞品名称、外观绘图和设计描述均为示例内容，不代表实际品牌、型号或研究结论。</p>`;
  }
  function render12(){document.querySelector('.metric-reading')?.remove();
    const editable=workMode&&view==='content';
    const pendingCount=current.values.filter((value,index)=>index===15?!value.trim():!['yes','no'].includes(value)).length;
    const groupStart=[0,11,14,16];
    const headers=current.fields.map((f,i)=>`<th class="field-${f.category}" scope="col">${esc(f.label).replace('/','<wbr>/')}</th>`).join('');
    const cells=current.fields.map((field,index)=>{
      const value=current.values[index];
      if(field.type==='state'){
        const state=value==='na'?'pending':value;
        return `<td data-cell="${index}"><button class="value-btn state ${state} ${editable?'editable':''}" type="button" data-metric="${index}" aria-label="${esc(field.label)}，${statusNames[state]}">${symbols[state]}</button></td>`;
      }
      return `<td data-cell="${index}"><button class="value-btn text metric-text ${editable?'editable':''}" type="button" data-metric="${index}" aria-label="${esc(field.label)}${editable?'，点击编辑':''}">${esc(value||(editable?'点击填写':'—'))}</button><button type="button" class="metric-fulltext" data-read-metric="${index}" aria-label="查看${esc(field.label)}全文" aria-expanded="false" hidden>↗</button></td>`;
    }).join('');
    wall.className='page dim12';
    wall.innerHTML=`<section class="panel matrix-panel"><div class="matrix-top"><div><h1>运维数据规划矩阵</h1><p>单个企划项目 · ${current.fields.length} 项运维指标</p></div>${pendingCount?`<button class="pending-jump" type="button" data-pending-jump>尚有 ${pendingCount} 项待选择 →</button>`:''}</div>${pendingCount?'':`<div class="complete" role="status"><b>✓ 运维数据规划选择已全部完成</b><div style="font-size:11px;margin-top:4px">所有需人工选择的指标均已设定规划状态；不代表产品功能或能力验收。</div></div>`}<div class="category-nav"><strong>维度快捷定位</strong><div class="category-nav-inner">${current.groups.map((group,i)=>`<button class="${nav12===i?'active':''}" type="button" data-group-nav="${i}" aria-current="${nav12===i}"><i></i>${esc(group.name)}</button>`).join('')}</div></div><div class="table-meta"><span>当前浏览：<strong id="current-group">${esc(current.groups[nav12].name)}</strong></span><span>横向滚动查看完整指标 ↔</span></div><div class="matrix-scroll" id="matrix-scroll" role="region" tabindex="0" aria-label="可横向滚动的18项指标完整规划矩阵"><table class="matrix"><colgroup><col style="width:168px"><col span="18" style="width:132px"></colgroup><thead><tr class="dimension-row"><th class="fixed" scope="col">软件</th>${current.groups.map(group=>`<th colspan="${group.count}"><div class="dim-name">${esc(group.name)}</div><div class="dim-desc">（${esc(group.description)}）</div></th>`).join('')}</tr><tr class="category-row"><th class="fixed" rowspan="2" scope="col">产品<br>名称</th>${current.categories.map((cat,i)=>`<th class="cat-${i}" colspan="${cat.count}">${esc(cat.name)}</th>`).join('')}</tr><tr class="field-row">${headers}</tr></thead><tbody><tr class="data-row"><th scope="row" class="fixed">${editable?`<button type="button" class="product-name-btn editable" data-edit-product-name>${esc(current.product)}</button>`:esc(current.product)}</th>${cells}</tr></tbody></table></div><div class="legend"><strong>状态说明</strong><span><b class="value-btn yes">√</b> 本次企划规划纳入</span><span><b class="value-btn no">×</b> 本次企划不纳入</span><span><b class="value-btn pending">—</b> 尚未人工选择</span></div><div class="subnote">状态记录本次企划的人工规划决定，不等于产品已具备或缺少相应能力。${editable?'点击状态格或文字格进行编辑。':''}</div></section>`;
    const text=wall.querySelector('.metric-text');
    if(text&&text.scrollHeight>text.clientHeight+1){
      text.title=current.values[15];
      text.nextElementSibling.hidden=false;
    }
    const matrix=wall.querySelector('#matrix-scroll');matrix.scrollLeft=render12.lastX||0;matrix.addEventListener('scroll',()=>{if(navForced!==null)return;const x=matrix.scrollLeft+Math.max(160,matrix.clientWidth*.54);let g=0;groupStart.forEach((start,i)=>{if(x>=168+start*132)g=i});if(matrix.scrollLeft>=matrix.scrollWidth-matrix.clientWidth-3)g=3;setActiveGroup(g);render12.lastX=matrix.scrollLeft},{passive:true});
  }
  function renderText(){
    wall.className='text-page';
    if(dim==='11')wall.innerHTML=`<h1>外观高档大气｜竞品外观视觉对比</h1><p>六款虚构竞品示意，用于外观画廊与设计语言对照。</p>${current.products.map((p,i)=>`<div class="text-item"><h2>${String(i+1).padStart(2,'0')} ${esc(p.name)}</h2><p>型号：${esc(p.model)}　·　产品类别：${esc(p.kind)}</p>${p.fields.map(f=>`<p><b>${esc(f.label)}：</b>${esc(f.value)}</p>`).join('')}</div>`).join('')}<p>图片为示意内容，正式项目需核实品牌、型号和图像权属。</p>`;
    else wall.innerHTML=`<h1>体验感好｜运维数据规划矩阵</h1><p>产品：${esc(current.product)}　·　18 项指标</p>${current.groups.map((group,g)=>`<h2>${esc(group.name)}</h2><p>${esc(group.description)}</p>${current.categories.filter((_,c)=>current.fields.some(f=>f.group===g&&f.category===c)).map(cat=>{const c=current.categories.indexOf(cat);return `<h3>${esc(cat.name)}</h3>${current.fields.map((f,i)=>f.group===g&&f.category===c?`<p><b>${esc(f.label)}：</b>${esc(f.type==='state'?statusNames[current.values[i]]:current.values[i])}</p>`:'').join('')}`}).join('')}`).join('')}<p>状态记录人工规划决定，不代表产品已具备相应能力。</p>`;
  }
  function render(){if(!current)return;const y=scroll.scrollTop;document.body.classList.toggle('work-mode',workMode&&view==='content');if(view==='text')renderText();else if(dim==='11')render11();else render12();scroll.scrollTop=y}
  function setActiveGroup(index){nav12=index;wall.querySelectorAll('[data-group-nav]').forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-current',String(i===index))});const currentName=wall.querySelector('#current-group');if(currentName)currentName.textContent=current.groups[index].name}
  function reveal(index){const matrix=wall.querySelector('#matrix-scroll'),cell=wall.querySelector(`[data-cell="${index}"]`);if(!matrix||!cell)return;const desired=Math.min(matrix.scrollWidth-matrix.clientWidth,Math.max(0,index*132-Math.min(90,(matrix.clientWidth-168)*.2)));matrix.scrollTo({left:desired,behavior:'smooth'});cell.classList.add('located');setTimeout(()=>cell.classList.remove('located'),1800);setActiveGroup(current.fields[index].group)}
  function closeEdit(){
    const oldEdit=editing;editing=null;
    if(oldEdit?.type==='text12'){oldEdit.input.remove();oldEdit.button.hidden=false;oldEdit.readButton.hidden=oldEdit.readWasHidden}
    mask.hidden=true;document.querySelector('.status-popover')?.remove();pending=false;autoNextFrom=null;document.getElementById('edit-save').disabled=false}
  function openProduct(index){if(!workMode||view!=='content'||pending)return;const p=current.products[index];if(!p)return;editing={type:'product11',index};imageDraft=p.imageUrl;document.getElementById('edit-title').textContent='编辑竞品外观信息';form.innerHTML=`<label class="edit-field">竞品名称<input name="name" required maxlength="5000" value="${esc(p.name)}"></label><label class="edit-field">外观样例型号<input name="model" required maxlength="5000" value="${esc(p.model)}"></label><label class="edit-field">产品类别<input name="kind" required maxlength="5000" value="${esc(p.kind)}"></label><div class="image-tools"><b>外观图片</b><p id="image-feedback">${p.imageUrl==='sample'?'当前使用示例示意图':'当前使用自定义图片'}。可上传本机图片或填写图片链接；图片在画廊内等比例完整显示。</p><input id="image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传本机外观图片"><label class="edit-field">图片链接（可选）<input id="image-url" type="url" placeholder="https://..." value="${p.imageUrl.startsWith('http')?esc(p.imageUrl):''}"></label><button type="button" data-reset-image>恢复示例示意图</button></div>${p.fields.map((f,i)=>`<label class="edit-field">${esc(f.label)}<textarea name="detail${i}" required maxlength="5000">${esc(f.value)}</textarea></label>`).join('')}`;document.getElementById('edit-save').hidden=false;document.getElementById('edit-error').textContent='';mask.hidden=false;form.querySelector('input')?.focus()}
  function placeMetricPopover(popover,anchor){
    document.body.appendChild(popover);
    const rect=anchor.getBoundingClientRect(),box=popover.getBoundingClientRect();
    popover.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-box.width-8))+'px';
    const below=rect.bottom+6;
    popover.style.top=(below+box.height<window.innerHeight?below:Math.max(8,rect.top-box.height-6))+'px';
  }
  function openMetric(index){
    if(!workMode||view!=='content'||pending)return;
    const field=current.fields[index],cell=wall.querySelector(`[data-cell="${index}"]`);
    if(!field||!cell)return;
    closeEdit();
    if(field.type==='state'){
      editing={type:'status12',index};
      const popover=document.createElement('div');
      popover.className='status-popover';popover.setAttribute('role','group');
      popover.setAttribute('aria-label',field.label+'规划状态');
      popover.innerHTML=['yes','no','pending'].map(key=>`<button type="button" data-status="${key}" class="${current.values[index]===key?'selected':''}"><b>${symbols[key]}</b>${key==='pending'?'清除选择':statusNames[key]}</button>`).join('');
      placeMetricPopover(popover,cell);return;
    }
    const button=cell.querySelector('.metric-text'),readButton=cell.querySelector('.metric-fulltext');
    const input=document.createElement('textarea');
    input.className='metric-inline';input.rows=3;input.maxLength=5000;
    input.setAttribute('aria-label',field.label);input.value=current.values[index];
    editing={type:'text12',index,input,button,readButton,readWasHidden:readButton.hidden};
    button.hidden=true;readButton.hidden=true;
    cell.appendChild(input);
    input.addEventListener('blur',()=>commitMetricText());
    input.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='Escape'){event.preventDefault();closeEdit();button.focus()}
      if(event.key==='Enter'&&!event.altKey&&!event.shiftKey){event.preventDefault();input.blur()}
    });
    input.focus();
  }
  function commitMetricText(){
    if(editing?.type!=='text12'||pending)return;
    const {index,input}=editing;
    if(input.value===current.values[index]){closeEdit();return}
    save([{path:['values',index],value:input.value}],'编辑运维文字内容');
  }
  function openProductName(){if(!workMode||view!=='content'||pending)return;editing={type:'product12'};document.getElementById('edit-title').textContent='编辑产品名称';form.innerHTML=`<label class="edit-field">产品名称<input name="product" required maxlength="5000" value="${esc(current.product)}"></label>`;document.getElementById('edit-save').hidden=false;document.getElementById('edit-error').textContent='';mask.hidden=false;form.querySelector('input')?.focus()}
  function save(patches,label){if(!editing||pending)return;pending=true;document.getElementById('edit-save').disabled=true;send({type:'bg-showcase-save',dim,patches,label})}
  document.addEventListener('click',event=>{
    if(event.target===mask||event.target.closest('#edit-close,#edit-cancel')){closeEdit();return}if(editing?.type==='status12'&&!event.target.closest('.status-popover,[data-metric]'))closeEdit();
    const reset=event.target.closest('[data-reset-image]');if(reset){imageDraft='sample';form.querySelector('#image-url').value='';form.querySelector('#image-file').value='';form.querySelector('#image-feedback').textContent='已选择恢复示例示意图，保存后生效。';return}
    const option=event.target.closest('[data-status]');if(option&&editing?.type==='status12'){const index=editing.index,value=option.dataset.status;if(value===current.values[index]){closeEdit();return}save([{path:['values',index],value}],`更新${current.fields[index].label}规划状态`);return}
    const design=event.target.closest('[data-open-design]');if(design){selected11=design.dataset.openDesign;render();return}
    if(event.target.closest('[data-close-design]')){selected11=null;render();return}
    const product=event.target.closest('[data-edit-product]');if(product){openProduct(Number(product.dataset.editProduct));return}
    if(event.target.closest('[data-edit-product-name]')){openProductName();return}
    const read=event.target.closest('[data-read-metric]');
    const existing=document.querySelector('.metric-reading');
    if(existing){wall.querySelector('.metric-fulltext[aria-expanded=true]')?.setAttribute('aria-expanded','false');existing.remove()}
    if(read){
      if(existing)return;
      const full=document.createElement('div');full.className='metric-reading';
      full.textContent=current.values[Number(read.dataset.readMetric)];placeMetricPopover(full,read);
      read.setAttribute('aria-expanded','true');return;
    }
    const metric=event.target.closest('[data-metric]');if(metric){openMetric(Number(metric.dataset.metric));return}
    const group=event.target.closest('[data-group-nav]');if(group){const g=Number(group.dataset.groupNav),starts=[0,11,14,16],matrix=wall.querySelector('#matrix-scroll');navForced=g;setActiveGroup(g);matrix?.scrollTo({left:Math.min(matrix.scrollWidth-matrix.clientWidth,starts[g]*132),behavior:'smooth'});setTimeout(()=>navForced=null,850);return}
    if(event.target.closest('[data-pending-jump]')){const index=current.values.findIndex((value,i)=>i===15?!value.trim():!['yes','no'].includes(value));if(index>=0)reveal(index)}
  });
  document.addEventListener('input',event=>{if(event.target.id==='gallery-search'){search11=event.target.value.trim().toLowerCase();if(selected11&&!current.products.some(p=>p.id===selected11&&[p.name,p.model,p.kind].some(v=>v.toLowerCase().includes(search11))))selected11=null;render();wall.querySelector('#gallery-search')?.focus()}});
  document.addEventListener('change',event=>{if(event.target.id!=='image-file')return;const file=event.target.files?.[0];if(!file)return;if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>550000){document.getElementById('edit-error').textContent='请选择不超过 550 KB 的 PNG、JPEG、WebP 或 GIF 图片。';event.target.value='';return}const reader=new FileReader();reader.onload=()=>{imageDraft=String(reader.result);form.querySelector('#image-url').value='';form.querySelector('#image-feedback').textContent=`已选择本机图片：${file.name}；保存后生效。`;document.getElementById('edit-error').textContent=''};reader.readAsDataURL(file)});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(editing)closeEdit();else if(selected11){selected11=null;render()}}});
  form.addEventListener('submit',event=>{event.preventDefault();if(!editing||pending)return;let patches=[],label='编辑内容';if(editing.type==='product11'){const i=editing.index,url=form.querySelector('#image-url').value.trim(),imageUrl=url||imageDraft;patches=[['name',form.elements.name.value],['model',form.elements.model.value],['kind',form.elements.kind.value],['imageUrl',imageUrl]].map(([key,value])=>({path:['products',i,key],value:String(value).trim()}));patches.push(...current.products[i].fields.map((f,j)=>({path:fieldPath(i,j),value:form.elements[`detail${j}`].value.trim()})));label='编辑竞品外观信息'}else if(editing.type==='text12'){patches=[{path:['values',editing.index],value:form.elements.value.value.trim()}];label='编辑运维文字内容'}else if(editing.type==='product12'){patches=[{path:['product'],value:form.elements.product.value.trim()}];label='编辑运维产品名称'}if(patches.some(x=>!x.value)){document.getElementById('edit-error').textContent='请填写全部必填字段。';return}save(patches,label)});
  window.addEventListener('message',event=>{if(event.origin!==origin||event.data?.dim!==dim)return;const msg=event.data;if(msg.type==='bg-dim12-command'&&dim==='12'&&workMode){
    commitMetricText();
    send({type:msg.action==='publish'?'bg-dim12-apply':'bg-dim12-save-draft',dim});
    return;
  }if(msg.type==='bg-showcase-state'){const nextFrom=msg.saved?autoNextFrom:null;current=clone(msg.content||seed);if(dim==='12')current.values=current.values.map((v,i)=>i!==15&&v==='na'?'pending':v);workMode=!!msg.workMode;if(workMode)selected11=null;if(msg.saved)closeEdit();render();if(nextFrom!==null&&dim==='12'){const next=current.values.findIndex((value,i)=>i>nextFrom&&i!==15&&value==='pending');const wrap=next>=0?next:current.values.findIndex((value,i)=>i!==15&&value==='pending');if(wrap>=0){reveal(wrap);openMetric(wrap)}}return}if(msg.type==='bg-showcase-save-error'){pending=false;document.getElementById('edit-save').disabled=false;document.getElementById('edit-error').textContent=msg.error||'保存失败，请重试。';return}});
  fetch(`/dimension-assets/dim${dim}-seed.json`).then(response=>{if(!response.ok)throw Error('示例数据无法加载');return response.json()}).then(json=>{seed=json;current=clone(seed);render();send({type:'bg-showcase-ready',dim,seed})}).catch(error=>{wall.innerHTML=`<div class="page"><p class="hint">${esc(error.message)}</p></div>`});
})();
