import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { scoringApi, type ScorePreview, type SchemeRow } from '@/services/endpoints'
import { UEI_CATEGORY_LABELS, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

export default function UeiPreviewPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [scheme, setScheme] = useState('')
  const [snapshotting, setSnapshotting] = useState(false)

  const schemesState = useAsync(() => scoringApi.listSchemes(), [])
  const state = useAsync(() => scoringApi.preview(id, scheme ? { scheme_version: scheme } : {}), [id, scheme])

  const columns: Column<NonNullable<ScorePreview['matrix_hits']>[number]>[] = useMemo(
    () => [
      { key: 'issue', header: '问题', minWidth: 200, className: 'wrap', render: (h) => <a href={`/issues/${h.issue_id}`} onClick={(e) => { e.preventDefault(); navigate(`/issues/${h.issue_id}`) }}>{h.description}</a> },
      { key: 'biz', header: '业务等级', minWidth: 90, render: (h) => h.business_level },
      { key: 'sev', header: '问题等级', minWidth: 90, render: (h) => h.severity },
      { key: 'cell', header: '命中单元', minWidth: 120, render: (h) => h.cell },
      { key: 'ded', header: '扣分', minWidth: 80, align: 'right', className: 'num', render: (h) => fmt1(h.deduction) },
    ],
    [navigate],
  )

  async function createSnapshot() {
    setSnapshotting(true)
    try {
      const snap = await scoringApi.createSnapshot(id, { scheme_version: scheme || undefined })
      toast.show('已创建 L1 快照', 'success')
      navigate(`/scores/project-score-snapshots/${snap.id}`)
    } catch (e) {
      toast.show(`创建快照失败：${(e as Error).message}`, 'error')
    } finally {
      setSnapshotting(false)
    }
  }

  return (
    <div>
      <AsyncBoundary
        state={schemesState}
        emptyTitle="无评分方案"
        emptyReason="系统尚未配置评分方案。"
      >
        {(schemes) => (
          <AsyncBoundary state={state} emptyTitle="暂无可预览的评分" emptyReason="该项目没有可计算的扣分数据。">
            {(d: ScorePreview) => (
              <>
                <PageHeader
                  title="UEI 实时预览"
                  subtitle={d.scheme_name ?? d.scheme_version ?? '默认方案'}
                  actions={
                    <>
                      <select className="input" value={scheme} onChange={(e) => setScheme(e.target.value)} aria-label="切换方案">
                        <option value="">默认方案</option>
                        {(schemes.items as SchemeRow[]).map((s) => <option key={s.id} value={s.code}>{s.name}</option>)}
                      </select>
                      <button className="btn btn--primary" onClick={createSnapshot} disabled={snapshotting}>{snapshotting ? '创建中…' : '创建快照'}</button>
                    </>
                  }
                />

                <div className="grid-cards" style={{ marginBottom: 16 }}>
                  <div className="card kpi"><span className="kpi__value glow-number">{fmt1(d.uei)}</span><span className="kpi__label">UEI 总分</span><span className="kpi__note">基准 100 − 总扣分</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.total_deduction)}</span><span className="kpi__label">总扣分</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.core_deduction)}</span><span className="kpi__label">核心业务扣分</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.non_core_deduction)}</span><span className="kpi__label">非核心业务扣分</span></div>
                </div>

                <section className="card" style={{ marginBottom: 16 }}>
                  <h2 className="card__title">8 类计数</h2>
                  <div className="row row--wrap">
                    {Object.entries(UEI_CATEGORY_LABELS).map(([k, label]) => (
                      <div key={k} className="card" style={{ minWidth: 120, boxShadow: 'none', border: '1px solid var(--color-border-default)' }}>
                        <div className="text-secondary" style={{ fontSize: 12 }}>{label}</div>
                        <div className="mono" style={{ fontSize: 20 }}>{d.counts_by_category?.[k] ?? 0}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="card">
                  <h2 className="card__title">逐问题矩阵命中（{d.matrix_hits?.length ?? 0}）</h2>
                  <DataTable
                    columns={columns}
                    rows={d.matrix_hits ?? []}
                    rowKey={(h) => h.issue_id}
                    onRowClick={(h) => navigate(`/issues/${h.issue_id}`)}
                    ariaLabel="矩阵命中"
                  />
                </section>
              </>
            )}
          </AsyncBoundary>
        )}
      </AsyncBoundary>
    </div>
  )
}
