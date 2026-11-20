import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, RefreshCw, Upload } from "lucide-react"
import { Button } from "@capability-ui/button"
import { Badge } from "@capability-ui/badge"
import { Input } from "@capability-ui/input"
import { Textarea } from "@capability-ui/textarea"
import { Select } from "@capability-ui/select"
import { Checkbox } from "@capability-ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@capability-ui/dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@capability-ui/sheet"
import { DataTable, type DataColumn } from "@capability-table/data-table"
import { platformApi } from "@/lib/platform-api"
import type { LeaveGuard } from "./templates-page"
import "./planning-pages.css"

const API = "/platform/v2/exhibitions"
const fields = ["name", "industry", "venue", "city", "reason", "level", "content", "area", "visitors", "exhibitorCount", "exhibitors", "website", "source", "sourceRow"] as const
type Field = typeof fields[number]
type Exhibition = Record<Field, string> & { id?: string; revision?: number; group: string; rating: number | null; schedule: string; startDate: string; endDate: string; topicIds: string[]; archived?: boolean; warnings?: string[]; updatedAt?: string; updatedBy?: string }
type Topic = { id: string; name: string; revision: number }
type Catalog = { items: Exhibition[]; topics: Topic[]; canManage: boolean; isAdmin: boolean }
type ImportResult = { added: number; skipped: number; failed: number; errors: { row: string; message: string }[]; warnings: { row: string; message: string }[] }
const labels: Record<Field, string> = { name: "展会名称", industry: "展会分类 / 行业", venue: "展馆", city: "城市", reason: "推荐理由", level: "级别", content: "主要内容", area: "展览面积", visitors: "观众数量", exhibitorCount: "参展商数量", exhibitors: "参展商", website: "官网", source: "来源", sourceRow: "来源行" }
const schedules = [{ value: "scheduled", label: "正常" }, { value: "postponed", label: "延期" }, { value: "cancelled", label: "取消" }, { value: "tbd", label: "日期待定" }]
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date())
const message = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试。"
const post = <T,>(path: string, body: object) => platformApi<T>(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
const blank = (): Exhibition => ({ ...Object.fromEntries(fields.map(k => [k, ""])) as Record<Field, string>, group: "推荐", rating: null, schedule: "scheduled", startDate: "", endDate: "", topicIds: [] })
const dates = (e: Exhibition) => e.startDate ? `${e.startDate} — ${e.endDate}` : "日期待定"

export function ExhibitionsPage({ registerGuard }: { registerGuard: (guard: LeaveGuard | null) => void }) {
  const [catalog, setCatalog] = useState<Catalog>({ items: [], topics: [], canManage: false, isAdmin: false })
  const [loading, setLoading] = useState(true), [error, setError] = useState("")
  const [scope, setScope] = useState("month"), [month, setMonth] = useState(today().slice(0, 7)), [view, setView] = useState("list")
  const [group, setGroup] = useState("focus"), [topic, setTopic] = useState("all"), [city, setCity] = useState("all"), [industry, setIndustry] = useState("all"), [query, setQuery] = useState(""), [available, setAvailable] = useState(false)
  const [detail, setDetail] = useState<Exhibition | null>(null), [form, setForm] = useState<Exhibition | null>(null), [initial, setInitial] = useState("")
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState(""), [notice, setNotice] = useState("")
  const [topicsOpen, setTopicsOpen] = useState(false), [newTopic, setNewTopic] = useState(""), [topicNames, setTopicNames] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<{ id: string; name: string; login: string }[] | null>(null), [selectedPeople, setSelectedPeople] = useState<string[]>([]), [peopleOpen, setPeopleOpen] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null), [archiveRecord, setArchiveRecord] = useState<Exhibition | null>(null)
  const [discard, setDiscard] = useState(false)
  const resolver = useRef<((value: boolean) => void) | null>(null)
  const file = useRef<HTMLInputElement>(null), sequence = useRef(0)
  const dirty = !!form && JSON.stringify(form) !== initial
  const requestLeave = useCallback(() => {
    if (busy) return Promise.resolve(false)
    if (!dirty) return Promise.resolve(true)
    setDiscard(true)
    return new Promise<boolean>(resolve => { resolver.current = resolve })
  }, [busy, dirty])
  useEffect(() => { registerGuard(requestLeave); return () => registerGuard(null) }, [registerGuard, requestLeave])
  useEffect(() => { const prevent = (e: BeforeUnloadEvent) => { if (dirty || busy) e.preventDefault() }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent) }, [dirty, busy])
  const load = useCallback(async () => {
    const seq = ++sequence.current; setLoading(true); setError("")
    try { const next = await platformApi<Catalog>(API); if (seq === sequence.current) setCatalog(next) }
    catch (e) { if (seq === sequence.current) { setError(message(e)); setCatalog({ items: [], topics: [], canManage: false, isAdmin: false }) } }
    finally { if (seq === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void load() }); const invalidate = () => { sequence.current++ }; return () => { active = false; invalidate() } }, [load])
  const reset = () => { setGroup("focus"); setTopic("all"); setCity("all"); setIndustry("all"); setQuery(""); setAvailable(false) }
  const filtered = useMemo(() => {
    const start = `${month}-01`, end = `${month}-31`, now = today()
    return catalog.items.filter(e => {
      if (scope === "archived" ? !e.archived : e.archived) return false
      if (scope === "month" && (!e.startDate || e.startDate > end || e.endDate < start)) return false
      if (scope === "tbd" && e.startDate) return false
      if (group === "focus" ? !["强相关", "推荐"].includes(e.group) : group !== "all" && group !== e.group) return false
      if (topic !== "all" && !e.topicIds.includes(topic)) return false
      if (city !== "all" && city !== e.city || industry !== "all" && industry !== e.industry) return false
      if (available && (e.schedule === "cancelled" || e.endDate && e.endDate < now)) return false
      return !query.trim() || [e.name, e.venue, e.content, e.exhibitors, e.reason, e.city].join(" ").toLowerCase().includes(query.trim().toLowerCase())
    }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name, "zh-CN"))
  }, [catalog, month, scope, group, topic, city, industry, query, available])
  async function openForm(e?: Exhibition) {
    if (!await requestLeave()) return
    const next = e ? structuredClone(e) : blank(); setDetail(null); setForm(next); setInitial(JSON.stringify(next)); setFormError("")
  }
  async function closeForm() { if (await requestLeave()) { setForm(null); setFormError("") } }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!form || busy) return
    setBusy(true); setFormError("")
    try { await post(form.id ? `/records/${form.id}` : "/records", form); setForm(null); setNotice("展会已保存。"); await load() }
    catch (e) { setFormError(message(e)) } finally { setBusy(false) }
  }
  async function changeArchive() {
    if (!archiveRecord || busy) return
    setBusy(true); setFormError("")
    try { await post(`/records/${archiveRecord.id}/archive`, { revision: archiveRecord.revision, archived: !archiveRecord.archived }); setArchiveRecord(null); setDetail(null); setNotice("归档状态已更新。"); await load() }
    catch (e) { setFormError(message(e)) } finally { setBusy(false) }
  }
  async function topicAction(action: string, item?: Topic) {
    if (busy) return
    setBusy(true); setFormError("")
    try {
      const result = await post<{ id: string }>("/topics", { action, id: item?.id, revision: item?.revision, name: item ? topicNames[item.id] ?? item.name : newTopic })
      if (action === "create") { setNewTopic(""); if (form) setForm({ ...form, topicIds: [...new Set([...form.topicIds, result.id])] }) }
      if (action === "delete" && form) setForm({ ...form, topicIds: form.topicIds.filter(id => id !== item?.id) })
      await load()
    } catch (e) { setFormError(message(e)) } finally { setBusy(false) }
  }
  async function openPeople() {
    setPeopleOpen(true); setPeople(null); setFormError("")
    try { const data = await platformApi<{ items: NonNullable<typeof people>; selected: string[] }>(API + "/maintainers"); setPeople(data.items); setSelectedPeople(data.selected) }
    catch (e) { setFormError(message(e)) }
  }
  async function savePeople() {
    setBusy(true); setFormError("")
    try { await post("/maintainers", { ids: selectedPeople }); setPeopleOpen(false); setNotice("维护权限已保存。"); await load() }
    catch (e) { setFormError(message(e)) } finally { setBusy(false) }
  }
  async function importFile(f?: File) {
    if (!f || busy) return
    if (!f.name.toLowerCase().endsWith(".xlsx") || f.size > 10 * 1024 * 1024) { setError("请上传不超过 10 MB 的 .xlsx 文件。"); return }
    setBusy(true); setError("")
    try { setImportResult(await platformApi<ImportResult>(API + "/import?filename=" + encodeURIComponent(f.name), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f })); await load() }
    catch (e) { setError(message(e)) } finally { setBusy(false); if (file.current) file.current.value = "" }
  }
  const monthShift = (n: number) => { if (!month) return; const [y,m] = month.split("-").map(Number); const d = new Date(y,m-1+n,1); if (d.getFullYear() >= 1900 && d.getFullYear() <= 9999) setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`) }
  const columns: DataColumn<Exhibition>[] = [
    { id: "name", title: "展会与调研方向", hideable: false, value: e => e.name, className: "min-w-64 max-w-96", cell: e => <div className="space-y-2"><button className="text-left font-medium text-primary hover:underline" onClick={() => setDetail(e)}>{e.name}</button><p className="line-clamp-2 text-xs text-muted-foreground">{e.reason || e.content || "—"}</p><div className="flex flex-wrap gap-1">{e.topicIds.map(id => <Badge variant="secondary" key={id}>{catalog.topics.find(t => t.id === id)?.name || "已移除专题"}</Badge>)}</div></div> },
    { id: "dates", title: "展期", value: e => e.startDate, className: "min-w-44", cell: e => <div className="space-y-1"><p>{dates(e)}</p>{e.schedule !== "scheduled" && <Badge variant="outline">{schedules.find(s => s.value === e.schedule)?.label}</Badge>}</div> },
    { id: "venue", title: "举办地点", value: e => e.city, className: "min-w-40 max-w-64 whitespace-normal", cell: e => <><p>{e.city || "—"}</p><p className="text-xs text-muted-foreground">{e.venue}</p></> },
    { id: "rating", title: "推荐度", value: e => e.rating || 0, cell: e => <div className="space-y-1"><Badge variant="outline">{e.group}</Badge><p aria-label={`${e.rating || 0} 星`} className="text-primary">{e.rating ? "★".repeat(e.rating) : "—"}</p></div> },
    { id: "actions", title: "操作", hideable: false, cell: e => <Button variant="outline" size="sm" onClick={() => catalog.canManage ? void openForm(e) : setDetail(e)}>{catalog.canManage ? "编辑" : "查看"}</Button> },
  ]
  const start = month ? new Date(Number(month.slice(0,4)), Number(month.slice(5))-1, 1) : new Date(2026,10,1)
  const offset = (start.getDay()+6)%7, count = new Date(start.getFullYear(),start.getMonth()+1,0).getDate()
  const choose = (label: string, value: string, change: (v: string) => void, values: string[]) => <Select label={label} value={value} onValueChange={change} options={[{ value: "all", label: `全部${label}` }, ...values.map(v => ({ value: v, label: v }))]} />
  return <section className="planning-page" aria-labelledby="exhibitions-title">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs text-muted-foreground">调研与行业观察</p><h1 id="exhibitions-title" className="mt-1 text-2xl font-bold">展会情况</h1><p className="mt-2 text-sm text-muted-foreground">按月发现值得关注的展会，安排参观调研。</p></div><div className="flex flex-wrap gap-2">{catalog.canManage && <><Button variant="outline" onClick={() => { setFormError(""); setTopicsOpen(true) }}>专题管理</Button>{catalog.isAdmin && <Button variant="outline" onClick={() => void openPeople()}>维护人员</Button>}<Button variant="outline" disabled={busy} onClick={() => file.current?.click()}><Upload />导入 Excel</Button><Button disabled={busy} onClick={() => void openForm()}><Plus />新增展会</Button><input hidden ref={file} type="file" accept=".xlsx" aria-label="导入展会文件" onChange={e => void importFile(e.target.files?.[0])} /></>}</div></div>
    {error && <div role="alert" className="planning-error">{error}<Button variant="outline" onClick={() => void load()}>重试</Button></div>}
    {notice && <div role="status" className="planning-notice">{notice}<Button variant="ghost" size="sm" onClick={() => setNotice("")}>关闭</Button></div>}
    <div className="planning-panel space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2" role="group" aria-label="展会范围">{[["month","月度展会"],["tbd","日期待定"],["archived","已归档"]].map(([id,label]) => <Button key={id} variant={scope === id ? "default" : "outline"} aria-pressed={scope === id} onClick={() => setScope(id)}>{label}</Button>)}</div><div className="flex flex-wrap items-center gap-2">{scope === "month" && <><Button variant="outline" size="icon" aria-label="上个月" onClick={() => monthShift(-1)}><ChevronLeft /></Button><Input type="month" aria-label="展会月份" min="1900-01" max="9999-12" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value) }} className="w-40" /><Button variant="outline" size="icon" aria-label="下个月" onClick={() => monthShift(1)}><ChevronRight /></Button></>}<Button variant="ghost" onClick={() => { setMonth(today().slice(0,7)); setScope("month") }}>本月</Button></div></div><div className="flex flex-wrap items-center gap-3"><Input type="search" aria-label="搜索展会" placeholder="搜索展会、展馆、内容或参展商" value={query} onChange={e => setQuery(e.target.value)} className="w-full sm:w-80" /><Select label="推荐分组" value={group} onValueChange={setGroup} options={[{ value: "focus", label: "重点展会" }, { value: "all", label: "全部分组" }, ...["强相关","推荐","不相关"].map(v => ({ value: v, label: v }))]} /><Select label="专题" value={topic} onValueChange={setTopic} options={[{ value: "all", label: "全部专题" }, ...catalog.topics.map(t => ({ value: t.id, label: t.name }))]} />{choose("城市",city,setCity,[...new Set(catalog.items.map(e => e.city).filter(Boolean))].sort())}{choose("行业",industry,setIndustry,[...new Set(catalog.items.map(e => e.industry).filter(Boolean))].sort())}<label className="flex items-center gap-2 text-sm"><Checkbox checked={available} onCheckedChange={v => setAvailable(v === true)} />仅看尚可参加</label><Button variant="ghost" onClick={reset}>重置</Button></div></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground" role="status">共 {filtered.length} 场展会{group === "focus" ? " · 强相关与推荐" : ""}{scope === "archived" ? " · 已归档" : ""}</p><div className="flex gap-2">{scope === "month" && <><Button variant={view === "list" ? "secondary" : "outline"} aria-pressed={view === "list"} onClick={() => setView("list")}><List />列表</Button><Button variant={view === "calendar" ? "secondary" : "outline"} aria-pressed={view === "calendar"} onClick={() => setView("calendar")}><CalendarDays />日历</Button></>}<Button variant="outline" disabled={loading || busy} onClick={() => void load()}><RefreshCw className={loading ? "animate-spin" : ""} />{loading ? "刷新中…" : "刷新"}</Button></div></div>
    {scope !== "month" || view === "list" ? <DataTable rows={filtered} columns={columns} rowId={e => e.id!} rowLabel={e => e.name} loading={loading} filterKey={JSON.stringify([scope,month,group,topic,city,industry,query,available])} label="展会列表" empty="暂无符合条件的展会，可以切换月份或调整筛选。" minWidth={960} /> : <div className="overflow-x-auto rounded-lg border bg-card"><div className="exhibition-calendar" role="region" aria-label={`${month}展会日历`}><div className="calendar-week">{["周一","周二","周三","周四","周五","周六","周日"].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-grid">{Array.from({ length: Math.ceil((offset+count)/7)*7 },(_,i) => { const day=i-offset+1, key=`${month}-${String(day).padStart(2,"0")}`; return <div key={i} className={day>0 && day<=count ? "calendar-day" : "calendar-day bg-muted/30"}>{day>0 && day<=count && <><span className={key === today() ? "font-bold text-primary" : "text-muted-foreground"}>{day}</span>{filtered.filter(e => e.startDate<=key && e.endDate>=key).map(e => <button key={e.id} onClick={() => setDetail(e)} className="calendar-event"><span>{e.name}</span>{e.schedule !== "scheduled" && <span className="text-xs"> · {schedules.find(s => s.value === e.schedule)?.label}</span>}</button>)}</>}</div> })}</div></div></div>}
    {!loading && !filtered.length && <div className="text-center"><Button variant="ghost" onClick={reset}>清空筛选</Button></div>}
    <Sheet open={!!detail} onOpenChange={o => { if (!o && !busy) setDetail(null) }}><SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>{detail?.name}</SheetTitle><SheetDescription>展会调研详情 · 共享展会库</SheetDescription></SheetHeader>{detail && <div className="space-y-5 px-4 pb-6"><div className="flex flex-wrap gap-2"><Badge>{detail.group}</Badge><Badge variant="outline">{schedules.find(s => s.value === detail.schedule)?.label}</Badge>{detail.archived && <Badge variant="secondary">已归档</Badge>}</div><p className="font-medium">{dates(detail)}</p><dl className="planning-details">{fields.filter(k => k !== "name").map(k => <div key={k}><dt>{labels[k]}</dt><dd>{k === "website" && detail[k] ? <a className="text-primary underline" href={detail[k]} target="_blank" rel="noreferrer">{detail[k]}</a> : detail[k] || "—"}</dd></div>)}<div><dt>专题</dt><dd>{detail.topicIds.map(id => catalog.topics.find(t => t.id === id)?.name).filter(Boolean).join("、") || "—"}</dd></div><div><dt>最近更新</dt><dd>{detail.updatedBy} · {detail.updatedAt ? new Date(detail.updatedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}) : "—"}</dd></div></dl>{detail.warnings?.map(w => <p key={w} role="note" className="text-sm text-muted-foreground">{w}</p>)}{catalog.canManage && <div className="flex gap-2"><Button onClick={() => void openForm(detail)}>编辑展会</Button><Button variant="outline" onClick={() => { setFormError(""); setArchiveRecord(detail) }}>{detail.archived ? "恢复" : "归档"}</Button></div>}</div>}</SheetContent></Sheet>
    <Dialog open={!!form} onOpenChange={o => { if (!o) void closeForm() }}><DialogContent className="planning-edit-dialog sm:max-w-3xl" showCloseButton={!busy} onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { e.preventDefault(); void closeForm() }}><DialogHeader><DialogTitle>{form?.id ? "编辑展会" : "新增展会"}</DialogTitle><DialogDescription>保存后更新共享展会库，* 为必填项。</DialogDescription></DialogHeader>{form && <form onSubmit={save} className="flex min-h-0 flex-1 flex-col"><div className="planning-form-scroll"><fieldset disabled={busy} className="planning-form-fields"><div className="grid gap-4 sm:grid-cols-2">{(["name","venue","industry","city","level"] as Field[]).map(k => <label className="planning-field" key={k}>{labels[k]}{["name","venue"].includes(k) ? " *" : ""}<Input value={form[k]} required={["name","venue"].includes(k)} maxLength={k === "name" ? 300 : 2000} onChange={e => setForm({ ...form, [k]: e.target.value })} /></label>)}<div className="planning-field"><span>推荐分组</span><Select label="推荐分组（编辑）" className="w-full max-w-full" value={form.group} onValueChange={v => setForm({ ...form, group: v })} options={["强相关","推荐","不相关"].map(v => ({ value: v, label: v }))} /></div><div className="planning-field"><span>推荐度</span><Select label="推荐度" className="w-full max-w-full" value={String(form.rating || 0)} onValueChange={v => setForm({ ...form, rating: Number(v) || null })} options={[{ value:"0",label:"未填写" }, ...[1,2,3,4,5].map(v => ({ value:String(v),label:"★".repeat(v) }))]} /></div><div className="planning-field"><span>展期标记</span><Select label="展期标记" className="w-full max-w-full" value={form.schedule} onValueChange={v => setForm({ ...form, schedule:v, ...(v === "tbd" ? { startDate:"",endDate:"" } : {}) })} options={schedules} /></div>{["startDate","endDate"].map((k,i) => <label className="planning-field" key={k}>{i ? "结束日期" : "开始日期"}<Input type="date" value={form[k as "startDate"]} required={form.schedule === "scheduled"} disabled={form.schedule === "tbd"} onChange={e => setForm({ ...form, [k]:e.target.value })} /></label>)}</div><p className="text-xs text-muted-foreground">延期但新日期未知时，清空起止日期；已知新展期时填写新日期。</p><div className="planning-field"><span>专题标签（可多选）</span><div className="flex flex-wrap gap-4">{catalog.topics.length ? catalog.topics.map(t => <label key={t.id} className="flex items-center gap-2"><Checkbox checked={form.topicIds.includes(t.id)} onCheckedChange={v => setForm({ ...form, topicIds:v ? [...form.topicIds,t.id] : form.topicIds.filter(id => id !== t.id) })} />{t.name}</label>) : <p className="text-muted-foreground">暂无专题，可在下方新增。</p>}</div><div className="flex gap-2"><Input aria-label="新专题名称" placeholder="输入新的专题名称" maxLength={40} value={newTopic} onChange={e => setNewTopic(e.target.value)} /><Button type="button" variant="outline" disabled={!newTopic.trim() || busy} onClick={() => void topicAction("create")}>添加专题</Button></div></div>{(["reason","content","exhibitors"] as Field[]).map(k => <label className="planning-field" key={k}>{labels[k]}<Textarea value={form[k]} maxLength={k === "content" ? 16000 : 2000} onChange={e => setForm({ ...form, [k]:e.target.value })} /></label>)}<div className="grid gap-4 sm:grid-cols-2">{(["area","visitors","exhibitorCount","website"] as Field[]).map(k => <label className="planning-field" key={k}>{labels[k]}<Input value={form[k]} maxLength={2000} onChange={e => setForm({ ...form, [k]:e.target.value })} /></label>)}</div></fieldset></div><div className="planning-form-footer">{formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => void closeForm()}>取消</Button><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存展会"}</Button></DialogFooter></div></form>}</DialogContent></Dialog>
    <Dialog open={topicsOpen} onOpenChange={o => { if (!busy) setTopicsOpen(o) }}><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>专题管理</DialogTitle><DialogDescription>改名会更新显示名称；删除专题会移除所有展会中的对应标签。</DialogDescription></DialogHeader><div className="flex gap-2"><Input aria-label="新增专题名称" placeholder="例如：AI机器人" maxLength={40} value={newTopic} onChange={e => setNewTopic(e.target.value)} /><Button disabled={busy || !newTopic.trim()} onClick={() => void topicAction("create")}>新增</Button></div>{catalog.topics.map(t => <div className="flex flex-wrap gap-2" key={t.id}><Input className="min-w-32 flex-1" aria-label={`专题名称 ${t.name}`} value={topicNames[t.id] ?? t.name} maxLength={40} onChange={e => setTopicNames({ ...topicNames,[t.id]:e.target.value })} /><Button variant="outline" disabled={busy} onClick={() => void topicAction("rename",t)}>改名</Button><Button variant="ghost" disabled={busy} onClick={() => void topicAction("delete",t)}>删除</Button></div>)}{formError && <p role="alert" className="text-destructive">{formError}</p>}<DialogFooter><span className="mr-auto text-sm text-muted-foreground">共 {catalog.topics.length} 个专题</span><Button disabled={busy} onClick={() => setTopicsOpen(false)}>完成</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={peopleOpen} onOpenChange={o => { if (!busy) setPeopleOpen(o) }}><DialogContent><DialogHeader><DialogTitle>维护人员</DialogTitle><DialogDescription>管理员默认具备维护权限。其他用户仅可查看。</DialogDescription></DialogHeader><div className="max-h-72 space-y-3 overflow-auto">{people ? people.length ? people.map(p => <label key={p.id} className="flex items-center gap-3 text-sm"><Checkbox disabled={busy} checked={selectedPeople.includes(p.id)} onCheckedChange={v => setSelectedPeople(v ? [...selectedPeople,p.id] : selectedPeople.filter(id => id !== p.id))} />{p.name}<span className="text-muted-foreground">{p.login}</span></label>) : <p className="text-sm text-muted-foreground">暂无可指定的普通用户。</p> : <p>{formError ? "人员读取失败" : "正在读取人员…"}</p>}</div>{formError && <p role="alert" className="text-destructive">{formError}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPeopleOpen(false)}>取消</Button><Button disabled={busy || !people} onClick={() => void savePeople()}>保存权限</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!archiveRecord} onOpenChange={o => { if (!o && !busy) setArchiveRecord(null) }}><DialogContent><DialogHeader><DialogTitle>{archiveRecord?.archived ? "恢复展会" : "归档展会"}</DialogTitle><DialogDescription>{archiveRecord?.name} · {archiveRecord?.archived ? "恢复后将回到月度或待定列表。" : "归档后仍可在已归档列表查阅和恢复。"}</DialogDescription></DialogHeader>{formError && <p role="alert" className="text-destructive">{formError}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setArchiveRecord(null)}>取消</Button><Button disabled={busy} onClick={() => void changeArchive()}>确认{archiveRecord?.archived ? "恢复" : "归档"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!importResult} onOpenChange={o => { if (!o) setImportResult(null) }}><DialogContent><DialogHeader><DialogTitle>导入完成</DialogTitle><DialogDescription>新增 {importResult?.added} 条，跳过重复 {importResult?.skipped} 条，失败 {importResult?.failed} 条。</DialogDescription></DialogHeader><div className="max-h-72 overflow-y-auto text-sm">{importResult?.errors.map((e,i) => <p className="text-destructive" key={`e${i}`}>{e.row}：{e.message}</p>)}{importResult?.warnings.map((e,i) => <p className="text-muted-foreground" key={`w${i}`}>{e.row}：{e.message}</p>)}</div><DialogFooter><Button onClick={() => setImportResult(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={o => { if (!o) { resolver.current?.(false); resolver.current=null;setDiscard(false) } }}><DialogContent><DialogHeader><DialogTitle>放弃未保存修改？</DialogTitle><DialogDescription>当前展会修改尚未保存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { resolver.current?.(false);resolver.current=null;setDiscard(false) }}>继续编辑</Button><Button variant="destructive" onClick={() => { resolver.current?.(true);resolver.current=null;setDiscard(false) }}>放弃修改</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
