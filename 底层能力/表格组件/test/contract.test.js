import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createIdFactory,
  importRows,
  locateErrors,
  normalizeColumns,
  parseCsv,
  readRows,
  toCsv,
} from '../src/contract.js'

const columns = normalizeColumns([
  { key: 'name', label: '名称', type: 'text' },
  { key: 'amount', label: '金额', type: 'number', format: 'money' },
  { key: 'level', label: '等级', type: 'singleSelect', options: ['低', '中', '高'] },
  { key: 'score', label: '测算', type: 'number', readonly: true },
])

test('提交后按字段键交回行，列顺序变化不影响键', () => {
  const headers = ['测算', '__id', '等级', '名称', '金额']
  const body = [
    [8, 'row-1', '高', '资质甲', '1,280'],
    ['', '', '', '', ''],
    [3, '', '低', '资质乙', 90],
  ]
  const nextId = createIdFactory(['row-1'])
  const { rows, assigned } = readRows({ columns, headers, body, nextId })
  assert.deepEqual(rows, [
    { id: 'row-1', values: { name: '资质甲', amount: 1280, level: '高', score: 8 } },
    { id: 'tmp_1', values: { name: '资质乙', amount: 90, level: '低', score: 3 } },
  ])
  assert.deepEqual(assigned, [{ rowIndex: 2, id: 'tmp_1' }])
})

test('公式文本会保留在提交值里', () => {
  const { rows } = readRows({
    columns,
    headers: ['__id', '名称', '金额', '等级', '测算'],
    body: [['row-1', '资质甲', '=SUM(1,2)', '中', 1]],
    nextId: createIdFactory(),
  })
  assert.equal(rows[0].values.amount, '=SUM(1,2)')
  assert.equal(rows[0].values.name, '资质甲')
})

test('表头多出的列会成为新字段，少掉的列不再提交', () => {
  const { rows, columns: liveColumns } = readRows({
    columns,
    headers: ['__id', '名称', '备注'],
    body: [['row-1', '甲', '补充']],
    nextId: createIdFactory(['row-1']),
  })
  assert.deepEqual(liveColumns.map((column) => column.label), ['名称', '备注'])
  assert.equal(liveColumns[1].type, 'text')
  assert.equal(rows[0].values.name, '甲')
  assert.equal(rows[0].values[liveColumns[1].key], '补充')
  assert.equal(rows[0].values.amount, undefined)
})

test('导入会带上新列，并按 id 更新已有行', () => {
  const rows = [{ id: 'row-1', values: { name: '甲', amount: 1, level: '低', score: 2 } }]
  const result = importRows({
    columns,
    rows,
    headers: ['名称', '额外列'],
    records: [{ id: 'row-1', 名称: '乙', 额外列: '允许' }],
    editable: true,
    nextId: createIdFactory(['row-1']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.columns.at(-1).label, '额外列')
  assert.equal(result.rows[0].values.name, '乙')
  assert.equal(result.rows[0].values[result.columns.at(-1).key], '允许')
  assert.equal(result.rows[0].values.amount, 1)
})

test('导入按 id 更新，没有 id 时追加', () => {
  const rows = [{ id: 'row-1', values: { name: '甲', amount: 1, level: '低', score: 2 } }]
  const result = importRows({
    columns,
    rows,
    headers: ['id', 'name', 'amount'],
    records: [
      { id: 'row-1', name: '甲改', amount: '15' },
      { name: '新增', amount: 4 },
    ],
    editable: true,
    nextId: createIdFactory(['row-1']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.rows[0].values.name, '甲改')
  assert.equal(result.rows[0].values.amount, 15)
  assert.equal(result.rows[0].values.level, '低')
  assert.equal(result.rows[1].id, 'tmp_1')
  assert.equal(result.rows[1].values.name, '新增')
})

test('不可编辑时导入被拒绝', () => {
  const rows = [{ id: 'row-1', values: { name: '甲', amount: 1, level: '低', score: 2 } }]
  const result = importRows({
    columns,
    rows,
    headers: ['name'],
    records: [{ id: 'row-1', name: '改不到' }],
    editable: false,
    nextId: createIdFactory(['row-1']),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'readonly')
  assert.equal(result.rows, rows)
})

test('错误按行 id 和字段键定位到单元格', () => {
  const marks = locateErrors({
    columns,
    headers: ['__id', '__pick', '名称', '金额', '等级', '测算'],
    rows: [
      { id: 'row-1', values: {} },
      { id: 'row-2', values: {} },
    ],
    errors: { 'row-2': { level: '需要复核' }, missing: { name: '忽略' } },
  })
  assert.deepEqual(marks, [{ rowIndex: 1, colIndex: 4, message: '需要复核' }])
})

test('CSV 往返保留字段键和逗号内容', () => {
  const rows = [{ id: 'row-1', values: { name: '甲,乙', amount: 12, level: '中', score: null } }]
  const parsed = parseCsv(toCsv(columns, rows))
  assert.deepEqual(parsed.headers, ['id', 'name', 'amount', 'level', 'score'])
  assert.equal(parsed.records[0].name, '甲,乙')
  assert.equal(parsed.records[0].amount, '12')
})
