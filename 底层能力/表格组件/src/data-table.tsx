import { useId, useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, EyeOff, SlidersHorizontal } from "lucide-react"
import { Button } from "../../交互组件/src/ui/button"
import { Checkbox } from "../../交互组件/src/ui/checkbox"
import { Select } from "../../交互组件/src/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../交互组件/src/ui/table"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator } from "../../交互组件/src/ui/dropdown-menu"

export type DataColumn<T> = { id: string; title: string; cell: (row: T) => ReactNode; value?: (row: T) => string | number; hideable?: boolean; className?: string }
export function DataTable<T>({ rows, columns, rowId, toolbar, loading = false, empty = "暂无记录。", selectionActions, label = "数据列表", rowLabel, filterKey = "", minWidth = 1000 }: {
  rows: T[]; columns: DataColumn<T>[]; rowId: (row: T) => string; toolbar?: ReactNode; loading?: boolean; empty?: string
  selectionActions?: (selected: T[], clear: () => void) => ReactNode; label?: string; rowLabel?: (row: T) => string; filterKey?: string; minWidth?: number
}) {
  const id = useId()
  const [hidden, setHidden] = useState<string[]>([])
  const [sort, setSort] = useState<{ id: string; descending: boolean } | null>(null)
  const [size, setSize] = useState(10)
  const [pagination, setPagination] = useState({ index: 0, filter: filterKey })
  const page = pagination.filter === filterKey ? pagination.index : 0
  const setPage = (index: number) => setPagination({ index, filter: filterKey })
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const visible = columns.filter(column => !hidden.includes(column.id))
  const sorted = useMemo(() => {
    const column = columns.find(item => item.id === sort?.id)
    if (!column?.value || !sort) return rows
    const value = column.value
    return [...rows].sort((a, b) => String(value(a)).localeCompare(String(value(b)), "zh-CN", { numeric: true }) * (sort.descending ? -1 : 1))
  }, [rows, columns, sort])
  const pages = Math.max(1, Math.ceil(sorted.length / size))
  const currentPage = Math.min(page, pages - 1)
  const current = sorted.slice(currentPage * size, (currentPage + 1) * size)
  const selected = rows.filter(row => selection.has(rowId(row)))
  const checked = current.filter(row => selection.has(rowId(row))).length
  const numbered = Array.from({ length: pages }, (_, i) => i).filter(i => i === 0 || i === pages - 1 || Math.abs(i - currentPage) <= 1)
  const resetSelection = () => setSelection(new Set())
  return <div className="flex min-w-0 flex-1 flex-col gap-4" aria-label={label} aria-busy={loading}>
    <div className="flex flex-wrap items-center gap-2"><div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline"><SlidersHorizontal />显示列</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>显示或隐藏列</DropdownMenuLabel><DropdownMenuSeparator />{columns.filter(column => column.hideable !== false).map(column => <DropdownMenuCheckboxItem key={column.id} checked={!hidden.includes(column.id)} onSelect={event => event.preventDefault()} onCheckedChange={show => setHidden(items => show ? items.filter(item => item !== column.id) : [...items, column.id])}>{column.title}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu></div>
    <div className="overflow-hidden rounded-lg border bg-card text-card-foreground"><Table style={{ minWidth }} aria-label={label}>
      <TableHeader><TableRow><TableHead className="w-10"><Checkbox aria-label="选择当前页全部记录" disabled={loading || !current.length} checked={checked === current.length && checked > 0 ? true : checked > 0 ? "indeterminate" : false} onCheckedChange={all => setSelection(previous => { const next = new Set(previous); current.forEach(row => { if (all) next.add(rowId(row)); else next.delete(rowId(row)) }); return next })} /></TableHead>{visible.map(column => <TableHead key={column.id} className={column.className}>{column.value ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="-ml-2 h-8" aria-label={`排序：${column.title}`}>{column.title}{sort?.id === column.id ? sort.descending ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown className="text-muted-foreground" />}</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => { setSort({ id: column.id, descending: false }); setPage(0) }}><ArrowUp />升序</DropdownMenuItem><DropdownMenuItem onSelect={() => { setSort({ id: column.id, descending: true }); setPage(0) }}><ArrowDown />降序</DropdownMenuItem><DropdownMenuItem onSelect={() => setSort(null)}>恢复默认排序</DropdownMenuItem>{column.hideable !== false && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setHidden(items => [...items, column.id])}><EyeOff />隐藏列</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu> : column.title}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{loading ? <TableRow><TableCell colSpan={visible.length + 1} className="h-32 text-center text-muted-foreground">正在载入…</TableCell></TableRow> : current.length ? current.map(row => <TableRow key={rowId(row)} data-row-id={rowId(row)} data-state={selection.has(rowId(row)) ? "selected" : undefined}><TableCell><Checkbox aria-label={`选择记录 ${rowLabel?.(row) || rowId(row)}`} checked={selection.has(rowId(row))} onCheckedChange={checked => setSelection(previous => { const next = new Set(previous); if (checked) next.add(rowId(row)); else next.delete(rowId(row)); return next })} /></TableCell>{visible.map(column => <TableCell key={column.id} className={column.className}>{column.cell(row)}</TableCell>)}</TableRow>) : <TableRow><TableCell colSpan={visible.length + 1} className="h-32 text-center text-muted-foreground">{empty}</TableCell></TableRow>}</TableBody>
    </Table></div>
    {selected.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 text-sm" role="region" aria-label="已选记录操作"><span>已选 {selected.length} 条</span><Button variant="ghost" size="sm" onClick={resetSelection}>清除选择</Button>{selectionActions?.(selected, resetSelection)}</div>}
    <div className="mt-auto flex flex-wrap items-center justify-between gap-4 pt-4 text-sm">
      <p className="text-muted-foreground" role="status">共 {rows.length} 条记录，已选 {selected.length} 条</p>
      <div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2"><Select label="每页行数" value={String(size)} onValueChange={value => { setSize(Number(value)); setPage(0) }} options={[10, 20, 30, 40, 50].map(value => ({ value: String(value), label: String(value) }))} /><span>条 / 页</span></label><span className="tabular-nums" id={id}>第 {currentPage + 1} / {pages} 页</span><nav className="flex items-center gap-1" aria-label={`${label}分页`} aria-describedby={id}><Button variant="outline" size="icon" aria-label="第一页" disabled={currentPage === 0 || loading} onClick={() => setPage(0)}><ChevronsLeft /></Button><Button variant="outline" size="icon" aria-label="上一页" disabled={currentPage === 0 || loading} onClick={() => setPage(currentPage - 1)}><ChevronLeft /></Button>{numbered.map((number, index) => <span key={number} className="hidden items-center gap-1 sm:inline-flex">{index > 0 && number - numbered[index - 1] > 1 && <span className="px-1 text-muted-foreground">…</span>}<Button variant={number === currentPage ? "default" : "outline"} size="icon" aria-label={`第 ${number + 1} 页`} aria-current={number === currentPage ? "page" : undefined} onClick={() => setPage(number)} disabled={loading}>{number + 1}</Button></span>)}<Button variant="outline" size="icon" aria-label="下一页" disabled={currentPage >= pages - 1 || loading} onClick={() => setPage(currentPage + 1)}><ChevronRight /></Button><Button variant="outline" size="icon" aria-label="最后一页" disabled={currentPage >= pages - 1 || loading} onClick={() => setPage(pages - 1)}><ChevronsRight /></Button></nav></div>
    </div>
  </div>
}
