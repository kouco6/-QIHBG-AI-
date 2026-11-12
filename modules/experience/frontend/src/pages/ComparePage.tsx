import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { systemsApi, type SystemRow, type SystemComparison, type SystemComparisonColumn } from '@/services/endpoints'
import { fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

/**
 * 跨系统对比（v1.1 层级合并：产品线 → 系统）。
 * 多选 2–5 个系统 → 调用对比接口 → 以表格呈现各系统 UEI / 扣分等横向对比。
 */
export default function ComparePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const listState = useAsync(() => systemsApi.list({ page_size: '100' }), [])
  const systems = (listState.data?.items ?? []) as SystemRow[]
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<{ message: string; requestId?: string } | null>(null)
  const [result, setResult] = useState<SystemComparison | null>(null)

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function runCompare() {
    if (selected.size < 2) {
      toast.show('请至少选择 2 个系统进行对比', 'warning')
      return
    }
    if (selected.size > 5) {
      toast.show('最多选择 5 个系统进行对比', 'warning')
      return
    }
    setCompareLoading(true)
    setCompareError(null)
    try {
      const r = await systemsApi.compare({ system_ids: Array.from(selected) })
      setResult(r)
    } catch (e) {
      setCompareError({ message: (e as Error).message })
    } finally {
      setCompareLoading(false)
    }
  }

  const compareCols: Column<SystemComparisonColumn>[] = [
    { key: 'name', header: '系统', minWidth: 160, fixed: true, render: (r) => <a href={`/systems/${r.system_id}`} onClick={(e) => { e.preventDefault(); navigate(`/systems/${r.system_id}`) }}>{r.system_name ?? r.system_id}</a> },
    { key: 'auth', header: '权威 UEI', minWidth: 110, align: 'right', className: 'num', render: (r) => fmt1(r.authoritative_uei as unknown as number) },
    { key: 'wavg', header: '加权 UEI', minWidth: 110, align: 'right', className: 'num', render: (r) => fmt1(r.weighted_average_uei as unknown as number) },
    { key: 'bucket', header: '木桶分', minWidth: 100, align: 'right', className: 'num', render: (r) => fmt1(r.bucket_uei as unknown as number) },
    { key: 'eff', header: '有效项目数', minWidth: 100, align: 'right', className: 'num', render: (r) => String(r.effective_project_count ?? '—') },
    { key: 'ded', header: '去重问题数', minWidth: 100, align: 'right', className: 'num', render: (r) => String(r.deduped_issue_count ?? '—') },
  ]

  return (
    <div>
      <PageHeader
        title="跨系统对比"
        subtitle="选择 2–5 个系统进行 UEI / 项目数 / 问题数横向对比。"
        actions={
          <button className="btn btn--primary" disabled={compareLoading || selected.size < 2 || selected.size > 5} onClick={runCompare}>
            {compareLoading ? '对比中…' : '开始对比'}
          </button>
        }
      />

      <AsyncBoundary
        state={listState}
        isEmpty={(d) => !d.items || d.items.length === 0}
        emptyTitle="暂无可对比的系统"
        emptyReason="请先在「系统」中创建并维护系统。"
      >
        {() => (
          <>
            <section className="card">
              <h2 className="card__title">选择系统（已选 {selected.size} / 最多 5）</h2>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {systems.map((l) => {
                  const checked = selected.has(l.id)
                  return (
                    <label key={l.id} className="chip" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked} disabled={!checked && selected.size >= 5} onChange={() => toggle(l.id)} style={{ marginRight: 6 }} />
                      {l.name}
                    </label>
                  )
                })}
              </div>
            </section>

            {compareError ? (
              <div className="state-block" role="alert" style={{ marginTop: 16 }}>
                <div className="state-block__title">对比失败</div>
                <div>{compareError.message}</div>
              </div>
            ) : null}

            {result ? (
              (() => {
                const cols = result.columns ?? []
                const ranks = result.ranking ?? []
                const excluded = result.excluded_from_ranking ?? []
                const rankNameLocal = (sid: string) => cols.find((c) => c.system_id === sid)?.system_name ?? sid
                const excludedLocal = new Set(excluded.map((x) => x.system_id ?? ''))
                return (
              <>
                {result.comparison_note ? (
                  <div className="field-hint" style={{ marginTop: 16 }}>{result.comparison_note}</div>
                ) : null}
                <section className="card" style={{ marginTop: 16 }}>
                  <h2 className="card__title">对比结果（{cols.length} 个系统）</h2>
                  <DataTable
                    columns={compareCols}
                    rows={cols}
                    rowKey={(r) => r.system_id}
                    onRowClick={(r) => navigate(`/systems/${r.system_id}`)}
                    ariaLabel="跨系统对比"
                  />
                  <div className="field-hint" style={{ marginTop: 8 }}>权威 UEI 为排名与对外口径；加权 / 木桶仅供对比参考。</div>
                </section>

                {ranks.length > 0 ? (
                  <section className="card" style={{ marginTop: 16 }}>
                    <h2 className="card__title">排名（按权威 UEI 降序）</h2>
                    <ol style={{ margin: 0, paddingLeft: 18 }}>
                      {ranks.map((sid) => (
                        <li key={sid}>
                          <a href={`/systems/${sid}`} onClick={(e) => { e.preventDefault(); navigate(`/systems/${sid}`) }}>{rankNameLocal(sid)}</a>
                          {excludedLocal.has(sid) ? '（已排除）' : ''}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}

                {excluded.length > 0 ? (
                  <section className="card" style={{ marginTop: 16 }}>
                    <h2 className="card__title">未参与排名</h2>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {excluded.map((x, i) => (
                        <li key={i}>{String(x.system_name ?? x.system_id ?? i)}：{String(x.exclude_reason ?? '样本不足')}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
                )
              })()
            ) : null}
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
