import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

// Pass explicit absolute files: shared components live outside the app root.
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(entry.name) ? [path] : []
  })
}
const web = resolve(import.meta.dirname, "..")
const sources = [...files(resolve(web, "src")), ...files(resolve(web, "../底层能力/交互组件/src/ui")), resolve(web, "../底层能力/表格组件/src/data-table.tsx"), resolve(web, "vite.config.ts")]
const result = spawnSync(resolve(web, "node_modules/.bin/oxlint"), ["--no-ignore", "--config", resolve(web, ".oxlintrc.json"), ...sources], { stdio: "inherit", cwd: web })
if (result.error) throw result.error
process.exit(result.status ?? 1)
