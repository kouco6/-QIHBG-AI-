import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Eye, EyeOff, KeyRound, MoreHorizontal, Pencil, RefreshCw, ShieldCheck, UserPlus, Users, X } from "lucide-react"
import { Button } from "@capability-ui/button"
import { Badge } from "@capability-ui/badge"
import { Checkbox } from "@capability-ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@capability-ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@capability-ui/dropdown-menu"
import { FacetedFilter } from "@capability-ui/faceted-filter"
import { Input } from "@capability-ui/input"
import { Select } from "@capability-ui/select"
import { DataTable, type DataColumn } from "@capability-table/data-table"
import { platformApi, PlatformApiError, type PlatformAccount } from "@/lib/platform-api"
import type { LeaveGuard } from "./templates-page"
import "./personnel-page.css"

const TAGS = ["体验", "企划", "产品", "UI"]
const MODULES: Record<string, string> = { bg: "产品企划中心", capabilities: "底层能力中心", ai: "AI调度中心", experience: "产品体验中心" }
const roleName = (role: string) => role === "admin" ? "管理员" : "普通用户"
const describe = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。"
const write = <T,>(path: string, method: "POST" | "PATCH", body: object) => platformApi<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
type PersonForm = { id?: string; name: string; login: string; role: "admin" | "user"; tags: string[]; password: string }
type StatusChange = { people: PlatformAccount[]; active: boolean; clear?: () => void }

function accessFor(role: string, tags: string[]) {
  return Object.keys(MODULES).filter(module => role === "admin" || (tags.length > 0 && (module === "capabilities" || module === "ai")) || (module === "bg" && tags.includes("企划")) || (module === "experience" && tags.includes("体验")))
}

