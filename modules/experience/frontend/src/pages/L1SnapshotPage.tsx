import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { scoringApi, type SnapshotDetail } from '@/services/endpoints'
import { formatDateTime, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

export default function L1SnapshotPage() {
  const { snapshotId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => scoringApi.getSnapshot(snapshotId), [snapshotId])

  const columns: Column<NonNullable<SnapshotDetail['issues']>[number]>[] = [
    { key: 'issue', header: '问题', minWidth: 200, className: 'wrap', render: (h) => <a href={`/issues/${h.issue_id}`} onClick={(e) => { e.preventDefault(); navigate(`/issues/${h.issue_id}`) }}>{h.description}</a> },
    { key: 'biz', header: '业务等级', minWidth: 90, render: (h) => h.business_level },
    { key: 'sev', header: '问题等级', minWidth: 90, render: (h) => h.severity },
    { key: 'cell', header: '命中单元', minWidth: 120, render: (h) => h.cell },
    { key: 'ded', header: '扣分', minWidth: 80, align: 'right', className: 'num', render: (h) => fmt1(h.deduction) },
  ]

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="快照不存在" emptyReason="未找到该 L1 快照。">
        {(d) => (
          <>
            <PageHeader
              title="L1 快照详情（只读）"
              subtitle={`${d.project_name ?? ''} ${d.version_name ?? ''} · 方案 ${d.scheme_version ?? ''}`}
              actions={
                <>
                  <button className="btn" onClick={() => toast.show('快照已导出', 'info')}>导出</button>
                  <button className="btn btn--primary" onClick={() => d.project_id ? navigate(`/projects/${d.project_id}/scores/preview`) : undefined}>复制为新预览</button>
                </>
              }
            />

            <div className="grid-cards" style={{ marginBottom: 16 }}>
              <div className="card kpi"><span className="kpi__value glow-number">{fmt1(d.uei)}</span><span className="kpi__label">UEI 总分</span></div>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.total_deduction)}</span><span className="kpi__label">总扣分</span></div>
              <div className="card kpi"><span className="kpi__value">{d.issue_count ?? d.issues?.length ?? 0}</span><span className="kpi__label">问题数</span></div>
              <div className="card kpi"><span className="kpi__value">{formatDateTime(d.created_at)}</span><span className="kpi__label">快照时间</span></div>
            </div>

            <div className="disclaimer" style={{ marginBottom: 16 }}>
              快照为不可变留痕，不提供编辑/删除；所有扣分均按所记录方案版本与阈值版本计算。
            </div>

            <section className="card">
              <h2 className="card__title">逐项扣分（{d.issues?.length ?? 0}）</h2>
              <DataTable columns={columns} rows={d.issues ?? []} rowKey={(h) => h.issue_id} onRowClick={(h) => navigate(`/issues/${h.issue_id}`)} ariaLabel="快照明细" />
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
