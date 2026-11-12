import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { systemsApi } from '@/services/endpoints'
import { fmt1 } from '@/constants'

/**
 * 系统统计大盘（v1.1 层级合并：产品线 → 系统）。
 * 用 systemsApi.analytics(id)（即后端 L2PreviewOut）展示来源项目 / 问题 / 单元计数 /
 * 排名（项目 UEI 偏差）/ 暴露热点 / 趋势 / 三口径 UEI / 样本充分性提示。
 * 该接口返回未适配的 Record，这里按呈现需要局部读取。
 */
interface L2Source {
  project_id: string
  project_name: string
  version_code?: string
  weight?: string
  project_uei?: string
  issue_count?: number
  is_out_of_scope?: boolean
}
interface L2Issue {
  issue_id: string
  issue_code?: string
  business_level: string
  severity: string
  cell_key: string
  deduction: string
  project_id?: string
  project_name?: string
}
interface L2Rank {
  project_id: string
  project_name: string
  project_uei?: string
  deviation?: string
  issue_count?: number
}
interface L2Preview {
  scheme?: { code?: string; name?: string }
  selection_mode_label?: string
  sources?: L2Source[]
  issues?: L2Issue[]
  cell_counts?: Record<string, number>
  core_deduction?: string
  non_core_deduction?: string
  total_deduction?: string
  raw_issue_count?: number
  source_snapshot_count?: number
  effective_project_count?: number
  outlier_project_count?: number
  deduped_issue_count?: number
  authoritative_uei?: string
  display_uei?: string
  auxiliary?: { weighted_average_uei?: string; bucket_uei?: string; caliber_weighted?: string; caliber_bucket?: string }
  sample_sufficient?: boolean
  sample_gap?: string
  rankings?: L2Rank[]
  top_exposure?: Array<Record<string, unknown>>
  trend?: Array<Record<string, unknown>>
  caliber_note?: string
}

