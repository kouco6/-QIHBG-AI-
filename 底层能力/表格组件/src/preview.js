import './style.css';
import { mountTable } from './kernel.js';
import { typeColumns, typeRows } from './fixtures.js';

const byId = id => document.getElementById(id);
const initialNotice = '临时演示 · 刷新后重置，请导出保留结果。';
let table;

function showNotice(text = initialNotice, error = false) {
  byId('notice').textContent = text;
  byId('notice').classList.toggle('is-error', error);
}
function renderCommit(rows) {
  byId('commit').textContent = JSON.stringify(rows, null, 2);
}
async function action(callback) {
  if (!table) return;
  try { await callback(); }
  catch (error) { showNotice('操作未完成：' + (error.message || '请重试'), true); }
}
for (const extension of ['csv', 'xlsx']) byId('import-' + extension).addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  action(async () => {
    if (file.size > 20 * 1024 * 1024) throw new Error('请选择 20 MB 以内的文件');
    const result = extension === 'csv' ? table.importText(await file.text()) : await table.importXlsx(await file.arrayBuffer());
    if (!result.ok) { showNotice('当前为只读，不能导入。', true); return; }
    renderCommit(table.getRows());
    showNotice((extension === 'csv' ? 'CSV' : 'Excel') + ' 已导入，按记录 ID 更新或追加。');
  });
});
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
byId('export-csv').addEventListener('click', () => action(() => download('表格组件.csv', table.exportCsv(), 'text/csv;charset=utf-8')));
byId('export-xlsx').addEventListener('click', () => action(async () => download('表格组件.xlsx', await table.exportXlsx(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')));
new ResizeObserver(() => table?.resetColumnWidths()).observe(byId('sheet'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') parent.postMessage({ type: 'table-exit-focus' }, location.origin); });
try {
  table = mountTable(byId('sheet'), { columns: typeColumns, rows: typeRows, editable: true, onCommit: renderCommit });
  requestAnimationFrame(() => table?.resetColumnWidths());
} catch (error) {
  byId('sheet').textContent = '表格加载失败，请刷新重试。';
  showNotice(error.message, true);
  console.error(error);
}
