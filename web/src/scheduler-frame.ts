import "./index.css"
import "./scheduler.css"
import "@capability-ui/native-layout.css"
import { openNativeDialog, type NativeDialogOptions } from "@capability-ui/native-dialog"
import { enhanceNativeControls } from "@capability-ui/native-controls"

import { renderNativeActionCards } from "@capability-ui/native-action-cards"
import { enhanceNativeForms } from "@capability-ui/native-forms"
import { createNativeMenu, mountNativeSheet } from "@capability-ui/native-surfaces"
import { createNativeRecordCard, wrapNativeCard, renderNativeMetrics, renderNativeSegments } from "@capability-ui/native-collections"
import { mountRetainedDialog } from "@capability-ui/native-retained-dialog"
import { renderNativeDataTable } from "@capability-table/native-data-table"

declare global {
  interface Window {
    platformRenderActionCards?: typeof renderNativeActionCards
    platformCreateRecordCard?: typeof createNativeRecordCard
    platformWrapCard?: typeof wrapNativeCard
    platformRenderMetrics?: typeof renderNativeMetrics
    platformRenderSegments?: typeof renderNativeSegments
    platformRenderDataTable?: typeof renderNativeDataTable
    platformDialogs?: Record<string, ReturnType<typeof mountRetainedDialog>>
    platformCreateMenu?: typeof createNativeMenu
    platformTaskDrawer?: ReturnType<typeof mountNativeSheet>
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
    document.body.dataset.nativeLayout = "comfortable"
    enhanceNativeControls(document.body)
    window.platformOpenDialog = openNativeDialog
    window.platformCreateMenu = createNativeMenu
    window.platformRenderActionCards = renderNativeActionCards
    window.platformCreateRecordCard = createNativeRecordCard
    window.platformWrapCard = wrapNativeCard
    window.platformRenderMetrics = renderNativeMetrics
    window.platformRenderSegments = renderNativeSegments
    window.platformRenderDataTable = renderNativeDataTable
    window.platformDialogs = {}
    for (const [id, title, titleId, width] of [
      ["artifactPreview", "文件预览", "apreviewName", 1000],
      ["skillDialog", "工作方法", "skillDlgTitle", 880],
      ["hubDialog", "连接 AI 能力平台", "hubDialogTitle", 560],
    ] as const) {
      const content = document.getElementById(id)
      if (content) window.platformDialogs[id] = mountRetainedDialog(content, { title, titleId, width })
    }
    const drawer = document.querySelector<HTMLElement>("#drawer")
    if (drawer) window.platformTaskDrawer = mountNativeSheet(drawer, () => drawer.dispatchEvent(new Event("native-sheet-close")))
    enhanceNativeForms(document.body, '#viewWorksite select, #viewFlowEdit select, #viewWorksite input[type="checkbox"], #viewFlowEdit input[type="checkbox"], #drawer select, #drawer input[type="checkbox"], #viewCollab select, #viewTemplates select, #hubDialog select, #skillDialog select, #viewSettings select, #viewSettings input[type="checkbox"]')
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
