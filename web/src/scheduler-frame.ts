import "./index.css"
import "./scheduler.css"
import { openNativeDialog, type NativeDialogOptions } from "@capability-ui/native-dialog"
import { enhanceNativeControls } from "@capability-ui/native-controls"

declare global {
  interface Window {
    platformOpenDialog?: (options: NativeDialogOptions) => ReturnType<typeof openNativeDialog>
    platformAiOpenView?: (view: string) => void
    platformHasUnsavedWork?: () => boolean
  }
}
const permitted = new Set(["worksite", "collab", "artifacts", "templates", "runner", "stats", "settings"])
let requestedView = location.hash.slice(1) || "worksite"
window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== location.origin) return
  if (event.data?.type === "ai-theme") document.documentElement.classList.toggle("dark", event.data.dark === true)
  if (event.data?.type === "ai-navigate" && permitted.has(event.data.view)) {
    requestedView = event.data.view
    window.platformAiOpenView?.(requestedView)
  }
})
window.addEventListener("ai-controller-ready", () => {
  if (permitted.has(requestedView)) window.platformAiOpenView?.(requestedView)
  parent.postMessage({ type: "ai-ready" }, location.origin)
})
async function connect() {
  try {
    const response = await fetch("/ai/scaffold.html", { credentials: "same-origin" })
    if (!response.ok || response.redirected) throw new Error("调度服务暂不可用，或登录已失效。请重试或重新登录。")
    const page = new DOMParser().parseFromString(await response.text(), "text/html")
    if (!page.querySelector("#viewWorksite")) throw new Error("调度服务返回了无效页面，请检查后端版本。")
    page.querySelectorAll("script").forEach(script => script.remove())
    document.body.replaceChildren(...Array.from(page.body.childNodes))
    document.body.classList.add("scheduler-document")
    enhanceNativeControls(document.body)
    window.platformOpenDialog = openNativeDialog
    const script = document.createElement("script")
    script.type = "module"; script.src = "/ai/app.js"
    script.onerror = () => showError("调度页面加载失败，请重试。")
    document.body.append(script)
  } catch (error) { showError(error instanceof Error ? error.message : "连接失败") }
}
function showError(message: string) {
  document.body.replaceChildren()
  const box = document.createElement("section"); box.className = "scheduler-error"
  const title = document.createElement("h2"); title.textContent = "暂时无法连接调度中心"
  const detail = document.createElement("p"); detail.textContent = message
  const retry = document.createElement("button"); retry.className = "primary"; retry.textContent = "重试"; retry.onclick = () => location.reload()
  box.append(title, detail, retry); document.body.append(box); enhanceNativeControls(box)
  parent.postMessage({ type: "ai-error", message }, location.origin)
}
void connect()
