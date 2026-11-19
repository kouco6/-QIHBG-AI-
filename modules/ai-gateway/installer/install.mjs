/**
 * AI 网关 · 安装（由 安装.cmd 跳板调用，整个安装逻辑都在 node 里，
 * 批处理只当入口——UTF-8 中文批处理会被 cmd 解析错乱，这里零编码坑）。
 *
 * 步骤：复制程序 → 生成本机密钥/配置 → 桌面开关 → 启动 → 探活 → 打开工作台。
 * 已存在的 secrets / 配置 / 数据一律不动：重复安装 = 升级。
 * 测试模式：环境变量 WB_INSTALL_TEST=1 跳过桌面图标与浏览器（自动化验证用）。
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const dest = join(process.env.LOCALAPPDATA ?? "", "AI网关");
const testMode = process.env.WB_INSTALL_TEST === "1";
const fail = (msg) => { console.error(`  [错误] ${msg}`); process.exit(1); };

console.log("\n  ==========================================");
console.log("   AI 网关 · 本地工作台 安装");
console.log("  ==========================================");
console.log(`  安装位置: ${dest}\n`);

if (!existsSync(join(srcDir, "src", "server.mjs"))) {
  fail("找不到程序文件。请先把整个安装包解压，再双击「安装.cmd」。");
}

// 1. 复制程序。注意：node 的 cpSync 对中文【目标】路径会拷进乱码目录（静默失败），
//    必须用系统 robocopy（退出码 1/2/3 都算成功）。
console.log("  [1/5] 复制程序文件...");
const robocopy = (from, to) => {
  try {
    execFileSync("robocopy", [from, to, "/E", "/NFL", "/NDL", "/NJH", "/NJS"], { stdio: "ignore" });
  } catch (e) {
    if (![1, 2, 3].includes(e.status)) throw e;
  }
};
robocopy(join(srcDir, "src"), join(dest, "src"));
robocopy(join(srcDir, "public"), join(dest, "public"));
for (const name of ["gateway-switch.vbs", "gateway-autostart.vbs", "gateway-run.cmd", "init-config.mjs", "node.exe"]) {
  if (existsSync(join(srcDir, name))) copyFileSync(join(srcDir, name), join(dest, name));
}
if (!existsSync(join(dest, "src", "server.mjs"))) fail("程序复制失败。");

// 2. 生成本机密钥与配置（node 脚本，已存在的文件不动）
console.log("  [2/5] 生成本机密钥与配置...");
const nodeExe = existsSync(join(dest, "node.exe")) ? join(dest, "node.exe") : "node";
try {
  execFileSync(nodeExe, [join(dest, "init-config.mjs")], { stdio: ["ignore", "ignore", "ignore"] });
} catch { /* init 自己抛错也继续，下面按产物判断 */ }
if (!existsSync(join(dest, "gateway.config.json"))) fail("配置生成失败（Node 运行时不可用）。");
const token = JSON.parse(readFileSync(join(dest, "secrets.json"), "utf8")).token;

// 3. 桌面开关。快捷方式的 vbs 由 node 以 UTF-16LE（带 BOM）现写现执行，
//    这样「AI网关.lnk」这个中文名不经过任何 ANSI 编码转换。
if (!testMode) {
  console.log("  [3/5] 创建桌面开关...");
  const desktop = join(process.env.USERPROFILE ?? "", "Desktop");
  const lnkScript = join(dest, "make-shortcut.tmp.vbs");
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from([
    'Set ws = CreateObject("WScript.Shell")',
    `Set lnk = ws.CreateShortcut("${desktop}\\AI网关.lnk")`,
    `lnk.TargetPath = "${dest}\\gateway-switch.vbs"`,
    `lnk.WorkingDirectory = "${dest}"`,
    `lnk.IconLocation = "${dest}\\node.exe,0"`,
    'lnk.Description = "AI 网关开关：一键启动 / 停止"',
    "lnk.Save",
    "",
  ].join("\r\n"), "utf16le");
  writeFileSync(lnkScript, Buffer.concat([bom, body]));
  try {
    execFileSync("wscript", [lnkScript], { stdio: "ignore" });
  } catch { /* 快捷方式失败不挡安装 */ }
}

// 4. 启动服务
console.log("  [4/5] 启动 AI 网关...");
if (testMode) {
  spawn("cmd.exe", ["/c", "gateway-run.cmd"], { cwd: dest, detached: true, stdio: "ignore" }).unref();
} else {
  try { execFileSync("wscript", [join(dest, "gateway-autostart.vbs")], { stdio: "ignore" }); } catch { /* 降级：由用户手动启动 */ }
}

// 5. 探活 + 带密钥打开工作台
console.log("  [5/5] 等待服务就绪...");
let ready = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const response = await fetch("http://127.0.0.1:4317/api/boot");
    if (response.status === 401) { ready = true; break; }
  } catch { /* 还没起来 */ }
}

console.log("");
console.log("  ==========================================");
if (ready) console.log("   安装完成！");
else console.log("   服务已在后台启动，但暂时未响应。");
console.log("  ==========================================");
console.log("   工作台:  http://127.0.0.1:4317");
console.log("   桌面:    「AI网关」图标 = 一键启动 / 停止");
console.log("   下一步:  打开「AI 员工」页配置你的 AI 员工（填 API Key）");
console.log("");

if (!testMode) {
  spawn("cmd.exe", ["/c", "start", "", `http://127.0.0.1:4317/?token=${token}`], { detached: true, stdio: "ignore" }).unref();
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
