(() => {
  'use strict';
  const view = new URLSearchParams(location.search).get('view') || 'content';
  const origin = location.origin;
  const wall = document.getElementById('cert-wall');
  const mask = document.getElementById('dim03-edit-mask');
  const form = document.getElementById('edit-form');
  const fieldNames = ['资质名称', '资质等级', '公司是否拥有', '有效期', '获取难度', '行业门槛'];
  const optionFields = {
    '资质等级': ['强制性', '市级', '省级', '国家级', '行业', '待核实'],
    '公司是否拥有': ['待核实', '是', '否'],
    '获取难度': ['低', '中', '高', '待核实'],
    '行业门槛': ['低', '中', '高', '待核实']
  };
  const icons = {
    product: '<path d="M12 2.8 19.2 6v5.6c0 5-3 8.4-7.2 10.1C7.8 20 4.8 16.6 4.8 11.6V6L12 2.8Z"/><path d="m8.5 12 2.2 2.2 4.8-4.9"/>',
    standard: '<path d="M4.5 5.5c2.8-1.1 5.4-.9 7.5.6v14.3c-2.1-1.5-4.7-1.7-7.5-.6V5.5Z"/><path d="M19.5 5.5c-2.8-1.1-5.4-.9-7.5.6v14.3c2.1-1.5 4.7-1.7 7.5-.6V5.5Z"/><path d="M7 9h2.2M14.8 9H17"/>',
    enterprise: '<path d="M3.5 20.5h17M5 20V7l6-3v16M11 10h8v10"/><path d="M7.5 9v1M7.5 13v1M7.5 17v1M14 13h2M14 17h2"/>'
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let seed = null;
  let current = null;
  let workMode = false;
  let pending = false;
  let editing = null;
  let activeSection = 'product';

  function row(label, value) {
    const status = label === '公司是否拥有' ? value === '是' ? 'yes' : value === '否' ? 'no' : 'unknown' : '';
    return `<div class="field-row"><span class="field-label">${label}</span><span class="field-value ${status}">${esc(value || '待核实')}</span></div>`;
  }
  function renderContent() {
    if (!current) return;
    wall.className = 'content';
    document.body.classList.toggle('work-mode', workMode);
    wall.innerHTML = current.groups.map((group, groupIndex) => `${groupIndex ? '<hr class="section-divider" aria-hidden="true">' : ''}<section class="qualification-section" id="${group.id}" aria-labelledby="heading-${group.id}"><div class="section-head"><span class="section-accent" aria-hidden="true"></span><h2 id="heading-${group.id}">${esc(group.name)}</h2></div><div class="card-grid">${group.items.map((item, itemIndex) => ({item, itemIndex})).sort((a,b) => ({'否':0,'是':1}[a.item['公司是否拥有']] ?? 2) - ({'否':0,'是':1}[b.item['公司是否拥有']] ?? 2) || a.itemIndex - b.itemIndex).map(({item,itemIndex}) => `<article class="cert-card" data-group="${groupIndex}" data-item="${itemIndex}" ${workMode?'role="button" tabindex="0" aria-label="编辑 '+esc(item['资质名称'])+'"':''}><div class="card-title-line"><span class="category-symbol ${group.id}" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[group.id]}</svg></span><h3 class="cert-name">${esc(item['资质名称'])}</h3></div><div class="cert-fields">${row('资质等级',item['资质等级'])}${row('公司是否拥有',item['公司是否拥有'])}<div class="field-divider" aria-hidden="true"></div>${row('有效期',item['有效期'])}${row('获取难度',item['获取难度'])}${row('行业门槛',item['行业门槛'])}</div></article>`).join('')}</div></section>`).join('');
  }
  function renderText() {
    if (!current) return;
    document.body.classList.remove('work-mode');
    wall.className = 'text-page';
    wall.innerHTML = `<article><h1>证书资质全</h1>${current.groups.map((group,index) => `<section id="${group.id}"><h2>${String(index+1).padStart(2,'0')} ${esc(group.name)}</h2>${group.items.map(item => `<h3>${esc(item['资质名称'])}</h3><p>资质等级：${esc(item['资质等级'])}　·　公司是否拥有：${esc(item['公司是否拥有'])}　·　有效期：${esc(item['有效期'])}</p><p>获取难度：${esc(item['获取难度'])}　·　行业门槛：${esc(item['行业门槛'])}</p>`).join('')}</section>`).join('')}</article>`;
  }
  function render() { if (view === 'text') renderText(); else renderContent(); }
  window.addEventListener('scroll', () => {
    if (view !== 'content') return;
    const sections = [...document.querySelectorAll('.qualification-section')];
    const active = sections.filter(section => section.getBoundingClientRect().top <= 100).at(-1)?.id || sections[0]?.id;
    if (active && active !== activeSection) { activeSection = active; window.parent.postMessage({type:'bg-dim03-active',id:active},origin); }
  }, {passive:true});

  function close() { if (pending) return; mask.hidden = true; editing = null; }
  function field(name, value) {
    const options = optionFields[name];
    const control = options ? `<select data-field="${name}">${options.map(option => `<option value="${option}" ${option===value?'selected':''}>${option}</option>`).join('')}</select>` : `<input data-field="${name}" value="${esc(value)}" maxlength="2000" ${name==='有效期'?'placeholder="例如 2028年、长期或待核实"':''}>`;
    return `<label class="edit-field"><span>${name}</span>${control}</label>`;
  }
  function open(groupIndex, itemIndex) {
    if (!workMode || pending || view !== 'content') return;
    const item = current?.groups?.[groupIndex]?.items?.[itemIndex];
    if (!item) return;
    editing = {groupIndex,itemIndex};
    form.innerHTML = fieldNames.map(name => field(name,item[name])).join('') + '<p class="edit-note">只修改条目内容，不改变六字段架构。保存会生成可预览、可恢复的新版本。</p>';
    document.getElementById('edit-error').textContent = '';
    mask.hidden = false;
    form.querySelector('[data-field]')?.focus();
  }
  wall.addEventListener('click', event => {
    const card = event.target.closest('.cert-card');
    if (card) open(Number(card.dataset.group), Number(card.dataset.item));
  });
  wall.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.cert-card');
    if (!card) return;
    event.preventDefault(); open(Number(card.dataset.group), Number(card.dataset.item));
  });
  mask.addEventListener('click', event => { if (event.target === mask) close(); });
  document.getElementById('edit-close').onclick = close;
  document.getElementById('edit-cancel').onclick = close;
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mask.hidden) close(); });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!editing || pending) return;
    const fields = Object.fromEntries([...form.querySelectorAll('[data-field]')].map(input => [input.dataset.field,input.value.trim()]));
    if (fieldNames.some(name => !fields[name])) { document.getElementById('edit-error').textContent = '六项字段均需填写；未知情况请选择或填写“待核实”。'; return; }
    pending = true; document.getElementById('edit-save').disabled = true;
    window.parent.postMessage({type:'bg-dim03-save',...editing,fields},origin);
  });
  window.addEventListener('message', event => {
    if (event.origin !== origin || !event.data?.type) return;
    if (event.data.type === 'bg-dim03-section') { document.getElementById(event.data.id)?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
    if (event.data.type === 'bg-dim03-save-error') { pending = false; document.getElementById('edit-save').disabled = false; document.getElementById('edit-error').textContent = event.data.error || '保存失败，请重试。'; return; }
    if (event.data.type !== 'bg-dim03-state') return;
    current = clone(event.data.content || seed);
    workMode = !!event.data.workMode && !event.data.preview && view === 'content';
    render();
    if (pending) { pending = false; mask.hidden = true; editing = null; document.getElementById('edit-save').disabled = false; }
  });
  fetch('/dimension-assets/dim03-seed.json',{cache:'no-store'}).then(response => {if(!response.ok)throw Error('seed');return response.json()}).then(source => {
    seed = {groups:clone(source.groups)}; current = clone(seed); render();
    window.parent.postMessage({type:'bg-dim03-ready',seed:clone(seed)},origin);
  }).catch(() => {wall.textContent = '示例内容加载失败，请刷新页面。';});
})();
