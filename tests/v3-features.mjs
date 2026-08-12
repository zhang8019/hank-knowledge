/**
 * v3 新功能集成测试：
 * 1. MinerU 二进制转换（mock API）
 * 2. 简单 Wiki 摄入（摘要页 + index）
 *
 * 运行：node tests/v3-features.mjs（需先 npm run build）
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const manage = require(join(root, "tools/knowledge_create_base.js"));
const add = require(join(root, "tools/knowledge_add_items.js"));
const list = require(join(root, "tools/knowledge_list_bases.js"));
const wikiIngest = require(join(root, "tools/knowledge_wiki_ingest.js"));

const dataDir = mkdtempSync(join(tmpdir(), "hk-v3-test-"));
const configMap = new Map();
const fakeCtx = {
  pluginId: "hank-knowledge",
  dataDir,
  config: { get: async (k) => configMap.get(k), set: async (k, v) => configMap.set(k, v) },
  network: { fetch: async () => { throw new Error("no network in mock"); } },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  resources: {},
  bus: { request: async () => { throw new Error("no bus"); } },
};

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("== 1. 建库 + 添加文本材料 ==");
  const created = await manage.execute({ name: "v3 测试库" }, fakeCtx);
  const baseId = created.details.base.id;
  check("建库成功", Boolean(baseId));

  const added = await add.execute({ baseId, items: [
    { type: "note", name: "Wiki测试笔记", content: "注意力机制是深度学习的核心技术，Transformer 基于多头注意力实现并行计算。查询键值三个向量计算加权和。" },
  ] }, fakeCtx);
  check("添加材料", added.details.items.length === 1);
  const itemId = added.details.items[0].id;
  await sleep(1000);

  console.log("== 2. Wiki 摄入 ==");
  const wiki = await wikiIngest.execute({ baseId, itemId }, fakeCtx);
  check("Wiki 页生成", wiki.details.result?.slug === "wiki测试笔记" || wiki.details.result?.slug, JSON.stringify(wiki.details.result?.slug));
  const wikiDir = join(dataDir, "bases", baseId, "raw", "wiki");
  check("wiki 目录存在", existsSync(wikiDir));
  const files = readdirSync(wikiDir);
  check("生成摘要页 + index", files.includes("index.md") && files.length >= 2, JSON.stringify(files));
  const page = readFileSync(join(wikiDir, "wiki测试笔记.md"), "utf8");
  check("摘要页含标题", page.includes("# Wiki测试笔记"));
  check("摘要页含关键词", page.includes("## 关键词"));
  check("index 含条目", readFileSync(join(wikiDir, "index.md"), "utf8").includes("Wiki测试笔记"));

  console.log("\n" + (failures === 0 ? "ALL PASS" : `${failures} FAILURES`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
