import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { systemsApi, scoringApi, type SystemRow } from '@/services/endpoints'
import { formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

/**
 * 系统列表（v1.1 层级合并：产品线 → 系统）。
 * 系统列表展示名称 / 编码 / 负责人 / 方案版本 / 有效项目数 / 成员数 / 状态 / 更新时间；
 * 支持新建系统与停用。
 */
export default function SystemsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', code: '', scheme_id: '', owner_text: '' })
  const state = useAsync(
    () => systemsApi.list({ q: q || undefined, page: String(page), page_size: String(pageSize) }),
    [q, page, pageSize],
  )
  const schemeState = useAsync(() => scoringApi.listSchemes(), [])
  const schemeOptions = (schemeState.data?.items ?? []).filter((s) => s.is_active !== false)
  const defaultScheme = schemeOptions.find((s) => s.is_default) ?? schemeOptions[0]

  const columns: Column<SystemRow>[] = useMemo(
    () => [
      { key: 'name', header: '名称', fixed: true, minWidth: 160, render: (r) => <a href={`/systems/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/systems/${r.id}`) }}>{r.name}</a> },
      { key: 'code', header: '编码', minWidth: 110, render: (r) => r.code },
      { key: 'owner', header: '负责人', minWidth: 110, render: (r) => r.owner_text ?? '—' },
      { key: 'scheme', header: '方案版本', minWidth: 120, render: (r) => r.scheme_code ?? '—' },
      { key: 'effective', header: '有效项目数', minWidth: 100, align: 'right', className: 'num', render: (r) => r.effective_project_count ?? 0 },
      { key: 'members', header: '成员数', minWidth: 90, align: 'right', className: 'num', render: (r) => r.member_count ?? 0 },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => r.status === 'archived' ? '已停用' : '启用' },
      { key: 'updated', header: '更新时间', minWidth: 130, align: 'right', className: 'num', render: (r) => formatDateTime(r.updated_at) },
    ],
    [navigate],
  )

  function openCreate() {
    setForm({ name: '', code: '', scheme_id: defaultScheme?.id ?? '', owner_text: '' })
    setCreateOpen(true)
  }

  async function onCreate() {
    if (!form.name.trim() || !form.code.trim()) { toast.show('名称与编码必填，且编码唯一', 'warning'); return }
    if (!form.scheme_id) { toast.show('请选择评分方案（系统必须绑定方案）', 'warning'); return }
    try {
      await systemsApi.create({
        name: form.name.trim(),
        code: form.code.trim(),
        scheme_id: form.scheme_id,
        owner_text: form.owner_text.trim(),
      })
      toast.show('系统已创建', 'success')
      setCreateOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    }
  }
  async function archive(r: SystemRow) {
    try {
      await systemsApi.archive(r.id)
      toast.show('已停用（历史保留）', 'success')
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader title="系统" subtitle="系统的创建与管理中枢：新建系统、停用、查看合并 UEI；系统下挂载项目并带权重" actions={
        <>
          <button className="btn" onClick={() => navigate('/systems/compare')}>跨系统对比</button>
          <button className="btn btn--primary" onClick={openCreate}>新建系统</button>
        </>
      } />

      <div className="table-toolbar">
        <input className="input" placeholder="搜索名称 / 编码" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="搜索系统" />
      </div>

      <AsyncBoundary state={state} emptyTitle="暂无系统" emptyReason="还没有创建任何系统。系统是你组织项目、合并 UEI 评价的上层单元——先在这里新建一个系统，再到「工作区 › 项目」或系统详情里把项目归入。">
        {(data) => (
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(r) => r.id}
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            onRowClick={(r) => navigate(`/systems/${r.id}`)}
            rowActions={(r) => (
              <div className="row" style={{ gap: 4 }}>
                <button className="btn" style={{ height: 26, fontSize: 12 }} onClick={(e) => { e.stopPropagation(); navigate(`/systems/${r.id}`) }}>详情</button>
                <button className="btn" style={{ height: 26, fontSize: 12 }} disabled={r.status === 'archived'} onClick={(e) => { e.stopPropagation(); archive(r) }}>停用</button>
              </div>
            )}
          />
        )}
      </AsyncBoundary>

      <Modal open={createOpen} title="新建系统" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={onCreate}>创建</button>
        </>
      }>
        <div className="field">
          <label className="field__label" htmlFor="sys-name">名称<span className="req">*</span></label>
          <input id="sys-name" className="input" style={{ width: '100%' }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="sys-code">编码<span className="req">*</span></label>
          <input id="sys-code" className="input" style={{ width: '100%' }} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="sys-scheme">评分方案<span className="req">*</span></label>
          <select id="sys-scheme" className="input" style={{ width: '100%' }} value={form.scheme_id} onChange={(e) => setForm((f) => ({ ...f, scheme_id: e.target.value }))}>
            <option value="">请选择评分方案</option>
            {schemeOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.is_default ? '（默认）' : ''}</option>
            ))}
          </select>
          <div className="field-hint">系统必须绑定一个评分方案版本，后续统一该口径。</div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="sys-owner">负责人</label>
          <input id="sys-owner" className="input" style={{ width: '100%' }} value={form.owner_text} onChange={(e) => setForm((f) => ({ ...f, owner_text: e.target.value }))} />
        </div>
      </Modal>
    </div>
  )
}
