const views = {
  table: document.getElementById('table-component'),
  interaction: document.getElementById('interaction'),
  type: document.getElementById('type'),
};
const viewHash = { table: 'table-component', interaction: 'interaction', type: 'type' };
const viewTitle = {
  table: '底层能力中心 · 表格组件',
  interaction: '底层能力中心 · 交互组件',
  type: '底层能力中心 · 文字',
};
function viewFromHash() {
  const hash = location.hash.slice(1);
  return Object.keys(viewHash).find(key => viewHash[key] === hash) || 'table';
}
function showCapability(view) {
  const name = views[view] ? view : 'table';
  Object.entries(views).forEach(([key, element]) => { element.hidden = key !== name; });
  document.querySelectorAll('nav a').forEach(link => {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = viewTitle[name];
  if (name === 'interaction') {
    const frame = views.interaction.querySelector('iframe');
    if (!frame.getAttribute('src')) frame.src = frame.dataset.src;
  }
  if (location.hash !== `#${viewHash[name]}`) {
    history.replaceState(null, '', `#${viewHash[name]}`);
  }
}
document.querySelectorAll('nav a').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    showCapability(link.dataset.view);
  });
});
showCapability(viewFromHash());
const rail = document.querySelector('.rail');
const railToggle = document.querySelector('.rail-toggle');
const focusToggle = document.querySelector('.focus-toggle');
railToggle.addEventListener('click', () => {
  const collapsed = rail.classList.toggle('is-collapsed');
  railToggle.setAttribute('aria-expanded', String(!collapsed));
  railToggle.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  railToggle.title = collapsed ? '展开侧栏' : '收起侧栏';
  railToggle.textContent = collapsed ? '»' : '«';
});
function setFocus(active) {
  document.body.classList.toggle('is-focused', active);
  focusToggle.setAttribute('aria-pressed', String(active));
  focusToggle.textContent = active ? '退出专注' : '专注表格';
}
focusToggle.addEventListener('click', () => setFocus(!document.body.classList.contains('is-focused')));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setFocus(false); });
window.addEventListener('message', event => {
  if (event.origin === location.origin && event.source === document.querySelector('iframe').contentWindow && event.data?.type === 'table-exit-focus') setFocus(false);
});
