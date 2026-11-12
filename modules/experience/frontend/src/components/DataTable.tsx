import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { PAGE_SIZE_OPTIONS, VIRTUAL_SCROLL_THRESHOLD } from '@/constants'
import { LoadingState } from './StateBlocks'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: number
  minWidth?: number
  fixed?: boolean // 首列/标识列固定
  align?: 'left' | 'right' | 'center'
  className?: string // 如 'wrap' 'num'
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  empty?: ReactNode
  selectable?: boolean
  selectedIds?: Set<string>
  onSelectedChange?: (ids: Set<string>) => void
  page?: number
  pageSize?: number
  total?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: readonly number[]
  rowActions?: (row: T) => ReactNode
  onRowClick?: (row: T) => void
  /** Alt+↑/↓ 调整可排序条目（DESIGN §6.2.1） */
  onMoveRow?: (id: string, delta: -1 | 1) => void
  rangeHint?: ReactNode
  batchBar?: ReactNode
  virtualThreshold?: number
  ariaLabel?: string
}

const ROW_HEIGHT = 38

/**
 * 通用数据表：覆盖分页 20/50/100、首列与操作列固定、选择范围提示、虚拟滚动阈值。
 * 五态中的「加载/空」由 loading/empty 控制；错误/无权限/只读由上层包装。
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns,
    rows,
    rowKey,
    loading,
    empty,
    selectable,
    selectedIds,
    onSelectedChange,
    page,
    pageSize,
    total,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = PAGE_SIZE_OPTIONS,
    rowActions,
    onRowClick,
    onMoveRow,
    rangeHint,
    batchBar,
    virtualThreshold = VIRTUAL_SCROLL_THRESHOLD,
    ariaLabel,
  } = props

  const allSelected = selectable && rows.length > 0 && selectedIds && rows.every((r) => selectedIds.has(rowKey(r)))
  const someSelected = selectable && selectedIds && selectedIds.size > 0 && !allSelected

  function toggleAll() {
    if (!onSelectedChange) return
    if (allSelected) onSelectedChange(new Set())
    else onSelectedChange(new Set(rows.map(rowKey)))
  }
  function toggleOne(id: string) {
    if (!onSelectedChange || !selectedIds) return
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectedChange(next)
  }

  const virtual = !pageSize && rows.length > virtualThreshold

  // 键盘导航（DESIGN §6.2.1）：↑/↓ 移动、Shift+↑/↓ 扩展选择、Ctrl/Cmd+A 全选当前页、
  // Enter 打开行、空格切换选择、Alt+↑/↓ 调整可排序条目。
  const [activeIndex, setActiveIndex] = useState(-1)
  const anchorIndex = useRef(-1)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(400)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!virtual) return
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll)
    setViewport(el.clientHeight)
    return () => el.removeEventListener('scroll', onScroll)
  }, [virtual])

  function handleTableKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(target.tagName)) return
    const canSelect = Boolean(selectable && selectedIds && onSelectedChange)
    const lastIndex = rows.length - 1

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      if (!canSelect) return
      e.preventDefault()
      onSelectedChange!(new Set(rows.map(rowKey)))
      return
    }

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (!onMoveRow || activeIndex < 0 || activeIndex > lastIndex) return
      e.preventDefault()
      onMoveRow(rowKey(rows[activeIndex]), e.key === 'ArrowUp' ? -1 : 1)
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (lastIndex < 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const base = activeIndex < 0 ? (delta > 0 ? 0 : lastIndex) : activeIndex
      const next = Math.min(lastIndex, Math.max(0, base + (activeIndex < 0 ? 0 : delta)))
      if (anchorIndex.current < 0) anchorIndex.current = next
      setActiveIndex(next)
      if (e.shiftKey && canSelect) {
        const anchor = anchorIndex.current
        const [from, to] = anchor <= next ? [anchor, next] : [next, anchor]
        const nextSet = new Set(selectedIds)
        for (let i = from; i <= to; i += 1) nextSet.add(rowKey(rows[i]))
        onSelectedChange!(nextSet)
      } else if (!e.shiftKey) {
        anchorIndex.current = next
      }
      return
    }

    if (e.key === 'Enter' && onRowClick && activeIndex >= 0 && activeIndex <= lastIndex) {
      e.preventDefault()
      onRowClick(rows[activeIndex])
      return
    }

    if (e.key === ' ' && canSelect && activeIndex >= 0 && activeIndex <= lastIndex) {
      e.preventDefault()
      const id = rowKey(rows[activeIndex])
      const next = new Set(selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onSelectedChange!(next)
      anchorIndex.current = activeIndex
    }
  }

  if (loading) {
    return <LoadingState rows={Math.min(rows.length || 6, 10)} label="载入表格" />
  }

  if (!loading && rows.length === 0) {
    return <div className="table-wrap">{empty ?? <div className="state-block">暂无数据</div>}</div>
  }

  let visibleRows: T[] = rows
  let offsetY = 0
  let totalHeight = 0
  if (virtual) {
    const overscan = 6
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan)
    const count = Math.ceil(viewport / ROW_HEIGHT) + overscan * 2
    const end = Math.min(rows.length, start + count)
    visibleRows = rows.slice(start, end)
    offsetY = start * ROW_HEIGHT
    totalHeight = rows.length * ROW_HEIGHT
  }

  const actionsCol = Boolean(rowActions)
  const colWidth = (c: Column<T>) => (c.width ? { width: c.width, minWidth: c.width } : c.minWidth ? { minWidth: c.minWidth } : undefined)

  const table = (
    <table className="data-table" aria-label={ariaLabel}>
      <thead>
        <tr>
          {selectable ? (
            <th className="col-fixed" style={{ width: 40, minWidth: 40 }}>
              <input
                type="checkbox"
                aria-label="全选当前页"
                checked={Boolean(allSelected)}
                ref={(el) => {
                  if (el) el.indeterminate = Boolean(someSelected)
                }}
                onChange={toggleAll}
              />
            </th>
          ) : null}
          {columns.map((c) => (
            <th
              key={c.key}
              className={c.fixed ? 'col-fixed' : undefined}
              style={{ ...colWidth(c), textAlign: c.align, minWidth: c.minWidth ?? (c.fixed ? 120 : undefined) }}
            >
              {c.header}
            </th>
          ))}
          {actionsCol ? <th className="sticky-actions" style={{ width: 120, minWidth: 120 }}>操作</th> : null}
        </tr>
      </thead>
      <tbody>
        {virtual ? <tr style={{ height: offsetY }} aria-hidden="true"><td colSpan={columns.length + (selectable ? 1 : 0) + (actionsCol ? 1 : 0)} style={{ padding: 0, border: 'none' }} /></tr> : null}
        {visibleRows.map((row) => {
          const id = rowKey(row)
          const selected = selectedIds?.has(id) ?? false
          return (
            <tr
              key={id}
              className={[selected ? 'is-selected' : '', activeIndex === rows.indexOf(row) ? 'is-active' : ''].filter(Boolean).join(' ') || undefined}
              aria-selected={selectable ? selected : undefined}
              style={virtual ? { height: ROW_HEIGHT } : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {selectable ? (
                <td className="col-fixed" style={{ width: 40, minWidth: 40 }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="选择该行" checked={selected} onChange={() => toggleOne(id)} />
                </td>
              ) : null}
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`${c.fixed ? 'col-fixed' : ''} ${c.align === 'right' ? 'num' : ''} ${c.className ?? ''}`}
                  style={{ ...colWidth(c), textAlign: c.align }}
                >
                  {c.render(row)}
                </td>
              ))}
              {actionsCol ? (
                <td className="sticky-actions" style={{ width: 120, minWidth: 120 }} onClick={(e) => e.stopPropagation()}>
                  {rowActions?.(row)}
                </td>
              ) : null}
            </tr>
          )
        })}
        {virtual ? <tr style={{ height: totalHeight - offsetY - visibleRows.length * ROW_HEIGHT }} aria-hidden="true"><td colSpan={columns.length + (selectable ? 1 : 0) + (actionsCol ? 1 : 0)} style={{ padding: 0, border: 'none' }} /></tr> : null}
      </tbody>
    </table>
  )

  return (
    <div>
      {batchBar}
      {rangeHint ? <div className="range-hint" style={{ marginBottom: 8 }}>{rangeHint}</div> : null}
      <div
        className="table-wrap"
        ref={scrollRef}
        style={virtual ? { maxHeight: 560, overflow: 'auto' } : undefined}
        tabIndex={0}
        role="region"
        aria-label={`${ariaLabel ?? '数据表格'}（↑/↓ 选择行，Shift+↑/↓ 扩展，Ctrl+A 全选当前页，Enter 打开，空格勾选）`}
        onKeyDown={handleTableKeyDown}
      >
        {table}
      </div>
      {pageSize ? (
        <div className="pager">
          <span>共 {total ?? rows.length} 条</span>
          <span className="page-size">
            每页
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              aria-label="每页条数"
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            条
          </span>
          <span className="table-toolbar__spacer" />
          <button type="button" className="btn" disabled={(page ?? 1) <= 1} onClick={() => onPageChange?.((page ?? 1) - 1)}>
            上一页
          </button>
          <span>第 {page ?? 1} 页</span>
          <button
            type="button"
            className="btn"
            disabled={total !== undefined && (page ?? 1) * pageSize >= total}
            onClick={() => onPageChange?.((page ?? 1) + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  )
}
