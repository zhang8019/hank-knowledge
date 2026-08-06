/**
 * ESM 加载验证：模拟 Hana 宿主的动态 import() 加载方式，
 * 核对路由 default 为函数、生命周期 default 为类、工具具名导出齐全。
 */

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
let failures = 0;

const load = (p) => import(pathToFileURL(p).href);

function check(name, condition, extra = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
}

// 1) 生命周期入口
const plugin = await load(join(root, "index.js"));
check("index.js default 是类（new 可实例化）", typeof plugin.default === "function" && /^class\s/.test(String(plugin.default)));
const instance = new plugin.default();
instance.ctx = { pluginId: "hank-knowledge", dataDir: "", config: {}, log: console, bus: {}, network: {}, resources: {} };
check("onload / onunload 方法存在", typeof instance.onload === "function" && typeof instance.onunload === "function");

// 2) 路由
const page = await load(join(root, "routes/page.js"));
check("routes/page.js default 是函数（factory）", typeof page.default === "function");

// 3) 工具具名导出
const toolFiles = readdirSync(join(root, "tools")).filter((name) => name.endsWith(".js") && name !== "_util.js");
check(`tools 数量 >= 10（实际 ${toolFiles.length}）`, toolFiles.length >= 10);
for (const file of toolFiles) {
  const mod = await load(join(root, "tools", file));
  const ok = typeof mod.name === "string" && typeof mod.description === "string" && typeof mod.execute === "function";
  check(`${file} 具名导出完整`, ok, JSON.stringify(Object.keys(mod)));
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);