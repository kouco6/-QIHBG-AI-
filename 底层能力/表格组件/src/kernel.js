import { CellValueType, createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import sheetsValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import sheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sheetsSortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN';

import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-data-validation/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';

import {
  createIdFactory,
  headerRow,
  importRows,
  locateErrors,
  normalizeColumns,
  parseCsv,
  readRows,
  toCsv,
} from './contract.js';

const NUMBER_FORMAT = {
  money: '#,##0.00',
  percent: '0.##"%"',
  number: '0.##',
};

/**
 * 把字段和行挂到容器上。渲染使用 Univer，调用方只接触这里的返回值。
 */
export function mountTable(host, options) {
  const columns = normalizeColumns(options.columns);
  const features = {
    selection: options.selection !== false,
    freezeFirstColumn: options.freezeFirstColumn !== false,
    filter: options.filter !== false,
    sort: options.sort !== false,
    reorderColumns: options.reorderColumns !== false,
  };
  const columnRatios = Array.isArray(options.columnRatios) ? options.columnRatios : null;
  const merges = Array.isArray(options.merges) ? options.merges : [];
  const state = {
    columns,
    rows: cloneRows(options.rows ?? []),
    editable: options.editable !== false,
    errors: {},
    painted: [],
  };
  const headers = headerRow(columns, features.selection);
  const mountPoint = document.createElement('div');
  mountPoint.style.height = '100%';
  host.replaceChildren(mountPoint);

  const chrome = options.chrome !== false;
  const presets = [
    UniverSheetsCorePreset({
      container: mountPoint,
      header: chrome,
      toolbar: chrome,
      ribbonType: 'grid',
      formulaBar: false,
      footer: chrome ? { sheetBar: false, statisticBar: false, menus: false, zoomSlider: true } : false,
      contextMenu: true,
      disableAutoFocus: true,
    }),
    UniverSheetsDataValidationPreset(),
  ];
  if (features.filter) presets.push(UniverSheetsFilterPreset());
  if (features.sort) presets.push(UniverSheetsSortPreset());

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(
        sheetsCoreZhCN,
        sheetsValidationZhCN,
        features.filter ? sheetsFilterZhCN : {},
        features.sort ? sheetsSortZhCN : {},
      ),
    },
    presets,
  });

  const workbook = univerAPI.createWorkbook({
    id: `kernel-${Date.now()}`,
    name: '记录',
    sheetOrder: ['kernel-sheet'],
    sheets: {
      'kernel-sheet': {
        id: 'kernel-sheet',
        name: '记录',
        rowCount: Math.max(state.rows.length + 16, 24),
        columnCount: headers.length,
        defaultColumnWidth: 132,
      },
    },
  });
  const sheet = workbook.getActiveSheet();
  let silent = 0;
  let filterReady = false;
  const disposables = [];

  function runSilent(action) {
    silent += 1;
    try {
      return action();
    } finally {
      setTimeout(() => {
        silent = Math.max(0, silent - 1);
      }, 300);
    }
  }

  function columnByLabel(label) {
    return state.columns.find((column) => column.label === label);
  }

  function fieldColumn(index) {
    const line = headerRow(state.columns, features.selection);
    let start = 0;
    if (line.includes('__id')) start += 1;
    if (line.includes('勾选')) start += 1;
    return start + index;
  }

  function layoutColumns() {
    if (!columnRatios) return;
    const usable = Math.floor((host.clientWidth || mountPoint.clientWidth || 1100) * 0.9);
    columnRatios.forEach((ratio, index) => {
      sheet.setColumnWidth(fieldColumn(index), Math.max(72, Math.round((usable * ratio) / 100)));
    });
  }

  function fitRowHeights(rows) {
    const context = document.createElement('canvas').getContext('2d');
    context.font = '16px "Microsoft YaHei", sans-serif';
    rows.forEach((row, index) => {
      let lines = 1;
      state.columns.forEach((column, columnIndex) => {
        const value = String(row.values[column.key] ?? '');
        const width = Math.max(32, sheet.getColumnWidth(fieldColumn(columnIndex)) - 16);
        const wrapped = value.split(/\r?\n/).reduce((total, part) => {
          let count = 1, used = 0;
          for (const character of part) {
            const size = context.measureText(character).width;
            if (used + size > width && used > 0) { count += 1; used = 0; }
            used += size;
          }
          return total + count;
        }, 0);
        lines = Math.max(lines, wrapped);
      });
      sheet.setRowHeightsForced(index + 1, 1, Math.max(48, lines * 22 + 18));
    });
  }

  function applyMerges() {
    merges.forEach((merge) => {
      sheet.getRange(merge.r + 1, fieldColumn(merge.c), merge.rs, merge.cs).merge({ isForceMerge: true });
    });
  }

  function activeRange() {
    return sheet.getSelection()?.getActiveRange() ?? null;
  }

  function selectionLabel() {
    const range = activeRange();
    if (!range || range.getRow() <= 0) return '请选择单元格或行号';
    const letters = 'ABCDEFGH';
    const row = range.getRow();
    const column = Math.max(0, range.getColumn() - fieldColumn(0));
    const rows = range.getNumRows?.() ?? 1;
    const cols = range.getNumColumns?.() ?? 1;
    const start = letters[column] || '?';
    const end = letters[column + cols - 1] || start;
    return `${start}${row}:${end}${row + rows - 1}`;
  }

  function nextIdFor(rows) {
    return createIdFactory(rows.map((row) => row.id));
  }

  function snapshotHeaders() {
    const width = sheet.getSheet().getSnapshot().columnCount || headers.length;
    const line = sheet.getRange(0, 0, 1, width).getValues()?.[0] ?? [];
    return line.map(plain);
  }

  function readCurrent() {
    const headerLine = snapshotHeaders();
    const rowCount = sheet.getSheet().getSnapshot().rowCount || 1;
    const body = (sheet.getRange(1, 0, Math.max(rowCount - 1, 1), headerLine.length).getValues() ?? []).map((line) => line.map(plain));
    return readRows({ columns: state.columns, headers: headerLine, body, nextId: nextIdFor(state.rows) });
  }

  function writeTable(rows) {
    const headerLine = headerRow(state.columns, features.selection);
    const width = headerLine.length;
    const rowCount = Math.max(sheet.getSheet().getSnapshot().rowCount || 0, rows.length + 1);
    if ((sheet.getSheet().getSnapshot().columnCount || 0) !== width) sheet.setColumnCount(width);
    const matrix = [headerLine.map((header) => textCell(header))];
    for (let index = 0; index < rowCount - 1; index += 1) {
      const row = rows[index];
      matrix.push(headerLine.map((header) => encodeCell(header, row)));
    }
    runSilent(() => {
      sheet.getRange(0, 0, matrix.length, width).setValues(matrix);
      styleSheet(headerLine, rowCount, rows);
    });
  }

  function encodeCell(header, row) {
    if (!row) return null;
    if (header === '__id') return textCell(row.id);
    if (header === '勾选') return null;
    const column = columnByLabel(header);
    if (!column) return null;
    if (column.type === 'number') {
      const value = row.values[column.key];
      if (value == null || value === '') return null;
      if (typeof value === 'string' && value.trim().startsWith('=')) return value.trim();
      return Number(value);
    }
    const value = row.values[column.key];
    return value == null || value === '' ? null : textCell(value);
  }

  function styleSheet(headerLine, rowCount, rows) {
    const header = sheet.getRange(0, 0, 1, headerLine.length);
    header.setBackgroundColor('#edf3f9');
    header.setFontColor('#324f69');
    header.setFontWeight('bold');
    header.setFontSize(12);
    const grid = sheet.getRange(0, 0, rowCount, headerLine.length);
    const borderType = univerAPI.Enum?.BorderType?.ALL;
    const borderStyle = univerAPI.Enum?.BorderStyleTypes?.THIN;
    if (borderType && borderStyle) {
      grid.setBorder(borderType, borderStyle, '#e8edf3');
    }
    grid.setFontColor('#334a61');
    header.setFontColor('#324f69');
    sheet.setRowHeightsForced(0, 1, 28);
    sheet.setFrozenRows(1);
    const idAt = headerLine.indexOf('__id');
    if (idAt >= 0) sheet.hideColumns(idAt, 1);
    const firstField = headerLine.findIndex((header) => columnByLabel(header));
    if (features.freezeFirstColumn && firstField >= 0) sheet.setFrozenColumns(firstField + 1);
    headerLine.forEach((header, index) => {
      const column = columnByLabel(header);
      if (!column) return;
      const body = sheet.getRange(1, index, Math.max(rowCount - 1, 1), 1);
      body.setFontSize(12);
      if (column.type === 'text' || column.type === 'longText') body.setWrap(true);
      if (column.type === 'number') body.setNumberFormat(NUMBER_FORMAT[column.format] ?? NUMBER_FORMAT.number);
      if (column.readonly) body.setBackgroundColor('#f3f5f8');
      if (!columnRatios) {
        const width = column.type === 'longText' ? 280 : column.type === 'link' ? 200 : column.type === 'number' ? 110 : 140;
        sheet.setColumnWidth(index, width);
      }
    });
    layoutColumns();
    applyMerges();
    fitRowHeights(rows);
    const pickAt = headerLine.indexOf('勾选');
    if (pickAt >= 0) {
      sheet.setColumnWidth(pickAt, 64);
      const rule = univerAPI.newDataValidation().requireCheckbox('1', '0').build();
      sheet.getRange(1, pickAt, Math.max(rowCount - 1, 1), 1).setDataValidation(rule);
    }
    state.columns.forEach((column) => {
      if (column.type !== 'singleSelect' || column.options.length === 0) return;
      const index = headerLine.indexOf(column.label);
      if (index < 0) return;
      const rule = univerAPI.newDataValidation().requireValueInList(column.options, false, true).build();
      sheet.getRange(1, index, Math.max(rowCount - 1, 1), 1).setDataValidation(rule);
    });
    if (features.filter && !filterReady) {
      sheet.getRange(0, 0, Math.max(state.rows.length + 1, 2), headerLine.length).createFilter();
      filterReady = true;
    }
  }

  function paintErrors() {
    state.painted.forEach(({ rowIndex, colIndex }) => {
      const header = snapshotHeaders()[colIndex];
      const column = columnByLabel(header);
      const color = column?.readonly ? '#f3f5f8' : '#ffffff';
      sheet.getRange(rowIndex + 1, colIndex).setBackgroundColor(color);
    });
    const headerLine = snapshotHeaders();
    state.painted = locateErrors({ columns: state.columns, headers: headerLine, rows: state.rows, errors: state.errors });
    state.painted.forEach((mark) => {
      sheet.getRange(mark.rowIndex + 1, mark.colIndex).setBackgroundColor('#f8d0cb');
    });
  }

  function publish() {
    if (silent) return;
    const { rows, assigned, columns: liveColumns } = readCurrent();
    if (assigned.length > 0) {
      const headerLine = snapshotHeaders();
      const idAt = headerLine.indexOf('__id');
      runSilent(() => {
        assigned.forEach((item) => {
          if (idAt >= 0) sheet.getRange(item.rowIndex + 1, idAt).setValue(textCell(item.id));
        });
      });
    }
    state.columns = liveColumns;
    state.rows = rows;
    options.onCommit?.(cloneRows(rows), cloneColumns(liveColumns));
    paintErrors();
  }

  function schedulePublish() {
    if (silent) return;
    clearTimeout(schedulePublish.timer);
    schedulePublish.timer = setTimeout(publish, 40);
  }

  function dataMutation(id) {
    return ['set-range-values', 'clear-selection', 'insert-row', 'remove-row', 'insert-col', 'remove-col', 'move-rows', 'move-cols', 'paste', 'undo', 'redo', 'auto-fill'].some((part) => id.includes(part));
  }

  function reservedColumn(index) {
    const header = snapshotHeaders()[index];
    return header === '__id' || header === '勾选';
  }

  function removesReservedColumn(params) {
    const range = params?.range;
    if (!range) return false;
    const start = range.startColumn ?? 0;
    const end = range.endColumn ?? start;
    for (let index = start; index <= end; index += 1) {
      if (reservedColumn(index)) return true;
    }
    return false;
  }

  disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
    if (silent) return;
    const id = String(event.id ?? '');
    if (!state.editable && dataMutation(id)) {
      event.cancel = true;
      return;
    }
    if (id.includes('remove-col') && removesReservedColumn(event.params)) event.cancel = true;
    if (!features.reorderColumns && id.includes('move-cols')) event.cancel = true;
  }));
  disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (event) => {
    if (silent) return;
    if (!state.editable || reservedColumn(event.column)) {
      event.cancel = true;
      return;
    }
    if (event.row > 0 && columnByLabel(snapshotHeaders()[event.column])?.readonly) event.cancel = true;
  }));
  disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeClipboardPaste, (event) => {
    if (silent) return;
    if (!state.editable) event.cancel = true;
  }));
  disposables.push(univerAPI.addEvent(univerAPI.Event.SheetEditEnded, (event) => {
    if (event.isConfirm) schedulePublish();
  }));
  disposables.push(univerAPI.addEvent(univerAPI.Event.ClipboardPasted, () => schedulePublish()));
  disposables.push(univerAPI.addEvent(univerAPI.Event.SheetSkeletonChanged, () => schedulePublish()));
  if (univerAPI.Event.SheetRangeSorted) {
    disposables.push(univerAPI.addEvent(univerAPI.Event.SheetRangeSorted, () => schedulePublish()));
  }
  if (univerAPI.Event.SelectionChanged) {
    disposables.push(univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => {
      options.onSelection?.(selectionLabel());
    }));
  }
  disposables.push(univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    const id = String(event.id ?? '');
    if (id.includes('undo') || id.includes('redo') || id.includes('sort')) schedulePublish();
  }));

  function insertRowsAt(direction, count = 1) {
    if (!state.editable) return { ok: false, reason: 'readonly' };
    const howMany = Math.max(1, Math.min(200, Number(count) || 1));
    const selected = activeRange()?.getRow() ?? 1;
    const at = Math.max(selected, 1);
    if (direction === 'above') sheet.insertRowsBefore(at, howMany);
    else sheet.insertRowsAfter(at, howMany);
    schedulePublish();
    return { ok: true };
  }

  writeTable(state.rows);

  return {
    getRows: () => cloneRows(state.rows),
    setEditable(editable) {
      state.editable = Boolean(editable);
      workbook.setEditable(state.editable);
    },
    setErrors(errors) {
      state.errors = errors ?? {};
      paintErrors();
    },
    importText(text) {
      return applyImport(parseCsv(text));
    },
    async importXlsx(buffer) {
      const { parseXlsx } = await import('./io.js');
      return applyImport(await parseXlsx(buffer));
    },
    exportCsv() {
      return toCsv(state.columns, state.rows);
    },
    async exportXlsx() {
      const { buildXlsx } = await import('./io.js');
      return buildXlsx(state.columns, state.rows);
    },
    getColumns() {
      return cloneColumns(state.columns);
    },
    undo() {
      return univerAPI.undo();
    },
    redo() {
      return univerAPI.redo();
    },
    insertRow() {
      return insertRowsAt('below', 1);
    },
    insertRows(direction, count = 1) {
      return insertRowsAt(direction, count);
    },
    mergeSelection() {
      if (!state.editable) return { ok: false, reason: 'readonly' };
      const range = activeRange();
      if (!range || range.getRow() <= 0) return { ok: false, reason: 'selection' };
      range.merge({ isForceMerge: true });
      return { ok: true };
    },
    unmergeSelection() {
      if (!state.editable) return { ok: false, reason: 'readonly' };
      const range = activeRange();
      if (!range) return { ok: false, reason: 'selection' };
      range.breakApart();
      return { ok: true };
    },
    async copySelection() {
      await univerAPI.copy();
      return { ok: true };
    },
    async pasteSelection() {
      if (!state.editable) return { ok: false, reason: 'readonly' };
      await univerAPI.paste();
      schedulePublish();
      return { ok: true };
    },
    resetColumnWidths() {
      layoutColumns();
      fitRowHeights(state.rows);
      return { ok: true };
    },
    selectionLabel,
    deleteSelectedRows() {
      if (!state.editable) return { ok: false, reason: 'readonly' };
      const selected = sheet.getSelection()?.getActiveRange()?.getRow() ?? 0;
      if (selected <= 0) return { ok: false, reason: 'header' };
      sheet.deleteRows(selected, 1);
      schedulePublish();
      return { ok: true };
    },
    destroy() {
      clearTimeout(schedulePublish.timer);
      disposables.forEach((item) => item.dispose?.());
      univer.dispose();
      host.replaceChildren();
    },
  };

  function applyImport(parsed) {
    const result = importRows({
      columns: state.columns,
      rows: state.rows,
      headers: parsed.headers,
      records: parsed.records,
      editable: state.editable,
      nextId: nextIdFor(state.rows),
    });
    if (!result.ok) return result;
    state.columns = result.columns;
    state.rows = result.rows;
    writeTable(state.rows);
    options.onCommit?.(cloneRows(state.rows), cloneColumns(state.columns));
    paintErrors();
    return result;
  }
}

function textCell(value) {
  return { v: String(value), t: CellValueType.FORCE_STRING, f: null, p: null };
}

function plain(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.toPlainText === 'function') return String(value.toPlainText());
    if (value.v != null) return String(value.v);
    if (typeof value.body?.dataStream === 'string') return value.body.dataStream.replace(/\r$/, '');
  }
  return String(value);
}

function cloneRows(rows) {
  return rows.map((row) => ({ id: row.id, values: { ...row.values } }));
}

function cloneColumns(columns) {
  return columns.map((column) => ({ ...column, options: column.options ? [...column.options] : undefined }));
}
