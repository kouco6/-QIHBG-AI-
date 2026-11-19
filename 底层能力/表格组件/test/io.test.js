import assert from 'node:assert/strict'
import test from 'node:test'
import { buildXlsx, parseXlsx } from '../src/io.js'

test('xlsx 往返保留字段键', async () => {
  const columns = [
    { key: 'name', label: '名称' },
    { key: 'amount', label: '金额' },
  ]
  const rows = [{ id: 'row-1', values: { name: '资质甲', amount: 12 } }]
  const buffer = await buildXlsx(columns, rows)
  const parsed = await parseXlsx(buffer)
  assert.deepEqual(parsed.headers, ['id', 'name', 'amount'])
  assert.equal(parsed.records[0].name, '资质甲')
  assert.equal(String(parsed.records[0].amount), '12')
})
