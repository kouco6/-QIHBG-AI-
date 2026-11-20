import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Button } from "./button"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./dropdown-menu"
import { Sheet, SheetContent, SheetTitle } from "./sheet"

/** Adapt existing action nodes; their click handlers and disabled state stay authoritative. */
export function createNativeMenu(label: string, items: HTMLButtonElement[]) {
  const host = document.createElement("span")
  host.dataset.nativeBridge = "menu"
  const root = createRoot(host)
  root.render(<DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">{label}</Button></DropdownMenuTrigger>
    <DropdownMenuContent data-native-bridge="menu" align="end">
      {items.map((item, index) => <DropdownMenuItem key={index} disabled={item.disabled}
        variant={item.classList.contains("danger") ? "destructive" : "default"}
        onSelect={() => { setTimeout(() => item.click(), 0) }}>{item.textContent}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>)
  const observer = new MutationObserver(() => {
    if (!host.isConnected) { observer.disconnect(); root.unmount() }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return host
}

/** Sheet owns focus/overlay; the existing controller retains all content nodes and streams. */
export function mountNativeSheet(content: HTMLElement, onClose: () => void) {
  const parking = document.createElement("div")
  parking.hidden = true
  content.before(parking)
  parking.append(content)
  const host = document.createElement("div")
  host.dataset.nativeBridge = "sheet-root"
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
    flushSync(() => root.render(<Sheet open={open} onOpenChange={value => { if (!value) onClose() }}>
      <SheetContent className="native-task-sheet" showCloseButton={false} aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); content.querySelector<HTMLElement>("button")?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); const target = previous?.isConnected ? previous : previousKey ? document.querySelector<HTMLElement>(`[data-native-focus-key="${CSS.escape(previousKey)}"]`) : null; target?.focus({ preventScroll: true }) }}>
        <SheetTitle className="sr-only">任务详情</SheetTitle>
        <div className="native-sheet-content" ref={node => { if (node) node.append(content); else parking.append(content) }} />
      </SheetContent>
    </Sheet>))
  }
  return { setOpen, dispose() { root.unmount(); host.remove(); parking.before(content); parking.remove() } }
}
