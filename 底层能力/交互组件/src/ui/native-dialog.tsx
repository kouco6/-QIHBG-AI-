import { createRoot } from "react-dom/client"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./dialog"

type MountedDialog = {
  panel: HTMLDivElement
  close: (value: unknown) => void
  onEnter: (handler: () => void) => void
}
export type NativeDialogOptions = {
  title: string; subtitle?: string; body?: string; footer?: string; tone?: string; width?: number
  onMount?: (dialog: MountedDialog) => void
}
let dismissPrevious: (() => void) | null = null

/** Adapt an existing DOM form controller to the shared Radix Dialog surface.
 * HTML is supplied by the application's existing escaped templates, never remote markup.
 */
export function openNativeDialog(options: NativeDialogOptions) {
  dismissPrevious?.()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let settled = false
  let mounted = false
  let resolveResult: (value: unknown) => void
  const promise = new Promise<unknown>(resolve => { resolveResult = resolve })
  const close = (value: unknown = null) => {
    if (settled) return
    settled = true
    if (dismissPrevious === dismiss) dismissPrevious = null
    queueMicrotask(() => { root.unmount(); host.remove(); previous?.focus({ preventScroll: true }); resolveResult(value) })
  }
  const dismiss = () => close(null)
  dismissPrevious = dismiss
  const mount = (panel: HTMLDivElement | null) => {
    if (!panel || mounted) return
    mounted = true
    panel.querySelectorAll("[data-dlg-cancel]").forEach(button => button.addEventListener("click", dismiss))
    options.onMount?.({ panel, close, onEnter(handler) {
      panel.addEventListener("keydown", event => {
        if (event.key !== "Enter") return
        if (event.target instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey) return
        if (event.target instanceof HTMLButtonElement && event.target.dataset.dlgCancel !== undefined) return
        event.preventDefault(); handler()
      })
    } })
  }
  root.render(<Dialog open onOpenChange={open => { if (!open) dismiss() }}>
    <DialogContent ref={mount} className="native-capability-dialog" style={{ width: Math.min(options.width || 460, 640), maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 32px)", overflow: "auto" }}
      onOpenAutoFocus={event => {
        event.preventDefault()
        requestAnimationFrame(() => host.ownerDocument.querySelector<HTMLElement>('[data-slot="dialog-content"] [data-dlg-autofocus], [data-slot="dialog-content"] input, [data-slot="dialog-content"] textarea')?.focus())
      }}>
      <DialogHeader><DialogTitle>{options.title}</DialogTitle><DialogDescription>{options.subtitle || "请核对内容后操作"}</DialogDescription></DialogHeader>
      <div className="native-dialog-body" dangerouslySetInnerHTML={{ __html: options.body || "" }} />
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3" dangerouslySetInnerHTML={{ __html: options.footer || "" }} />
    </DialogContent>
  </Dialog>)
  return { promise, close }
}
