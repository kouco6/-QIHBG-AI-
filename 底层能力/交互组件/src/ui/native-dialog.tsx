import "./native-layout.css"
import { enhanceNativeForms } from "./native-forms"
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
  const previousId = previous?.id || null
  const previousKey = previous?.getAttribute("data-native-focus-key") || null
  let forms: ReturnType<typeof enhanceNativeForms> | undefined
  let settled = false
  let mounted = false
  let resolveResult: (value: unknown) => void
  const promise = new Promise<unknown>(resolve => { resolveResult = resolve })
  const close = (value: unknown = null) => {
    if (settled) return
    settled = true
    if (dismissPrevious === dismiss) dismissPrevious = null
    queueMicrotask(() => { forms?.dispose(); root.unmount(); host.remove(); (previous?.isConnected ? previous : previousKey ? document.querySelector<HTMLElement>(`[data-native-focus-key="${CSS.escape(previousKey)}"]`) : previousId ? document.getElementById(previousId) : null)?.focus({ preventScroll: true }); resolveResult(value) })
  }
  const dismiss = () => close(null)
  dismissPrevious = dismiss
  const mount = (panel: HTMLDivElement | null) => {
    if (!panel || mounted) return
    mounted = true
    panel.querySelectorAll("[data-dlg-cancel]").forEach(button => button.addEventListener("click", dismiss))
    panel.dataset.nativeLayout = "comfortable"
    options.onMount?.({ panel, close, onEnter(handler) {
      panel.addEventListener("keydown", event => {
        if (event.key !== "Enter") return
        if (event.target instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey) return
        if (event.target instanceof HTMLButtonElement && event.target.dataset.dlgCancel !== undefined) return
        event.preventDefault(); handler()
      })
    } })
    forms = enhanceNativeForms(panel, 'select, input[type="checkbox"]')
  }
  root.render(<Dialog open onOpenChange={open => { if (!open) dismiss() }}>
    <DialogContent ref={mount} className="native-capability-dialog !flex !flex-col !gap-0 !p-0" style={{ width: Math.min(options.width || 480, 760), maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 32px)", overflow: "hidden" }}
      onOpenAutoFocus={event => {
        event.preventDefault()
        requestAnimationFrame(() => host.ownerDocument.querySelector<HTMLElement>('[data-slot="dialog-content"] [data-dlg-autofocus], [data-slot="dialog-content"] input, [data-slot="dialog-content"] textarea')?.focus())
      }}>
      <DialogHeader className="shrink-0 border-b px-6 pt-6 pb-5 pr-12"><DialogTitle>{options.title}</DialogTitle><DialogDescription>{options.subtitle || "请核对内容后操作"}</DialogDescription></DialogHeader>
      <div className="native-dialog-body min-h-0 overflow-y-auto px-6 py-6" dangerouslySetInnerHTML={{ __html: options.body || "" }} />
      <div className="native-dialog-footer flex shrink-0 flex-wrap justify-end gap-3 border-t px-6 py-4" dangerouslySetInnerHTML={{ __html: options.footer || "" }} />
    </DialogContent>
  </Dialog>)
  return { promise, close }
}
