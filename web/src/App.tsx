import { useCallback, useEffect, useRef, useState } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { InteractionPage, TablePage, TypePage } from "@/components/capability-pages"
import { LoginPage } from "@/components/login-page"
import { Overview } from "@/components/overview"
import { SearchCommand } from "@/components/search-command"
import { UserMenu } from "@/components/user-menu"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import JellyRadio from "@/components/JellyRadio"
import { ThemeToggle } from "@/components/theme-toggle"
import { TemplatesPage, type LeaveGuard } from "@/components/templates-page"
import { AiPage, type AiPage as AiPageId } from "@/components/ai-page"
import { platformApi, PlatformApiError, type PlatformAccount } from "@/lib/platform-api"
import { PersonnelPage } from "@/components/personnel-page"

type ModuleId = "planning" | "capabilities" | "ai"
type PageId = "overview" | "table" | "interaction" | "type" | "templates" | "people" | `ai-${AiPageId}`

const modules: { id: ModuleId; label: string }[] = [
  { id: "planning", label: "产品企划中心" },
  { id: "ai", label: "AI 调度中心" },
  { id: "capabilities", label: "底层能力" },
]

export default function App() {
  const [aiAdmin, setAiAdmin] = useState(false)
  const [account, setAccount] = useState<PlatformAccount | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [moduleId, setModuleId] = useState<ModuleId>(location.hash.startsWith("#ai/") ? "ai" : "planning")
  const [pageId, setPageId] = useState<PageId>(location.hash.startsWith("#ai/") && ["worksite","collab","artifacts","templates","runner","stats","settings"].includes(location.hash.slice(4)) ? `ai-${location.hash.slice(4) as AiPageId}` : location.hash.startsWith("#ai/") ? "ai-worksite" : "overview")
  const [sessionError, setSessionError] = useState("")
  const leaveGuard = useRef<LeaveGuard | null>(null)
  const registerGuard = useCallback((guard: LeaveGuard | null) => { leaveGuard.current = guard }, [])
  const refreshAccount = useCallback(async () => {
    try {
      const next = await platformApi<PlatformAccount>('/platform/session')
      setAccount(next)
      setSignedIn(!next.must_change_password)
      if (next.role !== 'admin') setPageId(page => page === 'people' ? 'overview' : page)
      setSessionError('')
    } catch (reason) {
      if (reason instanceof PlatformApiError && reason.status === 401) { setAccount(null); setSignedIn(false) }
      else setSessionError('无法更新账号状态，请检查连接后重试。')
    }
  }, [])
  useEffect(() => { void platformApi<PlatformAccount>('/platform/session').then(account => { setAccount(account); setSignedIn(!account.must_change_password) }).catch(() => {}) }, [])
  useEffect(() => {
    const logout = async () => {
      if (leaveGuard.current && !await leaveGuard.current()) return
      try { await platformApi('/platform/logout', { method: 'POST' }); setSignedIn(false); setAccount(null) }
      catch { setSessionError('退出失败，请重试') }
    }
    window.addEventListener('platform-logout-request', logout)
    return () => window.removeEventListener('platform-logout-request', logout)
  }, [])

  const selectAiPage = useCallback((page: AiPageId) => {
    setPageId(`ai-${page}`)
    history.replaceState(null, "", `#ai/${page}`)
  }, [])
  const permittedModules = modules.filter(item => !account || account.modules.includes(item.id === "planning" ? "bg" : item.id))
  useEffect(() => {
    if (signedIn) void platformApi<PlatformAccount>('/platform/session').then(setAccount).catch(() => setSignedIn(false))
  }, [signedIn])

  if (!signedIn) {
    return <LoginPage onSuccess={next => { setAccount(next); setSignedIn(true); if (next.role !== 'admin' && pageId === 'people') setPageId('overview'); setSessionError('') }} />
  }

  async function openModule(next: ModuleId) {
    if (leaveGuard.current && !await leaveGuard.current()) return
    setModuleId(next)
    setPageId(next === "ai" ? "ai-worksite" : next === "planning" ? "overview" : "table")
    history.replaceState(null, "", next === "ai" ? "#ai/worksite" : "#" + next)
  }
  async function openPage(id: string) {
    if (id === 'people' && account?.role !== 'admin') return
    if (id === pageId) return
    if (leaveGuard.current && !await leaveGuard.current()) return
    setPageId(id as PageId)
    if (id.startsWith("ai-")) history.replaceState(null, "", "#ai/" + id.slice(3))
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar aiAdmin={aiAdmin} moduleId={moduleId} activeId={pageId} onSelect={id => void openPage(id)} account={account} />
        <SidebarInset>
          <header className="sticky top-0 z-20 flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:gap-3 sm:px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="hidden h-4 sm:block" />
            <div className="min-w-0 flex-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><JellyRadio
              ariaLabel="模块"
              items={permittedModules.map((item) => ({ value: item.id, label: item.label }))}
              value={moduleId}
              onChange={(value) => openModule(value as ModuleId)}
              size="sm"
              chipColor="var(--muted)"
              activeColor="var(--primary)"
              textColor="var(--muted-foreground)"
              activeTextColor="var(--primary-foreground)"
            /></div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <div className="hidden sm:block"><SearchCommand /></div>
              <ThemeToggle />
              <UserMenu account={account} />
            </div>
          </header>
          <main className={moduleId === "ai" && pageId.startsWith("ai-") ? "flex min-w-0 flex-1 flex-col" : "flex min-w-0 flex-1 flex-col gap-4 p-4"}>
            {sessionError ? <p role="alert" className="text-sm text-destructive">{sessionError}</p> : null}
            {moduleId === "ai" && pageId.startsWith("ai-") ? <AiPage page={pageId.slice(3) as AiPageId} onSelect={selectAiPage} onAdmin={setAiAdmin} registerGuard={registerGuard} /> : null}
            {pageId === "overview" ? <Overview /> : null}
            {pageId === "table" ? <TablePage /> : null}
            {pageId === "interaction" ? <InteractionPage /> : null}
            {pageId === "type" ? <TypePage /> : null}
            {pageId === "templates" ? <TemplatesPage registerGuard={registerGuard} /> : null}
            {pageId === "people" && account?.role === "admin" ? <PersonnelPage account={account} refreshAccount={refreshAccount} registerGuard={registerGuard} /> : null}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
