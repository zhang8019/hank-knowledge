/**
 * 发布打包脚本：构建 → 校验必需文件 → 组装 → 出 zip。
 *
 * 用法：node scripts/release.mjs
 * 产物：release/hank-knowledge-<version>.zip（顶层为单目录 hank-knowledge/）
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const version = manifest.version;

// 1) 构建（保证产物最新）
console.log("[release] building…");
execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit", cwd: root });

// 2) 必需文件校验
const requiredFiles = ["manifest.json", "package.json", "index.js"];
const requiredDirs = ["tools", "routes"];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) throw new Error(`缺少必需文件: ${file}`);
}
for (const dir of requiredDirs) {
  if (!existsSync(join(root, dir))) throw new Error(`缺少必需目录: ${dir}`);
}
const toolCount = readdirSync(join(root, "tools")).filter((name) => name.endsWith(".js")).length;
if (toolCount < 10) throw new Error(`tools 数量不足（实际 ${toolCount}）`);
console.log(`[release] 校验通过：tools=${toolCount} 个`);

// 3) 组装 staging
const stagingDir = join(root, "release", "staging", "hank-knowledge");
rmSync(join(root, "release"), { recursive: true, force: true });
mkdirSync(join(stagingDir, "tools"), { recursive: true });
mkdirSync(join(stagingDir, "routes"), { recursive: true });

cpSync(join(root, "manifest.json"), join(stagingDir, "manifest.json"));
cpSync(join(root, "package.json"), join(stagingDir, "package.json"));
cpSync(join(root, "index.js"), join(stagingDir, "index.js"));
cpSync(join(root, "README.md"), join(stagingDir, "README.md"));
for (const file of readdirSync(join(root, "tools")).filter((name) => name.endsWith(".js"))) {
  cpSync(join(root, "tools", file), join(stagingDir, "tools", file));
}
for (const file of readdirSync(join(root, "routes")).filter((name) => name.endsWith(".js"))) {
  cpSync(join(root, "routes", file), join(stagingDir, "routes", file));
}

// 4) 出 zip（调用 PowerShell Compress-Archive，顶层为单目录）
const zipPath = join(root, "release", `hank-knowledge-${version}.zip`);
const psCommand = `Compress-Archive -Path '${stagingDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], { stdio: "inherit" });

rmSync(join(root, "release", "staging"), { recursive: true, force: true });
console.log(`[release] 完成: ${zipPath}`);
console.log(`[release] 安装：解压 zip，把 hank-knowledge/ 放入 ${"${HANA_HOME}"}/plugins/ 后重启 Hana`);