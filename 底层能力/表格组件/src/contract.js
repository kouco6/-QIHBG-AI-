/** 内核与调用方之间的数据契约。这里不依赖 Univer，方便单独测试。 */

export const VALUE_TYPES = ['text', 'longText', 'number', 'date', 'singleSelect', 'link']

const RESERVED_HEADERS = new Set(['__id', '__pick', '勾选'])
const IMPORT_META = new Set(['id', '__id', '__pick', '勾选'])

export function normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('至少需要一列字段')
  }
  const keys = new Set()
  const labels = new Set()
  return columns.map((column) => {
    const key = String(column?.key ?? '').trim()
    const label = String(column?.label ?? '').trim()
    if (!key || !label) throw new Error('字段需要键和显示名')
    if (key.startsWith('__') || RESERVED_HEADERS.has(label)) {
      throw new Error(`字段「${label}」与内核保留列冲突`)
    }
    if (!VALUE_TYPES.includes(column.type)) throw new Error(`不支持的值类型：${column.type}`)
    if (keys.has(key)) throw new Error(`字段键重复：${key}`)
    if (labels.has(label)) throw new Error(`字段显示名重复：${label}`)
    keys.add(key)
    labels.add(label)
    const next = { key, label, type: column.type, readonly: Boolean(column.readonly) }
    if (column.type === 'singleSelect') {
      next.options = [...new Set((column.options ?? []).map((item) => String(item)))]
    }
    if (column.type === 'number') {
      next.format = column.format === 'money' || column.format === 'percent' ? column.format : 'number'
    }
    return next
  })
}

export function createIdFactory(existingIds = []) {
  const used = new Set(existingIds.map((id) => String(id)))
  let serial = 1
  return () => {
    let id = `tmp_${serial}`
    while (used.has(id)) {
      serial += 1
      id = `tmp_${serial}`
    }
    used.add(id)
    serial += 1
    return id
  }
}

export function headerRow(columns, selection) {
  return ['__id', ...(selection ? ['勾选'] : []), ...columns.map((column) => column.label)]
}

export function fieldIndex(headers, column) {
  return headers.indexOf(column.label)
}

export function isFormulaInput(value) {
  return typeof value === 'string' && value.trim().startsWith('=')
}

export function coerceCell(column, value) {
  if (isFormulaInput(value)) return { ok: true, value: String(value).trim() }
  if (value == null || value === '') {
    return { ok: true, value: column.type === 'number' ? null : '' }
  }
  if (column.type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
    const text = String(value).trim().replace(/,/g, '').replace(/%$/, '')
    if (text === '') return { ok: true, value: null }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return { ok: false, reason: 'number' }
    return { ok: true, value: parsed }
  }
  return { ok: true, value: String(value) }
}

export function displayCell(column, value) {
  const coerced = coerceCell(column, value)
  if (!coerced.ok) return ''
  if (column.type === 'number') return coerced.value
  return coerced.value
}

function blankValue(column) {
  return column.type === 'number' ? null : ''
}

function cellFilled(value) {
  return value != null && String(value).trim() !== ''
}

export function columnsFromHeaders(columns, headers) {
  const usedKeys = new Set()
  const usedLabels = new Set()
  const next = []
  headers.forEach((header) => {
    const rawLabel = String(header ?? '').trim()
    if (!rawLabel || RESERVED_HEADERS.has(rawLabel)) return
    const label = uniqueLabel(rawLabel, usedLabels)
    usedLabels.add(label)
    const existing = columns.find((column) => column.label === rawLabel && !usedKeys.has(column.key))
    if (existing) {
      const column = label === existing.label ? existing : { ...existing, label }
      next.push(column)
      usedKeys.add(column.key)
      return
    }
    const key = fieldKey(label, usedKeys)
    usedKeys.add(key)
    next.push({ key, label, type: 'text', readonly: false })
  })
  return next
}

function uniqueLabel(label, used) {
  if (!used.has(label)) return label
  let serial = 2
  let next = `${label} ${serial}`
  while (used.has(next)) {
    serial += 1
    next = `${label} ${serial}`
  }
  return next
}

function fieldKey(label, used) {
  const base = String(label).replace(/\s+/g, '') || 'col'
  let key = base
  let serial = 2
  while (used.has(key) || key.startsWith('__')) {
    key = `${base}_${serial}`
    serial += 1
  }
  return key
}

/**
 * 从当前表网格读回行。表头里多出来的列会成为新字段，少掉的列不再提交。
 * 空行丢弃。没有 id 但写了内容的行分配临时 id。
 */
