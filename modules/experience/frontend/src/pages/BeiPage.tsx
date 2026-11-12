import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { beiApi, type BeiQuarter } from '@/services/endpoints'
import { BEI_DISCLAIMER, fmt1 } from '@/constants'

/**
 * 事业部体验重视度指数（BEI）总览（DESIGN §6.2.2 事业部评价）。
 */
export default function BeiPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState('')
  const state = useAsync<{ items: BeiQuarter[] }>(() => beiApi.list(period ? { quarter: period } : {}), [period])

  const columns: Column<NonNullable<BeiQuarter['divisions'][number]>>[] = [
    { key: 'name', header: '事业部', minWidth: 160, render: (d) => d.name },
    { key: 'sample', header: '取样状态', minWidth: 120, render: (d) => d.sample_status },
    { key: 'auto', header: '自动分', minWidth: 100, align: 'right', className: 'num', render: (d) => (d.auto_score !== undefined ? fmt1(d.auto_score) : '—') },
    { key: 'manual', header: '人工分', minWidth: 100, align: 'right', className: 'num', render: (d) => (d.manual_score !== undefined ? fmt1(d.manual_score) : '—') },
    { key: 'final', header: '最终分', minWidth: 100, align: 'right', className: 'num', render: (d) => (d.final_score !== undefined ? fmt1(d.final_score) : '—') },
    { key: 'grade', header: '等级', minWidth: 90, render: (d) => d.grade ?? '—' },
    { key: 'rank', header: '排名状态', minWidth: 110, render: (d) => d.ranking_status ?? '—' },
  ]

  return (
    <div>
      <PageHeader
        title="事业部体验重视度指数（BEI）"
        subtitle="按季度对事业部在体验问题上的响应、闭环、整改与成效进行评价。"
        actions={
          <input
            className="input"
            style={{ width: 160 }}
            placeholder="季度（如 2025Q1）"
            value={period}
            onChange={(e) => setPeriod(e.target.value.trim())}
          />
        }
      />

      <div className="disclaimer" style={{ marginBottom: 16 }}>{BEI_DISCLAIMER}</div>

      <AsyncBoundary
        state={state}
        isEmpty={(d) => !d.items || d.items.length === 0}
        emptyTitle="暂无 BEI 数据"
        emptyReason="该季度暂无 BEI 评价；可切换季度或先完成问题闭环与验收。"
      >
        {(d) => (
          <>
            {(d.items ?? []).map((q) => (
              <section className="card" key={q.quarter} style={{ marginBottom: 16 }}>
                <h2 className="card__title">季度 {q.quarter}（{q.divisions.length} 个事业部）</h2>
                <DataTable
                  columns={columns}
                  rows={q.divisions}
                  rowKey={(dd) => dd.id}
                  onRowClick={(dd) => navigate(`/divisions/${dd.id}/bei/${q.quarter}`)}
                  ariaLabel={`${q.quarter} BEI`}
                />
              </section>
            ))}
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
