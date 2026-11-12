import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PLATFORM_MANUAL_ACCEPTANCE !== "1") {
  throw new Error("逐页截图/控件取证默认关闭；仅用户明确要求时启用 PLATFORM_MANUAL_ACCEPTANCE=1。");
}
if (!process.env.PLATFORM_ACCEPTANCE_OUTPUT) {
  throw new Error("请显式设置源码目录之外的 PLATFORM_ACCEPTANCE_OUTPUT。");
}
export const acceptanceOutput = resolve(process.env.PLATFORM_ACCEPTANCE_OUTPUT);
let sourceContainer = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (let current = sourceContainer; dirname(current) !== current; current = dirname(current)) {
  if (existsSync(join(current, ".worktrees")) && existsSync(join(current, "integration"))) {
    sourceContainer = current;
    break;
  }
}
if (acceptanceOutput === sourceContainer || acceptanceOutput.startsWith(sourceContainer + sep)) {
  throw new Error("验收产物不得写入源码工程或其工作区。");
}

export async function captureControls(scope, screenshotDirectory, id) {
  const documentScope = scope.locator("body");
  const evidence = await documentScope.evaluate(body => {
    const clean = value => (value || "").trim().replace(/\s+/g, " ").slice(0, 140);
    const select = node => [...node.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button], [role=tab]")];
    const entries = [];
    const seen = new Set();
    for (const control of select(body)) {
      if (!control.getClientRects().length || control.closest("[hidden], [inert]")) continue;
      const label = ["adhocCwd", "taskCwd"].includes(control.id) ? "工作目录（已遮盖）" : clean(control.getAttribute("aria-label") ||
        [...(control.labels || [])].map(label => label.textContent).join(" ") ||
        control.getAttribute("placeholder") || control.getAttribute("title") || control.textContent);
      const row = {
        control: control.tagName.toLowerCase(),
        label,
        ...(control.name && { name: control.name }),
        ...(control.type && { type: control.type }),
        ...(control.required && { required: true }),
        ...(control.disabled && { disabled: true }),
        ...(control.dataset.act && { action: control.dataset.act }),
        ...(control.dataset.view && { view: control.dataset.view }),
      };
      const key = JSON.stringify(row);
      if (!seen.has(key) && (label || row.name)) {
        entries.push(row);
        seen.add(key);
      }
    }
    const path = location.pathname.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, ":id");
    return { title: document.title, path, visibleControls: entries };
  });
  const folder = resolve(acceptanceOutput, "controls",
    resolve(screenshotDirectory, "..").split(/[\\/]/).at(-1), screenshotDirectory.split(/[\\/]/).at(-1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, id + ".json"), JSON.stringify(evidence, null, 2) + "\n");
}

export const knowledgePages = [
  ["AI-010", "research", "调研"], ["AI-011", "planning", "企划"],
  ["AI-012", "product", "产品"], ["AI-013", "idea", "灵感"],
  ["AI-014", "graph", "图谱"], ["AI-015", "reviews", "审核中心"],
  ["AI-016", "imports", "导入中心"], ["AI-017", "ops", "运行记录"],
];

export function experiencePages(projectPath, systemId) {
  return [
    ["EXP-017", "/systems/compare", "跨系统对比", "ComparePage.tsx"],
    ["EXP-018", "/divisions/bei", "事业群体验评分", "BeiPage.tsx"],
    ["EXP-019", "/settings/audit", "审计日志", "AuditPage.tsx"],
    ["EXP-020", "/provider-jobs", "Provider 作业", "ProviderJobsPage.tsx"],
    ["EXP-021", "/ai", "AI 分析与会话", "AiPage.tsx"],
    ["EXP-022", projectPath + "/collaboration", "协作空间", "CollaborationPage.tsx"],
    ["EXP-023", projectPath + "/scores/preview", "项目 UEI 实时预览", "UeiPreviewPage.tsx"],
    ["EXP-024", "/dictionaries/software", "体验字典", "DictionaryPage.tsx"],
    ["EXP-025", "/dictionaries/scoring_scheme", "评分方案（选用）", "DictionaryPage.tsx"],
    ["EXP-026", "/systems/" + systemId, "系统详情", "SystemDetailPage.tsx"],
    ["EXP-027", "/systems/" + systemId + "/analytics", "系统分析", "SystemAnalyticsPage.tsx"],
  ];
}
