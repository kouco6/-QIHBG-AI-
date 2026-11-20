import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Dialog, DialogContent, DialogTitle } from "./dialog"

/** Radix owns modal focus/Escape/overlay; existing form nodes, IDs and handlers stay intact. */
export function mountRetainedDialog(content: HTMLElement, options: { title: string; titleId?: string; width?: number }) {
  const parking = document.createElement("div")
  parking.hidden = true
  content.before(parking)
  parking.append(content)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let opened = false
  let previous: HTMLElement | null = null
  let previousKey: string | null = null
  const setOpen = (open: boolean) => {
    if (opened === open) return
    if (open) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      previousKey = previous?.getAttribute("data-native-focus-key") || null
    }
    opened = open
    content.hidden = !open
    flushSync(() => root.render(<Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="native-retained-dialog !flex !flex-col !gap-0 !p-0" aria-labelledby={options.titleId} aria-describedby={undefined}
        style={{ width: options.width || 760, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 32px)", overflow: "hidden" }}
        onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => Array.from(content.querySelectorAll<HTMLElement>('input,textarea,[data-slot="select-trigger"],button')).find(node => node.offsetParent !== null && !node.matches(":disabled,.native-control-source"))?.focus()) }}
        onCloseAutoFocus={event => { event.preventDefault(); const target = previous?.isConnected ? previous : previousKey ? document.querySelector<HTMLElement>(`[data-native-focus-key="${CSS.escape(previousKey)}"]`) : null; target?.focus({ preventScroll: true }) }}>
        <DialogTitle className="sr-only">{options.title}</DialogTitle>
        <div className="native-retained-slot flex min-h-0 flex-1 flex-col" ref={node => { if (node) node.append(content); else parking.append(content) }} />
      </DialogContent>
    </Dialog>))
    if (!open) content.dispatchEvent(new Event("close"))
  }
  return { setOpen, get open() { return opened }, dispose() { root.unmount(); host.remove(); parking.before(content); parking.remove() } }
}