export function PersonnelPage({ account, refreshAccount, registerGuard }: { account: PlatformAccount; refreshAccount: () => Promise<void>; registerGuard: (guard: LeaveGuard | null) => void }) {
  const [people, setPeople] = useState<PlatformAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [query, setQuery] = useState("")
  const [roles, setRoles] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [states, setStates] = useState<string[]>([])
  const [form, setForm] = useState<PersonForm | null>(null)
  const [resetting, setResetting] = useState<PlatformAccount | null>(null)
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null)
  const [formError, setFormError] = useState("")
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const sequence = useRef(0)
  const refreshSession = useRef(refreshAccount)
  useEffect(() => { refreshSession.current = refreshAccount }, [refreshAccount])
  useEffect(() => { registerGuard(async () => !busy); return () => registerGuard(null) }, [busy, registerGuard])

  const load = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    setError("")
    try {
      const result = await platformApi<{ items: PlatformAccount[] }>("/platform/accounts")
      if (mounted.current && request === sequence.current) setPeople(result.items)
    } catch (reason) {
      if (mounted.current && request === sequence.current) { setPeople([]); setError(describe(reason)) }
      if (reason instanceof PlatformApiError && [401, 403].includes(reason.status)) await refreshSession.current()
    } finally { if (mounted.current && request === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => { mounted.current = true; queueMicrotask(() => { if (mounted.current) void load() }); return () => { mounted.current = false } }, [load])
  useEffect(() => {
    const onFocus = () => { if (!busy && !form && !resetting && !statusChange) void load() }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [busy, form, resetting, statusChange, load])

  const filtered = useMemo(() => people.filter(person => (!query.trim() || `${person.name} ${person.login}`.toLowerCase().includes(query.trim().toLowerCase())) && (!roles.length || roles.includes(person.role)) && (!tags.length || tags.some(tag => person.tags.includes(tag))) && (!states.length || states.includes(person.active ? "active" : "inactive"))), [people, query, roles, tags, states])
  const hasFilters = !!(query || roles.length || tags.length || states.length)
  const lastAdmin = (person: PlatformAccount) => person.active && person.role === "admin" && people.filter(item => item.active && item.role === "admin").length === 1
  const protectedReason = (person: PlatformAccount) => person.id === account.id ? "不能停用自己" : lastAdmin(person) ? "不能停用最后一名管理员" : ""
  const openPerson = (person?: PlatformAccount) => { setFormError(""); setShowPassword(false); setForm(person ? { id: person.id, name: person.name, login: person.login, role: person.role, tags: [...person.tags], password: "" } : { name: "", login: "", role: "user", tags: [], password: "" }) }

  async function afterWrite(message: string) {
    setNotice(message)
    await refreshAccount()
    if (mounted.current) await load()
  }

  async function savePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form || busy) return
    if (!form.name.trim()) { setFormError("请输入姓名。"); return }
    if (form.role === "user" && !form.tags.length) { setFormError("普通用户至少选择一个岗位标签。"); return }
    setBusy(true); setFormError("")
    try {
      const body = { name: form.name.trim(), role: form.role, tags: form.tags }
      await write("/platform/accounts" + (form.id ? `/${form.id}` : ""), form.id ? "PATCH" : "POST", form.id ? body : { ...body, login: form.login.trim(), password: form.password })
      setForm(null)
      await afterWrite("账号已保存，访问权限由岗位标签自动生成。")
    } catch (reason) {
      setFormError(describe(reason))
      if (reason instanceof PlatformApiError && [401, 403].includes(reason.status)) await refreshAccount()
    } finally { setBusy(false) }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!resetting || busy) return
    if (password !== confirmPassword) { setFormError("两次输入的新密码不一致。"); return }
    setBusy(true); setFormError("")
    try {
      await write(`/platform/accounts/${resetting.id}/password`, "POST", { password })
      setPassword(""); setConfirmPassword(""); setResetting(null)
      await afterWrite("密码已重置，已有登录会话已撤销。用户下次登录必须修改密码。")
    } catch (reason) {
      setFormError(describe(reason))
      if (reason instanceof PlatformApiError && [401, 403].includes(reason.status)) await refreshAccount()
    } finally { setBusy(false) }
  }

  async function changeStatus() {
    if (!statusChange || busy) return
    setBusy(true); setFormError("")
    let completed = 0
    const failures: string[] = []
    try {
      // Existing single-account API: partial success is reported explicitly.
      for (const person of statusChange.people) {
        try { await write(`/platform/accounts/${person.id}`, "PATCH", { active: statusChange.active }); completed++ }
        catch (reason) {
          failures.push(`${person.name}：${describe(reason)}`)
          if (reason instanceof PlatformApiError && [401, 403].includes(reason.status)) break
        }
      }
      statusChange.clear?.()
      setStatusChange(null)
      await afterWrite(`已${statusChange.active ? "启用" : "停用"} ${completed} 个账号。${!statusChange.active && completed ? "已撤销这些账号的登录会话。" : ""}`)
      if (failures.length) setError(`部分操作未完成：${failures.join("；")}。请刷新后核对。`)
    } finally { setBusy(false) }
  }

  const columns: DataColumn<PlatformAccount>[] = [
    { id: "login", title: "登录账号", value: person => person.login, hideable: false, className: "min-w-40", cell: person => <span className="font-medium">{person.login}</span> },
    { id: "name", title: "姓名", value: person => person.name, className: "min-w-32", cell: person => <span className="whitespace-nowrap">{person.name}{person.id === account.id && <span className="ml-1 text-xs text-muted-foreground">（我）</span>}</span> },
    { id: "status", title: "状态", value: person => Number(person.active), className: "min-w-28", cell: person => <div className="flex flex-col items-start gap-1"><Badge className={person.active ? "personnel-active" : ""} variant={person.active ? "outline" : "secondary"}>{person.active ? "启用" : "停用"}</Badge>{person.must_change_password && <span className="text-xs text-muted-foreground">待修改密码</span>}</div> },
    { id: "role", title: "管理身份", value: person => roleName(person.role), className: "min-w-32", cell: person => <span className="inline-flex items-center gap-2 whitespace-nowrap">{person.role === "admin" ? <ShieldCheck className="size-4 text-muted-foreground" /> : <Users className="size-4 text-muted-foreground" />}{roleName(person.role)}</span> },
    { id: "tags", title: "岗位标签", className: "min-w-36", cell: person => <div className="flex max-w-48 flex-wrap gap-1">{person.tags.length ? person.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="text-muted-foreground">—</span>}</div> },
    { id: "modules", title: "可访问模块", className: "min-w-52", cell: person => <div className="max-w-64 text-xs leading-6 text-muted-foreground">{person.modules.map(module => MODULES[module] || module).join("、")}</div> },
    { id: "actions", title: "操作", hideable: false, className: "w-12", cell: person => <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`操作 ${person.name}`} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-52"><DropdownMenuLabel>{person.name}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => openPerson(person)}><Pencil />编辑</DropdownMenuItem><DropdownMenuItem onSelect={() => { setFormError(""); setPassword(""); setConfirmPassword(""); setShowPassword(false); setResetting(person) }}><KeyRound />重置密码</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem disabled={person.active && !!protectedReason(person)} title={person.active ? protectedReason(person) : undefined} className={person.active ? "text-destructive focus:text-destructive" : ""} onSelect={() => { setFormError(""); setStatusChange({ people: [person], active: !person.active }) }}>{person.active ? "停用账号" : "启用账号"}</DropdownMenuItem>{person.active && protectedReason(person) && <p className="px-2 py-1 text-xs text-muted-foreground">{protectedReason(person)}</p>}</DropdownMenuContent></DropdownMenu> },
  ]

  return <section className="personnel-page flex min-w-0 flex-1 flex-col gap-5 sm:gap-6" aria-labelledby="personnel-title">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 id="personnel-title" className="text-2xl font-bold tracking-tight">人员管理</h1><p className="mt-1 text-sm text-muted-foreground">统一维护账号、岗位标签和登录权限。</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={loading ? "animate-spin" : ""} />刷新</Button><Button onClick={() => openPerson()} disabled={busy}><UserPlus />新增账号</Button></div></div>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>重试</Button></div>}
    {notice && <div role="status" className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm"><span>{notice}</span><Button size="icon-sm" variant="ghost" aria-label="关闭操作提示" onClick={() => setNotice("")}><X /></Button></div>}
    <DataTable rows={filtered} columns={columns} rowId={person => person.id} rowLabel={person => person.name} filterKey={JSON.stringify([query, roles, tags, states])} loading={loading} label="人员列表" empty={hasFilters ? "没有符合条件的人员，请调整或重置筛选条件。" : "暂无人员。"} toolbar={<>
      <Input type="search" aria-label="搜索姓名或登录账号" placeholder="搜索姓名或登录账号…" maxLength={80} className="h-8 w-full sm:w-64" value={query} onChange={event => setQuery(event.target.value)} />
      <FacetedFilter title="状态" selected={states} onChange={setStates} options={[{ value: "active", label: "启用", count: people.filter(person => person.active).length }, { value: "inactive", label: "停用", count: people.filter(person => !person.active).length }]} />
      <FacetedFilter title="管理身份" selected={roles} onChange={setRoles} options={["admin", "user"].map(value => ({ value, label: roleName(value), count: people.filter(person => person.role === value).length }))} />
      <FacetedFilter title="岗位标签" selected={tags} onChange={setTags} options={TAGS.map(value => ({ value, label: value, count: people.filter(person => person.tags.includes(value)).length }))} />
      {hasFilters && <Button variant="ghost" onClick={() => { setQuery(""); setRoles([]); setTags([]); setStates([]) }}>重置<X /></Button>}
    </>} selectionActions={(selected, clear) => {
      const enable = selected.filter(person => !person.active)
      const disable = selected.filter(person => person.active && !protectedReason(person))
      return <><Button size="sm" variant="outline" disabled={!enable.length || busy || loading} onClick={() => { setFormError(""); setStatusChange({ people: enable, active: true, clear }) }}>启用所选（{enable.length}）</Button><Button size="sm" variant="destructive" disabled={!disable.length || busy || loading} onClick={() => { setFormError(""); setStatusChange({ people: disable, active: false, clear }) }}>停用所选（{disable.length}）</Button>{selected.some(person => person.active && protectedReason(person)) && <span className="text-xs text-muted-foreground">自己和最后一名管理员已排除停用操作。</span>}</>
    }} />

    <Dialog open={!!form} onOpenChange={open => { if (!open && !busy) { setForm(null); setFormError("") } }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader><DialogTitle>{form?.id ? "编辑账号" : "新增账号"}</DialogTitle><DialogDescription>{form?.id ? "修改账号信息及岗位标签，访问权限将自动更新。" : "填写账号信息。用户首次登录必须修改初始密码。"}</DialogDescription></DialogHeader>
      {form && <form onSubmit={savePerson} className="space-y-4" aria-label={form.id ? "编辑账号表单" : "新增账号表单"}>
        <fieldset disabled={busy} className="space-y-4">
          <div className="personnel-field"><label htmlFor="personnel-name">姓名</label><Input id="personnel-name" name="name" value={form.name} maxLength={64} required autoComplete="off" onChange={event => setForm({ ...form, name: event.target.value })} /></div>
          <div className="personnel-field"><label htmlFor="personnel-login">登录账号</label><div className="space-y-1.5"><Input id="personnel-login" name="login" value={form.login} disabled={!!form.id} minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]{3,64}" required autoComplete="off" onChange={event => setForm({ ...form, login: event.target.value })} /><p className="text-xs leading-5 text-muted-foreground">3–64 位字母、数字、点、下划线或连字符；创建后不可修改。</p></div></div>
          {!form.id && <div className="personnel-field"><label htmlFor="personnel-password">初始密码</label><div className="space-y-1.5"><div className="relative"><Input id="personnel-password" name="password" type={showPassword ? "text" : "password"} className="pr-10" value={form.password} minLength={8} maxLength={128} required autoComplete="new-password" onChange={event => setForm({ ...form, password: event.target.value })} /><Button variant="ghost" size="icon" type="button" className="absolute top-0 right-0" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff /> : <Eye />}</Button></div><p className="text-xs text-muted-foreground">8–128 个字符。</p></div></div>}
          <div className="personnel-field"><label>管理身份</label><Select label="管理身份" className="w-full max-w-full" value={form.role} onValueChange={value => setForm({ ...form, role: value as PersonForm["role"] })} options={(form.id && people.some(person => person.id === form.id && lastAdmin(person)) ? ["admin"] : ["user", "admin"]).map(value => ({ value, label: roleName(value) }))} /></div>
          {form.id && people.some(person => person.id === form.id && lastAdmin(person)) && <p className="text-xs text-muted-foreground">不能降级最后一名启用中的管理员。</p>}
          <div className="personnel-field"><span id="personnel-tags">岗位标签</span><div role="group" aria-labelledby="personnel-tags" className="flex flex-wrap gap-4 py-1.5">{TAGS.map(tag => <label key={tag} className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox name="tags" value={tag} checked={form.tags.includes(tag)} onCheckedChange={checked => setForm({ ...form, tags: checked ? [...form.tags, tag] : form.tags.filter(value => value !== tag) })} />{tag}</label>)}</div></div>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-6"><span className="font-medium">可访问：</span>{accessFor(form.role, form.tags).map(module => MODULES[module]).join("、") || "请选择至少一个岗位标签"}{form.role === "admin" ? "；人员管理" : ""}</div>
        </fieldset>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter><Button variant="outline" type="button" disabled={busy} onClick={() => setForm(null)}>取消</Button><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存账号"}</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog>

    <Dialog open={!!resetting} onOpenChange={open => { if (!open && !busy) { setResetting(null); setPassword(""); setConfirmPassword(""); setFormError("") } }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}><DialogHeader><DialogTitle>重置密码 · {resetting?.name}</DialogTitle><DialogDescription>设置新的临时密码。已有登录会话立即失效，用户下次登录必须修改密码。{resetting?.id === account.id ? "这是你自己的账号，重置后需要重新登录。" : ""}</DialogDescription></DialogHeader><form onSubmit={resetPassword} className="space-y-4" aria-label="重置密码表单"><div className="personnel-field"><label htmlFor="reset-password">新密码</label><Input id="reset-password" type="password" value={password} minLength={8} maxLength={128} required autoComplete="new-password" disabled={busy} onChange={event => setPassword(event.target.value)} /></div><div className="personnel-field"><label htmlFor="reset-confirm">确认新密码</label><Input id="reset-confirm" type="password" value={confirmPassword} minLength={8} maxLength={128} required autoComplete="new-password" disabled={busy} onChange={event => setConfirmPassword(event.target.value)} /></div>{formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setResetting(null); setPassword(""); setConfirmPassword("") }}>取消</Button><Button type="submit" disabled={busy}>{busy ? "正在重置…" : "确认重置"}</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={!!statusChange} onOpenChange={open => { if (!open && !busy) setStatusChange(null) }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}><DialogHeader><DialogTitle>确认{statusChange?.active ? "启用" : "停用"}账号</DialogTitle><DialogDescription>{statusChange?.active ? "这些账号将恢复登录和原有岗位权限。" : "这些账号将无法登录，已有登录会话将立即失效。"}所选账号将逐一处理。</DialogDescription></DialogHeader><ul className="max-h-52 space-y-1 overflow-auto text-sm">{statusChange?.people.map(person => <li key={person.id}>{person.name} <span className="text-muted-foreground">{person.login}</span></li>)}</ul>{formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setStatusChange(null)}>取消</Button><Button variant={statusChange?.active ? "default" : "destructive"} disabled={busy} onClick={() => void changeStatus()}>{busy ? "正在处理…" : `确认${statusChange?.active ? "启用" : "停用"}`}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
