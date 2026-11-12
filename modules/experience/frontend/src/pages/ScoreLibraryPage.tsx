import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { scoreLibraryApi, SCORE_LIBRARY_LEVELS, type ScoreLibraryLevel, type LibraryEntry, type Page } from '@/services/endpoints'
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, formatDateTime, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

/**
 * 分值库（DESIGN §6.2.2）：L1/L2/L3 三个独立层级，互不串档。
 * 顶部固定三个 Tab，选中后按层级查询；默认每页 50（20/50/100）。
 */
export default function ScoreLibraryPage() {
  const toast = useToast()
  const [level, setLevel] = useState<ScoreLibraryLevel>('L1')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  const state = useAsync<Page<LibraryEntry>>(
    () => scoreLibraryApi.query(level, { page: String(page), page_size: String(pageSize) }),
    [level, page, pageSize],
  )
  const rows = state.data?.items ?? []

  const columns: Column<LibraryEntry>[] = [
    { key: 'object', header: '对象', minWidth: 200, render: (r) => r.object },
    { key: 'period', header: '周期/版本', minWidth: 140, render: (r) => r.period_version ?? '—' },
    { key: 'caliber', header: '口径', minWidth: 120, render: (r) => r.caliber ?? '—' },
    { key: 'scheme', header: '方案版本', minWidth: 110, render: (r) => r.scheme_version ?? '—' },
    { key: 'score', header: '分值', minWidth: 90, align: 'right', className: 'num', render: (r) => fmt1(r.score) },
    { key: 'threshold', header: '阈值版本', minWidth: 110, render: (r) => r.threshold_version ?? '—' },
    { key: 'at', header: '快照时间', minWidth: 140, render: (r) => formatDateTime(r.snapshot_at) },
  ]

  return (
    <div>
      <PageHeader
        title="分值库"
        subtitle="L1 产品评分 / L2 系统评价 / L3 事业部评价 的三档留痕，互不串档。"
        actions={<button className="btn btn--primary" onClick={() => toast.show('导出归档（演示）', 'info')}>导出归档</button>}
      />

      <div className="tabs" style={{ marginBottom: 16 }}>
        {SCORE_LIBRARY_LEVELS.map((lv) => (
          <button
            key={lv}
            className={`tab${level === lv ? ' is-active' : ''}`}
            onClick={() => { setLevel(lv); setPage(1) }}
          >
            {lv === 'L1' ? 'L1 产品评分' : lv === 'L2' ? 'L2 系统评价' : 'L3 事业部评价'}
          </button>
        ))}
      </div>

      <AsyncBoundary
        state={state}
        isEmpty={(d) => !d.items || d.items.length === 0}
        emptyTitle={`${level} 档暂无记录`}
        emptyReason="当前层级尚未生成分值库记录，可先完成对应评分快照或事业部评价。"
      >
        {(d) => (
          <section className="card">
            <h2 className="card__title">{level} 档记录（{d.total}）</h2>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              page={page}
              pageSize={pageSize}
              total={d.total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              ariaLabel={`${level} 分值库`}
            />
          </section>
        )}
      </AsyncBoundary>
    </div>
  )
}
