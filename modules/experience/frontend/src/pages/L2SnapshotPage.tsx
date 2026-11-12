import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { systemsApi, type L2SnapshotDetail, type L2Issue, type L2Source } from '@/services/endpoints'
import { formatDateTime, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

export default function L2SnapshotPage() {
  const { snapshotId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => systemsApi.getSnapshot(snapshotId), [snapshotId])

  const issueCols: Column<NonNullable<L2SnapshotDetail['issues']>[number]>[] = [
    { key: 'issue', header: '问题', minWidth: 200, className: 'wrap', render: (h: L2Issue) => h.issue_code ?? h.issue_id },
    { key: 'biz', header: '业务等级', minWidth: 90, render: (h) => h.business_level },
    { key: 'sev', header: '问题等级', minWidth: 90, render: (h) => h.severity },
    { key: 'cell', header: '单元', minWidth: 120, render: (h) => h.cell_key },
    { key: 'ded', header: '扣分', minWidth: 90, align: 'right', className: 'num', render: (h) => fmt1(h.deduction as unknown as number) },
    { key: 'src', header: '来源项目', minWidth: 140, render: (h) => h.project_name ?? '—' },
  ]

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="系统合并 UEI 快照不存在" emptyReason="未找到该系统评价快照。">
        {(d: L2SnapshotDetail) => (
          <>
            <PageHeader
              title="系统合并 UEI 快照（只读）"
              subtitle={`${d.system_name ?? ''} · 方案 ${d.scheme_code ?? ''} · ${d.selection_mode ?? ''}`}
              actions={
                <>
                  <button className="btn" onClick={() => toast.show('快照已导出', 'info')}>导出</button>
                  <button className="btn btn--primary" onClick={() => navigate('/systems')}>返回系统</button>
                </>
              }
            />

            <div className="grid-cards" style={{ marginBottom: 16 }}>
              <div className="card kpi"><span className="kpi__value glow-number">{fmt1(d.authoritative_uei as unknown as number)}</span><span className="kpi__label">权威 UEI（去重重算）</span></div>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.weighted_average_uei as unknown as number)}</span><span className="kpi__label">加权 UEI（默认展示）</span></div>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.bucket_uei as unknown as number)}</span><span className="kpi__label">木桶分</span></div>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.total_deduction as unknown as number)}</span><span className="kpi__label">总扣分</span></div>
              <div className="card kpi"><span className="kpi__value">{formatDateTime(d.snapshot_at)}</span><span className="kpi__label">快照时间</span></div>
            </div>

            <div className="disclaimer" style={{ marginBottom: 16 }}>
              快照为不可变留痕，不提供编辑/删除；跨项目问题已按口径去重，权威来源取系统当前方案。
            </div>

            <section className="card" style={{ marginBottom: 16 }}>
              <h2 className="card__title">来源项目（{d.sources?.length ?? 0}）</h2>
              <table className="data-table" aria-label="来源项目">
                <thead>
                  <tr><th>项目</th><th>版本</th><th>权重</th><th>单项目 UEI</th><th>问题数</th><th>口径</th></tr>
                </thead>
                <tbody>
                  {(d.sources ?? []).map((s: L2Source) => (
                    <tr key={s.project_id}>
                      <td>
                        {s.l1_snapshot_id ? (
                          <a href={`/scores/project-score-snapshots/${s.l1_snapshot_id}`} onClick={(e) => { e.preventDefault(); navigate(`/scores/project-score-snapshots/${s.l1_snapshot_id}`) }}>{s.project_name ?? s.l1_snapshot_id}</a>
                        ) : (
                          (s.project_name ?? '—')
                        )}
                      </td>
                      <td>{s.version_code ?? '—'}</td>
                      <td className="num">{String(s.weight ?? '—')}</td>
                      <td className="num">{fmt1(s.project_uei as unknown as number)}</td>
                      <td className="num">{String(s.issue_count ?? '—')}</td>
                      <td>{s.is_out_of_scope ? '口径外' : '口径内'}</td>
                    </tr>
                  ))}
                  {(d.sources ?? []).length === 0 ? <tr><td colSpan={6} className="text-tertiary">暂无来源</td></tr> : null}
                </tbody>
              </table>
            </section>

            <section className="card">
              <h2 className="card__title">逐项扣分（{d.issues?.length ?? 0}）</h2>
              <DataTable columns={issueCols} rows={d.issues ?? []} rowKey={(h) => h.issue_id} ariaLabel="系统合并 UEI 快照明细" />
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
