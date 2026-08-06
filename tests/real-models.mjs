/**
 * 真实模型端到端测试（SiliconFlow：BAAI/bge-m3 嵌入 + BAAI/bge-reranker-v2-m3 重排）。
 *
 * 覆盖：向量库创建（自动探测维度）→ 添加材料 → 真实 embedding 索引 →
 * 混合检索（BM25 + 向量 RRF）→ 启用重排 → relevance 分数 + 阈值。
 *
 * 运行：node tests/real-models.mjs
 */

import { createRequire } from "node:module";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const createBase = require(join(root, "tools/knowledge_create_base.js"));
const addItems = require(join(root, "tools/knowledge_add_items.js"));
const listBases = require(join(root, "tools/knowledge_list_bases.js"));
const search = require(join(root, "tools/knowledge_search.js"));

// ---- SiliconFlow 真实配置 ----
// API 密钥从环境变量读取（勿硬编码）：
//   复制 .env.example 为 .env 并填入密钥，然后运行：
//   node --env-file=.env tests/real-models.mjs
//   或直接设置环境变量 SILICONFLOW_API_KEY
const API_KEY = process.env.SILICONFLOW_API_KEY || "";
if (!API_KEY) {
  console.error("缺少 SILICONFLOW_API_KEY 环境变量。请复制 .env.example 为 .env 并填入密钥，再以 node --env-file=.env 运行。");
  process.exit(1);
}

const CONFIG = {
  embeddingBaseUrl: "https://api.siliconflow.cn/v1",
  embeddingApiKey: API_KEY,
  embeddingModel: "BAAI/bge-m3",
  embeddingDimensions: 0, // 自动探测
  rerankBaseUrl: "https://api.siliconflow.cn/v1",
  rerankApiKey: API_KEY,
  rerankModel: "BAAI/bge-reranker-v2-m3",
};

