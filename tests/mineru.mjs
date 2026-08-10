/**
 * MinerU 客户端单元测试：
 * 1. Zip 解包（Store + Deflate）提取 full.md
 * 2. Agent 轻量 API 全流程（mock 服务：签名上传 → 轮询 → markdown_url）
 * 3. 双模式选择（无 Token 用 Agent；有 Token 且超限用精准）
 *
 * 运行：node tests/mineru.mjs（需先 npm install）
 */

import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");

// 用 esbuild 将 lib/mineru.ts 打包为 ESM 到临时目录
const esbuild = require(join(root, "node_modules/esbuild"));
const outDir = mkdtempSync(join(tmpdir(), "hank-mineru-test-"));
await esbuild.build({
  entryPoints: [join(root, "lib/mineru.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: join(outDir, "mineru.mjs"),
});

const { MineruClient, extractMarkdownFromZipBuffer, countPdfPages, splitPageRanges, pageRangeCount, joinSegments } = await import(
  pathToFileURL(join(outDir, "mineru.mjs")).href
);

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

function makeZip(files) {
  // 构造最小 zip：仅支持 Store + Deflate 的中央目录 + 本地头
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content, method } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const rawBuf = Buffer.from(content, "utf8");
    const rawLength = rawBuf.length;
    const data = method === 8 ? deflateRawSync(rawBuf) : rawBuf;
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local sig
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // flags (UTF-8)
    localHeader.writeUInt16LE(method, 8); // method
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(rawLength, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra length
    const local = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central sig
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8); // flags
    centralHeader.writeUInt16LE(method, 10); // method
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(rawLength, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28); // filename length
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += local.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localParts.reduce((n, b) => n + b.length, 0), 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

console.log("== 1. Zip 解包 ==");
{
  const md = "# Full Doc\n\nHello MinerU 中文内容。";
  const zipDeflate = makeZip([
    { name: "example/full.md", content: md, method: 8 },
    { name: "example/content_list.json", content: "{}", method: 0 },
  ]);
  const got = extractMarkdownFromZipBuffer(zipDeflate);
  check("Deflate zip 提取 full.md", got === md, `got=${JSON.stringify(got)}`);

  const zipStore = makeZip([{ name: "full.md", content: "store method", method: 0 }]);
  check("Store zip 提取 full.md", extractMarkdownFromZipBuffer(zipStore) === "store method");

  check("无 md 的 zip 返回 null", extractMarkdownFromZipBuffer(makeZip([{ name: "a.json", content: "{}", method: 0 }])) === null);
}

console.log("== 2. Agent 轻量 API 全流程（mock） ==");
{
  const taskId = "task-abc-123";
  const markdownText = "# Agent Parse Result\n\nPDF 内容已转换为 Markdown。";
  let putCalls = 0;

  const fakeNetwork = {
    async fetch(url, init) {
      const u = String(url);
      if (u.endsWith("/api/v1/agent/parse/file")) {
        const body = JSON.parse(init.body);
        check("提交含 file_name", body.file_name === "document.pdf");
        check("提交含 language", body.language === "ch");
        return new Response(JSON.stringify({
          code: 0, data: { task_id: taskId, file_url: "https://oss.example/upload/abc" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/upload/abc")) {
        putCalls += 1;
        check("PUT 上传文件", init.method === "PUT");
        return new Response(null, { status: 200 });
      }
      if (u.includes(`/api/v1/agent/parse/${taskId}`)) {
        return new Response(JSON.stringify({
          code: 0, data: { state: "done", markdown_url: "https://cdn.example/full.md" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("cdn.example/full.md")) {
        return new Response(markdownText, { status: 200 });
      }
      throw new Error(`unexpected url: ${u}`);
    },
  };

  const configStore = {
    get: async (k) => {
      const map = {
        mineruBaseUrl: "https://mineru.net",
        mineruApiKey: "",
        mineruModel: "vlm",
        mineruLanguage: "ch",
        mineruEnableTable: true,
        mineruEnableFormula: true,
        mineruOcr: false,
      };
      return map[k];
    },
  };

  const client = await MineruClient.fromConfig(configStore, fakeNetwork);
  check("未配 Token 时客户端可用（Agent 模式）", client !== null);
  check("未配 Token 时 configuredApiKey=false", client.configuredApiKey === false);

  const result = await client.parseFile("document.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  check("解析结果 mode=agent", result.mode === "agent", `got=${result.mode}`);
  check("解析结果内容正确", result.markdown === markdownText);
  check("PUT 调用一次", putCalls === 1, `calls=${putCalls}`);
}

console.log("== 3. 页数超限自动分段（mock） ==");
{
  // 构造 45 页 PDF（/Count 45）+ 带 Token → 走精准 API？不，这里测 Agent 模式分段：
  // 无 Token + 45 页 + autoSplit → 分 3 段，每段带 page_range
  const tasks = [];
  const seenRanges = [];
  const fakeNetwork = {
    async fetch(url, init) {
      const u = String(url);
      if (u.endsWith("/api/v1/agent/parse/file")) {
        const body = JSON.parse(init.body);
        seenRanges.push(body.page_range);
        const id = `task-${seenRanges.length}`;
        tasks.push(id);
        return new Response(JSON.stringify({
          code: 0, data: { task_id: id, file_url: `https://oss.example/up/${id}` },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/up/")) {
        return new Response(null, { status: 200 });
      }
      const taskMatch = u.match(/\/api\/v1\/agent\/parse\/(task-\d+)/);
      if (taskMatch) {
        const id = taskMatch[1];
        const idx = tasks.indexOf(id);
        return new Response(JSON.stringify({
          code: 0, data: { state: "done", markdown_url: `https://cdn.example/md/${id}` },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("cdn.example/md/")) {
        return new Response(`# Part ${u.split("/").pop()}`, { status: 200 });
      }
      throw new Error(`unexpected url: ${u}`);
    },
  };
  const configStore = {
    get: async (k) => {
      const map = {
        mineruBaseUrl: "https://mineru.net",
        mineruApiKey: "",
        mineruModel: "vlm",
        mineruLanguage: "ch",
        mineruEnableTable: true,
        mineruEnableFormula: true,
        mineruOcr: false,
        mineruAutoSplit: true,
        mineruMaxPagesPerBatch: 0,
      };
      return map[k];
    },
  };
  const client = await MineruClient.fromConfig(configStore, fakeNetwork);
  // 45 页 PDF 字节（含 /Count 45）
  const pdfBytes = Buffer.from("<< /Type /Pages /Count 45 /Kids [] >>", "latin1");
  const result = await client.parseFile("big.pdf", new Uint8Array(pdfBytes));
  check("分段数 = 3", result.splitCount === 3, `split=${result.splitCount}`);
  check("每段带 page_range", seenRanges.length === 3, JSON.stringify(seenRanges));
  check("分段范围正确", seenRanges[0] === "1-20" && seenRanges[1] === "21-40" && seenRanges[2] === "41-45", JSON.stringify(seenRanges));
  check("拼接结果含 3 段内容", result.markdown.includes("# Part task-1") && result.markdown.includes("# Part task-3"));
  check("拼接含分隔注释", result.markdown.includes("拆分片段"));
}

console.log("== 4. 页数探测 ==");
{
  check("Agent 轻量 API 不支持 docx？", MineruClient.supports("a.docx") === true);
  check("支持 pdf", MineruClient.supports("x.pdf") === true);
  check("不支持 exe", MineruClient.supports("x.exe") === false);
  check("不支持 txt（本地文本无需 MinerU）", MineruClient.supports("x.txt") === false);
  check("无扩展名返回提示", MineruClient.unsupportedReason("README") !== null);
}

console.log("== 4. 页数探测 ==");
{
  // 构造含 /Count 的 PDF 文本（latin1 扫描即可，无需合法 PDF）
  const makePdf = (count) => {
    const trailer = `<< /Type /Catalog /Pages 2 0 R >>\n2 0 obj\n<< /Type /Pages /Count ${count} /Kids [3 0 R 4 0 R] >>\nendobj\n`;
    return Buffer.from(trailer, "latin1");
  };
  check("探测到 /Count 30", countPdfPages(makePdf(30)) === 30);
  check("多 /Count 取最大", countPdfPages(Buffer.concat([makePdf(10), makePdf(45)])) === 45);
  check("无 /Count 返回 null", countPdfPages(Buffer.from("hello world", "latin1")) === null);
}

console.log("== 5. 页数分段 ==");
{
  const r1 = splitPageRanges(45, 20);
  check("45 页 / 20 每段 → 3 段", r1.length === 3, JSON.stringify(r1));
  check("段格式正确", r1[0] === "1-20" && r1[1] === "21-40" && r1[2] === "41-45", JSON.stringify(r1));
  const r2 = splitPageRanges(20, 20);
  check("恰好上限 → 1 段", r2.length === 1 && r2[0] === "1-20", JSON.stringify(r2));
  const r3 = splitPageRanges(5, 20);
  check("低于上限 → 1 段", r3.length === 1 && r3[0] === "1-5", JSON.stringify(r3));
  check("单页范围计数", pageRangeCount("1-20") === 20);
  check("单页计数", pageRangeCount("7") === 1);
  const joined = joinSegments(["# A", "# B"], ["1-20", "21-40"]);
  check("拼接含页范围注释", joined.includes("1-20") && joined.includes("21-40") && joined.includes("# A") && joined.includes("# B"));
  check("单段拼接原样", joinSegments(["only"]) === "only");
}

console.log("");
if (failures === 0) console.log("ALL PASS");
else {
  console.error(`${failures} FAILURES`);
  process.exit(1);
}
