import { createRoot, type Root } from "react-dom/client"
import { ActionCard } from "./action-card"

type Action = {
  id: string; title: string; description: string; muted?: boolean
  onClick: () => void
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void
  onDragEnd?: () => void
}
const roots = new WeakMap<HTMLElement, Root>()
/** The controller supplies actions; React owns the entire card group. */
export function renderNativeActionCards(container: HTMLElement, actions: Action[]) {
  let root = roots.get(container)
  if (!root) { container.replaceChildren(); root = createRoot(container); roots.set(container, root) }
  container.dataset.nativeBridge = "action-cards"
  root.render(actions.map(action => <ActionCard key={action.id} variant="outline" title={action.title} description={action.description}
    data-action-id={action.id} data-native-focus-key={"action:" + action.id} data-muted={action.muted || undefined} aria-label={`${action.title}，${action.description}`}
    className="data-[muted=true]:opacity-60" draggable={!!action.onDragStart} onClick={action.onClick}
    onDragStart={event => { event.currentTarget.style.opacity = ".35"; action.onDragStart?.(event) }}
    onDragEnd={event => { event.currentTarget.style.removeProperty("opacity"); action.onDragEnd?.() }} />))
}
