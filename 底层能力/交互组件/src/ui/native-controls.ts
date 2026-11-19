import { buttonVariants } from "./button"
import { inputClasses } from "./input"
import { textareaClasses } from "./textarea"

/** Apply shared appearance without replacing native nodes or their event/value state.
 * Intended for migrated controllers that create controls dynamically. Returns cleanup.
 */
export function enhanceNativeControls(root: HTMLElement) {
  const apply = (element: Element) => {
    if (!(element instanceof HTMLElement)) return
    let classes = ""
    if (element.tagName === "BUTTON") {
      const variant = element.classList.contains("primary") ? "default"
        : element.classList.contains("danger") ? "destructive" : "outline"
      element.dataset.slot = "button"
      element.dataset.variant = variant
      classes = buttonVariants({ variant, size: "default" })
    } else if (element.tagName === "INPUT" && !["checkbox", "radio", "hidden", "range", "color"].includes((element as HTMLInputElement).type)) {
      element.dataset.slot = "input"; classes = inputClasses
    } else if (element.tagName === "TEXTAREA") {
      element.dataset.slot = "textarea"; classes = textareaClasses
    }
    if (classes) for (const token of classes.split(/\s+/)) if (token && !element.classList.contains(token)) element.classList.add(token)
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
