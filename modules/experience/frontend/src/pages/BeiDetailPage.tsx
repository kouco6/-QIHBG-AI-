import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { beiApi, type BeiDetail } from '@/services/endpoints'
import { BEI_DISCLAIMER, BEI_METRIC_BY_KEY, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

/**
 * 事业部 BEI 评价详情（DESIGN §6.2.2 事业部评价 → 详情）。
 * 展示五维度指标、自动/人工/最终分与等级，并附免责声明。
 * BEI 由后端 L3 服务真实计算（预估 / 定榜），403 与 404 分别按无权限、未找到降级。
 */
export default function BeiDetailPage() {
  const { id = '', period = '' } = useParams()
  const toast = useToast()
  const state = useAsync(() => beiApi.get(id, period), [id, period])

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="暂无评价" emptyReason="未找到该事业部在所选季度的 BEI 评价。">
        {(d: BeiDetail) => (
          <>
            <PageHeader
              title={`${d.division_name ?? d.division_id} · ${d.quarter} L3 BEI 详情`}
              subtitle="L3 事业部体验重视度指数：各维度指标取归一化值后按权重加权；人工分仅可作 ±20% 微调。"
              actions={<button className="btn" onClick={() => toast.show('已发起排名重算（演示）', 'info')}>重算排名</button>}
            />

            <div className="grid-cards" style={{ marginBottom: 16 }}>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.final_score)}</span><span className="kpi__label">最终分</span></div>
              <div className="card kpi"><span className="kpi__value">{d.grade ?? '—'}</span><span className="kpi__label">等级</span></div>
              <div className="card kpi"><span className="kpi__value">{fmt1(d.manual_score)}</span><span className="kpi__label">人工分</span></div>
            </div>

            <div className="disclaimer" style={{ marginBottom: 16 }}>{d.disclaimer ?? BEI_DISCLAIMER}</div>

            <section className="card">
              <h2 className="card__title">五维度指标</h2>
              {(d.dimensions ?? []).map((dim) => {
                return (
                  <div key={dim.code} style={{ marginBottom: 14 }}>
                    <div className="row row--between">
                      <strong>{dim.name}（权重 {dim.weight}）</strong>
                      <span className="num">{dim.dimension_score === null || dim.dimension_score === undefined ? '—' : fmt1(dim.dimension_score)}</span>
                    </div>
                    <table className="data-table" style={{ marginTop: 6 }} aria-label={`${dim.name} 指标`}>
                      <thead>
                        <tr>
                          <th style={{ minWidth: 160 }}>指标</th>
                          <th style={{ minWidth: 90 }}>原始值</th>
                          <th style={{ minWidth: 90 }}>归一化</th>
                          <th style={{ minWidth: 70 }}>计分</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(dim.metric_values ?? []).map((m) => {
                          const mm = BEI_METRIC_BY_KEY[m.key]
                          return (
                            <tr key={m.key}>
                              <td>{mm?.name ?? m.key}</td>
                              <td className="num">{m.raw ?? '—'}</td>
                              <td className="num">{m.normalized === null || m.normalized === undefined ? '—' : fmt1(m.normalized)}</td>
                              <td>{m.scoring ? '是' : '否'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
              {(d.dimensions ?? []).length === 0 ? <div className="text-tertiary">暂无维度数据。</div> : null}
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
