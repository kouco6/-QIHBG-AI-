"""Generate integration source trees from the verified original archives."""

import hashlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from prepare_sources import ROOT, SOURCES, extract, prepare


def transform(path, operation):
    text = path.read_text(encoding="utf-8")
    path.write_text(operation(text), encoding="utf-8", newline="\n")


def edit(path, *changes):
    def replace(text):
        for old, new in changes:
            if old not in text:
                raise ValueError(f"Integration adapter does not match source: {path.name}: {old[:80]}")
            text = text.replace(old, new)
        return text
    transform(path, replace)


def prefix_paths(path, routes, prefix):
    expression = rf"(?<=[\x27\x22\x60(])/(?:{routes})"
    transform(path, lambda source: re.sub(expression, lambda m: prefix + m[0], source))


def bg(source):
    for file in [source / "index.html", *(source / "dimension-assets").iterdir()]:
        if file.is_file() and file.suffix in {".html", ".css", ".js"}:
            prefix_paths(file, r"api/|dimension-assets/", "/bg")
    edit(source / "server.py",
         ("import json\n", "import json\nimport hmac\n"),
         ("DB = ROOT / 'platform.sqlite3'", "DATA = Path(os.environ.get('BG_DATA_DIR', ROOT))\n"
          "ACCESS = os.environ.get('BG_INTEGRATION_KEY', '')\n"
          "DB = DATA / 'platform.sqlite3'"),
         ("Round1Service(DB, ROOT, LOCK)", "Round1Service(DB, DATA, LOCK)"),
         ("        port = self.server.server_port\n",
          "        if ACCESS and not hmac.compare_digest(self.headers.get('X-Integration-Key', ''), ACCESS):\n"
          "            self.send_json(403, {'error': '请从统一入口访问'})\n"
          "            return False\n"
          "        port = self.server.server_port\n"))
    edit(source / "index.html",
         ("function render(){", "function render(){\n rememberIntegratedView();"),
         ("${done(p.id,d.id)?", "${body(p.id,d.id)?.text?.trim()?"),
         ("${formatMD(body(p.id,d.id).text)}", "${formatMD(body(p.id,d.id)?.text)}"),
         ("\nrender();\n</script>", """
function rememberIntegratedView() {
  if (ui.page === 'report' && location.hash.startsWith('#report-')) return;
  const view = ['projects','settings','overview','workspace','report'].includes(ui.page) ? ui.page : 'projects';
  const value = [view, view === 'projects' || view === 'settings' ? '' : ui.projectId,
    view === 'workspace' ? ui.dimId : ''].map(encodeURIComponent).join('/');
  if (location.hash !== '#bg=' + value) history.replaceState(null, '', '#bg=' + value);
}
window.platformHasUnsavedWork = () => Boolean(createBusy || saveInFlight || dim02DraftTimer || storageError
  || (ui.edited && ui.saveState !== 'saved') || (ui.page === 'workspace' && workspaceHasChanges())
  || (ui.page === 'create' && ui.draftName.trim()));
const previousView = location.hash.startsWith('#bg=') ? location.hash.slice(4).split('/') : [];
let [savedPage, savedProject, savedDimension] = previousView;
try { savedProject = decodeURIComponent(savedProject || ''); } catch { savedProject = ''; }
if (savedPage === 'settings') applyPage('settings');
else if (P(savedProject) && ['overview','workspace','report'].includes(savedPage)) {
  applyPage(savedPage, savedProject, DIMENSIONS.some(d => d.id === savedDimension) ? savedDimension : 'DIM-01');
} else render();
</script>"""))


