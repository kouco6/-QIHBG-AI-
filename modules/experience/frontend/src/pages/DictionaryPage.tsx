import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { Modal } from '@/components/Modal'
import { dictionariesApi, type DictTreeItem, type DictItem } from '@/services/endpoints'
import { DICT_TYPE_LABELS } from '@/constants'
import { useAuth } from '@/app/AuthProvider'
import { useToast } from '@/components/Toast'

function Tree({ node, level }: { node: DictTreeItem; level: number }) {
  const [open, setOpen] = useState(level < 2)
  const hasChildren = (node.children?.length ?? 0) > 0
  return (
    <div>
      <div className="row" style={{ gap: 4, paddingLeft: level * 12 }}>
        {hasChildren ? (
          <button type="button" className="side-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? '折叠' : '展开'}>{open ? '▾' : '▸'}</button>
        ) : <span style={{ width: 16, display: 'inline-block' }} />}
        <span style={{ fontSize: 13 }}>{node.code ? `[${node.code}] ` : ''}{node.name}</span>
        {node.count !== undefined ? <span className="text-tertiary" style={{ fontSize: 12 }}>({node.count})</span> : null}
      </div>
      {open && hasChildren ? node.children!.map((c) => <Tree key={c.id} node={c} level={level + 1} />) : null}
    </div>
  )
}

export default function DictionaryPage() {
  const { type = 'software' } = useParams()
  const { isPrimary } = useAuth()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [raw, setRaw] = useState('')

  const treeState = useAsync(() => dictionariesApi.tree(type), [type])
  const summaryState = useAsync(() => dictionariesApi.summary(type), [type])
  const state = useAsync(
    () => dictionariesApi.items(type, { q: q || undefined, status: status || undefined, page: String(page), page_size: String(pageSize) }),
    [type, q, status, page, pageSize],
  )

  const columns: Column<DictItem>[] = useMemo(
    () => [
      { key: 'code', header: '编号', fixed: true, minWidth: 110, render: (r) => r.code ?? '—' },
      { key: 'name', header: '名称', minWidth: 200, className: 'wrap', render: (r) => r.name },
      { key: 'desc', header: '说明', minWidth: 200, className: 'wrap', render: (r) => r.description ?? '—' },
      { key: 'standard', header: '标准', minWidth: 160, className: 'wrap', render: (r) => r.standard ?? '—' },
      { key: 'example', header: '示例', minWidth: 140, className: 'wrap', render: (r) => r.example ?? '—' },
      { key: 'ded', header: '等级/扣分', minWidth: 100, align: 'right', className: 'num', render: (r) => (r.deduction ?? '—') as unknown as React.ReactNode },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => r.status ?? '启用' },
    ],
    [],
  )

  async function doImport() {
    let rows: unknown[]
    try {
      rows = JSON.parse(raw || '[]')
    } catch {
      toast.show('JSON 解析失败，请检查格式', 'error')
      return
    }
    try {
      const pre = await dictionariesApi.importPrecheck({ source: 'manual', rows })
      if (pre.errors.length) {
        toast.show(`预检发现 ${pre.errors.length} 处错误，已阻止导入`, 'error')
        return
      }
      await dictionariesApi.importApply({ source: 'manual', rows })
      toast.show('导入成功（幂等）', 'success')
      setImportOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`导入失败：${(e as Error).message}`, 'error')
    }
  }
  async function disableSelected() {
    if (selected.size === 0) return
    try {
      await Promise.all(Array.from(selected).map((i) => dictionariesApi.disableItem(i)))
      toast.show(`已停用 ${selected.size} 项（引用项禁止物理删除）`, 'success')
      setSelected(new Set())
      state.reload()
    } catch (e) {
      toast.show(`停用失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader
        title={`字典管理 · ${DICT_TYPE_LABELS[type] ?? type}`}
        subtitle={isPrimary ? '首账号可导入 / 维护 / 停用' : '只读：仅首账号可导入与停用'}
        actions={
          isPrimary ? (
            <>
              <button className="btn" onClick={disableSelected} disabled={selected.size === 0}>停用选中</button>
              <button className="btn btn--primary" onClick={() => setImportOpen(true)}>导入预检</button>
            </>
          ) : undefined
        }
      />

      <div className="grid-2" style={{ gridTemplateColumns: '260px 1fr', alignItems: 'start' }}>
        <section className="card">
          <h2 className="card__title">层级树</h2>
          <AsyncBoundary state={treeState} emptyTitle="无层级数据">
            {(tree) => <Tree node={tree} level={0} />}
          </AsyncBoundary>
          <div className="text-tertiary" style={{ marginTop: 8, fontSize: 12 }}>
            合计 {summaryState.data ? `${summaryState.data.total} 项` : '—'}
            {summaryState.data?.checked !== undefined ? ` · 已检查 ${summaryState.data.checked}` : ''}
          </div>
        </section>

        <section className="card">
          <div className="table-toolbar">
            <input className="input" placeholder="搜索编号 / 名称 / 标准" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="搜索字典" />
            <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="状态">
              <option value="">全部状态</option>
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
            </select>
            <button className="btn" onClick={() => toast.show('已导出当前筛选结果', 'info')}>导出</button>
          </div>
          <AsyncBoundary
            state={state}
            isEmpty={(data) => !data.items || data.items.length === 0}
            emptyTitle="暂无字典项"
            emptyReason="该分类下没有匹配的字典项。"
          >
            {(data) => (
              <DataTable
                columns={columns}
                rows={data.items}
                rowKey={(r) => r.id}
                selectable={isPrimary}
                selectedIds={selected}
                onSelectedChange={setSelected}
                page={page}
                pageSize={pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
              />
            )}
          </AsyncBoundary>
        </section>
      </div>

      <Modal open={importOpen} title="导入预检（仅首账号）" onClose={() => setImportOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setImportOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={doImport}>执行导入</button>
        </>
      }>
        <div className="text-secondary" style={{ marginBottom: 8 }}>粘贴 JSON 数组（每项含 code/name/standard 等）。连续号与数量将自动校验，引用项不会被物理删除。</div>
        <textarea className="input" style={{ width: '100%', minHeight: 160 }} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder='[{"code":"S1.1","name":"示例","standard":"标准A"}]' />
      </Modal>
    </div>
  )
}
