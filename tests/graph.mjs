/**
 * P1 知识图谱数据层单元测试：
 * 1. 命名规范（神经元/主干/树文件/concept/entity/source/冲突）
 * 2. 图谱节点 CRUD + 触发词/tag 索引 + 边关联
 * 3. 成熟度状态机（评估/提升门槛/降级）
 *
 * 运行：node tests/graph.mjs（需先 npm install）
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

// 打包 lib 模块（含 store 依赖）
const esbuild = require(join(root, "node_modules/esbuild"));
const outDir = mkdtempSync(join(tmpdir(), "hank-graph-test-"));
await esbuild.build({
  entryPoints: [join(root, "lib/graph.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: join(outDir, "graph.mjs"),
});
await esbuild.build({
  entryPoints: [join(root, "lib/naming.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: join(outDir, "naming.mjs"),
});
await esbuild.build({
  entryPoints: [join(root, "lib/maturity.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: join(outDir, "maturity.mjs"),
});

const graphMod = await import(pathToFileURL(join(outDir, "graph.mjs")).href);
const namingMod = await import(pathToFileURL(join(outDir, "naming.mjs")).href);
const maturityMod = await import(pathToFileURL(join(outDir, "maturity.mjs")).href);

const { KnowledgeGraph, emptyGraph, rebuildIndexes, maturityRank, MATURITY_LABELS } = graphMod;
const {
  neuronName, branchName, treeFileName, conceptName, entityName, sourceSlug, uniqueName,
  validateNeuronName, validateTreeFileName,
} = namingMod;
const { evaluateMaturity, validateCodify, DEFAULT_MATURITY_RULE, feedbackWeight } = maturityMod;

// ---- mock store（仅实现 graph 读写） ----
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

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else { failures += 1; console.error(`  ❌ ${name} ${extra}`); }
}

console.log("== 1. 命名规范 ==");
{
  check("神经元名带前缀", neuronName({ branchIndex: 1, subject: "判定解除类型" }) === "N1·判定解除类型");
  const longName = neuronName({ branchIndex: 3, subject: "这是一个非常长的神经元名称应该被截断到十五字" });
  check("神经元名截断", longName.length <= 17, longName);
  check("主干名", branchName(1, "解除类型") === "主干1：解除类型");
  check("树文件名", treeFileName("民法典", 1, 0) === "神经树_《民法典》_v1.0.md");
  check("concept 英文 TitleCase", conceptName("attention mechanism") === "AttentionMechanism");
  check("concept 中文原样", conceptName("注意力机制") === "注意力机制");
  check("entity TitleCase", entityName("meta ai") === "MetaAi");
  check("source slug kebab", sourceSlug("My Report.pdf") === "my-report");
  check("uniqueName 冲突追加", uniqueName("报告", ["报告", "报告_1"]) === "报告_2");
  check("uniqueName 无冲突原样", uniqueName("报告", ["其他"]) === "报告");
  check("神经元名校验", validateNeuronName("正常名称") === null && validateNeuronName("") !== null);
  check("树文件名校验", validateTreeFileName("神经树_《法律》_v1.0.md") === null && validateTreeFileName("bad.md") !== null);
}

console.log("== 2. 图谱节点 CRUD + 索引 ==");
{
  const store = makeMockStore();
  const graph = new KnowledgeGraph(store);
  const baseId = "kb_test_1";

  const n1 = await graph.addNode(baseId, {
    title: "N1·判定解除类型",
    type: "neuron",
    maturity: "codified",
    elements: {
      definition: "约定解除与法定解除的区分",
      scenario: "审查合同解除条款时",
      keyData: "约定解除§562② 法定解除§563①",
      triggers: ["约定解除", "法定解除", "解除权", "§562", "§563"],
      tags: ["#合同法/解除类型"],
      source: "《民法典》§562-563 → L1",
    },
  });
  check("新增 codified 节点", n1.maturity === "codified" && n1.type === "neuron");
  check("节点 id 前缀", n1.id.startsWith("nd_"));

  const n2 = await graph.addNode(baseId, {
    title: "N3·计算解除后果",
    type: "neuron",
    maturity: "emerging",
    elements: {
      definition: "解除后的返还与折价",
      scenario: "解除生效后计算返还金额",
      keyData: "恢复原状+折价补偿+损失赔偿",
      triggers: ["返还", "折价", "解除后果", "清算", "结算"],
      tags: ["#合同法/后果"],
      source: "《民法典》§566 → L1",
    },
  });

  const wiki = await graph.addNode(baseId, {
    title: "解除权消灭",
    type: "wiki-page",
    elements: { triggers: ["解除权消灭", "除斥期间", "过期"], tags: ["#合同法/解除权"] },
  });
  check("新增 wiki 页 fuzzy", wiki.maturity === "fuzzy");

  // 触发词检索（codified 优先）
  const hits = await graph.findByTrigger(baseId, "约定解除");
  check("触发词命中 codified 节点", hits.length > 0 && hits[0].id === n1.id);
  const fuzzyHits = await graph.findByTrigger(baseId, "除斥期间");
  check("命中 wiki 节点", fuzzyHits.some((n) => n.id === wiki.id));

  // tag 检索
  const tagged = await graph.findByTag(baseId, "#合同法/解除类型");
  check("tag 索引命中", tagged.some((n) => n.id === n1.id));

  // 边关联
  const edge = await graph.linkNodes(baseId, {
    source: n1.id,
    target: n2.id,
    kind: "synapse",
    relation: "流程衔接",
    strength: 5,
  });
  check("建立突触", edge.kind === "synapse" && edge.strength === 5);
  const neighbors = await graph.neighbors(baseId, n1.id);
  check("邻居含 n2", neighbors.some((nb) => nb.node.id === n2.id));
  check("出边记录", (await graph.getNode(baseId, n1.id))?.outbound.includes(n2.id));

  // 删除节点级联删边
  await graph.deleteNode(baseId, n2.id);
  const after = await graph.load(baseId);
  check("删除后边同步清理", after.edges.every((e) => e.source !== n2.id && e.target !== n2.id));
  check("删除后节点数 2", after.nodes.length === 2);

  // 持久化验证
  check("graph.json 已写入", store.files.has(`${baseId}/graph.json`));
  const persisted = JSON.parse(store.files.get(`${baseId}/graph.json`));
  check("持久化含节点", persisted.nodes.length === 2);
  check("持久化含触发词索引", persisted.triggerIndex["约定解除"]?.length === 1);

  // 重新加载（缓存外）
  const graph2 = new KnowledgeGraph(store);
  const reloaded = await graph2.load(baseId);
  check("重新加载节点完整", reloaded.nodes.length === 2);
}

console.log("== 3. 成熟度状态机 ==");
{
  const mkNode = (over) => ({
    id: "nd_x",
    baseId: "kb",
    type: "neuron",
    maturity: "fuzzy",
    title: "x",
    elements: {},
    sourceRefs: [],
    inbound: [],
    outbound: [],
    stats: { hitCount: 0, negativeFeedback: 0, lastHitAt: null, lastUpdatedAt: Date.now() },
    createdAt: Date.now(),
    ...over,
  });

  // fuzzy → emerging
  const ev1 = evaluateMaturity(mkNode({
    sourceRefs: ["it1", "it2"],
    stats: { hitCount: 3, negativeFeedback: 0, lastHitAt: Date.now(), lastUpdatedAt: Date.now() },
  }));
  check("多源+命中建议 emerging", ev1.suggestsPromote && ev1.suggested === "emerging");

  // fuzzy 单源不提升
  const ev2 = evaluateMaturity(mkNode({ sourceRefs: ["it1"] }));
  check("单源仍 fuzzy", !ev2.suggestsPromote);

  // codified 负面反馈降级
  const ev3 = evaluateMaturity(mkNode({
    maturity: "codified",
    stats: { hitCount: 5, negativeFeedback: 3, lastHitAt: Date.now(), lastUpdatedAt: Date.now() },
  }));
  check("codified 负面反馈→fuzzy", ev3.suggestsDemote && ev3.suggested === "fuzzy");

  // supersede 降级
  const ev4 = evaluateMaturity(mkNode({
    maturity: "codified",
    elements: { validity: { superseded: true } },
  }));
  check("supersede 降级", ev4.suggestsDemote);

  // 提升门槛
  const fullNode = mkNode({
    maturity: "emerging",
    elements: {
      definition: "约定解除是合同约定条件成就时的解除权",
      scenario: "审查合同解除条款时使用",
      keyData: "法定解除五种情形（§563①）不可抗力/预期违约/根本违约等",
      triggers: ["约定解除", "法定解除", "解除权", "§562", "§563"],
      source: "《民法典》§562-563 → L1",
    },
  });
  check("完整神经元通过提升校验", validateCodify(fullNode) === null);
  const incomplete = mkNode({ maturity: "emerging", elements: { definition: "太短", scenario: "x", keyData: "xx", triggers: ["a", "b"], source: "" } });
  check("不完整神经元被拦截", validateCodify(incomplete) !== null);

  // 负面反馈权重
  check("无用权重×2", feedbackWeight("无用") === 2 && feedbackWeight("不准确") === 1);
  check("成熟度排序", maturityRank("codified") === 3 && maturityRank("emerging") === 2 && maturityRank("fuzzy") === 1);
  check("标签", MATURITY_LABELS.fuzzy === "探索" && MATURITY_LABELS.codified === "已编译");
}

console.log("");
if (failures === 0) console.log("ALL PASS");
else { console.error(`${failures} FAILURES`); process.exit(1); }
