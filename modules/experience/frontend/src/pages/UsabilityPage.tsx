import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { StudyStatusBadge } from '@/components/StatusBadge'
import { usabilityApi, projectsApi, type StudyRow } from '@/services/endpoints'
import { STUDY_TYPE_LABELS, formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

export default function UsabilityPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', project_id: '', study_kind: 'usability_test' })
  const state = useAsync(() => usabilityApi.list({ page: String(page), page_size: String(pageSize) }), [page, pageSize])
  const projectState = useAsync(() => projectsApi.list({ page_size: 200 }), [])
  const projectOptions = projectState.data?.items ?? []

  const columns: Column<StudyRow>[] = useMemo(
    () => [
      { key: 'name', header: '研究', fixed: true, minWidth: 200, className: 'wrap', render: (r) => <a href={`/usability/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/usability/${r.id}`) }}>{r.name}</a> },
      { key: 'proj', header: '项目 / 版本', minWidth: 180, render: (r) => `${r.project_name ?? '—'}${r.version_name ? ` / ${r.version_name}` : ''}` },
      { key: 'type', header: '类型', minWidth: 110, render: (r) => STUDY_TYPE_LABELS[r.study_type ?? ''] ?? r.study_type ?? '—' },
      { key: 'p', header: '参与者', minWidth: 80, align: 'right', className: 'num', render: (r) => r.participant_count ?? 0 },
      { key: 't', header: '任务', minWidth: 80, align: 'right', className: 'num', render: (r) => r.task_count ?? 0 },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => <StudyStatusBadge status={r.status ?? 'draft'} /> },
      { key: 'updated', header: '更新', minWidth: 130, align: 'right', className: 'num', render: (r) => formatDateTime(r.updated_at) },
    ],
    [navigate],
  )

  async function onCreate() {
    if (!form.name.trim()) { toast.show('研究名称必填', 'warning'); return }
    if (!form.project_id) { toast.show('请选择项目', 'warning'); return }
    try {
      const created = await usabilityApi.create({
        name: form.name.trim(),
        project_id: form.project_id,
        study_kind: form.study_kind,
      })
      toast.show('已新建研究', 'success')
      setCreateOpen(false)
      setForm({ name: '', project_id: '', study_kind: 'usability_test' })
      navigate(`/usability/${created.id}`)
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader title="可用性研究" subtitle="建立研究、参与者、任务与统计" actions={<button className="btn btn--primary" onClick={() => setCreateOpen(true)}>新建研究</button>} />

      <AsyncBoundary state={state} emptyTitle="暂无研究" emptyReason="还没有可用性研究。">
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
            onRowClick={(r) => navigate(`/usability/${r.id}`)}
          />
        )}
      </AsyncBoundary>

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn" onClick={() => toast.show('已复制选中研究', 'info')}>复制</button>
        <button className="btn" onClick={() => toast.show('已导出研究清单', 'info')}>导出</button>
      </div>

      <Modal open={createOpen} title="新建可用性研究" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={onCreate}>创建</button>
        </>
      }>
        <div className="field">
          <label className="field__label" htmlFor="st-name">研究名称<span className="req">*</span></label>
          <input id="st-name" className="input" style={{ width: '100%' }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="st-proj">项目<span className="req">*</span></label>
            <select id="st-proj" className="input" style={{ width: '100%' }} value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
              <option value="">请选择项目</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="st-kind">类型</label>
            <select id="st-kind" className="input" style={{ width: '100%' }} value={form.study_kind} onChange={(e) => setForm((f) => ({ ...f, study_kind: e.target.value }))}>
              {Object.entries(STUDY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  )
}
