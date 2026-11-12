import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { FormField, ErrorSummary } from '@/components/FormField'
import { projectsApi, systemsApi, type ProjectRow } from '@/services/endpoints'
import { formatDateTime, PROJECT_TYPE_LABELS, PROJECT_TYPES } from '@/constants'
import { useToast } from '@/components/Toast'

export default function ProjectsListPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', system_id: '', version_code: '', project_type: 'new_product' })
  const [systems, setSystems] = useState<Array<{ id: string; name: string }>>([])
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string[]>([])

  useEffect(() => {
    systemsApi
      .list({ page_size: 200 })
      .then((p) => setSystems(p.items ?? []))
      .catch(() => setSystems([]))
  }, [])

  const state = useAsync(
    () =>
      projectsApi.list({
        q: name || undefined,
        type: type || undefined,
        status: status || undefined,
        page: String(page),
        page_size: String(pageSize),
        sort: 'updated_at',
        order: 'desc',
      }),
    [name, type, status, page, pageSize],
  )

  const columns: Column<ProjectRow>[] = useMemo(
    () => [
      { key: 'name', header: '项目名', fixed: true, minWidth: 160, render: (r) => <a href={`/projects/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/projects/${r.id}`) }}>{r.name}</a> },
      { key: 'system', header: '系统', minWidth: 120, render: (r) => r.system?.name ?? '—' },
      { key: 'version', header: '版本', minWidth: 100, render: (r) => r.version_name ?? '—' },
      { key: 'type', header: '类型', minWidth: 100, render: (r) => PROJECT_TYPE_LABELS[r.type ?? ''] ?? r.type ?? '—' },
      { key: 'owner', header: '负责人', minWidth: 100, render: (r) => r.owner_name ?? '—' },
      { key: 'division', header: '事业部', minWidth: 120, render: (r) => r.division_name ?? '—' },
      { key: 'node', header: '当前节点', minWidth: 120, render: (r) => r.current_node_name ?? r.current_node_code ?? '—' },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => (r.archived ? '已归档' : '进行中') },
      { key: 'updater', header: '更新人', minWidth: 100, render: (r) => r.updated_by_name ?? '—' },
      { key: 'updated', header: '更新时间', minWidth: 140, align: 'right', className: 'num', render: (r) => formatDateTime(r.updated_at) },
    ],
    [navigate],
  )

  async function onBatchArchive() {
    if (selected.size === 0) return
    try {
      await projectsApi.batchArchive(Array.from(selected))
      toast.show(`已归档 ${selected.size} 个项目`, 'success')
      setSelected(new Set())
      state.reload()
    } catch (e) {
      toast.show(`批量归档失败：${(e as Error).message}`, 'error')
    }
  }

  function onExport() {
    const ids = Array.from(selected)
    toast.show(ids.length ? `已导出选中的 ${ids.length} 个项目` : '已导出当前筛选结果', 'info')
  }

  function openCreate() {
    setForm({ name: '', system_id: '', version_code: '', project_type: 'new_product' })
    setFormError([])
    setCreateOpen(true)
  }
  async function onSubmitCreate() {
    const errs: string[] = []
    if (!form.name.trim()) errs.push('项目名称必填')
    if (!form.system_id) errs.push('请选择系统')
    if (!form.version_code.trim()) errs.push('版本编码必填')
    setFormError(errs)
    if (errs.length) return
    setCreating(true)
    try {
      const created = await projectsApi.create({
        name: form.name.trim(),
        system_id: form.system_id,
        project_type: form.project_type,
        version_code: form.version_code.trim(),
      })
      toast.show('项目已创建', 'success')
      setCreateOpen(false)
      navigate(`/projects/${created.id}`)
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="项目"
        subtitle="体验执行的主线；按更新时间倒序展示"
        actions={
          <>
            <button type="button" className="btn" onClick={onBatchArchive} disabled={selected.size === 0}>批量归档（{selected.size}）</button>
            <button type="button" className="btn" onClick={onExport}>导出</button>
            <button type="button" className="btn btn--primary" onClick={openCreate}>新建项目</button>
          </>
        }
      />

      <Modal
        open={createOpen}
        title="新建项目"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="btn btn--primary" onClick={onSubmitCreate} disabled={creating}>{creating ? '创建中…' : '创建'}</button>
          </>
        }
      >
        <ErrorSummary
          errors={formError}
          items={formError.map((message) => ({
            message,
            fieldId: message.includes('项目名称')
              ? 'np-name'
              : message.includes('系统')
                ? 'np-system'
                : message.includes('版本')
                  ? 'np-version'
                  : undefined,
          }))}
        />
        <FormField label="项目名称" required htmlFor="np-name">
          <input id="np-name" className="input" style={{ width: '100%' }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </FormField>
        <FormField label="所属系统" required htmlFor="np-system">
          <select id="np-system" className="input" style={{ width: '100%' }} value={form.system_id} onChange={(e) => setForm((f) => ({ ...f, system_id: e.target.value }))}>
            <option value="">请选择系统</option>
            {systems.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="版本编码" required htmlFor="np-version">
          <input id="np-version" className="input" style={{ width: '100%' }} placeholder="如 V7.32" value={form.version_code} onChange={(e) => setForm((f) => ({ ...f, version_code: e.target.value }))} />
        </FormField>
        <FormField label="项目类型" required htmlFor="np-type">
          <select id="np-type" className="input" style={{ width: '100%' }} value={form.project_type} onChange={(e) => setForm((f) => ({ ...f, project_type: e.target.value }))}>
            {PROJECT_TYPES.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
        </FormField>
      </Modal>

      <div className="table-toolbar">
        <input className="input" placeholder="搜索项目名" value={name} onChange={(e) => { setName(e.target.value); setPage(1) }} aria-label="搜索项目名" />
        <select className="input" value={type} onChange={(e) => { setType(e.target.value); setPage(1) }} aria-label="项目类型">
          <option value="">全部类型</option>
          <option value="new_product">新产品</option>
          <option value="iteration">迭代产品</option>
        </select>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="项目状态">
          <option value="">全部状态</option>
          <option value="active">进行中</option>
          <option value="archived">已归档</option>
        </select>
      </div>

      <AsyncBoundary
        state={state}
        emptyTitle="暂无项目"
        emptyReason="还没有创建任何体验执行项目。"
        emptyAction={<button className="btn btn--primary" onClick={openCreate}>新建项目</button>}
      >
        {(data) => (
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(r) => r.id}
            selectable
            selectedIds={selected}
            onSelectedChange={setSelected}
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            onRowClick={(r) => navigate(`/projects/${r.id}`)}
            rangeHint={selected.size > 0 ? `已选 ${selected.size} 条（跨页选择有效）` : undefined}
            ariaLabel="项目列表"
          />
        )}
      </AsyncBoundary>
    </div>
  )
}
