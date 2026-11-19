/**
 * AI 网关 · 卸载（由 卸载.cmd 跳板调用）。
 * 停服务 → 清开机自启 → 清桌面图标 → 删安装目录（任务记录与产出一并删除）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dest = join(process.env.LOCALAPPDATA ?? "", "AI网关");
const testMode = process.env.WB_INSTALL_TEST === "1";

console.log("\n  AI 网关 · 卸载");
console.log(`  目标: ${dest}`);
console.log("  任务记录、流程模板与产出文件会一并删除且无法恢复。\n");

if (!testMode) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  确认卸载？输入 Y 继续: ")).trim();
  rl.close();
  if (answer.toUpperCase() !== "Y") { console.log("  已取消。"); process.exit(0); }
}

// 1. 停服务（按端口找进程）
try {
  const listing = execFileSync("cmd.exe", ["/c", "netstat -ano | findstr \":4317 \" | findstr LISTENING"], { encoding: "utf8" });
  for (const line of listing.split("\n")) {
    const pid = line.trim().split(/\s+/).pop();
    if (/^\d+$/.test(pid ?? "")) {
      try { execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" }); } catch { /* 可能已退出 */ }
    }
  }
} catch { /* 没在跑 */ }

// 2. 清开机自启（开了自启的机器；沙箱/受限环境失败就跳过）
try { execFileSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "WorkBuddyGateway", "/f"], { stdio: "ignore" }); } catch { /* 本来就没开 */ }

// 3. 清桌面图标
if (!testMode) {
  spawn("cmd.exe", ["/c", "del", `${join(process.env.USERPROFILE ?? "", "Desktop")}\\AI网关.lnk`], { stdio: "ignore" }).unref();
}

// 4. 删安装目录
rmSync(dest, { recursive: true, force: true });
console.log("\n  卸载完成。\n");
