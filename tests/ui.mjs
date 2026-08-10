/**
 * P4 UI 冒烟验证：
 * 1. 路由注册完整（页面 + 全部 API）
 * 2. 渲染出的 HTML shell 结构完整
 * 3. 内联 JS 语法正确（用 node vm / new Function 校验）
 * 4. 页面 CSS 包含成熟度色带 / Tab / 力导向图样式
 *
 * 运行：node tests/ui.mjs（需先 npm run build）
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

// 加载构建产物
const routeMod = require(join(root, "routes/page.js"));

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else { failures += 1; console.error(`  ❌ ${name} ${extra}`); }
}

// ---- 模拟宿主路由 app ----
function makeApp() {
  const routes = [];
  return {
    routes,
    get(path, handler) { routes.push({ method: "GET", path, handler }); },
    post(path, handler) { routes.push({ method: "POST", path, handler }); },
    patch(path, handler) { routes.push({ method: "PATCH", path, handler }); },
    delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
  };
}

console.log("== 1. 路由注册 ==");
{
  const app = makeApp();
  routeMod.default(app, {});
  const paths = app.routes.map((r) => r.path);
  const expected = [
    "/page", "/widget",
    "/api/status",
    "/api/bases",
    "/api/bases/:id/graph",
    "/api/bases/:id/graph/nodes/:nodeId/promote",
    "/api/bases/:id/build-tree",
    "/api/bases/:id/verify-tree",
    "/api/bases/:id/wiki-ingest",
    "/api/bases/:id/wiki-lint",
    "/api/bases/:id/graph-answer",
  ];
  for (const p of expected) {
    check("路由存在: " + p, paths.includes(p));
  }
  check("路由总数合理", app.routes.length >= 30, `count=${app.routes.length}`);
}

console.log("== 2. HTML shell 结构 ==");
{
  const app = makeApp();
  routeMod.default(app, {});
  const pageRoute = app.routes.find((r) => r.path === "/page" && r.method === "GET");
  const c = { req: { query: () => ({}) }, html: (s) => s };
  const html = pageRoute.handler(c);
  check("含标题", html.includes("<title>知识库</title>"));
  check("含成熟度图例", html.includes("成熟度图例"));
  check("含 canvas", html.includes("graphCanvas"));
  check("含创建按钮", html.includes("createBaseBtn"));
  check("含 serviceBadge", html.includes("serviceBadge"));
  check("含 Tab 结构", html.includes('data-tab="tree"') && html.includes('data-tab="wiki"'));
}

console.log("== 3. 内联 JS 语法 ==");
{
  const app = makeApp();
  routeMod.default(app, {});
  const pageRoute = app.routes.find((r) => r.path === "/page" && r.method === "GET");
  const c = { req: { query: () => ({}) }, html: (s) => s };
  const html = pageRoute.handler(c);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  check("找到内联脚本", match !== null);
  if (match) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(match[1]);
      check("JS 语法解析通过", true);
    } catch (err) {
      check("JS 语法解析通过", false, err.message);
    }
  }
}

console.log("== 4. CSS 样式 ==");
{
  const app = makeApp();
  routeMod.default(app, {});
  const pageRoute = app.routes.find((r) => r.path === "/page" && r.method === "GET");
  const c = { req: { query: () => ({}) }, html: (s) => s };
  const html = pageRoute.handler(c);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  check("成熟度色带变量", css.includes("--fuzzy") && css.includes("--emerging") && css.includes("--codified"));
  check("glassmorphism", css.includes("glass"));
  check("力导向图 canvas 样式", css.includes("graph-wrap") && css.includes("graphCanvas"));
  check("Tab 样式", css.includes(".tabs") && css.includes(".tab-panel"));
  check("节点卡片样式", css.includes(".node-card"));
  check("Wiki 卡片样式", css.includes(".wiki-card"));
  check("统计面板样式", css.includes(".stat-box"));
  check("建树向导样式", css.includes(".wizard-step"));
}

console.log("");
if (failures === 0) console.log("ALL PASS");
else { console.error(`${failures} FAILURES`); process.exit(1); }