def ai(source):
    public = source / "public"
    for file in public.iterdir():
        if file.suffix in {".html", ".css", ".js"}:
            prefix_paths(file, r"api/|v1/|assets/|health\b|styles\.css\b|app\.js\b", "/ai")
    edit(public / "index.html",
         ('<meta name="color-scheme" content="dark">', '<meta name="color-scheme" content="light">'),
         ("</head>", '  <link rel="stylesheet" href="/platform/ai-theme.css">\n</head>'))
    edit(public / "app.js",
         ('  token: sessionStorage.getItem(LS.token) || "",', '  token: "",'),
         ('  if (urlToken) {', '  if (urlToken && !location.pathname.startsWith("/ai/")) {'),
         ('    if (!$("#tokenDialog").open) $("#tokenDialog").showModal();',
          '    if (window.parent !== window) window.parent.postMessage({type:"platform-auth-check"}, location.origin);'),
         ('  if (!state.token) {\n    $("#tokenDialog").showModal();\n    return;\n  }\n', ''),
         ('    if (!state.token) $("#tokenDialog").showModal();', ''),
         ('    setView("dashboard");',
          '''    const [view, tab] = location.hash.slice(1).split("/");
    if (tab === "flows") state.worksiteTab = "flows";
    setView(["dashboard","worksite","collab","artifacts","knowledge","templates","settings"].includes(view) ? view : "dashboard");'''),
         ('  state.view = view;\n', '  state.view = view;\n  rememberGatewayView();\n'),
         ('  state.worksiteTab = tab;\n', '  state.worksiteTab = tab;\n  rememberGatewayView();\n'),
         ('wire();\nstart();', '''
function rememberGatewayView() {
  const section = state.view === "flowEdit" ? "worksite" : state.view;
  if (section) history.replaceState(null, "", "#" + section + (section === "worksite" ? "/" + state.worksiteTab : ""));
}
window.platformHasUnsavedWork = () => Boolean(
  document.querySelector("#composer.open, dialog[open]") ||
  $("#adhocPrompt").value.trim() || state.view === "flowEdit"
);
wire();
start();'''),
         ('http://${esc(ip)}:${svc.port}/?token=${encodeURIComponent(state.token)}',
          '${location.origin}/work/ai'))
    for name in ("collab.js", "knowledge.js"):
        transform(public / name, lambda s: re.sub(
            r'sessionStorage\.getItem\("wb\.token"\)\s*\|\|\s*new URLSearchParams\(location.search\)\.get\("token"\)\s*\|\|\s*""',
            '""', s))
    edit(source / "src/workbench/knowledge/api.mjs",
         ('url: \x60/api/knowledge/attachments/${row.id}\x60', 'url: \x60/ai/api/knowledge/attachments/${row.id}\x60'))
    edit(source / "src/server.mjs",
         ("frame-ancestors 'none'", "frame-ancestors 'self'"),
         ('    json(res, 400, { error: error instanceof Error ? error.message : String(error) });',
          '''    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });'''),
         ('  lanAddresses,\n  relisten,', '''  lanAddresses: () => [],
  relisten: async (host, port) => {
    if (host !== config.host || port !== config.port) {
      throw new Error("由三合一平台管理监听地址，请修改平台配置后重启。");
    }
  },'''),
         ('  autostartSupported: process.platform === "win32",', '  autostartSupported: false,'),
         ('setTimeout(runUpdateCheck, 25_000).unref?.();\nscheduleUpdateCheck();\nsetInterval(autoApplySweep, 60 * 60 * 1000).unref?.();',
          '// The integration launcher owns the lifecycle of this source snapshot.'))


