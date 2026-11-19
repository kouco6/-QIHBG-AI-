import ExcelJS from 'exceljs';

function workbookCtor() {
  return ExcelJS.Workbook ?? ExcelJS.default?.Workbook;
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.text) return String(value.text);
    if (value.result != null) return String(value.result);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value);
}

export async function parseXlsx(buffer) {
  const Workbook = workbookCtor();
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], records: [] };
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, index) => {
    headers[index - 1] = cellText(cell.value).trim();
  });
  const records = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = cellText(row.getCell(index + 1).value);
    });
    records.push(record);
  });
  return { headers: headers.filter(Boolean), records };
}

export async function buildXlsx(columns, rows) {
  const Workbook = workbookCtor();
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('记录');
  sheet.addRow(['id', ...columns.map((column) => column.key)]);
  rows.forEach((row) => {
    sheet.addRow([row.id, ...columns.map((column) => row.values[column.key] ?? '')]);
  });
  return workbook.xlsx.writeBuffer();
}
