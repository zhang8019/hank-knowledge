/**
 * P2 神经树构建单元测试：
 * 1. verifier：V1-V17 检查（完整树通过 / 缺元素拦截）
 * 2. tree-builder：一本书 → 一棵树（章节切主干 → 神经元 → 突触）
 * 3. tree 渲染：Markdown 模板生成
 *
 * 运行：node tests/tree.mjs（需先 npm install）
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const esbuild = require(join(root, "node_modules/esbuild"));
const outDir = mkdtempSync(join(tmpdir(), "hank-tree-test-"));
for (const entry of ["verifier", "tree-builder", "tree", "graph"]) {
  await esbuild.build({
    entryPoints: [join(root, `lib/${entry}.ts`)],
    bundle: true, format: "esm", platform: "node", target: "node20",
    outfile: join(outDir, `${entry}.mjs`),
  });
}

const { TreeVerifier } = await import(pathToFileURL(join(outDir, "verifier.mjs")).href);
const { TreeBuilder } = await import(pathToFileURL(join(outDir, "tree-builder.mjs")).href);
const { renderTreeMd, renderNeuronTable } = await import(pathToFileURL(join(outDir, "tree.mjs")).href);
const { KnowledgeGraph } = await import(pathToFileURL(join(outDir, "graph.mjs")).href);

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else { failures += 1; console.error(`  ❌ ${name} ${extra}`); }
}

function makeMockStore() {
  const files = new Map();
  return {
    files,
    async readGraph(baseId) {
      const key = `${baseId}/graph.json`;
      return files.has(key) ? JSON.parse(files.get(key)) : null;
    },
    async writeGraph(baseId, graph) {
      files.set(`${baseId}/graph.json`, JSON.stringify(graph));
    },
    async requireBase() { return { status: "completed" }; },
  };
}

// 一个元素完整的神经元（供 verifier 测试）
function fullNeuron(id, title, extra = {}) {
  return {
    id, baseId: "kb", type: "neuron", maturity: "codified", title,
    elements: {
      definition: "约定解除是合同约定条件成就时的解除权，属形成权",
      scenario: "审查合同解除条款时判断解除类型",
      keyData: "法定解除五种情形（§563①）不可抗力/预期违约/迟延催告后/根本违约/其他",
      triggers: ["约定解除", "法定解除", "解除权", "§562", "§563", "§564"],
      tags: ["#合同法/解除类型"],
      decisionTemplate: "①看合同有无解除条款 → ②有→判断条件（约定解除） → ③无→看§563五种情形 → ④确认解除权人 → ⑤发解除通知",
      misjudgmentDefenses: ["对方违约不自动解除", "不可抗力须达目的不能实现", "约定条件可能格式条款无效"],
      checkList: ["确认解除类型", "解除条件已成就", "解除权人已确定", "未超行使期限"],
      source: "《民法典》§562-563 → L1",
      validity: { verifiedAt: "2026-08-10", superseded: false, nextCheck: "2027-08-10" },
    },
    sourceRefs: [], inbound: [], outbound: [],
    stats: { hitCount: 0, negativeFeedback: 0, lastHitAt: null, lastUpdatedAt: Date.now() },
    createdAt: Date.now(),
    ...extra,
  };
}

console.log("== 1. 验证器：完整树通过 ==");
{
  const n1 = fullNeuron("nd_1", "N1·判定解除类型");
  const n2 = fullNeuron("nd_2", "N2·解除程序", {
    elements: {
      definition: "解除须通知对方并经合理异议期生效",
      scenario: "准备发出解除通知时",
      keyData: "通知到达生效；对方异议 3 个月内可起诉确认解除无效",
      triggers: ["解除通知", "异议期", "解除程序", "通知送达", "§565", "§566"],
      tags: ["#合同法/解除程序"],
      decisionTemplate: "①确认解除权 → ②书面通知 → ③送达留证 → ④异议期 → ⑤生效",
      misjudgmentDefenses: ["口头通知无效", "未送达不算", "异议期内对方可起诉"],
      checkList: ["通知已送达", "理由已写明", "证据已保留", "异议期已过"],
      source: "《民法典》§565 → L1",
      validity: { verifiedAt: "2026-08-10", superseded: false, nextCheck: "2027-08-10" },
    },
  });
  const verifier = new TreeVerifier({
    stats: { neurons: 2, synapses: 1, endings: 0 },
    root: { essence: "合同解除是合法退出机制", questions: ["最底层逻辑？", "反过来成立吗？", "外行怎么理解？"] },
    branches: [
      { index: 1, title: "解除类型", neurons: [n1] },
      { index: 2, title: "解除程序", neurons: [n2] },
    ],
    treeEdges: [{ id: "ed_1", source: "nd_1", target: "nd_2", kind: "synapse", relation: "流程衔接", strength: 5, createdAt: Date.now() }],
    crossTreeEdges: [],
    selfCheck: "□ 自检完成",
  });
  const report = verifier.run();
  check("V1 通过", report.checks.find((c) => c.id === "V1")?.passed);
  check("V2 触发词通过", report.checks.find((c) => c.id === "V2")?.passed);
  check("V3 判定模板通过", report.checks.find((c) => c.id === "V3")?.passed);
  check("V4 误判防御通过", report.checks.find((c) => c.id === "V4")?.passed);
  check("V5 检查清单通过", report.checks.find((c) => c.id === "V5")?.passed);
  check("V6 突触通过", report.checks.find((c) => c.id === "V6")?.passed);
  check("V7 根验证通过", report.checks.find((c) => c.id === "V7")?.passed);
  check("V8 自检清单通过", report.checks.find((c) => c.id === "V8")?.passed);
  check("V9 Header 统计通过", report.checks.find((c) => c.id === "V9")?.passed);
  check("V12 出处可信度通过", report.checks.find((c) => c.id === "V12")?.passed);
  check("V14 命名通过", report.checks.find((c) => c.id === "V14")?.passed);
  check("V15 证据链通过", report.checks.find((c) => c.id === "V15")?.passed);
  check("健康度 ≥ 90", report.healthScore >= 90, `score=${report.healthScore}`);
}

console.log("== 2. 验证器：缺元素拦截 ==");
{
  const bad = fullNeuron("nd_9", "N1·坏节点", {
    elements: { definition: "太短", scenario: "", keyData: "x", triggers: ["a"], source: "" },
  });
  const verifier = new TreeVerifier({
    stats: { neurons: 1, synapses: 0, endings: 0 },
    branches: [{ index: 1, title: "测试", neurons: [bad] }],
    treeEdges: [], crossTreeEdges: [],
  });
  const report = verifier.run();
  check("V1 拦截缺元素", !report.checks.find((c) => c.id === "V1")?.passed);
  check("V2 拦截触发词不足", !report.checks.find((c) => c.id === "V2")?.passed);
  check("V12 拦截缺出处", !report.checks.find((c) => c.id === "V12")?.passed);
  check("健康度下降", report.healthScore < 70, `score=${report.healthScore}`);
}

console.log("== 3. TreeBuilder：一本书 → 一棵树 ==");
{
  const store = makeMockStore();
  const graph = new KnowledgeGraph(store);
  const builder = new TreeBuilder(store, graph);
  const book = [
    "# 合同解除实务",
    "",
    "## 解除类型",
    "",
    "约定解除指合同约定条件成就时解除权人可解除合同。法定解除是法律直接规定的情形，包括不可抗力、预期违约、迟延催告后仍不履行、根本违约以及其他法律规定的特殊情形。解除权属于形成权，单方通知即可生效。",
    "",
    "## 解除程序",
    "",
    "解除权人应当通知对方，合同自通知到达对方时解除。对方有异议的可以请求人民法院或者仲裁机构确认解除合同的效力。异议期为三个月，逾期未起诉视为解除生效。通知应当采用书面形式并保留送达证据。",
    "",
    "## 解除后果",
    "",
    "合同解除后尚未履行的终止履行，已经履行的根据履行情况和合同性质，当事人可以请求恢复原状或者采取其他补救措施，并有权请求赔偿损失。返还财产与赔偿损失可以同时主张。",
  ].join("\n");

  const result = await builder.build({ baseId: "kb_tree", domain: "民法典合同解除", text: book });
  check("生成了 3 个主干", result.branches.length >= 3, `branches=${result.branches.length}`);
  check("生成神经元", result.nodeCount >= 3, `nodes=${result.nodeCount}`);
  check("生成突触", result.edgeCount >= 2, `edges=${result.edgeCount}`);
  check("文件名规范", result.fileName.startsWith("神经树_《") && result.fileName.endsWith(".md"), result.fileName);
  check("Markdown 含根", result.treeMarkdown.includes("🌱 根"));
  check("Markdown 含主干", result.treeMarkdown.includes("🌿 主干"));
  check("Markdown 含突触区", result.treeMarkdown.includes("🔗 突触区"));

  // graph 落库验证
  const persisted = JSON.parse(store.files.get("kb_tree/graph.json"));
  const neurons = persisted.nodes.filter((n) => n.type === "neuron");
  check("graph 中 codified 神经元", neurons.length === result.nodeCount);
  check("graph 中触发词索引", Object.keys(persisted.triggerIndex).length > 0);
  check("graph 中突触", persisted.edges.length === result.edgeCount);
}

console.log("== 4. 树渲染 ==");
{
  const md = renderTreeMd({
    domain: "测试领域",
    root: { essence: "测试本质", questions: ["q1", "q2", "q3"] },
    branches: [
      { index: 1, title: "主干A", neurons: [fullNeuron("nd_a", "N1·测试")] },
    ],
    treeEdges: [],
  });
  check("渲染含统计", md.includes("**统计：1N / 0突触"));
  check("渲染含领域", md.includes("领域：测试领域"));
  check("渲染含表格", md.includes("| 元素 | 内容 |"));
  check("渲染含触发词", md.includes("约定解除"));

  const table = renderNeuronTable(fullNeuron("nd_b", "N2·测试", {}));
  check("神经元表格含出处", table.includes("《民法典》"));
  check("神经元表格含成熟度", table.includes("成熟度"));
}

console.log("");
if (failures === 0) console.log("ALL PASS");
else { console.error(`${failures} FAILURES`); process.exit(1); }
