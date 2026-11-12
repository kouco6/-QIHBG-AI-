import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { JobStatusBadge } from '@/components/StatusBadge'
import { providerJobsApi, type ProviderJob } from '@/services/endpoints'
import { formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

export default function ProviderJobsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [status, setStatus] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)
  const state = useAsync(
    () => providerJobsApi.list({ status: status || undefined, page: String(page), page_size: String(pageSize) }),
    [status, page, pageSize],
  )

  const columns: Column<ProviderJob>[] = useMemo(
    () => [
      { key: 'type', header: '类型', fixed: true, minWidth: 130, render: (r) => r.type },
      { key: 'target', header: '目标', minWidth: 160, className: 'wrap', render: (r) => r.target ?? '—' },
      { key: 'idempotency', header: '幂等键', minWidth: 150, render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.idempotency_key ?? '—'}</span> },
      { key: 'mode', header: '模式', minWidth: 90, render: (r) => r.mode ?? '—' },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => <JobStatusBadge status={r.status} /> },
      { key: 'progress', header: '进度', minWidth: 100, align: 'right', className: 'num', render: (r) => r.progress !== undefined ? `${Math.round((r.progress ?? 0) * 100)}%` : '—' },
      { key: 'retry', header: '重试数', minWidth: 80, align: 'right', className: 'num', render: (r) => r.retry_count ?? 0 },
      { key: 'updated', header: '时间', minWidth: 130, align: 'right', className: 'num', render: (r) => formatDateTime(r.updated_at) },
    ],
    [],
  )

  async function retry(j: ProviderJob) {
    if (j.status !== 'failed') { toast.show('仅失败作业可重试', 'warning'); return }
    try {
      await providerJobsApi.retry(j.id)
      toast.show('已提交重试（新作业）', 'success')
      state.reload()
    } catch (e) {
      toast.show(`重试失败：${(e as Error).message}`, 'error')
    }
  }
  async function cancel(j: ProviderJob) {
    if (j.status !== 'queued' && j.status !== 'running') { toast.show('仅 queued / running 可取消', 'warning'); return }
    try {
      await providerJobsApi.cancel(j.id)
      toast.show('已取消作业', 'success')
      state.reload()
    } catch (e) {
      toast.show(`取消失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader
        title="Provider 作业"
        subtitle="同步 / 分析 / 导出等异步任务；running 不重复提交"
        actions={<button className="btn" onClick={() => toast.show('已导出作业清单', 'info')}>导出</button>}
      />

      <div className="table-toolbar">
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="状态筛选">
          <option value="">全部状态</option>
          {['queued', 'running', 'succeeded', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <AsyncBoundary state={state} emptyTitle="暂无作业" emptyReason="还没有 Provider 作业。">
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
            onRowClick={() => navigate('/provider-jobs')}
            rowActions={(r) => (
              <div className="row" style={{ gap: 4 }}>
                <button className="btn" style={{ height: 26, fontSize: 12 }} disabled={r.status !== 'failed'} onClick={(e) => { e.stopPropagation(); retry(r) }}>重试</button>
                <button className="btn" style={{ height: 26, fontSize: 12 }} disabled={r.status !== 'queued' && r.status !== 'running'} onClick={(e) => { e.stopPropagation(); cancel(r) }}>取消</button>
                <button className="btn" style={{ height: 26, fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setReceipt(r.receipt ?? '（无回执）') }}>回执</button>
              </div>
            )}
          />
        )}
      </AsyncBoundary>

      <Modal open={receipt !== null} title="作业回执" onClose={() => setReceipt(null)}>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{receipt}</pre>
      </Modal>
    </div>
  )
}
