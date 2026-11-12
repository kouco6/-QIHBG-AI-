import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { DataTable, type Column } from '@/components/DataTable'
import { auditApi, type AuditRow, type Page } from '@/services/endpoints'
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, formatDateTime } from '@/constants'

/**
 * 审计日志（DESIGN §6.2.2 系统设置 → 审计日志；仅首账号可见入口）。
 * 所有账号可读；支持按分类过滤与分页（默认 50/页）。
 */
const CATEGORIES = [
  { code: '', label: '全部' },
  { code: 'auth', label: '账号/鉴权' },
  { code: 'business', label: '业务操作' },
  { code: 'setting', label: '系统设置' },
]

export default function AuditPage() {
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const state = useAsync<Page<AuditRow>>(
    () => auditApi.list({ category, page: String(page), page_size: String(pageSize) }),
    [category, page, pageSize],
  )
  const rows = state.data?.items ?? []

  const columns: Column<AuditRow>[] = [
    { key: 'at', header: '时间', minWidth: 150, render: (r) => formatDateTime(r.created_at) },
    { key: 'actor', header: '操作人', minWidth: 120, render: (r) => `${r.actor_name ?? '—'}${r.actor_role ? `（${r.actor_role}）` : ''}` },
    { key: 'category', header: '分类', minWidth: 90, render: (r) => r.category ?? '—' },
    { key: 'action', header: '动作', minWidth: 110, render: (r) => r.action ?? '—' },
    { key: 'target', header: '对象', minWidth: 140, render: (r) => `${r.target_type ?? ''} ${r.target_id ?? ''}`.trim() || '—' },
    { key: 'summary', header: '摘要', minWidth: 220, className: 'wrap', render: (r) => r.summary ?? '' },
    { key: 'rid', header: '请求编号', minWidth: 180, className: 'mono', render: (r) => r.request_id ?? '—' },
  ]

  return (
    <div>
      <PageHeader
        title="审计日志"
        subtitle="所有账号可读；记录鉴权、业务与系统设置三类操作，便于追溯。"
      />

      <div className="tabs" style={{ marginBottom: 16 }}>
        {CATEGORIES.map((c) => (
          <button key={c.code} className={`tab${category === c.code ? ' is-active' : ''}`} onClick={() => { setCategory(c.code); setPage(1) }}>
            {c.label}
          </button>
        ))}
      </div>

      <AsyncBoundary
        state={state}
        isEmpty={(d) => !d.items || d.items.length === 0}
        emptyTitle="暂无审计记录"
        emptyReason="当前筛选条件下没有审计日志。"
      >
        {(d) => (
          <section className="card">
            <h2 className="card__title">操作记录（{d.total}）</h2>
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
              ariaLabel="审计日志"
            />
          </section>
        )}
      </AsyncBoundary>
    </div>
  )
}