def experience(source):
    web = source / "frontend/src"
    edit(web / "main.tsx",
         ("import './styles/components.css'", "import './styles/components.css'\nimport './styles/platform.css'"),
         ("<BrowserRouter>", '<BrowserRouter basename={import.meta.env.BASE_URL}>'))
    shutil.copyfile(ROOT / "portal" / "experience-theme.css", web / "styles/platform.css")
    edit(web / "services/api.ts",
         ("const API_PREFIX = '/api/v1'", "const API_PREFIX = import.meta.env.BASE_URL + 'api/v1'"),
         ("fetch('/api/health',", "fetch(import.meta.env.BASE_URL + 'api/health',"))
    edit(web / "app/App.tsx",
         ('  if (bootstrap?.needs_setup && !account) {', '''  if (!account && import.meta.env.BASE_URL === '/experience/') {
    return <main className="login-page"><section className="login-card">
      <h1>体验账号不可用</h1>
      <p>请核对统一平台账号与体验工作台原账号的绑定及启用状态。</p>
      <a href="/work/experience" target="_top">返回统一入口</a>
    </section></main>
  }

  if (bootstrap?.needs_setup && !account) {'''))
    edit(web / "app/AppShell.tsx",
         ('<button type="button" className="btn" onClick={onLogout}>',
          '<button type="button" className="btn" onClick={onLogout} hidden={import.meta.env.BASE_URL === "/experience/"}>'))
    edit(web / "pages/ArtifactEditorPage.tsx",
         ("    window.addEventListener('beforeunload', handler)\n    return () => window.removeEventListener('beforeunload', handler)",
          """    document.documentElement.dataset.platformDirty = 'true'
    window.addEventListener('beforeunload', handler)
    return () => {
      delete document.documentElement.dataset.platformDirty
      window.removeEventListener('beforeunload', handler)
    }"""))
    backend = source / "backend/app"
    edit(backend / "api/deps.py",
         ("from dataclasses import dataclass", "import os\nfrom dataclasses import dataclass"),
         ("def get_current_account(", '''def resolve_request_account(request: Request, db: Session) -> Account | None:
    if os.environ.get("EXPERIENCE_INTEGRATION_KEY"):
        account_id = request.headers.get("x-integration-account", "")
        account = db.get(Account, account_id) if account_id else None
        return account if account and account.is_active else None
    return accounts_service.resolve_session(db, extract_session_token(request))


def get_current_account('''),
         ("    token = extract_session_token(request)\n    account = accounts_service.resolve_session(db, token)",
          "    account = resolve_request_account(request, db)"),
         ("    return accounts_service.resolve_session(db, extract_session_token(request))\n\n\ndef require_primary_account",
          "    return resolve_request_account(request, db)\n\n\ndef require_primary_account"))
    edit(backend / "main.py",
         ("import logging\n", "import hmac\nimport logging\nimport os\n"),
         ("        rid = request.headers.get(REQUEST_ID_HEADER)", '''        key = os.environ.get("EXPERIENCE_INTEGRATION_KEY")
        if key and not hmac.compare_digest(request.headers.get("x-integration-key", ""), key):
            return JSONResponse(status_code=403, content={"code": "forbidden", "message": "请从统一入口访问"})
        rid = request.headers.get(REQUEST_ID_HEADER)'''))
    edit(backend / "services/issues.py",
         ("from app.models.scoring import ScoringScheme, ScoringSchemeCell",
          "from app.models.scoring import ScoringScheme, ScoringSchemeCell\nfrom app.models.systems import System"))
    edit(backend / "services/collaboration.py",
         ("    idempotency_key: str,\n", "    idempotency_key: str | None,\n"),
         ("        idempotency_key=idempotency_key,\n", '        idempotency_key=idempotency_key or f"ai_conv:{conv.id}:{user_message.id}",\n'),
         ('        idempotency_key=f"ai_conv:{conv.id}:{user_message.id}",\n', '        idempotency_key=None,\n'))


def prepare_runtime(node, npm, source_dir):
    runtime = ROOT / "runtime"
    revision = hashlib.sha256(Path(__file__).read_bytes() + (ROOT / "portal/experience-theme.css").read_bytes()).hexdigest()
    marker = runtime / ".source-revision"
    if marker.is_file() and marker.read_text() == revision and (runtime / "experience/frontend/dist/index.html").is_file():
        return
    prepare(source_dir, ROOT, SOURCES)
    with tempfile.TemporaryDirectory(prefix="platform-sources-", dir=ROOT) as tmp:
        staging = Path(tmp) / "runtime"
        staging.mkdir()
        for name, adapt in (("bg", bg), ("ai-gateway", ai), ("experience", experience)):
            archive, wrapper, _, encoding = SOURCES[name]
            folder = staging / name
            folder.mkdir()
            extract(ROOT / "backups" / archive, folder, wrapper, encoding)
            adapt(folder)
        front = staging / "experience/frontend"
        installed = runtime / "experience/frontend/node_modules"
        if not installed.exists():
            installed = ROOT / "modules/experience/frontend/node_modules"
        if (installed / "vite/bin/vite.js").is_file():
            shutil.copytree(installed, front / "node_modules", symlinks=True)
        else:
            command = [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
            subprocess.run(command, cwd=front, check=True, shell=Path(npm).suffix.lower() in {".cmd", ".bat"})
        subprocess.run([node, "node_modules/typescript/bin/tsc", "-b"], cwd=front, check=True)
        subprocess.run([node, "node_modules/vite/bin/vite.js", "build", "--base", "/experience/"], cwd=front, check=True)
        (staging / ".source-revision").write_text(revision)
        previous = Path(tmp) / "previous"
        if runtime.exists():
            runtime.rename(previous)
        try:
            staging.rename(runtime)
        except OSError:
            if previous.exists():
                previous.rename(runtime)
            raise
