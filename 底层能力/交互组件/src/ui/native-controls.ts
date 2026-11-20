import { buttonVariants } from "./button"
import { inputClasses } from "./input"
import { textareaClasses } from "./textarea"

/** Apply shared appearance without replacing native nodes or their event/value state.
 * Intended for migrated controllers that create controls dynamically. Returns cleanup.
 */
export function enhanceNativeControls(root: HTMLElement) {
  const applied = new WeakMap<Element, string[]>()
  const apply = (element: Element) => {
    if (!(element instanceof HTMLElement)) return
    let classes = ""
    if (element.tagName === "BUTTON" && !element.closest("[data-native-bridge]") && (!element.dataset.slot || !!element.dataset.nativeControl)) {
      const variant = element.classList.contains("primary") ? "default"
        : element.classList.contains("danger") ? "destructive"
        : element.classList.contains("text-btn") ? "link"
        : element.classList.contains("ghost") || element.classList.contains("icon-btn") ? "ghost" : "outline"
      element.dataset.nativeControl = "button"
      element.dataset.slot = "button"
      element.dataset.variant = variant
      const size = element.dataset.nativeSize === "content" || element.matches(".avatar-pick,.ua-seg-btn,.ua-cli-card") ? "content" : "default"
      element.dataset.size = size
      classes = buttonVariants({ variant, size })
    } else if (element.tagName === "INPUT" && !["checkbox", "radio", "hidden", "range", "color"].includes((element as HTMLInputElement).type)) {
      element.dataset.slot = "input"; classes = inputClasses
    } else if (element.tagName === "TEXTAREA") {
      element.dataset.slot = "textarea"; classes = textareaClasses
    }
    if (classes) {
      const tokens = classes.split(/\s+/).filter(Boolean)
      for (const token of applied.get(element) || []) if (!tokens.includes(token)) element.classList.remove(token)
      for (const token of tokens) if (!element.classList.contains(token)) element.classList.add(token)
      applied.set(element, tokens)
    }
  }
  const scan = (node: Element) => { apply(node); node.querySelectorAll("button,input,textarea").forEach(apply) }
  scan(root)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") apply(record.target as Element)
      else record.addedNodes.forEach(node => { if (node instanceof Element) scan(node) })
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}
