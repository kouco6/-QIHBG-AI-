import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Button } from "@capability-ui/button"
import { Input } from "@capability-ui/input"
import { Badge } from "@capability-ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@capability-ui/chart"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@capability-ui/sheet"
import { DataTable, type DataColumn } from "@capability-table/data-table"
import RubberSegment from "../../../底层能力/交互组件/src/bits/Micro/RubberSegment/RubberSegment.jsx"
import { platformApi } from "@/lib/platform-api"
import "./planning-pages.css"

type Project = { projectId: string; projectName: string; projectType: string; createdAt: string | null; firstArchivedAt: string | null; lastProgressAt: string | null; firstCompletionDays: number | null; daysInProgress: number | null; statusLabel: string }
type Dashboard = { snapshotAsOf: string; asOf: string; range: { startDate: string; endDate: string; timezone: string; grain: string }; metrics: { completedProjectCount: number; inProgressProjectCount: number; averageFirstCompletionDays: number | null }; trend: { startDate: string; endDate: string; completedProjectCount: number }[]; completedProjects: Project[]; inProgressProjects: Project[]; coverage: { warning: string | null; eventsFrom: string; unknownFirstArchiveCount: number; unknownCreationCount: number } }
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("sv-SE", { timeZone:"Asia/Shanghai" }).format(new Date(value)) : "—"
const periods = [{ value:"all",label:"全部" },{ value:"week",label:"本周" },{ value:"month",label:"本月" },{ value:"year",label:"本年" },{ value:"custom",label:"自定义" }]
export function DashboardPage() {
  const [period, setPeriod] = useState("all"), [start, setStart] = useState(""), [end, setEnd] = useState("")
  const [data, setData] = useState<Dashboard | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [reload, setReload] = useState(0)
  const [detail, setDetail] = useState<Project | null>(null)
  const sequence = useRef(0)
  const invalid = period === "custom" && (!start || !end || start > end)
  useEffect(() => {
    const seq = ++sequence.current
    if (invalid) { queueMicrotask(() => { if (seq === sequence.current) { setLoading(false); setData(null); setError("") } }); return }
    const controller = new AbortController()
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); setData(null) } })
    const params = new URLSearchParams({ period })
    if (period === "custom") { params.set("start",start);params.set("end",end) }
    // Presets are relative to today; the backend clips calculations to frozen asOf.
    if (["week","month","year"].includes(period)) params.set("anchor",new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date()))
    void platformApi<Dashboard>("/platform/v2/planning-dashboard?"+params, { signal:controller.signal }).then(value => { if (seq === sequence.current && !controller.signal.aborted) setData(value) }).catch(e => { if (seq === sequence.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : "统计结果不可用") }).finally(() => { if (seq === sequence.current && !controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [period,start,end,reload,invalid])
  const nameColumn: DataColumn<Project> = { id:"name",title:"项目名称",hideable:false,value:p => p.projectName, className:"min-w-48",cell:p => <button className="font-medium text-primary hover:underline" onClick={() => setDetail(p)}>{p.projectName}</button> }
  const createdColumn: DataColumn<Project> = { id:"created",title:"创建日期",value:p => p.createdAt || "",cell:p => formatDate(p.createdAt) }
  const completedColumns: DataColumn<Project>[] = [nameColumn,createdColumn,{ id:"first",title:"首次归档日期",value:p => p.firstArchivedAt || "",cell:p => formatDate(p.firstArchivedAt) },{ id:"cycle",title:"首次完成周期",value:p => p.firstCompletionDays ?? -1,cell:p => p.firstCompletionDays === null ? "—" : `${p.firstCompletionDays} 天` }]
  const progressColumns: DataColumn<Project>[] = [nameColumn,createdColumn,{ id:"progress",title:"最近有效推进日期",value:p => p.lastProgressAt || "",cell:p => formatDate(p.lastProgressAt) },{ id:"days",title:"已进行天数",value:p => p.daysInProgress ?? -1,cell:p => p.daysInProgress === null ? "—" : `${p.daysInProgress} 天` }]
  return <section className="planning-page" aria-labelledby="dashboard-title">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">归档统计</p><h1 id="dashboard-title" className="mt-1 text-2xl font-bold">数据看板</h1><p className="mt-2 text-sm text-muted-foreground">个人企划工作量与项目完成周期。</p></div><Badge variant="outline">历史统计快照</Badge></div>
    <div className="planning-panel flex flex-wrap items-center gap-4"><span className="text-sm font-medium">时间范围</span><div className="max-w-full overflow-x-auto"><RubberSegment aria-label="统计时间范围" items={periods} defaultValue="all" value={period} onChange={(value: string) => setPeriod(value)} size="md" trackColor="var(--muted)" thumbColor="var(--card)" textColor="var(--muted-foreground)" activeTextColor="var(--primary)" /></div>{period === "custom" && <div className="flex flex-wrap gap-3"><label className="planning-field">开始日期<Input type="date" aria-label="开始日期" value={start} onChange={e => setStart(e.target.value)} /></label><label className="planning-field">结束日期<Input type="date" aria-label="结束日期" value={end} onChange={e => setEnd(e.target.value)} /></label></div>}<Button variant="outline" className="ml-auto" disabled={loading || invalid} onClick={() => setReload(v => v+1)}><RefreshCw className={loading ? "animate-spin" : ""} />重新加载</Button></div>
    {invalid && <p role="status" className="text-sm text-muted-foreground">请选择有效的起止日期，结束日期不得早于开始日期。</p>}
    {loading && <p role="status" className="planning-panel text-muted-foreground">正在读取统计…</p>}
    {error && <div role="alert" className="planning-panel space-y-2"><h2 className="font-semibold">统计结果不可用</h2><p className="text-sm text-muted-foreground">{error}</p><Button variant="outline" onClick={() => setReload(v => v+1)}>重新加载</Button></div>}
    {data && <><div className="planning-panel space-y-2 text-sm"><p>统计截止：<strong>{new Date(data.snapshotAsOf).toLocaleString("zh-CN", { timeZone:data.range.timezone, hour12:false })}</strong>（{data.range.timezone}）</p><p className="text-muted-foreground">一次性迁入的历史记录，尚未接入新的企划项目写入。筛选区间：{data.range.startDate} — {data.range.endDate}；“本周／本月／本年”按当前日期筛选，统计与已进行天数均截至快照。</p>{data.coverage.warning && <p role="note" className="text-muted-foreground">{data.coverage.warning} 事件覆盖起点：{formatDate(data.coverage.eventsFrom)}；首次归档未知 {data.coverage.unknownFirstArchiveCount} 项，创建日期未知 {data.coverage.unknownCreationCount} 项。</p>}</div>
    <section aria-labelledby="dashboard-metrics" className="space-y-3"><h2 id="dashboard-metrics" className="text-base font-semibold">核心指标</h2><div className="grid gap-4 sm:grid-cols-3">{[{ label:"本期完成项目数",value:data.metrics.completedProjectCount },{ label:"本期推进中项目数",value:data.metrics.inProgressProjectCount },{ label:"平均完成周期",value:data.metrics.averageFirstCompletionDays === null ? "—" : `${Number(data.metrics.averageFirstCompletionDays.toFixed(1))} 天` }].map(item => <div className="planning-panel space-y-3" key={item.label}><p className="text-sm text-muted-foreground">{item.label}</p><p className="text-3xl font-semibold tabular-nums">{item.value}</p></div>)}</div><p className="text-xs text-muted-foreground">仅统计可核实的首次归档与有效推进。完成与推进中项目可重叠，两项数量不能相加。</p></section>
    <section className="planning-panel space-y-4" aria-labelledby="dashboard-trend"><div className="flex items-center justify-between"><h2 id="dashboard-trend" className="text-base font-semibold">项目完成趋势</h2><span className="text-xs text-muted-foreground">首次归档</span></div>{data.metrics.completedProjectCount ? <ChartContainer config={{ completedProjectCount:{label:"首次归档数量",color:"var(--chart-1)"} }} className="h-64 w-full" aria-label="首次归档数量趋势"><BarChart accessibilityLayer data={data.trend}><CartesianGrid vertical={false} /><XAxis dataKey="startDate" tickLine={false} axisLine={false} minTickGap={36} tickFormatter={v => data.range.grain === "month" ? String(v).slice(0,7) : String(v).slice(5)} /><YAxis allowDecimals={false} width={30} /><ChartTooltip content={<ChartTooltipContent />} /><Bar isAnimationActive={false} dataKey="completedProjectCount" fill="var(--color-completedProjectCount)" radius={[4,4,0,0]} /></BarChart></ChartContainer> : <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">该范围内没有首次归档</p>}</section>
    <section className="space-y-3" aria-labelledby="dashboard-completed"><h2 id="dashboard-completed" className="text-base font-semibold">本期完成项目</h2><DataTable rows={data.completedProjects} columns={completedColumns} rowId={p => p.projectId} rowLabel={p => p.projectName} filterKey={period+start+end} label="本期完成项目" minWidth={740} empty="该范围内没有可信首次归档记录。" /></section>
    <section className="space-y-3" aria-labelledby="dashboard-progress"><h2 id="dashboard-progress" className="text-base font-semibold">本期推进中项目</h2><DataTable rows={data.inProgressProjects} columns={progressColumns} rowId={p => p.projectId} rowLabel={p => p.projectName} filterKey={period+start+end} label="本期推进中项目" minWidth={740} empty="该范围内没有有效推进中的项目。" /></section></>}
    <Sheet open={!!detail} onOpenChange={o => { if (!o) setDetail(null) }}><SheetContent className="w-full overflow-y-auto sm:max-w-lg"><SheetHeader><SheetTitle>{detail?.projectName}</SheetTitle><SheetDescription>历史项目统计详情 · 只读</SheetDescription></SheetHeader>{detail && <dl className="planning-details px-4 pb-6">{[["项目类型",detail.projectType],["截止时状态",detail.statusLabel],["创建日期",formatDate(detail.createdAt)],["首次归档日期",formatDate(detail.firstArchivedAt)],["最近有效推进日期",formatDate(detail.lastProgressAt)],["首次完成周期",detail.firstCompletionDays === null ? "—" : `${detail.firstCompletionDays} 天`],["已进行天数",detail.daysInProgress === null ? "—" : `${detail.daysInProgress} 天`]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}</SheetContent></Sheet>
  </section>
}
