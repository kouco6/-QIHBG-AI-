import { useEffect, useRef, useState } from "react"
import { Button } from "@capability-ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@capability-ui/dialog"
import { Skeleton } from "@capability-ui/skeleton"
import type { LeaveGuard } from "./templates-page"

export const aiPages = ["worksite", "collab", "artifacts", "templates", "runner", "stats", "settings"] as const
export type AiPage = typeof aiPages[number]
export function AiPage({ page, onSelect, onAdmin, registerGuard }: {
  page: AiPage; onSelect: (page: AiPage) => void; onAdmin: (admin: boolean) => void
  registerGuard: (guard: LeaveGuard | null) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [initialPage] = useState(page)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const leaveResolver = useRef<((leave: boolean) => void) | null>(null)
  const currentPage = useRef(page)
  useEffect(() => { currentPage.current = page }, [page])
  const send = (data: unknown) => frame.current?.contentWindow?.postMessage(data, location.origin)
  useEffect(() => {
    send({ type: "ai-navigate", view: page })
  }, [page, ready])
  useEffect(() => {
    const syncTheme = () => send({ type: "ai-theme", dark: document.documentElement.classList.contains("dark") })
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.type === "ai-ready") { setReady(true); setError(""); syncTheme(); send({type:"ai-navigate",view:currentPage.current}) }
      if (event.data?.type === "ai-error") setError(event.data.message)
      if (event.data?.type === "ai-view" && aiPages.includes(event.data.view)) onSelect(event.data.view)
      if (event.data?.type === "ai-account") onAdmin(event.data.admin === true)
      if (event.data?.type === "platform-auth-check") window.dispatchEvent(new Event("platform-logout-request"))
    }
    window.addEventListener("message", receive)
    registerGuard(async () => {
      const target = frame.current?.contentWindow as (Window & { platformHasUnsavedWork?: () => boolean }) | null
      if (!target?.platformHasUnsavedWork?.()) return true
      if (leaveResolver.current) return false
      return new Promise<boolean>(resolve => { leaveResolver.current = resolve; setConfirmLeave(true) })
    })
    return () => { observer.disconnect(); window.removeEventListener("message", receive); registerGuard(null); leaveResolver.current?.(false); leaveResolver.current = null }
  }, [onSelect, onAdmin, registerGuard])
  function finishLeave(leave: boolean) { const resolve = leaveResolver.current; leaveResolver.current = null; setConfirmLeave(false); resolve?.(leave) }
  return <section className="relative flex min-h-0 flex-1 flex-col" aria-label="AI 调度中心">
    {!ready && !error ? <div className="absolute inset-0 z-10 space-y-4 bg-background p-6" role="status"><p className="text-sm text-muted-foreground">正在连接调度服务…</p><Skeleton className="h-10 w-48" /><Skeleton className="h-52 w-full" /></div> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm"><p>{error}</p><Button variant="outline" onClick={() => { setError(""); setReady(false); frame.current?.contentWindow?.location.reload() }}>重试</Button></div> : null}
    <iframe ref={frame} title="AI 调度工作台" src={`./scheduler.html#${initialPage}`} className="min-h-[calc(100dvh-5rem)] w-full flex-1 border-0" onLoad={() => send({ type: "ai-theme", dark: document.documentElement.classList.contains("dark") })} />
    <Dialog open={confirmLeave} onOpenChange={open => { if (!open) finishLeave(false) }}><DialogContent><DialogHeader><DialogTitle>离开当前调度页面？</DialogTitle><DialogDescription>当前页面存在未提交内容，离开后可能丢失。已派发的任务会继续执行。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => finishLeave(false)}>继续编辑</Button><Button onClick={() => finishLeave(true)}>确认离开</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
