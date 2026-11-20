import { createRoot, type Root } from "react-dom/client"
import { Select } from "./select"
import { Checkbox } from "./checkbox"

type Source = HTMLSelectElement | HTMLInputElement

/** Keep native sources for controller queries, validation, FormData and change listeners.
 * React owns only the adjacent shared control, never the business form subtree.
 */
export function enhanceNativeForms(container: HTMLElement, selector: string) {
  const entries = new Map<Source, { host: HTMLSpanElement; root: Root; signature: string; restore: () => void }>()
  let pending = false
  let disposed = false
  const refresh = () => {
    pending = false
    if (disposed) return
    for (const [source, entry] of entries) {
      if (!container.contains(source)) {
        entry.root.unmount(); entry.host.remove(); entry.restore(); entries.delete(source)
      }
    }
    container.querySelectorAll<Source>(selector).forEach(source => {
      if (source.closest("[data-native-bridge]") || (source instanceof HTMLSelectElement && source.multiple)) return
      let entry = entries.get(source)
      if (!entry) {
        const host = document.createElement("span")
        host.dataset.nativeBridge = source instanceof HTMLSelectElement ? "select" : "checkbox"
        const tabIndex = source.getAttribute("tabindex")
        const ariaHidden = source.getAttribute("aria-hidden")
        source.classList.add("native-control-source")
        source.tabIndex = -1; source.setAttribute("aria-hidden", "true")
        source.after(host)
        const focus = () => host.querySelector<HTMLElement>("button")?.focus()
        source.addEventListener("focus", focus)
        entry = { host, root: createRoot(host), signature: "", restore: () => {
          source.classList.remove("native-control-source")
          if (tabIndex === null) source.removeAttribute("tabindex"); else source.setAttribute("tabindex", tabIndex)
          if (ariaHidden === null) source.removeAttribute("aria-hidden"); else source.setAttribute("aria-hidden", ariaHidden)
          source.removeEventListener("focus", focus)
        } }
        entries.set(source, entry)
      }
      const label = source.getAttribute("aria-label") || source.labels?.[0]?.querySelector(":scope > span")?.textContent?.trim() || source.labels?.[0]?.textContent?.trim() || "选择"
      const disabled = source.matches(":disabled")
      const changed = () => {
        source.dispatchEvent(new Event("input", { bubbles: true }))
        source.dispatchEvent(new Event("change", { bubbles: true }))
        schedule()
      }
      const options = source instanceof HTMLSelectElement
        ? Array.from(source.options).map(option => ({ value: "native:" + option.value, label: option.label, disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) })) : []
      const signature = JSON.stringify([label, disabled, source.hidden, source.title, source instanceof HTMLSelectElement ? source.value : source.checked, options])
      if (entry.signature === signature) return
      entry.signature = signature
      entry.host.hidden = source.hidden
      if (source instanceof HTMLSelectElement) {
        entry.root.render(<Select label={label} value={source.selectedIndex < 0 ? "" : "native:" + source.value} disabled={disabled} options={options}
          onValueChange={value => { source.value = value.slice(7); changed() }} />)
      } else {
        entry.root.render(<Checkbox aria-label={label} title={source.title || undefined} checked={source.checked} disabled={disabled}
          onClick={event => event.stopPropagation()}
          onCheckedChange={value => { source.checked = value === true; changed() }} />)
      }
    })
  }
  const schedule = () => {
    if (!pending && !disposed) { pending = true; queueMicrotask(refresh) }
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target instanceof Element && !record.target.closest("[data-native-bridge]"))) schedule()
  })
  observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "selected", "checked", "label", "value", "aria-label"] })
  container.addEventListener("change", schedule, true)
  container.addEventListener("input", schedule, true)
  const reset = () => setTimeout(schedule, 0)
  container.addEventListener("reset", reset, true)
  refresh()
  return { refresh: schedule, dispose() {
    disposed = true; observer.disconnect()
    container.removeEventListener("change", schedule, true); container.removeEventListener("input", schedule, true); container.removeEventListener("reset", reset, true)
    for (const entry of entries.values()) { entry.root.unmount(); entry.host.remove(); entry.restore() }
    entries.clear()
  } }
}
