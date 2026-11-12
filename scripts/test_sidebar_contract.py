"""Check the three module sidebars share one visual contract."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    "portal/index.html": ('aria-label="公共导航"', "企划设计BG平台", "logo.png"),
    "portal/style.css": ("grid-template-rows: 56px minmax(0, 1fr)",),
    "portal/app.js": ("产品企划中心", "AI调度中心", "产品体验中心", "企划设计BG平台"),
    "portal/logo.png": (),
    "modules/bg/index.html": (
        "产品企划中心", "产品企划与方案管理", "业务菜单", "planning-sidebar-header",
        "rail-toggle", "width:220px", "width:64px", "#e9f3ff", "#1376d1",
        'data-page="projects"', 'data-page="settings"', "function render(){", 'stroke-width="1.5"',
        "产品企划中心　｜　数据保存在本机 SQLite",
    ),
    "modules/ai-gateway/public/index.html": (
        "AI调度中心", "任务调度与协作工作台", "业务菜单", 'id="sideToggle"', 'data-view="dashboard"',
        'data-view="worksite"', 'data-view="collab"', 'data-view="artifacts"', 'data-view="knowledge"',
        'data-view="templates"', 'data-view="settings"',
    ),
    "modules/ai-gateway/public/styles.css": ("220px", "64px", "#e9f3ff", "#1376d1"),
    "modules/ai-gateway/public/app.js": ("is-collapsed", "setView(btn.dataset.view)"),
    "modules/experience/frontend/src/app/AppShell.tsx": (
        "产品体验中心", "体验评测与问题管理", "业务菜单", "primaryOnly", "isPrimary",
        "to: '/projects'", "to: '/settings'",
        "aria-label={collapsed ? '展开侧栏' : '收起侧栏'}", "LineIcon",
        "isActive && !disabled",
    ),
    "modules/experience/frontend/src/styles/base.css": ("width: 220px",),
    "modules/experience/frontend/src/styles/components.css": ("width: 64px", "#e9f3ff", "#1376d1"),
    "portal/ai-theme.css": ("#e9f3ff", "#1376d1"),
    "scripts/platform_http.py": ('"logo.png"',),
}


def main():
    missing = []
    for relative, needles in REQUIRED.items():
        path = ROOT / relative
        if not path.is_file():
            missing.append(f"{relative}: missing")
            continue
        if relative.endswith(".png"):
            continue
        text = path.read_text()
        for needle in needles:
            if needle not in text:
                missing.append(f"{relative}: {needle}")
    if missing:
        raise SystemExit("sidebar contract failed:\n" + "\n".join(missing))
    print("PASS sidebar contract")


if __name__ == "__main__":
    main()
