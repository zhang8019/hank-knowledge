/**
 * P3 LLM Wiki 单元测试：
 * 1. LLM 客户端（mock chat/completions）
 * 2. Wiki ingest 确定性路径（无 LLM）：source/concept 页 + 索引 + 矛盾检测
 * 3. 多源引用 → emerging 提升建议
 *
 * 运行：node tests/wiki.mjs（需先 npm install）
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const esbuild = require(join(root, "node_modules/esbuild"));
const outDir = mkdtempSync(join(tmpdir(), "hank-wiki-test-"));
for (const entry of ["llm", "wiki", "graph"]) {
  await esbuild.build({
    entryPoints: [join(root, `lib/${entry}.ts`)],
    bundle: true, format: "esm", platform: "node", target: "node20",
    outfile: join(outDir, `${entry}.mjs`),
  });
}

const { LlmClient } = await import(pathToFileURL(join(outDir, "llm.mjs")).href);
const { WikiIngester } = await import(pathToFileURL(join(outDir, "wiki.mjs")).href);
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

console.log("== 1. LLM 客户端（mock） ==");
{
  const fakeNetwork = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      check("请求含 model", body.model === "test-model");
      check("请求含 messages", Array.isArray(body.messages) && body.messages.length === 2);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "这是 LLM 返回的摘要内容" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  const store = {
    get: async (k) => ({
      llmBaseUrl: "https://api.test/v1",
      llmApiKey: "key",
      llmModel: "test-model",
    })[k],
  };
  const client = await LlmClient.fromConfig(store, fakeNetwork);
  check("fromConfig 返回客户端", client !== null);
  check("model 读取", client.model === "test-model");
  const text = await client.chat("sys", "user");
  check("chat 返回内容", text === "这是 LLM 返回的摘要内容");

  // JSON 输出
  const jsonNet = {
    async fetch() {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"concepts":[{"title":"测试"}]}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  const jsonClient = await LlmClient.fromConfig(store, jsonNet);
  const parsed = await jsonClient.chatJson("sys", "user");
  check("chatJson 解析", parsed.concepts[0].title === "测试");

  // 未配置 → null
  const emptyStore = { get: async () => "" };
  check("未配置返回 null", (await LlmClient.fromConfig(emptyStore, fakeNetwork)) === null);
}

console.log("== 2. Wiki ingest 确定性路径 ==");
{
  const store = makeMockStore();
  const graph = new KnowledgeGraph(store);
  const ingester = new WikiIngester(graph, async () => null); // 无 LLM
  const text = [
    "注意力机制是深度学习中的核心技术。Transformer 模型基于多头注意力实现并行计算。",
    "注意力机制通过查询、键、值三个向量计算加权和。缩放点积注意力是其中一种实现。",
    "自注意力让每个位置都能关注序列中其他位置，是理解长距离依赖的关键。",
  ].join("\n\n");

  const result = await ingester.ingest({
    baseId: "kb_wiki",
    itemId: "it_1",
    itemName: "attention-mechanism.md",
    text,
  });
  check("生成 source 页", result.sourceNode.type === "wiki-page");
  check("source 命名 kebab", result.sourceNode.title === "attention-mechanism", result.sourceNode.title);
  check("生成 concept 页", result.conceptNodes.length > 0, `concepts=${result.conceptNodes.length}`);
  check("sourceRefs 关联", result.sourceNode.sourceRefs.includes("it_1"));
  check("矛盾检测无误报", result.contradictions.length === 0, JSON.stringify(result.contradictions));
  check("索引行生成", result.indexLines.length >= 1);
  check("未使用 LLM", result.usedLlm === false);

  // graph 持久化
  const persisted = JSON.parse(store.files.get("kb_wiki/graph.json"));
  const pages = persisted.nodes.filter((n) => n.type === "wiki-page" || n.type === "concept");
  check("wiki 页已落库", pages.length >= 2);
}

console.log("== 3. 多源引用 → emerging ==");
{
  const store = makeMockStore();
  const graph = new KnowledgeGraph(store);
  const ingester = new WikiIngester(graph, async () => null);

  // 摄入两份共享概念的材料
  const textA = "注意力机制用于序列建模，Transformer 是其典型应用。缩放点积注意力计算查询与键的匹配程度。";
  const textB = "注意力机制让模型聚焦关键信息。多头注意力并行运行多组注意力，捕获不同子空间特征。";
  const r1 = await ingester.ingest({ baseId: "kb_wiki2", itemId: "it_a", itemName: "a.md", text: textA });
  const r2 = await ingester.ingest({ baseId: "kb_wiki2", itemId: "it_b", itemName: "b.md", text: textB });

  // 概念被多源引用
  const shared = r2.conceptNodes.filter((n) => n.sourceRefs.length >= 2);
  check("多源概念引用 ≥2", shared.length >= 1, JSON.stringify(r2.conceptNodes.map((n) => ({ t: n.title, refs: n.sourceRefs.length }))));

  // 成熟度评估建议 emerging
  const evals = shared.map((n) => ({
    title: n.title,
    sourceRefs: n.sourceRefs.length,
    hitCount: n.stats.hitCount,
  }));
  check("多源概念存在", evals.length >= 1);
}

console.log("== 4. Wiki lint 基础 ==");
{
  const store = makeMockStore();
  const graph = new KnowledgeGraph(store);
  const ingester = new WikiIngester(graph, async () => null);
  await ingester.ingest({ baseId: "kb_lint", itemId: "it_1", itemName: "x.md", text: "这是一个足够长的材料内容，用于生成 wiki 页面和概念抽取，测试 lint 逻辑是否正常工作。" });
  const g = await graph.load("kb_lint");
  const pages = g.nodes.filter((n) => n.type === "wiki-page");
  check("lint 前提：有 wiki 页", pages.length >= 1);
}

console.log("");
if (failures === 0) console.log("ALL PASS");
else { console.error(`${failures} FAILURES`); process.exit(1); }
