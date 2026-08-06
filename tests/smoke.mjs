/**
 * 冒烟测试：直接加载构建产物（tools/*.js），用最小 fake ctx 跑通
 * 建库 → 添加材料 → 后台索引 → 检索 → 重建 → 删除 → 持久化。
 *
 * 运行：node tests/smoke.mjs（需先 npm run build）
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const createBase = require(join(root, "tools/knowledge_create_base.js"));
const deleteBase = require(join(root, "tools/knowledge_delete_base.js"));
const addItems = require(join(root, "tools/knowledge_add_items.js"));
const search = require(join(root, "tools/knowledge_search.js"));
const listBases = require(join(root, "tools/knowledge_list_bases.js"));
const readItem = require(join(root, "tools/knowledge_read_item.js"));
const reindex = require(join(root, "tools/knowledge_reindex_items.js"));
const deleteItems = require(join(root, "tools/knowledge_delete_items.js"));

const dataDir = mkdtempSync(join(tmpdir(), "hank-kb-test-"));

const configMap = new Map();
const fakeCtx = {
  pluginId: "hank-knowledge",
  dataDir,
  config: {
    get: async (key) => configMap.get(key),
    set: async (key, value) => configMap.set(key, value),
  },
  network: {
    fetch: async () => { throw new Error("smoke test has no network"); },
  },
  log: {
    debug: () => {},
    info: (...args) => console.log("[info]", ...args),
    warn: () => {},
    error: (...args) => console.error("[log]", ...args),
  },
  resources: {},
  bus: { request: async () => { throw new Error("no bus"); } },
};

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 15000, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  return false;
}

async function main() {
  console.log("== 1. 创建 BM25 知识库 ==");
  const created = await createBase.execute({ name: "测试知识库" }, fakeCtx);
  check("创建返回 ok", !created.details.error, JSON.stringify(created));
  const baseId = created.details.base.id;
  check("base id 已生成", Boolean(baseId));

  console.log("== 2. 添加材料（note + file + directory）==");
  const added = await addItems.execute({
    baseId,
    items: [
      { type: "note", name: "中文笔记", content: "这是一段关于知识库插件架构的中文测试内容，包含向量检索与 BM25 混合检索的说明。" },
      { type: "file", name: "readme.md", content: "# Knowledge Base Plugin\nThis plugin brings Cherry Studio knowledge base to Hanko Agent. It supports BM25 search by default." },
      {
        type: "directory",
        name: "docs",
        files: [
          { name: "a.md", content: "Reciprocal Rank Fusion combines BM25 and vector scores." },
          { name: "b.md", content: "RRF is a rank-based fusion method used in hybrid retrieval." },
        ],
      },
    ],
  }, fakeCtx);
  check("添加 3 个根材料", added.details.items.length === 3, JSON.stringify(added.details.items));

  console.log("== 3. 等待后台索引完成 ==");
  const done = await waitFor(async () => {
    const res = await listBases.execute({}, fakeCtx);
    const base = res.details.bases.find((b) => b.id === baseId);
    return base && base.completedCount >= 5; // 3 根 + 2 个 directory 子项
  });
  check("全部材料完成索引（含目录展开）", done);

  console.log("== 4. 检索命中 ==");
  const zh = await search.execute({ baseId, query: "向量检索" }, fakeCtx);
  check("中文检索命中", zh.details.results.length > 0, JSON.stringify(zh.details.results?.[0] ?? zh));
  const en = await search.execute({ baseId, query: "RRF hybrid" }, fakeCtx);
  check("英文检索命中", en.details.results.length > 0, JSON.stringify(en.details.results?.[0] ?? en));
  const miss = await search.execute({ baseId, query: "不存在的词qqxx" }, fakeCtx);
  check("无相关词返回空", miss.details.results.length === 0, JSON.stringify(miss));

  console.log("== 5. 读取材料 ==");
  const noteItem = added.details.items.find((item) => item.type === "note");
  const read = await readItem.execute({ baseId, itemId: noteItem.id }, fakeCtx);
  check("读取笔记全文", read.details.fullLength > 10 && read.content[0].text.includes("知识库插件"), "");

  console.log("== 6. 重建索引 ==");
  const re = await reindex.execute({ baseId }, fakeCtx);
  check("重建接受", !re.details.error, JSON.stringify(re));
  // completedCount 在 reindex 删 chunks 时仍是旧值，这里等链上真实落盘
  await sleep(1200);
  const redone = await waitFor(async () => {
    const res = await listBases.execute({}, fakeCtx);
    const base = res.details.bases.find((b) => b.id === baseId);
    return base && base.completedCount >= 5;
  });
  check("重建完成", redone);
  const after = await search.execute({ baseId, query: "RRF" }, fakeCtx);
  check("重建后检索仍命中", after.details.results.length > 0);

  console.log("== 7. 删除材料 ==");
  const fileItem = added.details.items.find((item) => item.type === "file");
  await deleteItems.execute({ baseId, itemIds: [fileItem.id] }, fakeCtx);
  const deleted = await waitFor(async () => {
    const res = await listBases.execute({}, fakeCtx);
    const base = res.details.bases.find((b) => b.id === baseId);
    return base && base.itemCount <= 4; // 3 根 + 2 子 - 1 = 4
  });
  check("删除后材料数减少", deleted);
  const delSearch = await search.execute({ baseId, query: "Hanko Agent" }, fakeCtx);
  check("删除的文件不再命中", delSearch.details.results.length === 0, JSON.stringify(delSearch));

  console.log("== 8. 持久化 ==");
  // 等待链上重建 job 完成落盘（步骤 6 的 reindex 会在链尾重新索引）
  const chunksStable = await waitFor(async () => {
    try {
      const chunksDir = join(dataDir, "bases", baseId, "chunks");
      return require("node:fs").readdirSync(chunksDir).length >= 3;
    } catch {
      return false;
    }
  });
  check("chunks 已写入（重建完成后）", chunksStable);
  const metaExists = existsSync(join(dataDir, "bases", baseId, "meta.json"));
  const itemsExists = existsSync(join(dataDir, "bases", baseId, "items.json"));
  check("meta.json 持久化", metaExists);
  check("items.json 持久化", itemsExists);

  console.log("== 9. 删除知识库 ==");
  const delBase = await deleteBase.execute({ baseId }, fakeCtx);
  check("删除知识库", !delBase.details.error, JSON.stringify(delBase));
  check("数据目录已清理", !existsSync(join(dataDir, "bases", baseId)));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  // 等待 stdout 管道 flush 后再退出
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});