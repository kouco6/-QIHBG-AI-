import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { ReviewStatusBadge } from '@/components/StatusBadge'
import { reviewsApi, projectsApi, type ReviewRow } from '@/services/endpoints'
import { REVIEW_KINDS, formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

export default function ReviewsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ project_id: '', review_kind: 'release', title: '' })
  const state = useAsync(() => reviewsApi.list({ page: String(page), page_size: String(pageSize) }), [page, pageSize])
  const projectState = useAsync(() => projectsApi.list({ page_size: 200 }), [])
  const projectOptions = projectState.data?.items ?? []

  const columns: Column<ReviewRow>[] = useMemo(
    () => [
      { key: 'project', header: '项目', minWidth: 160, render: (r) => r.project_name ?? '—' },
      { key: 'version', header: '版本', minWidth: 100, render: (r) => r.version_name ?? '—' },
      { key: 'stage', header: '阶段', minWidth: 90, render: (r) => r.stage ?? '—' },
      { key: 'conclusion', header: '结论', minWidth: 120, render: (r) => r.conclusion ?? '—' },
      { key: 'disputes', header: '争议数', minWidth: 80, align: 'right', className: 'num', render: (r) => r.dispute_count ?? 0 },
      { key: 'reviewed', header: '评审时间', minWidth: 140, align: 'right', className: 'num', render: (r) => formatDateTime(r.reviewed_at) },
      { key: 'updated', header: '更新', minWidth: 130, align: 'right', className: 'num', render: (r) => formatDateTime(r.updated_at) },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => <ReviewStatusBadge status={r.status ?? 'before'} /> },
    ],
    [],
  )

  async function onCreate() {
    if (!form.project_id) { toast.show('请选择项目', 'warning'); return }
    if (!form.title.trim()) { toast.show('评审标题必填', 'warning'); return }
    try {
      const created = await reviewsApi.create({
        project_id: form.project_id,
        review_kind: form.review_kind,
        title: form.title.trim(),
      })
      toast.show('评审已创建', 'success')
      setCreateOpen(false)
      setForm({ project_id: '', review_kind: 'release', title: '' })
      navigate(`/reviews/${created.id}`)
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader title="评审工作区" subtitle="系统内部评审；不创建外部账号" actions={<button className="btn btn--primary" onClick={() => setCreateOpen(true)}>新建评审</button>} />

      <AsyncBoundary state={state} emptyTitle="暂无评审" emptyReason="还没有评审记录。">
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
            onRowClick={(r) => navigate(`/reviews/${r.id}`)}
            ariaLabel="评审列表"
          />
        )}
      </AsyncBoundary>

      <Modal open={createOpen} title="新建评审" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={onCreate}>创建</button>
        </>
      }>
        <div className="field">
          <label className="field__label" htmlFor="rv-proj">项目<span className="req">*</span></label>
          <select id="rv-proj" className="input" style={{ width: '100%' }} value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
            <option value="">请选择项目</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="rv-kind">评审类型<span className="req">*</span></label>
          <select id="rv-kind" className="input" style={{ width: '100%' }} value={form.review_kind} onChange={(e) => setForm((f) => ({ ...f, review_kind: e.target.value }))}>
            {REVIEW_KINDS.map((k) => (
              <option key={k.code} value={k.code}>{k.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="rv-title">评审标题<span className="req">*</span></label>
          <input id="rv-title" className="input" style={{ width: '100%' }} placeholder="如 会议一体机 V7.32 发布体验评审" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </div>
      </Modal>
    </div>
  )
}