const configMap = new Map(Object.entries(CONFIG));
const dataDir = mkdtempSync(join(tmpdir(), "hank-kb-real-"));
const fakeCtx = {
  pluginId: "hank-knowledge",
  dataDir,
  config: { get: async (k) => configMap.get(k), set: async (k, v) => configMap.set(k, v) },
  network: { fetch: globalThis.fetch.bind(globalThis) },
  log: { debug: () => {}, info: (...a) => console.log("[info]", ...a), warn: (...a) => console.log("[warn]", ...a), error: (...a) => console.error("[log]", ...a) },
  resources: {},
  bus: { request: async () => { throw new Error("no bus"); } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
}

async function waitFor(predicate, timeoutMs = 120000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  return false;
}

async function main() {
  console.log("== 1. 创建向量知识库（bge-m3，自动探测维度）==");
  const created = await createBase.execute({ name: "真实模型测试库", enableVector: true }, fakeCtx);
  console.log("  create:", JSON.stringify(created.details));
  check("创建成功", !created.details.error, JSON.stringify(created.details.error ?? ""));
  const baseId = created.details.base?.id;
  if (!baseId) { console.log("无法继续：创建失败"); process.exit(1); }
  check("embedding 模型已固化", created.details.base.embeddingModelId === "BAAI/bge-m3");
  check("维度已探测（bge-m3 应为 1024）", created.details.base.dimensions === 1024, `dimensions=${created.details.base.dimensions}`);

  console.log("== 2. 添加中英文材料 ==");
  const added = await addItems.execute({
    baseId,
    items: [
      { type: "note", name: "中文笔记", content: "知识库插件使用向量检索与 BM25 混合检索，支持重排序模型精排候选片段，检索相关性阈值过滤低分结果。" },
      { type: "file", name: "vector.md", content: "Vector search computes cosine similarity between embedding vectors. Hybrid retrieval fuses BM25 and vector scores with reciprocal rank fusion." },
      { type: "file", name: "rerank.md", content: "Reranking models reorder candidate passages by relevance. BGE reranker v2 m3 is a multilingual reranker supporting Chinese and English." },
      { type: "note", name: "无关笔记", content: "今天天气很好，去公园散步，买了面包和牛奶。" },
    ],
  }, fakeCtx);
  check("添加 4 个材料", added.details.items.length === 4, JSON.stringify(added.details.items));

  console.log("== 3. 等待真实 embedding 索引完成 ==");
  const done = await waitFor(async () => {
    const res = await listBases.execute({}, fakeCtx);
    const base = res.details.bases.find((b) => b.id === baseId);
    return base && base.completedCount >= 4;
  }, 120000);
  check("4 个材料全部完成索引（含真实 embedding 调用）", done);

  // 验证 chunk 是否带向量
  const chunksDir = join(dataDir, "bases", baseId, "chunks");
  if (existsSync(chunksDir)) {
    const files = readdirSync(chunksDir);
    let withVector = 0;
    let total = 0;
    for (const f of files) {
      const file = JSON.parse(require("node:fs").readFileSync(join(chunksDir, f), "utf8"));
      for (const chunk of file.chunks) {
        total += 1;
        if (chunk.vector && chunk.vector.length === 1024) withVector += 1;
      }
    }
    check(`chunks 全部带 1024 维向量（${withVector}/${total}）`, total > 0 && withVector === total);
  }

  console.log("== 4. 混合检索（BM25 + bge-m3 向量，RRF）==");
  const zh = await search.execute({ baseId, query: "向量检索", topK: 5 }, fakeCtx);
  check("中文查询命中知识库文档", zh.details.results.length > 0 && zh.details.results.some((r) => r.itemName === "中文笔记"), JSON.stringify(zh.details.results?.slice(0, 2)));
  const en = await search.execute({ baseId, query: "reranking model", topK: 5 }, fakeCtx);
  check("英文查询命中 rerank 文档", en.details.results.length > 0 && en.details.results.some((r) => r.itemName === "rerank.md"), JSON.stringify(en.details.results?.slice(0, 2)));
  check("混合检索分数为 ranking", zh.details.results.every((r) => r.scoreKind === "ranking"));

  console.log("== 5. 启用重排（bge-reranker-v2-m3）==");
  const { pathToFileURL } = await import("node:url");
  const { getRuntime } = await import(pathToFileURL(join(root, "index.js")).href);
  const runtime = getRuntime("hank-knowledge");
  await runtime.service.enableRerank(baseId);
  const baseInfo = await runtime.service.getBase(baseId);
  check("rerankModelId 已固化", baseInfo.rerankModelId === "BAAI/bge-reranker-v2-m3", JSON.stringify(baseInfo.rerankModelId));

  const reranked = await search.execute({ baseId, query: "向量检索", topK: 5 }, fakeCtx);
  check("重排后查询有结果", reranked.details.results.length > 0);
  check("重排分数为 relevance", reranked.details.results.every((r) => r.scoreKind === "relevance"), JSON.stringify(reranked.details.results?.slice(0, 2)));
  check("relevance 分数在 [0,1]", reranked.details.results.every((r) => r.score >= 0 && r.score <= 1), JSON.stringify(reranked.details.results?.slice(0, 2)));
  console.log("  重排结果样例:", JSON.stringify(reranked.details.results?.slice(0, 2)));

  console.log("== 6. 阈值过滤（relevance-only）==");
  const thresholded = await runtime.service.search(baseId, "向量检索", { topK: 5, threshold: 0.5 });
  check("阈值 0.5 过滤后分数均 >= 0.5", thresholded.every((r) => r.scoreKind !== "relevance" || r.score >= 0.5), JSON.stringify(thresholded.map((r) => r.score)));

  console.log("== 7. rerank 相关性判别验证 ==");
  const unrelated = await search.execute({ baseId, query: "公园散步面包", topK: 5 }, fakeCtx);
  const top = unrelated.details.results?.[0];
  check(
    "包含查询词的文档排第一（高分），不匹配文档近零分",
    top?.itemName === "无关笔记" && top.score > 0.9 && (unrelated.details.results?.[1]?.score ?? 1) < 0.01,
    JSON.stringify(unrelated.details.results?.slice(0, 2)),
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("real-models test crashed:", err);
  process.exit(1);
});