import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "..");

/** esbuild 的 JS 入口（用当前 node 直接执行，避免 .bin/.cmd 的 shell 兼容问题）。 */
function esbuildEntry() {
  const p = join(repoRoot, "node_modules", "esbuild", "bin", "esbuild");
  if (!existsSync(p)) {
    throw new Error("esbuild not found. Run `npm install` first.");
  }
  return p;
}

function run(args) {
  execFileSync(process.execPath, [esbuildEntry(), ...args], { stdio: "inherit", cwd: repoRoot });
}

// 宿主按"文件 + 命名导出"加载 index.js / tools/*.js / routes/*.js。
// 产物为 ESM（发布包含 package.json 的 "type": "module"，与参考插件一致），
// 输出到源码原位（outbase=项目根）；lib/ 被各入口打包，不单独输出。
// 注意：tools 入口只取 knowledge_*.ts（_util.ts 是共享 helper，随各工具打包，
// 不单独产出，避免宿主把无工具导出的文件当作工具加载）。
run([
  "--bundle",
  "--format=esm",
  "--platform=node",
  "--target=node20",
  "--outbase=.",
  "--outdir=.",
  "index.ts",
  "tools/knowledge_*.ts",
  "routes/*.ts",
]);

console.log("build ok -> index.js / tools/*.js / routes/*.js (ESM)");