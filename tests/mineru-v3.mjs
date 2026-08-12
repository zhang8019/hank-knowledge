/**
 * v3 MinerU 集成测试（mock API）：验证 workflow 二进制 → MinerU 转换链路。
 *
 * 运行：node tests/mineru-v3.mjs（需先 npm install）
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

const esbuild = require(join(root, "node_modules/esbuild"));
const outDir = mkdtempSync(join(tmpdir(), "hk-mineru-v3-"));
await esbuild.build({
  entryPoints: [join(root, "lib/mineru.ts")],
  bundle: true, format: "esm", platform: "node", target: "node20",
  outfile: join(outDir, "mineru.mjs"),
});
const { MineruClient, extractMarkdownFromZipBuffer, countPdfPages, splitPageRanges } =
  await import(pathToFileURL(join(outDir, "mineru.mjs")).href);

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("== 1. MinerU Agent 轻量 API 全流程（mock）==");
{
  const taskId = "t-1";
  const markdown = "# Parsed PDF\n\n内容已转换。";
  let puts = 0;
  const net = {
    async fetch(url, init) {
      const u = String(url);
      if (u.endsWith("/api/v1/agent/parse/file")) {
        return new Response(JSON.stringify({ code: 0, data: { task_id: taskId, file_url: "https://oss/x" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/oss/x")) { puts++; return new Response(null, { status: 200 }); }
      if (u.includes(`/api/v1/agent/parse/${taskId}`)) {
        return new Response(JSON.stringify({ code: 0, data: { state: "done", markdown_url: "https://cdn/md" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("cdn/md")) return new Response(markdown, { status: 200 });
      throw new Error("unexpected: " + u);
    },
  };
  const store = {
    get: async (k) => ({
      mineruBaseUrl: "https://mineru.net", mineruApiKey: "", mineruModel: "vlm",
      mineruLanguage: "ch", mineruEnableTable: true, mineruEnableFormula: true,
      mineruOcr: false, mineruAutoSplit: true, mineruMaxPagesPerBatch: 0,
    })[k],
  };
  const client = await MineruClient.fromConfig(store, net);
  check("fromConfig 返回客户端", client !== null);
  const result = await client.parseFile("report.pdf", new Uint8Array([1, 2, 3]));
  check("解析 mode=agent", result.mode === "agent");
  check("内容正确", result.markdown === markdown);
  check("PUT 一次", puts === 1);
}

console.log("== 2. 页数探测 + 分段 ==");
{
  const pdf = Buffer.from("<< /Type /Pages /Count 45 /Kids [] >>", "latin1");
  check("探测 45 页", countPdfPages(pdf) === 45);
  const ranges = splitPageRanges(45, 20);
  check("45 页分 3 段", ranges.length === 3 && ranges[0] === "1-20" && ranges[2] === "41-45", JSON.stringify(ranges));
}

console.log("== 3. Zip 解包 ==");
{
  // 构造最小 Store zip（full.md）
  const name = "full.md", content = "# hello";
  const nameBuf = Buffer.from(name), data = Buffer.from(content);
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lh, nameBuf, data]);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0, 42);
  const central = Buffer.concat([ch, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, central, eocd]);
  check("zip 解出 markdown", extractMarkdownFromZipBuffer(zip) === "# hello");
}

console.log("\n" + (failures === 0 ? "ALL PASS" : `${failures} FAILURES`));
process.exit(failures === 0 ? 0 : 1);