export default function SystemAnalyticsPage() {
  const { id = '' } = useParams()
  const state = useAsync(() => systemsApi.analytics(id), [id])

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="暂无统计" emptyReason="该系统尚无评价数据，无法生成统计。">
        {(raw: Record<string, unknown>) => {
          const d = raw as unknown as L2Preview
          const sources = d.sources ?? []
          const issues = d.issues ?? []
          const ranks = d.rankings ?? []
          const scheme = d.scheme ?? {}
          const cellEntries = Object.entries(d.cell_counts ?? {})
          const topExposure = d.top_exposure ?? []
          const trend = d.trend ?? []
          return (
            <>
              <PageHeader
                title="系统统计（只读）"
                subtitle={`${String(raw.system_name ?? '')} · 方案 ${String(scheme.code ?? '—')} · ${String(d.selection_mode_label ?? '')}`}
              />

              <div className="grid-cards" style={{ marginBottom: 16 }}>
                <div className="card kpi"><span className="kpi__value glow-number">{fmt1(d.authoritative_uei as unknown as number)}</span><span className="kpi__label">权威 UEI（去重重算）</span></div>
                <div className="card kpi"><span className="kpi__value">{fmt1(d.auxiliary?.weighted_average_uei as unknown as number)}</span><span className="kpi__label">加权 UEI（默认展示）</span></div>
                <div className="card kpi"><span className="kpi__value">{fmt1(d.auxiliary?.bucket_uei as unknown as number)}</span><span className="kpi__label">木桶分</span></div>
                <div className="card kpi"><span className="kpi__value">{String(d.deduped_issue_count ?? '—')}</span><span className="kpi__label">去重问题数</span></div>
                <div className="card kpi"><span className="kpi__value">{fmt1(d.total_deduction as unknown as number)}</span><span className="kpi__label">总扣分</span></div>
                <div className="card kpi"><span className="kpi__value">{String(d.effective_project_count ?? '—')}</span><span className="kpi__label">有效项目数</span></div>
              </div>

              <section className="card" style={{ marginBottom: 16 }}>
                <h2 className="card__title">口径与样本</h2>
                <dl className="detail-grid">
                  <dt>权威口径</dt><dd>{String(d.caliber_note ?? '—')}</dd>
                  <dt>样本状态</dt><dd>{d.sample_sufficient === false ? '样本不足，不排名' : '样本充足'}</dd>
                  <dt>样本缺口</dt><dd>{String(d.sample_gap ?? '—')}</dd>
                  <dt>原始问题数</dt><dd className="num">{String(d.raw_issue_count ?? '—')}</dd>
                  <dt>来源快照数</dt><dd className="num">{String(d.source_snapshot_count ?? '—')}</dd>
                  <dt>核心扣分</dt><dd className="num">{fmt1(d.core_deduction as unknown as number)}</dd>
                  <dt>非核心扣分</dt><dd className="num">{fmt1(d.non_core_deduction as unknown as number)}</dd>
                </dl>
              </section>

              {ranks.length > 0 ? (
                <section className="card" style={{ marginBottom: 16 }}>
                  <h2 className="card__title">项目 UEI 偏差排名（按权威 UEI 降序）</h2>
                  <table className="data-table" aria-label="项目 UEI 偏差">
                    <thead>
                      <tr><th>项目</th><th>单项目 UEI</th><th>与系统偏差</th><th>问题数</th></tr>
                    </thead>
                    <tbody>
                      {ranks.map((r) => (
                        <tr key={r.project_id}>
                          <td>{r.project_name}</td>
                          <td className="num">{fmt1(r.project_uei as unknown as number)}</td>
                          <td className="num">{fmt1(r.deviation as unknown as number)}</td>
                          <td className="num">{String(r.issue_count ?? '—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {topExposure.length > 0 ? (
                <section className="card" style={{ marginBottom: 16 }}>
                  <h2 className="card__title">暴露热点（Top Exposure）</h2>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {topExposure.map((t, i) => (
                      <li key={i}>{String(t.label ?? t.key ?? i)}：{String(t.issue_count ?? '—')}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {trend.length > 0 ? (
                <section className="card" style={{ marginBottom: 16 }}>
                  <h2 className="card__title">趋势（Trend）</h2>
                  <table className="data-table" aria-label="趋势">
                    <thead>
                      <tr><th>版本</th><th>项目数</th><th>去重问题数</th><th>UEI</th></tr>
                    </thead>
                    <tbody>
                      {trend.map((t, i) => (
                        <tr key={i}>
                          <td>{String(t.version_code ?? '—')}</td>
                          <td className="num">{String(t.project_count ?? '—')}</td>
                          <td className="num">{String(t.deduped_issue_count ?? '—')}</td>
                          <td className="num">{fmt1(t.uei as unknown as number)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              <section className="card" style={{ marginBottom: 16 }}>
                <h2 className="card__title">单元计数（{cellEntries.length}）</h2>
                <div className="row row--wrap">
                  {cellEntries.map(([k, v]) => (
                    <div key={k} className="card" style={{ minWidth: 120, boxShadow: 'none', border: '1px solid var(--color-border-default)' }}>
                      <div className="text-secondary" style={{ fontSize: 12 }}>{k}</div>
                      <div className="mono" style={{ fontSize: 20 }}>{v}</div>
                    </div>
                  ))}
                  {cellEntries.length === 0 ? <div className="text-tertiary">暂无单元计数</div> : null}
                </div>
              </section>

              <section className="card" style={{ marginBottom: 16 }}>
                <h2 className="card__title">来源项目（{sources.length}）</h2>
                <table className="data-table" aria-label="来源项目">
                  <thead>
                    <tr><th>项目</th><th>版本</th><th>权重</th><th>单项目 UEI</th><th>问题数</th><th>口径</th></tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.project_id}>
                        <td>{String(s.project_name ?? '—')}</td>
                        <td>{String(s.version_code ?? '—')}</td>
                        <td className="num">{String(s.weight ?? '—')}</td>
                        <td className="num">{fmt1(s.project_uei as unknown as number)}</td>
                        <td className="num">{String(s.issue_count ?? '—')}</td>
                        <td>{s.is_out_of_scope ? '口径外' : '口径内'}</td>
                      </tr>
                    ))}
                    {sources.length === 0 ? <tr><td colSpan={6} className="text-tertiary">暂无可计入的项目快照</td></tr> : null}
                  </tbody>
                </table>
              </section>

              <section className="card">
                <h2 className="card__title">问题清单（{issues.length}）</h2>
                <table className="data-table" aria-label="问题清单">
                  <thead>
                    <tr><th>问题</th><th>业务等级</th><th>问题等级</th><th>单元</th><th>扣分</th><th>来源项目</th></tr>
                  </thead>
                  <tbody>
                    {issues.map((h) => (
                      <tr key={h.issue_id}>
                        <td className="wrap">{h.issue_code ?? h.issue_id}</td>
                        <td>{h.business_level}</td>
                        <td>{h.severity}</td>
                        <td>{h.cell_key}</td>
                        <td className="num">{fmt1(h.deduction as unknown as number)}</td>
                        <td>{String(h.project_name ?? '—')}</td>
                      </tr>
                    ))}
                    {issues.length === 0 ? <tr><td colSpan={6} className="text-tertiary">暂无可计入的问题</td></tr> : null}
                  </tbody>
                </table>
              </section>
            </>
          )
        }}
      </AsyncBoundary>
    </div>
  )
}
