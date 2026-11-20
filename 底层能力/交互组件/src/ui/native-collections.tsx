import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "./card"
import { Button } from "./button"
import { Badge } from "./badge"
import { Avatar, AvatarImage, AvatarFallback } from "./avatar"

type Tone = "success" | "danger"
type Tag = { label: string; tone?: Tone; variant?: "outline" | "default" | "secondary" | "destructive" }
type Action = { label: string; variant?: "outline" | "default" | "ghost" | "destructive"; attributes?: Record<string, string>; onClick?: () => void }
export type NativeRecord = { title: string; avatar?: { src?: string; fallback: string }; name?: string; description?: string; tags?: Tag[]; meta?: string; actions?: Action[]; onOpen?: () => void }

/** Dispose short-lived native-controller islands after their containing view is replaced. */
function island(host: HTMLElement) {
  const root = createRoot(host)
  let connected = host.isConnected
  const observer = new MutationObserver(() => {
    if (host.isConnected) connected = true
    else if (connected) { observer.disconnect(); root.unmount() }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return root
}

/** Real Card / Button / Badge composition; business controllers provide data and callbacks. */
export function createNativeRecordCard(record: NativeRecord) {
  const host = document.createElement("div")
  host.dataset.nativeBridge = "record-card"
  host.className = "min-w-0"
  const root = island(host)
  flushSync(() => root.render(<Card className={"h-full min-w-0 [--card-spacing:--spacing(5)]" + (record.onOpen ? " cursor-pointer" : "")}
    onClick={event => { if (record.onOpen && !(event.target as Element).closest("button,a,input,select,textarea")) record.onOpen() }}>
    <CardHeader className="gap-2">
      {record.avatar && <Avatar size="lg"><AvatarImage src={record.avatar.src} alt="" /><AvatarFallback>{record.avatar.fallback}</AvatarFallback></Avatar>}
      <CardTitle role="heading" aria-level={3} className="[overflow-wrap:anywhere]">{record.onOpen
        ? <Button variant="ghost" size="content" className="h-auto max-w-full justify-start p-0 text-left text-base whitespace-normal" onClick={record.onOpen}>{record.title}</Button>
        : record.title}</CardTitle>
      {record.name && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{record.name}</p>}
      {record.description && <CardDescription className="leading-7 [overflow-wrap:anywhere]">{record.description}</CardDescription>}
    </CardHeader>
    {(record.tags?.length || record.meta) ? <CardContent className="flex min-w-0 flex-col gap-3">
      {!!record.tags?.length && <div className="flex flex-wrap gap-2">{record.tags.map((tag, index) => <Badge key={index} variant={tag.variant || "outline"} data-tone={tag.tone} className="max-w-full whitespace-normal text-[13px] leading-5 [overflow-wrap:anywhere]">{tag.label}</Badge>)}</div>}
      {record.meta && <p className="text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{record.meta}</p>}
    </CardContent> : null}
    {!!record.actions?.length && <CardFooter className="mt-auto flex-wrap gap-3">{record.actions.map((action, index) => <Button key={index} variant={action.variant || "outline"} {...action.attributes}
      data-native-focus-key={action.attributes ? "record:" + JSON.stringify(action.attributes) : undefined} onClick={action.onClick}>{action.label}</Button>)}</CardFooter>}
  </Card>))
  return host
}

/** Retain streamed/native content and its event listeners inside the shared Card surface. */
export function wrapNativeCard(content: HTMLElement) {
  const host = document.createElement("div")
  host.className = "native-content-card min-w-0"
  const root = island(host)
  flushSync(() => root.render(<Card className="[--card-spacing:--spacing(5)]"><CardContent className="native-card-content" ref={node => { if (node) node.append(content) }} /></Card>))
  return host
}

const metrics = new WeakMap<HTMLElement, Root>()
const segments = new WeakMap<HTMLElement, Root>()
export function renderNativeSegments(container: HTMLElement, options: { label: string; value: string; items: { value: string; label: string; count?: number }[]; onValueChange: (value: string) => void }) {
  let root = segments.get(container)
  if (!root) { container.replaceChildren(); root = island(container); segments.set(container, root) }
  container.dataset.nativeBridge = "segments"
  root.render(<div role="group" aria-label={options.label} className="flex flex-wrap gap-3">{options.items.map(item => <Button key={item.value}
    variant={item.value === options.value ? "default" : "outline"} aria-pressed={item.value === options.value} onClick={() => options.onValueChange(item.value)}>
    {item.label}{item.count !== undefined && <span className="tabular-nums opacity-80">{item.count}</span>}
  </Button>)}</div>)
}
export function renderNativeMetrics(container: HTMLElement, items: { label: string; value: string | number; tone?: Tone; hint?: string }[]) {
  let root = metrics.get(container)
  if (!root) { container.replaceChildren(); root = island(container); metrics.set(container, root) }
  container.dataset.nativeBridge = "metrics"
  root.render(items.map(item => <Card key={item.label} className="min-w-0 [--card-spacing:--spacing(5)]">
    <CardHeader className="gap-2"><CardDescription>{item.label}</CardDescription><CardTitle data-tone={item.tone} className="text-2xl tabular-nums [overflow-wrap:anywhere]">{item.value}</CardTitle>
      {item.hint && <p className="text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{item.hint}</p>}
    </CardHeader>
  </Card>))
}
