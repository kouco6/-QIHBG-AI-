"""Bind the retained task controller to V2-only routing and lifecycle."""
import re

def transform(path,operation):
    path.write_text(operation(path.read_text(encoding='utf-8')),encoding='utf-8',newline='\n')

def ai(source):
    for path in (source/'public').rglob('*'):
        if path.suffix in {'.html','.css','.js'}:
            transform(path,lambda text:re.sub(r'''(?<=['"`(])/(?:api/|v1/|assets/|health\b|layout\.css\b|app\.js\b)''',lambda m:'/ai'+m[0],text))
    transform(source/'public/app.js',lambda s:s.replace('  token: sessionStorage.getItem(LS.token) || "",','  token: "",').replace('  if (urlToken) {','  if (urlToken && !location.pathname.startsWith("/ai/")) {'))
    transform(source/'public/collab.js',lambda s:re.sub(r'sessionStorage\.getItem\("wb\.token"\)\s*\|\|\s*new URLSearchParams\(location.search\)\.get\("token"\)\s*\|\|\s*""','""',s))
    transform(source/'src/server.mjs',lambda s:s.replace("frame-ancestors 'none'","frame-ancestors 'self'").replace('  lanAddresses,\n  relisten,','  lanAddresses: () => [],\n  relisten: async () => { throw new Error("请通过 V2 启动器管理监听"); },').replace('  autostartSupported: process.platform === "win32",','  autostartSupported: false,').replace('setTimeout(runUpdateCheck, 25_000).unref?.();\nscheduleUpdateCheck();\nsetInterval(autoApplySweep, 60 * 60 * 1000).unref?.();','// V2 owns source updates and process lifecycle.'))
