import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Expand, History, LoaderCircle, Maximize2, Minimize2, Upload } from "lucide-react"
import { Button } from "@capability-ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@capability-ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@capability-ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@capability-ui/dropdown-menu"
import { Select } from "@capability-ui/select"
import SquishSwitch from "../../../底层能力/交互组件/src/bits/Micro/SquishSwitch/SquishSwitch.jsx"
import { ScrollArea } from "@capability-ui/scroll-area"
import { platformApi } from "@/lib/platform-api"
import "./templates-page.css"

const API = "/platform/v2/planning-templates"
type Dimension = { name: string; entry: string; sample: string; sections: [string, string][] }
type Version = { id: string; version: string; label: string; note: string; actor: string; created: string; dimensions: Record<string, Dimension> }
type Catalog = { active: string; revision: number; canManage: boolean; previewTicket: string; items: Version[] }
type Snapshot = Record<string, unknown>
export type LeaveGuard = () => Promise<boolean>
const clone = <T,>(value: T): T => structuredClone(value)
const stateType = (id: string) => ["01", "02", "03", "04", "06"].includes(id.slice(-2)) ? `bg-dim${id.slice(-2)}-state` : "bg-showcase-state"

export function TemplatesPage({ registerGuard }: { registerGuard: (guard: LeaveGuard | null) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selected, setSelected] = useState("")
  const [dimension, setDimension] = useState("DIM-01")
  const [chapter, setChapter] = useState("")
  const [view, setView] = useState("content")
  const [working, setWorking] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [source, setSource] = useState("")
  const [reset, setReset] = useState(0)
  const [drawer, setDrawer] = useState(false)
  const [details, setDetails] = useState(false)
  const [applyDialog, setApplyDialog] = useState(false)
  const [leaveDialog, setLeaveDialog] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const surface = useRef<HTMLElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const sample = useRef<Snapshot | null>(null)
  const sampleKey = useRef("")
  const ready = useRef(false)
  const dirtyRef = useRef(false)
  const pendingLeave = useRef<((answer: boolean) => void) | null>(null)
  const busyRef = useRef(false)
  const requestSequence = useRef(0)
  const mounted = useRef(true)
  const version = catalog?.items.find(item => item.id === selected) || catalog?.items.find(item => item.id === catalog.active)
  const record = version?.dimensions[dimension]
  const state = useRef({ dimension, working, view, immersive })
  state.current = { dimension, working, view, immersive }

  const markDirty = useCallback(() => { dirtyRef.current = true; setDirty(true) }, [])
  const clearDirty = useCallback(() => { dirtyRef.current = false; setDirty(false) }, [])
  const guard = useCallback((): Promise<boolean> => {
    if (busyRef.current) return Promise.resolve(false)
    if (!dirtyRef.current) return Promise.resolve(true)
    if (pendingLeave.current) return Promise.resolve(false)
    setLeaveDialog(true)
    return new Promise(resolve => { pendingLeave.current = resolve })
  }, [])
  const answerLeave = (answer: boolean) => {
    if (answer) clearDirty()
    setLeaveDialog(false); pendingLeave.current?.(answer); pendingLeave.current = null
  }
  useEffect(() => {
    mounted.current = true
    registerGuard(guard)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || busyRef.current) event.preventDefault() }
    window.addEventListener("beforeunload", beforeUnload)
    return () => { mounted.current = false; registerGuard(null); pendingLeave.current?.(false); window.removeEventListener("beforeunload", beforeUnload) }
  }, [guard, registerGuard])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current
    try {
      const next = await platformApi<Catalog>(API, { signal })
      if (!mounted.current || signal?.aborted || sequence !== requestSequence.current) return
      setCatalog(next)
      setSelected(current => next.items.some(item => item.id === current) ? current : next.active)
      setError("")
    } catch (reason) {
      if (!signal?.aborted && mounted.current && sequence === requestSequence.current) { setError(reason instanceof Error ? reason.message : "读取失败"); setLoading(false) }
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { if (!busyRef.current) void refresh(controller.signal) }, 5000)
    const focus = () => { if (!busyRef.current) void refresh(controller.signal) }
    window.addEventListener("focus", focus)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", focus) }
  }, [refresh])

  const sendTheme = useCallback(() => {
    const style = getComputedStyle(document.documentElement)
    const names = ["background","foreground","card","card-foreground","popover","popover-foreground","primary","primary-foreground","secondary","secondary-foreground","muted","muted-foreground","accent","accent-foreground","border","input","ring","radius"]
    frame.current?.contentWindow?.postMessage({ type: "bg-v2-theme", dark: document.documentElement.classList.contains("dark"), tokens: Object.fromEntries(names.map(name => [name, style.getPropertyValue(`--${name}`).trim()])) }, "*")
  }, [])
  const sendState = useCallback((saved = false) => {
    if (!sample.current) return
    const current = state.current
    frame.current?.contentWindow?.postMessage({ type: stateType(current.dimension), dim: current.dimension.slice(-2), content: clone(sample.current), draft: clone(sample.current), workMode: current.working && current.view === "content", preview: false, saved }, "*")
  }, [])
  useEffect(() => {
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [sendTheme])
  useEffect(() => {
    if (!version || !catalog?.previewTicket || !record) return
    const controller = new AbortController()
    ready.current = false; setLoading(true); setSource("")
    const key = version.id + "/" + dimension
    if (key !== sampleKey.current) { sample.current = null; sampleKey.current = key; clearDirty(); setWorking(false) }
    setChapter(record.sections[0]?.[0] || "")
    const load = async () => {
      try {
        if (!sample.current) sample.current = await platformApi<Snapshot>(`${API}/versions/${version.id}/${record.sample}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        const query = new URLSearchParams({ dim: dimension.slice(-2), view })
        setSource(`${API}/preview/${catalog.previewTicket}/${version.id}/${record.entry}?${query}`)
      } catch (reason) {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "示例加载失败"); setLoading(false) }
      }
    }
    void load()
    const timeout = setTimeout(() => { if (!ready.current) { setLoading(false); setError("预览加载超时，请重新加载") } }, 20000)
    return () => { controller.abort(); clearTimeout(timeout) }
  // Catalog polling must never recreate the iframe document.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id, dimension, view, reset, catalog?.previewTicket, clearDirty])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null" || typeof event.data?.type !== "string") return
      const message = event.data
      if (message.type === "bg-v2-theme-ready") { sendTheme(); return }
      if (message.type === "bg-template-preview-escape") { setImmersive(false); setCollapsed(false); if (document.fullscreenElement) void document.exitFullscreen(); return }
      const current = state.current
      const n = current.dimension.slice(-2)
      const prefix = stateType(current.dimension).replace(/-state$/, "")
      if (message.type === prefix + "-ready") { ready.current = true; setLoading(false); sendTheme(); sendState(); return }
      if (!ready.current) return
      if (message.type === prefix + "-active" && typeof message.id === "string") { setChapter(message.id); return }
      if (!current.working || !sample.current) return
      if (message.type === "bg-v2-preview-edited") { markDirty(); return }
      if (message.type === prefix + "-save-full" && message.snapshot) { sample.current = clone(message.snapshot); markDirty(); return }
      if (n === "02" && ["bg-dim02-draft", "bg-dim02-publish"].includes(message.type) && message.draft) {
        sample.current = clone(message.draft); markDirty()
        if (message.type === "bg-dim02-publish") frame.current?.contentWindow?.postMessage({ type: "bg-dim02-published", content: sample.current, draft: sample.current }, "*")
        return
      }
      if (message.type === "bg-showcase-save" && message.dim === n && Array.isArray(message.patches)) {
        for (const patch of message.patches) {
          if (!Array.isArray(patch.path) || !patch.path.length || patch.path.some((key: unknown) => typeof key !== "string" && typeof key !== "number" || ["__proto__", "prototype", "constructor"].includes(String(key)))) return
          let parent: unknown = sample.current
          for (const key of patch.path.slice(0, -1)) { if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) return; parent = (parent as Record<string, unknown>)[key] }
          const key = patch.path.at(-1)
          if (parent && typeof parent === "object" && Object.hasOwn(parent, key)) {
            const target = parent as Record<string, unknown>
            target[key] = typeof target[key] === "number" ? Number(patch.value) : patch.value
          }
        }
        markDirty(); sendState(true); return
      }
      if ([prefix + "-apply", prefix + "-save-draft", ...(n === "12" ? ["bg-dim12-apply", "bg-dim12-save-draft"] : [])].includes(message.type)) {
        if (message.snapshot) sample.current = clone(message.snapshot)
        markDirty(); sendState(true); setNotice("临时操作已完成，修改仅本次有效")
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [markDirty, sendState, sendTheme])
  useEffect(() => { if (ready.current) sendState(true) }, [working, sendState])

  useEffect(() => {
    const change = () => { const active = document.fullscreenElement === document.documentElement; setFullscreen(active); if (!active) { setImmersive(false); setCollapsed(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !pendingLeave.current && !drawer && !applyDialog) { setImmersive(false); setCollapsed(false) } }
    document.addEventListener("fullscreenchange", change); document.addEventListener("keydown", escape)
    return () => { document.removeEventListener("fullscreenchange", change); document.removeEventListener("keydown", escape) }
  }, [drawer, applyDialog])
  const changeDimension = async (next: string) => { if (next !== dimension && await guard()) { setDimension(next); setView("content") } }
  const changeVersion = async (id: string) => { if (id !== selected && await guard()) { setSelected(id); setDrawer(false) } }
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) { await document.exitFullscreen(); return }
    setImmersive(true)
    try { await document.documentElement.requestFullscreen() } catch { setNotice("浏览器未能进入全屏，已展开沉浸预览") }
  }
  const apply = async () => {
    if (!version || !catalog?.canManage) return
    setApplyDialog(false); busyRef.current = true; setBusy(true)
    try {
      await platformApi(API + "/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: version.id, revision: catalog.revision }) })
      await refresh(); setNotice(`已应用模版 v${version.version}`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "应用失败") }
    finally { busyRef.current = false; setBusy(false) }
  }
  const importFile = async (upload: File) => {
    if (!catalog?.canManage || !await guard()) return
    if (upload.size > 32 * 1024 * 1024) { setError("模版包不能超过32MB"); return }
    busyRef.current = true; setBusy(true); setError("")
    try {
      const result = await platformApi<{ id: string; duplicate: boolean }>(API + "/import", { method: "POST", headers: { "Content-Type": "application/zip" }, body: upload })
      await refresh(); setSelected(result.id); setNotice(result.duplicate ? "该模版包已导入" : "导入成功，当前启用版本保持不变")
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败") }
    finally { busyRef.current = false; setBusy(false) }
  }

  return <section ref={surface} aria-label="模版管理" className={`templates-surface ${immersive ? "is-immersive" : ""}`}>
    <header className="template-management flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0"><h1 className="text-2xl font-bold tracking-tight">模版管理</h1><p className="mt-1 truncate text-sm text-muted-foreground">{version ? `${version.label} · v${version.version}` : "正在读取模版…"}<span className="ml-2 text-xs text-primary">{version && (version.id === catalog?.active ? "当前启用" : "预览版本")}</span></p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setDetails(false); setDrawer(true) }} disabled={!catalog || busy}><History />版本记录</Button>{catalog?.canManage ? <><input ref={file} type="file" accept=".zip,application/zip" hidden onChange={event => { const upload = event.target.files?.[0]; event.target.value = ""; if (upload) void importFile(upload) }} /><Button variant="outline" disabled={busy} onClick={() => file.current?.click()}><Upload />导入模版</Button>{version?.id !== catalog.active ? <Button disabled={busy} onClick={() => setApplyDialog(true)}>应用此版本</Button> : null}</> : null}</div>
    </header>
    {error ? <div role="alert" className="flex items-center justify-between gap-2 border-y bg-destructive/10 px-4 py-2 text-sm text-destructive"><span>{error}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => { sampleKey.current = ""; void refresh(); setReset(value => value + 1) }}>重新加载</Button></div> : null}
    {notice ? <div role="status" className="flex items-center justify-between gap-2 border-b bg-muted px-4 py-2 text-sm"><span>{notice}</span><Button size="sm" variant="ghost" onClick={() => setNotice("")}>关闭提示</Button></div> : null}
    <nav className="template-dimensions border-y bg-muted/40" aria-label="12维预览导航"><div role="tablist" aria-label="预览维度" className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-2">{Object.entries(version?.dimensions || {}).map(([id, item], index, entries) => <button key={id} role="tab" aria-selected={dimension === id} aria-controls="template-preview-panel" id={`template-tab-${id}`} tabIndex={dimension === id ? 0 : -1} disabled={busy} className={`shrink-0 border-b-2 px-3 py-3 text-sm ${dimension === id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => void changeDimension(id)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowRight" ? 1 : entries.length - 1)) % entries.length; void changeDimension(entries[next][0]).then(() => document.getElementById(`template-tab-${state.current.dimension}`)?.focus()) } }}><span className="mr-1.5 text-xs opacity-60">{id.slice(-2)}</span>{item.name}</button>)}</div></nav>
    <div className={`template-tools flex flex-wrap items-center justify-between gap-2 border-b p-2 ${collapsed ? "is-collapsed" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2"><Select label="选择预览维度" value={dimension} disabled={busy || !version} onValueChange={next => void changeDimension(next)} options={Object.entries(version?.dimensions || {}).map(([id, item]) => ({ value: id, label: `${id.slice(-2)} ${item.name}` }))} />{record?.sections.length ? <Select label="章节定位" value={chapter} options={record.sections.map(([id, label]) => ({ value: id, label }))} onValueChange={id => { setChapter(id); const n = dimension.slice(-2); frame.current?.contentWindow?.postMessage({ type: Number(n) <= 4 ? `bg-dim${n}-section` : "bg-showcase-section", dim: n, id }, "*") }} /> : null}</div>
      <div className="flex flex-wrap items-center gap-1"><SquishSwitch checked={working} onChange={(value: boolean) => setWorking(value)} label="临时操作" ariaLabel="临时操作" id="template-work-switch" disabled={busy || loading || view === "text"} width={48} height={26} trackColor="var(--muted)" trackOnColor="var(--primary)" thumbColor="var(--muted-foreground)" thumbOnColor="var(--primary-foreground)" /><DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" disabled={!version || busy}>更多<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { void guard().then(ok => { if (ok) { sampleKey.current = ""; setView(view === "text" ? "content" : "text") } }) }}>{view === "text" ? "返回页面视图" : "文字视图"}</DropdownMenuItem><DropdownMenuItem onSelect={() => { void guard().then(ok => { if (ok) { sampleKey.current = ""; setReset(value => value + 1) } }) }}>重置示例</DropdownMenuItem><DropdownMenuItem asChild><a href={version ? `${API}/versions/${version.id}/package.zip` : undefined} download>下载完整包</a></DropdownMenuItem><DropdownMenuItem onSelect={() => { setDetails(true); setDrawer(true) }}>版本详情</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button size="sm" variant="ghost" onClick={() => { if (fullscreen) void document.exitFullscreen(); setImmersive(value => !value); setCollapsed(false) }}>{immersive ? <Minimize2 /> : <Expand />}{immersive ? "退出预览" : "沉浸预览"}</Button><Button size="sm" variant="ghost" onClick={() => void toggleFullscreen()}><Maximize2 />{fullscreen ? "退出全屏" : "全屏预览"}</Button>{immersive ? <Button size="sm" variant="ghost" onClick={() => setCollapsed(true)}>收起工具栏</Button> : null}</div>
    </div>
    <div id="template-preview-panel" role="tabpanel" aria-labelledby={`template-tab-${dimension}`} className="template-canvas relative min-h-0 flex-1 overflow-hidden bg-background" aria-busy={loading}>
      <iframe ref={frame} title={`${record?.name || "模版"}示例预览`} sandbox="allow-scripts" src={source || "about:blank"} className="h-full w-full border-0" />
      {loading ? <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载示例…</div> : null}
      {immersive && collapsed ? <div className="absolute top-3 right-3 flex gap-2 rounded-lg border bg-card p-1 shadow"><Button size="sm" variant="ghost" onClick={() => setCollapsed(false)}>显示工具栏</Button><Button size="sm" variant="ghost" onClick={() => { if (fullscreen) void document.exitFullscreen(); setImmersive(false); setCollapsed(false) }}>退出预览</Button></div> : null}
    </div>
    <footer className="flex flex-wrap justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground" role="status"><span>{busy ? "正在处理模版…" : `${view === "text" ? "文字视图" : working ? "临时体验" : "只读预览"} · ${record?.name || "读取中"}`}</span><span>{dirty ? "已有临时修改 · 离开前将提示" : "示例操作仅本次有效"} · 修改不保存到模版或项目</span></footer>
    <Sheet open={drawer} onOpenChange={setDrawer}><SheetContent className="gap-0"><SheetHeader><SheetTitle>{details ? "版本详情" : "版本记录"}</SheetTitle><SheetDescription>{catalog?.canManage ? "选择版本预览，确认后再应用。导入不会切换启用版本。" : "选择版本查看十二维页面效果。"}</SheetDescription></SheetHeader><ScrollArea className="min-h-0 flex-1"><div className="grid gap-3 p-4">{(details && version ? [version] : catalog?.items || []).map(item => <button key={item.id} disabled={busy || details} onClick={() => void changeVersion(item.id)} className={`grid gap-2 rounded-xl border bg-card p-4 text-left text-sm ${item.id === version?.id ? "border-primary ring-1 ring-primary" : "hover:bg-muted"}`}><span className="flex items-center justify-between gap-2"><strong>v{item.version}</strong><span className="text-xs text-primary">{item.id === catalog?.active ? "当前启用" : item.id === version?.id ? "正在预览" : "历史版本"}</span></span><span className="font-medium">{item.label}</span><span className="whitespace-pre-wrap text-muted-foreground">{item.note || "无版本说明"}</span><span className="text-xs text-muted-foreground">{new Date(item.created).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {item.actor}</span>{details ? <span className="text-xs text-muted-foreground">范围：整套12维页面</span> : null}</button>)}</div></ScrollArea></SheetContent></Sheet>
    <Dialog open={applyDialog} onOpenChange={setApplyDialog}><DialogContent><DialogHeader><DialogTitle>应用模版 v{version?.version}</DialogTitle><DialogDescription>将「{version?.label}」设为 V2.0 启用版本。新打开的页面使用此版本；已打开的编辑页面保留原版本并提示更新，项目内容和历史版本保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setApplyDialog(false)}>取消</Button><Button onClick={() => void apply()}>确认应用</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={leaveDialog} onOpenChange={open => { if (!open) answerLeave(false) }}><DialogContent><DialogHeader><DialogTitle>放弃本次临时修改？</DialogTitle><DialogDescription>当前修改仅用于体验，尚未写入模版或项目。离开后将恢复示例内容。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => answerLeave(false)}>继续体验</Button><Button onClick={() => answerLeave(true)}>放弃修改并离开</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