export function readRows({ columns, headers, body, nextId }) {
  const liveColumns = columnsFromHeaders(columns, headers)
  const idAt = headers.indexOf('__id')
  const assigned = []
  const rows = []
  body.forEach((line, index) => {
    const rawId = idAt >= 0 ? line[idAt] : ''
    const values = {}
    let touched = cellFilled(rawId)
    liveColumns.forEach((column) => {
      const at = headers.indexOf(column.label)
      const raw = at >= 0 ? line[at] : ''
      if (cellFilled(raw)) touched = true
      const coerced = coerceCell(column, raw)
      values[column.key] = coerced.ok ? coerced.value : blankValue(column)
    })
    if (!touched) return
    let id = rawId == null ? '' : String(rawId).trim()
    if (!id) {
      id = nextId()
      assigned.push({ rowIndex: index, id })
    }
    rows.push({ id, values })
  })
  return { rows, assigned, columns: liveColumns }
}

export function importRows({ columns, rows, headers, records, editable, nextId }) {
  if (!editable) {
    return { ok: false, reason: 'readonly', rows, columns }
  }
  const liveColumns = importColumns(columns, headers)
  const byKey = new Map(liveColumns.map((column) => [column.key, column]))
  const byLabel = new Map(liveColumns.map((column) => [column.label, column]))
  const nextRows = rows.map((row) => ({ id: row.id, values: { ...row.values } }))
  const indexById = new Map(nextRows.map((row, index) => [String(row.id), index]))
  records.forEach((record) => {
    const values = {}
    liveColumns.forEach((column) => {
      values[column.key] = rowValue(nextRows, indexById, record, column)
    })
    Object.entries(record).forEach(([header, raw]) => {
      if (header === 'id' || header === '__id' || header === '__pick') return
      const column = byKey.get(header) ?? byLabel.get(header)
      if (!column) return
      const coerced = coerceCell(column, raw)
      values[column.key] = coerced.ok ? coerced.value : blankValue(column)
    })
    const recordId = record.id ?? record.__id
    if (recordId != null && String(recordId).trim() !== '' && indexById.has(String(recordId))) {
      const index = indexById.get(String(recordId))
      nextRows[index] = { id: String(recordId), values }
      return
    }
    const id = recordId != null && String(recordId).trim() !== '' ? String(recordId) : nextId()
    indexById.set(id, nextRows.length)
    nextRows.push({ id, values })
  })
  return { ok: true, rows: nextRows, columns: liveColumns }
}

function importColumns(columns, headers) {
  const extras = []
  headers.forEach((header) => {
    if (!header || IMPORT_META.has(header)) return
    const known = columns.some((column) => column.key === header || column.label === header)
    if (!known) extras.push(header)
  })
  return columnsFromHeaders(columns, [...columns.map((column) => column.label), ...extras])
}

function rowValue(rows, indexById, record, column) {
  const recordId = record.id ?? record.__id
  if (recordId == null || !indexById.has(String(recordId))) return blankValue(column)
  return rows[indexById.get(String(recordId))].values[column.key] ?? blankValue(column)
}

export function locateErrors({ columns, headers, rows, errors }) {
  const marks = []
  rows.forEach((row, index) => {
    const fieldErrors = errors?.[row.id]
    if (!fieldErrors) return
    Object.entries(fieldErrors).forEach(([key, message]) => {
      const column = columns.find((item) => item.key === key)
      if (!column || !message) return
      const colIndex = headers.indexOf(column.label)
      if (colIndex < 0) return
      marks.push({ rowIndex: index, colIndex, message: String(message) })
    })
  })
  return marks
}

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const table = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quoted && char === '"' && next === '"') {
      cell += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      row.push(cell)
      table.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    table.push(row)
  }
  const filled = table.filter((line) => line.some((item) => String(item).trim() !== ''))
  if (filled.length === 0) return { headers: [], records: [] }
  const headers = filled[0].map((item) => String(item).trim())
  const records = filled.slice(1).map((line) => {
    const record = {}
    headers.forEach((header, index) => {
      if (!header) return
      record[header] = line[index] ?? ''
    })
    return record
  })
  return { headers, records }
}

export function toCsv(columns, rows) {
  const headers = ['id', ...columns.map((column) => column.key)]
  const lines = [headers.map(escapeCsv).join(',')]
  rows.forEach((row) => {
    const line = [row.id, ...columns.map((column) => formatCsvValue(column, row.values[column.key]))]
    lines.push(line.map(escapeCsv).join(','))
  })
  return `\uFEFF${lines.join('\n')}`
}

function formatCsvValue(column, value) {
  if (value == null) return ''
  return String(value)
}

function escapeCsv(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}
