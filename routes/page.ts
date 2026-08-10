/**
 * 知识库管理界面与 REST API（全内联，零外部资源依赖）。
 *
 * 参考 desktop-orchestrator 插件的做法：
 * - 页面 HTML 内联全部 CSS/JS，不引用 /assets/*（避免宿主静态服务缺失导致 404）
 * - iframe 内 fetch 用相对路径并继承当前 query 参数（pluginSurfaceSession 等）
 * - /page 与 /widget 注册同一个管理界面
 */

import { EmbeddingClient } from "../lib/embedding";
import { RerankClient } from "../lib/rerank";
import { MineruClient } from "../lib/mineru";
import { LlmClient } from "../lib/llm";
import { ensureRuntime } from "../lib/runtime";
import type { KnowledgeAddInput } from "../lib/knowledge";

interface ApiCtx {
  get(name: string): unknown;
}

function handler(
  run: (bundle: ReturnType<typeof ensureRuntime>, c: any) => Promise<unknown>,
) {
  return async (c: any) => {
    try {
      const pluginCtx = c.get("pluginCtx") as ApiCtx;
      const bundle = ensureRuntime(pluginCtx as never);
      const result = await run(bundle, c);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  };
}

export default function registerKnowledgePageRoutes(app: any, _ctx: any): void {
  // ---- 页面 ----
  app.get("/page", (c: any) => c.html(renderShell(c)));
  app.get("/widget", (c: any) => c.html(renderShell(c)));

  // ---- 状态 ----
  app.get("/api/status", handler(async (bundle) => {
    const embedding = await EmbeddingClient.fromConfig(bundle.ctx.config, bundle.ctx.network);
    const rerank = await RerankClient.fromConfig(bundle.ctx.config, bundle.ctx.network);
    const mineru = await MineruClient.fromConfig(bundle.ctx.config, bundle.ctx.network);
    const llm = await LlmClient.fromConfig(bundle.ctx.config, bundle.ctx.network);
    return {
      embeddingConfigured: Boolean(embedding),
      embeddingModel: embedding ? embedding.model : "",
      rerankConfigured: Boolean(rerank),
      rerankModel: rerank ? rerank.model : "",
      mineruConfigured: Boolean(mineru),
      mineruModel: mineru ? mineru.model : "",
      mineruApiKey: mineru ? mineru.configuredApiKey : false,
      llmConfigured: Boolean(llm),
      llmModel: llm ? llm.model : "",
    };
  }));

  // ---- 知识库 CRUD ----
  app.get("/api/bases", handler(async (bundle) => {
    return { bases: await bundle.service.listBases() };
  }));

  app.post("/api/bases", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const base = await bundle.service.createBase(body.name ?? "", {
      enableVector: Boolean(body.enableVector),
    });
    return { base };
  }));

  app.patch("/api/bases/:id", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name === "string") {
      return { base: await bundle.service.renameBase(c.req.param("id"), body.name) };
    }
    throw new Error("缺少 name 字段");
  }));

  app.delete("/api/bases/:id", handler(async (bundle, c) => {
    await bundle.service.deleteBase(c.req.param("id"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/enable-embedding", handler(async (bundle, c) => {
    await bundle.service.enableEmbedding(c.req.param("id"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/enable-rerank", handler(async (bundle, c) => {
    await bundle.service.enableRerank(c.req.param("id"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/disable-rerank", handler(async (bundle, c) => {
    await bundle.service.disableRerank(c.req.param("id"));
    return { ok: true };
  }));

  // ---- 材料 ----
  app.get("/api/bases/:id/items", handler(async (bundle, c) => {
    const items = await bundle.service.listItems(c.req.param("id"));
    return { items };
  }));

  app.get("/api/bases/:id/item/:itemId", handler(async (bundle, c) => {
    const { text, item } = await bundle.service.readItemText(c.req.param("id"), c.req.param("itemId"));
    return { item, text };
  }));

  /** multipart 上传：files[] + mode(flat|directory) + dirName? */
  app.post("/api/bases/:id/upload", handler(async (bundle, c) => {
    const form = await c.req.formData();
    const baseId = c.req.param("id");
    const mode = String(form.get("mode") || "flat");
    const dirName = String(form.get("dirName") || "uploads");
    const files = form
      .getAll("files")
      .filter((entry: FormDataEntryValue): entry is File => entry instanceof File);
    if (files.length === 0) return { accepted: 0, items: [] };

    const inputs: KnowledgeAddInput[] = [];
    if (mode === "directory") {
      const folderName = firstPathSegment(files[0]?.name) || dirName;
      inputs.push({
        type: "directory",
        name: folderName,
        files: await Promise.all(files.map(async (file: File) => ({
          name: baseName(file.name),
          content: new Uint8Array(await file.arrayBuffer()),
        }))),
      });
    } else {
      for (const file of files) {
        inputs.push({
          type: "file",
          name: baseName(file.name),
          content: new Uint8Array(await file.arrayBuffer()),
        });
      }
    }
    const created = await bundle.service.addItems(baseId, inputs);
    return {
      accepted: created.length,
      items: created.map((item) => ({ id: item.id, name: item.name, type: item.type })),
    };
  }));

  app.post("/api/bases/:id/url", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const created = await bundle.service.addItems(c.req.param("id"), [
      { type: "url", name: body.name ?? body.url ?? "网页", url: body.url },
    ]);
    return { items: created.map((item) => ({ id: item.id, name: item.name, type: item.type })) };
  }));

  app.post("/api/bases/:id/note", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const created = await bundle.service.addItems(c.req.param("id"), [
      { type: "note", name: body.name ?? "笔记", content: body.content ?? "" },
    ]);
    return { items: created.map((item) => ({ id: item.id, name: item.name, type: item.type })) };
  }));

  app.post("/api/bases/:id/delete-items", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
    if (itemIds.length === 0) throw new Error("缺少 itemIds");
    await bundle.service.deleteItems(c.req.param("id"), itemIds);
    return { ok: true };
  }));

  app.post("/api/bases/:id/reindex", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const itemIds = Array.isArray(body.itemIds) && body.itemIds.length
      ? body.itemIds.map(String)
      : (await bundle.service.listItems(c.req.param("id")))
          .filter((item) => item.parentId === null)
          .map((item) => item.id);
    await bundle.service.reindexItems(c.req.param("id"), itemIds);
    return { ok: true };
  }));

  app.post("/api/bases/:id/retry/:itemId", handler(async (bundle, c) => {
    await bundle.service.retryItem(c.req.param("id"), c.req.param("itemId"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/refresh-url/:itemId", handler(async (bundle, c) => {
    await bundle.service.refreshUrlItem(c.req.param("id"), c.req.param("itemId"));
    return { ok: true };
  }));

  // ---- 检索 ----
  app.get("/api/bases/:id/search", handler(async (bundle, c) => {
    const query = String(c.req.query("q") ?? "");
    const topK = Number(c.req.query("topK") ?? 0) || undefined;
    const results = await bundle.service.search(c.req.param("id"), query, { topK });
    return { results };
  }));

  app.get("/api/bases/:id/chunks/:itemId", handler(async (bundle, c) => {
    const chunks = await bundle.service.listItemChunks(c.req.param("id"), c.req.param("itemId"));
    return { chunks };
  }));

  // ---- 知识图谱 ----
  app.get("/api/bases/:id/graph", handler(async (bundle, c) => {
    return { graph: await bundle.service.getGraph(c.req.param("id")) };
  }));

  app.post("/api/bases/:id/graph/nodes", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.title !== "string" || !body.title.trim()) throw new Error("缺少 title");
    const node = await bundle.service.addGraphNode(c.req.param("id"), {
      type: body.type,
      maturity: body.maturity,
      title: body.title,
      elements: body.elements,
      sourceRefs: body.sourceRefs,
    });
    return { node };
  }));

  app.patch("/api/bases/:id/graph/nodes/:nodeId", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const node = await bundle.service.updateGraphNode(c.req.param("id"), c.req.param("nodeId"), body);
    return { node };
  }));

  app.delete("/api/bases/:id/graph/nodes/:nodeId", handler(async (bundle, c) => {
    await bundle.service.deleteGraphNode(c.req.param("id"), c.req.param("nodeId"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/graph/edges", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.source !== "string" || typeof body.target !== "string") {
      throw new Error("缺少 source / target");
    }
    const edge = await bundle.service.linkGraphNodes(c.req.param("id"), {
      source: body.source,
      target: body.target,
      kind: body.kind,
      relation: body.relation,
      strength: body.strength,
      bidirectional: body.bidirectional,
    });
    return { edge };
  }));

  app.delete("/api/bases/:id/graph/edges/:edgeId", handler(async (bundle, c) => {
    await bundle.service.unlinkGraphNodes(c.req.param("id"), c.req.param("edgeId"));
    return { ok: true };
  }));

  app.get("/api/bases/:id/graph/search", handler(async (bundle, c) => {
    const query = String(c.req.query("q") ?? "");
    const nodes = query ? await bundle.service.searchGraph(c.req.param("id"), query) : [];
    return { nodes };
  }));

  app.get("/api/bases/:id/graph/nodes/:nodeId/neighbors", handler(async (bundle, c) => {
    const neighbors = await bundle.service.graphNeighbors(c.req.param("id"), c.req.param("nodeId"));
    return { neighbors };
  }));

  app.post("/api/bases/:id/graph/nodes/:nodeId/promote", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const node = await bundle.service.promoteNode(c.req.param("id"), c.req.param("nodeId"), { force: Boolean(body.force) });
    return { node };
  }));

  app.post("/api/bases/:id/graph/nodes/:nodeId/demote", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    const node = await bundle.service.demoteNode(c.req.param("id"), c.req.param("nodeId"), body.reason);
    return { node };
  }));

  app.get("/api/bases/:id/graph/nodes/:nodeId/evaluate", handler(async (bundle, c) => {
    const evaluation = await bundle.service.evaluateNode(c.req.param("id"), c.req.param("nodeId"));
    return { evaluation };
  }));

  // ---- 神经树构建 / 验证 ----
  app.post("/api/bases/:id/build-tree", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.domain !== "string" || !body.domain.trim()) throw new Error("缺少 domain（书名/主题）");
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("缺少 text（材料内容）");
    const result = await bundle.service.buildTree({
      baseId: c.req.param("id"),
      domain: body.domain,
      text: body.text,
      sourceRefs: body.sourceRefs,
      maxNeuronsPerBranch: body.maxNeuronsPerBranch,
    });
    return result;
  }));

  app.post("/api/bases/:id/verify-tree", handler(async (bundle, c) => {
    const report = await bundle.service.verifyTree(c.req.param("id"));
    return { report };
  }));

  app.get("/api/bases/:id/graph-answer", handler(async (bundle, c) => {
    const query = String(c.req.query("q") ?? "");
    if (!query) return { nodes: [], answerKind: "synthesis" };
    return bundle.service.graphAnswer(c.req.param("id"), query);
  }));

  // ---- LLM Wiki ----
  app.post("/api/bases/:id/wiki-ingest", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("缺少 text（材料内容）");
    const result = await bundle.service.wikiIngest({
      baseId: c.req.param("id"),
      itemId: typeof body.itemId === "string" ? body.itemId : "manual",
      itemName: typeof body.itemName === "string" && body.itemName ? body.itemName : "未命名材料",
      text: body.text,
      useLlm: body.useLlm,
    });
    return result;
  }));

  app.get("/api/bases/:id/wiki-lint", handler(async (bundle, c) => {
    const report = await bundle.service.wikiLint(c.req.param("id"));
    return { report };
  }));
}

// ================= 页面渲染 =================

function renderShell(c: any): string {
  const theme = (c.req.query("hana-theme") as string) || "inherit";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>知识库</title>
<style>${PAGE_CSS}</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}">
<main id="app" class="app">
  <header class="top">
    <h1>📚 知识库</h1>
    <div class="row">
      <span id="serviceBadge" class="badge muted">…</span>
    </div>
  </header>
  <div id="toast" class="toast" hidden></div>
  <div class="layout">
    <aside class="side">
      <section class="card glass">
        <h2>新建知识库</h2>
        <input id="newBaseName" class="input" placeholder="知识库名称">
        <label class="check"><input id="newBaseVector" type="checkbox"> 启用向量检索</label>
        <button id="createBaseBtn" class="btn primary" disabled>创建</button>
      </section>
      <section class="card glass">
        <h2>知识库列表</h2>
        <div id="baseList" class="list"></div>
      </section>
      <section class="card glass">
        <h2>成熟度图例</h2>
        <div class="legend">
          <span class="dot fuzzy"></span><span class="lv">探索 <em>fuzzy</em></span>
          <span class="dot emerging"></span><span class="lv">共识 <em>emerging</em></span>
          <span class="dot codified"></span><span class="lv">已编译 <em>codified</em></span>
        </div>
      </section>
    </aside>
    <main class="main">
      <section id="empty" class="card glass empty">选择一个知识库，或创建一个。</section>
      <section id="detail" class="detail" hidden></section>
    </main>
  </div>
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

const PAGE_CSS = `
:root {
  --bg: #0f1115;
  --bg2: #171a21;
  --panel: rgba(255,255,255,.045);
  --panel-strong: rgba(255,255,255,.07);
  --border: rgba(255,255,255,.1);
  --border-strong: rgba(255,255,255,.16);
  --text: #e8e6e1;
  --text-dim: #9a958a;
  --text-faint: #6b675e;
  --accent: #6fb3d9;
  --accent-2: #8f7fe0;
  --fuzzy: #6fb3d9;      /* 雾蓝 */
  --emerging: #e0a94f;   /* 琥珀 */
  --codified: #5cb87a;   /* 翡翠 */
  --danger: #e07070;
  --ok: #5cb87a;
  --radius: 14px;
  --shadow: 0 8px 32px rgba(0,0,0,.35);
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--text); background: radial-gradient(1200px 800px at 15% -10%, #1a2333 0%, var(--bg) 55%); min-height: 100vh; }
.app { display: flex; flex-direction: column; min-height: 100vh; }
.top { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: var(--bg2); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; backdrop-filter: blur(12px); }
.top h1 { font-size: 17px; margin: 0; letter-spacing: .5px; }
.layout { display: flex; gap: 16px; padding: 16px; flex: 1; }
.side { width: 252px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; }
.main { flex: 1; min-width: 0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 15px; margin-bottom: 12px; }
.card.glass { backdrop-filter: blur(14px); box-shadow: var(--shadow); }
.card h2 { margin: 0 0 10px; font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; }
.card h3 { margin: 0 0 10px; font-size: 14px; }
.input, textarea.input { width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); color: var(--text); font-size: 13px; margin-bottom: 8px; }
textarea.input { resize: vertical; font-family: inherit; min-height: 60px; }
.input:focus { outline: none; border-color: var(--accent); }
.btn { padding: 7px 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-strong); color: var(--text); cursor: pointer; font-size: 13px; transition: all .15s; }
.btn:hover { border-color: var(--accent); color: #fff; }
.btn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border: none; color: #0b0d12; font-weight: 600; }
.btn.danger { color: var(--danger); }
.btn.tiny { padding: 3px 9px; font-size: 12px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); margin: 6px 0; }
.row { display: flex; align-items: center; gap: 8px; }
.row.between { justify-content: space-between; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; }
.muted { color: var(--text-dim); font-size: 12px; }
.faint { color: var(--text-faint); font-size: 12px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.list-item { text-align: left; padding: 9px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); cursor: pointer; transition: border-color .15s; }
.list-item:hover { border-color: var(--border-strong); }
.list-item.selected { border-color: var(--accent); background: rgba(111,179,217,.1); }
.list-item .name { font-weight: 600; font-size: 13px; }
.list-item .meta { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.badge { padding: 2px 9px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--text-dim); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: var(--ok); }
.badge.err { color: var(--danger); border-color: var(--danger); }
.badge.busy { color: var(--emerging); border-color: var(--emerging); }
.badge.muted { color: var(--text-faint); }
.empty { color: var(--text-faint); font-size: 13px; padding: 40px 0; text-align: center; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 6px; background: var(--bg2); }
.item.child { margin-left: 26px; }
.item .info { flex: 1; min-width: 0; }
.item .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .err { font-size: 11px; color: var(--danger); }
.result { border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin-bottom: 8px; background: var(--bg2); }
.result .head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.result .rank { color: var(--accent); font-weight: 700; }
.result .text { margin-top: 5px; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.toast { position: fixed; top: 16px; right: 16px; background: var(--bg2); color: var(--text); padding: 10px 16px; border-radius: 10px; font-size: 13px; z-index: 60; border: 1px solid var(--border); box-shadow: var(--shadow); }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.kv { font-size: 12px; color: var(--text-dim); }
.kv b { color: var(--text); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; backdrop-filter: blur(4px); }
.modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 16px; padding: 18px; width: min(760px, 94vw); max-height: 84vh; display: flex; flex-direction: column; box-shadow: var(--shadow); }
.modal pre { flex: 1; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap; font-family: inherit; margin: 8px 0 0; color: var(--text-dim); }
.legend { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
.legend .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 7px; }
.legend .lv em { font-style: normal; color: var(--text-faint); margin-left: 4px; font-size: 11px; }
.dot.fuzzy { background: var(--fuzzy); box-shadow: 0 0 8px var(--fuzzy); }
.dot.emerging { background: var(--emerging); box-shadow: 0 0 8px var(--emerging); }
.dot.codified { background: var(--codified); box-shadow: 0 0 8px var(--codified); }
.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap; }
.tab { padding: 7px 14px; border: 1px solid transparent; border-radius: 9px 9px 0 0; cursor: pointer; font-size: 13px; color: var(--text-dim); background: transparent; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-color: var(--border); border-bottom-color: var(--bg2); background: var(--panel); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.graph-wrap { position: relative; height: 520px; border: 1px solid var(--border); border-radius: var(--radius); background: radial-gradient(circle at 50% 40%, #161b26 0%, var(--bg) 70%); overflow: hidden; }
#graphCanvas { width: 100%; height: 100%; display: block; }
.graph-toolbar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.node-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: var(--bg2); margin-bottom: 8px; cursor: pointer; transition: border-color .15s; }
.node-card:hover { border-color: var(--border-strong); }
.node-card .n-title { font-size: 13px; font-weight: 600; }
.node-card .n-meta { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
.node-card .n-def { font-size: 12px; color: var(--text-dim); margin-top: 5px; line-height: 1.5; }
.badge.fuzzy { color: var(--fuzzy); border-color: var(--fuzzy); }
.badge.emerging { color: var(--emerging); border-color: var(--emerging); }
.badge.codified { color: var(--codified); border-color: var(--codified); }
.wiki-card { border: 1px solid var(--border); border-radius: 10px; padding: 11px; background: var(--bg2); margin-bottom: 8px; }
.wiki-card .w-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
.wiki-card .w-def { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.5; }
.wiki-card .w-tags { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
.wiki-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
.flag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(224,112,112,.15); color: var(--danger); border: 1px solid var(--danger); }
.wizard-step { border: 1px solid var(--border); border-radius: 12px; padding: 13px; background: var(--bg2); margin-bottom: 10px; }
.wizard-step h4 { margin: 0 0 8px; font-size: 13px; }
.kbd { font-family: ui-monospace, monospace; font-size: 11px; background: var(--panel-strong); padding: 1px 5px; border-radius: 5px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.stat-box { border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center; background: var(--bg2); }
.stat-box .n { font-size: 20px; font-weight: 700; }
.stat-box .l { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
`;

// 注意：字符串中的 <\/script> 转义是为了防止闭合外层 HTML 脚本块
const PAGE_SCRIPT = `
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { bases: [], selectedId: null, items: [], status: null };
  let toastTimer = null;

  function notify(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function notifyParent() {
    window.parent && window.parent.postMessage({ type: "ready" }, "*");
    requestAnimationFrame(() => {
      const height = document.body.scrollHeight;
      window.parent && window.parent.postMessage({ type: "resize-request", payload: { height } }, "*");
    });
  }

  // 相对路径 + 继承当前 query（pluginSurfaceSession / hana-theme 等）
  function apiUrl(path) {
    const url = new URL(path, window.location.href);
    const current = new URL(window.location.href);
    current.searchParams.forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    });
    return url.toString();
  }

  async function apiGet(path) {
    const response = await fetch(apiUrl(path), { credentials: "same-origin" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "HTTP " + response.status);
    return body;
  }

  async function apiPost(path, payload) {
    const form = payload instanceof FormData;
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "same-origin",
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ? payload : JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "HTTP " + response.status);
    return body;
  }

  const STATUS = { idle: "待处理", preparing: "展开中", processing: "排队中", reading: "读取中", embedding: "嵌入中", completed: "完成", failed: "失败", deleting: "删除中" };
  const STATUS_CLASS = { idle: "muted", preparing: "busy", processing: "busy", reading: "busy", embedding: "busy", completed: "ok", failed: "err", deleting: "busy" };
  const TYPE_ICON = { file: "📄", directory: "📁", url: "🔗", note: "📝" };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
  }

  async function refresh() {
    try {
      const [basesBody, statusBody] = await Promise.all([apiGet("api/bases"), apiGet("api/status")]);
      state.bases = basesBody.bases || [];
      state.status = statusBody;
      if (!state.selectedId || !state.bases.some((b) => b.id === state.selectedId)) {
        state.selectedId = state.bases[0] ? state.bases[0].id : null;
      }
      renderBases();
      renderServiceBadge();
      if (state.selectedId) await refreshItems();
      renderDetail();
    } catch (err) {
      notify("加载失败：" + err.message);
    }
  }

  function renderServiceBadge() {
    const s = state.status || {};
    const parts = [];
    if (s.embeddingConfigured) parts.push("嵌入: " + s.embeddingModel);
    else parts.push("嵌入: 未配置");
    if (s.rerankConfigured) parts.push("重排: " + s.rerankModel);
    if (s.mineruConfigured) parts.push("MinerU: " + s.mineruModel + (s.mineruApiKey ? " 🔑" : ""));
    $("serviceBadge").textContent = parts.join(" · ");
  }

  function renderBases() {
    const list = $("baseList");
    if (!state.bases.length) {
      list.innerHTML = '<div class="empty">还没有知识库</div>';
      return;
    }
    list.innerHTML = state.bases.map((base) => {
      const mode = base.embeddingModelId ? "混合检索" : "BM25";
      const rerank = base.rerankModelId ? " + 重排" : "";
      const meta = base.status === "failed" ? "⚠ 不可用" : base.itemCount + " 项材料";
      return '<button class="list-item ' + (base.id === state.selectedId ? "selected" : "") + '" data-id="' + escapeHtml(base.id) + '">' +
        '<div class="name">' + escapeHtml(base.name) + '</div>' +
        '<div class="meta">' + escapeHtml(meta + " · " + mode + rerank) + '</div>' +
        '</button>';
    }).join("");
    list.querySelectorAll(".list-item").forEach((el) => {
      el.addEventListener("click", () => { state.selectedId = el.dataset.id; renderBases(); refreshItems().then(renderDetail); });
    });
  }

  async function refreshItems() {
    if (!state.selectedId) return;
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/items");
      state.items = body.items || [];
    } catch (err) {
      state.items = [];
    }
  }

  function renderDetail() {
    const detail = $("detail");
    const empty = $("empty");
    const base = state.bases.find((b) => b.id === state.selectedId);
    if (!base) {
      detail.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    detail.hidden = false;
    const mode = base.embeddingModelId ? "混合检索（" + base.embeddingModelId + "）" : "BM25 全文检索";
    const rerank = base.rerankModelId ? '<span class="badge ok">重排: ' + escapeHtml(base.rerankModelId) + '</span>' : "";
    detail.innerHTML =
      '<div class="card glass">' +
        '<div class="detail-head">' +
          '<div><h2>' + escapeHtml(base.name) + '</h2>' +
          '<div class="muted">' + (base.status === "failed" ? "⚠ " + escapeHtml(base.error || "不可用") : base.itemCount + " 项材料 · 已完成 " + base.completedCount) + '</div>' +
          '<div class="muted" style="margin-top:4px">' + escapeHtml(mode) + ' ' + rerank + '</div></div>' +
          '<div class="row">' +
            '<button class="btn" id="renameBtn">重命名</button>' +
            '<button class="btn" id="reindexAllBtn">重建全部</button>' +
            (base.embeddingModelId ? "" : '<button class="btn" id="enableEmbeddingBtn">启用向量</button>') +
            (base.rerankModelId ? '<button class="btn" id="disableRerankBtn">关闭重排</button>' : '<button class="btn" id="enableRerankBtn">启用重排</button>') +
            '<button class="btn danger" id="deleteBaseBtn">删除</button>' +
          '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn primary" id="uploadBtn">⬆ 上传文件</button>' +
          '<input type="file" id="fileInput" multiple hidden>' +
          '<label class="check"><input type="checkbox" id="dirMode">按文件夹导入</label>' +
          '<button class="btn" id="addUrlBtn">🔗 添加 URL</button>' +
          '<button class="btn" id="addNoteBtn">📝 添加笔记</button>' +
          '<button class="btn" id="buildTreeBtn" title="把已完成材料编译为神经树">🌳 一键建树</button>' +
          '<button class="btn" id="verifyTreeBtn" title="运行验证器 V1-V17">✅ 验证神经树</button>' +
          '<button class="btn" id="wikiIngestBtn" title="把已完成材料摄入 Wiki">🧠 Wiki 摄入</button>' +
        '</div>' +
      '</div>' +
      '<div class="card glass">' +
        '<h3>命中测试</h3>' +
        '<div class="row"><input class="input grow" id="searchInput" placeholder="输入检索词…（命中判定/综合自动标注）" style="margin:0"><button class="btn primary" id="searchBtn">检索</button></div>' +
        '<div id="results" style="margin-top:10px"></div>' +
      '</div>' +
      '<div class="tabs" id="tabs">' +
        '<button class="tab active" data-tab="materials">材料</button>' +
        '<button class="tab" data-tab="tree">🌳 神经树</button>' +
        '<button class="tab" data-tab="wiki">🧠 Wiki</button>' +
        '<button class="tab" data-tab="graph">🕸 图谱</button>' +
      '</div>' +
      '<div class="tab-panel active" id="panel-materials"><div id="itemList"></div></div>' +
      '<div class="tab-panel" id="panel-tree">' +
        '<div class="stat-grid" id="treeStats"></div>' +
        '<div class="graph-toolbar">' +
          '<input class="input" id="graphFilter" placeholder="筛选节点（触发词/标题）…" style="width:220px;margin:0">' +
          '<button class="btn tiny" id="graphFitBtn">适配视图</button>' +
        '</div>' +
        '<div class="graph-wrap"><canvas id="graphCanvas"></canvas></div>' +
        '<div id="nodeDetail" style="margin-top:12px"></div>' +
      '</div>' +
      '<div class="tab-panel" id="panel-wiki"><div id="wikiList"></div></div>' +
      '<div class="tab-panel" id="panel-graph"><div id="graphList"></div></div>';

    const baseId = base.id;
    $("createBaseBtn").disabled = true;
    $("tabs").querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $("tabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $("panel-materials").classList.toggle("active", tab.dataset.tab === "materials");
        $("panel-tree").classList.toggle("active", tab.dataset.tab === "tree");
        $("panel-wiki").classList.toggle("active", tab.dataset.tab === "wiki");
        $("panel-graph").classList.toggle("active", tab.dataset.tab === "graph");
        if (tab.dataset.tab === "tree") loadGraph();
        if (tab.dataset.tab === "wiki") loadWiki();
        if (tab.dataset.tab === "graph") loadGraphList();
      });
    });
    if ($("buildTreeBtn")) $("buildTreeBtn").addEventListener("click", () => showBuildTreeWizard());
    if ($("verifyTreeBtn")) $("verifyTreeBtn").addEventListener("click", runVerifyTree);
    if ($("wikiIngestBtn")) $("wikiIngestBtn").addEventListener("click", runWikiIngest);
    $("renameBtn").addEventListener("click", async () => {
      const name = prompt("新名称", base.name);
      if (name) { try { await apiPost("api/bases/" + baseId + "/rename", { name }); notify("已重命名"); await refresh(); } catch (e) { notify(e.message); } }
    });
    $("reindexAllBtn").addEventListener("click", async () => {
      if (!confirm("重建全部材料的索引？")) return;
      try { await apiPost("api/bases/" + baseId + "/reindex", {}); notify("已开始重建全部索引"); } catch (e) { notify(e.message); }
    });
    if ($("enableEmbeddingBtn")) $("enableEmbeddingBtn").addEventListener("click", async () => {
      try { await apiPost("api/bases/" + baseId + "/enable-embedding", {}); notify("已启用向量检索，正在重建索引"); await refresh(); } catch (e) { notify(e.message); }
    });
    if ($("enableRerankBtn")) $("enableRerankBtn").addEventListener("click", async () => {
      try { await apiPost("api/bases/" + baseId + "/enable-rerank", {}); notify("已启用重排序"); await refresh(); } catch (e) { notify(e.message); }
    });
    if ($("disableRerankBtn")) $("disableRerankBtn").addEventListener("click", async () => {
      try { await apiPost("api/bases/" + baseId + "/disable-rerank", {}); notify("已关闭重排序"); await refresh(); } catch (e) { notify(e.message); }
    });
    $("deleteBaseBtn").addEventListener("click", async () => {
      if (!confirm("确认永久删除知识库「" + base.name + "」及其全部材料？")) return;
      try { await apiPost("api/bases/" + baseId + "/delete", {}); state.selectedId = null; notify("知识库已删除"); await refresh(); } catch (e) { notify(e.message); }
    });
    $("uploadBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", async () => {
      const files = $("fileInput").files;
      if (!files.length) return;
      const form = new FormData();
      form.append("mode", $("dirMode").checked ? "directory" : "flat");
      for (const file of Array.from(files)) form.append("files", file);
      try {
        const body = await apiPost("api/bases/" + baseId + "/upload", form);
        notify("已接受 " + body.accepted + " 个文件，正在后台索引");
      } catch (e) { notify(e.message); }
      $("fileInput").value = "";
    });
    $("addUrlBtn").addEventListener("click", async () => {
      const url = prompt("网页地址（https://…）");
      if (!url) return;
      try { await apiPost("api/bases/" + baseId + "/url", { url }); notify("已添加 URL，正在后台抓取快照"); } catch (e) { notify(e.message); }
    });
    $("addNoteBtn").addEventListener("click", async () => {
      const content = prompt("笔记内容");
      if (!content) return;
      try { await apiPost("api/bases/" + baseId + "/note", { content }); notify("已添加笔记，正在后台索引"); } catch (e) { notify(e.message); }
    });
    $("searchBtn").addEventListener("click", runSearch);
    $("searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });

    renderItems();
  }

  async function runSearch() {
    const base = state.bases.find((b) => b.id === state.selectedId);
    if (!base) return;
    const query = $("searchInput").value.trim();
    if (!query) return;
    try {
      const body = await apiGet("api/bases/" + base.id + "/search?q=" + encodeURIComponent(query));
      const results = body.results || [];
      const box = $("results");
      if (!results.length) { box.innerHTML = '<div class="empty">没有相关结果。</div>'; return; }
      box.innerHTML = results.map((r) =>
        '<div class="result"><div class="head"><span class="rank">#' + r.rank + '</span>' +
        '<strong>' + escapeHtml(r.itemName || r.itemId) + '</strong>' +
        '<span class="muted">' + r.scoreKind + " " + Number(r.score).toFixed(4) + '</span></div>' +
        '<div class="text">' + escapeHtml(clip(r.pageContent, 200)) + '</div></div>'
      ).join("");
    } catch (err) {
      notify("检索失败：" + err.message);
    }
  }

  function renderItems() {
    const list = $("itemList");
    if (!list) return;
    if (!state.items.length) { list.innerHTML = '<div class="empty">还没有材料。上传文件或添加 URL / 笔记。</div>'; return; }
    list.innerHTML = state.items.map((item) =>
      '<div class="item' + (item.parentId ? " child" : "") + '">' +
        '<span>' + (TYPE_ICON[item.type] || "📄") + '</span>' +
        '<div class="info"><div class="name">' + escapeHtml(item.name) + '</div>' +
        (item.error ? '<div class="err">⚠ ' + escapeHtml(item.error) + '</div>' : "") +
        '</div>' +
        '<span class="badge ' + (STATUS_CLASS[item.status] || "muted") + '">' + (STATUS[item.status] || item.status) + '</span>' +
        '<div class="row">' + itemActions(item) + '</div>' +
      '</div>'
    ).join("");
    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => runItemAction(btn.dataset.action, btn.dataset.item));
    });
  }

  function itemActions(item) {
    const baseId = state.selectedId;
    const actions = [];
    if (item.status === "completed") {
      actions.push('<button class="btn tiny" data-action="view" data-item="' + item.id + '">查看</button>');
      actions.push('<button class="btn tiny" data-action="reindex" data-item="' + item.id + '">重建</button>');
    }
    if (item.status === "failed") {
      actions.push('<button class="btn tiny" data-action="retry" data-item="' + item.id + '">重试</button>');
    }
    if (item.type === "url" && item.status === "completed") {
      actions.push('<button class="btn tiny" data-action="refresh" data-item="' + item.id + '">刷新</button>');
    }
    actions.push('<button class="btn tiny danger" data-action="delete" data-item="' + item.id + '">删除</button>');
    return actions.join("");
  }

  async function runItemAction(action, itemId) {
    const baseId = state.selectedId;
    try {
      if (action === "view") {
        const body = await apiGet("api/bases/" + baseId + "/item/" + itemId);
        showModal("材料全文", body.text);
        return;
      }
      if (action === "delete") {
        if (!confirm("删除该材料？")) return;
        await apiPost("api/bases/" + baseId + "/delete-items", { itemIds: [itemId] });
        notify("已开始删除");
      } else if (action === "retry") {
        await apiPost("api/bases/" + baseId + "/retry/" + itemId, {});
        notify("已开始重试");
      } else if (action === "reindex") {
        await apiPost("api/bases/" + baseId + "/reindex", { itemIds: [itemId] });
        notify("已开始重建索引");
      } else if (action === "refresh") {
        await apiPost("api/bases/" + baseId + "/refresh-url/" + itemId, {});
        notify("已开始刷新快照");
      }
    } catch (err) {
      notify(err.message);
    }
  }

  function showModal(title, text) {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = '<div class="modal"><div class="row between"><h3>' + escapeHtml(title) + '</h3><button class="btn" id="closeModal">✕</button></div><pre>' + escapeHtml(text) + '</pre></div>';
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    overlay.querySelector("#closeModal").addEventListener("click", () => overlay.remove());
  }

  function clip(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  $("createBaseBtn").addEventListener("click", async () => {
    const name = $("newBaseName").value.trim();
    if (!name) return;
    try {
      await apiPost("api/bases", { name, enableVector: $("newBaseVector").checked });
      $("newBaseName").value = "";
      $("newBaseVector").checked = false;
      notify("知识库已创建");
      await refresh();
    } catch (err) { notify(err.message); }
  });
  $("newBaseName").addEventListener("input", () => { $("createBaseBtn").disabled = !$("newBaseName").value.trim(); });

  // ============ 神经树可视化（力导向图） ============
  let graphState = { nodes: [], edges: [], layout: new Map(), selected: null, running: false, filter: "" };

  async function loadGraph() {
    if (!state.selectedId) return;
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/graph");
      const neurons = (body.graph.nodes || []).filter((n) => n.type === "neuron");
      renderTreeStats(body.graph);
      if (neurons.length === 0) {
        $("graphCanvas").getContext("2d").clearRect(0, 0, $("graphCanvas").width, $("graphCanvas").height);
        $("nodeDetail").innerHTML = '<div class="empty">还没有神经树。点击「一键建树」从材料生成。</div>';
        return;
      }
      graphState.nodes = neurons;
      graphState.edges = (body.graph.edges || []).filter((e) => e.kind === "synapse");
      initForceLayout();
      animateGraph();
    } catch (err) { notify("图谱加载失败：" + err.message); }
  }

  function renderTreeStats(g) {
    const nodes = g.nodes || [];
    const byMaturity = (m) => nodes.filter((n) => n.maturity === m).length;
    $("treeStats").innerHTML =
      '<div class="stat-box"><div class="n">' + nodes.length + '</div><div class="l">节点</div></div>' +
      '<div class="stat-box"><div class="n" style="color:var(--codified)">' + byMaturity("codified") + '</div><div class="l">已编译</div></div>' +
      '<div class="stat-box"><div class="n" style="color:var(--emerging)">' + byMaturity("emerging") + '</div><div class="l">共识</div></div>' +
      '<div class="stat-box"><div class="n" style="color:var(--fuzzy)">' + byMaturity("fuzzy") + '</div><div class="l">探索</div></div>' +
      '<div class="stat-box"><div class="n">' + (g.edges || []).length + '</div><div class="l">突触</div></div>' +
      '<div class="stat-box"><div class="n">' + (g.triggerCount || 0) + '</div><div class="l">触发词</div></div>';
  }

  function initForceLayout() {
    const w = $("graphCanvas").width || 800;
    const h = $("graphCanvas").height || 520;
    const count = graphState.nodes.length;
    const cx = w / 2, cy = h / 2;
    graphState.layout = new Map();
    graphState.nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const radius = Math.min(w, h) * 0.36;
      graphState.layout.set(n.id, { x: cx + Math.cos(angle) * radius * (0.7 + Math.random() * 0.3), y: cy + Math.sin(angle) * radius * (0.7 + Math.random() * 0.3), vx: 0, vy: 0 });
    });
  }

  function animateGraph() {
    const canvas = $("graphCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const filter = graphState.filter.toLowerCase();
    const visibleIds = new Set(filter
      ? graphState.nodes.filter((n) => (n.title || "").toLowerCase().includes(filter) || (n.elements?.triggers || []).some((t) => String(t).toLowerCase().includes(filter))).map((n) => n.id)
      : graphState.nodes.map((n) => n.id));
    const visibleNodes = graphState.nodes.filter((n) => visibleIds.has(n.id));

    // 力导向迭代
    const pos = graphState.layout;
    const edgeMap = new Map();
    graphState.edges.forEach((e) => { if (!edgeMap.has(e.source)) edgeMap.set(e.source, []); edgeMap.get(e.source).push(e.target); });

    for (let iter = 0; iter < 40; iter++) {
      // 斥力
      const arr = [...pos.entries()];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const [ida, a] = arr[i], [idb, b] = arr[j];
          if (!visibleIds.has(ida) || !visibleIds.has(idb)) continue;
          let dx = a.x - b.x, dy = a.y - b.y;
          const dist2 = Math.max(1, dx * dx + dy * dy);
          const force = 2600 / dist2;
          const dist = Math.sqrt(dist2);
          dx /= dist; dy /= dist;
          a.vx += dx * force; a.vy += dy * force;
          b.vx -= dx * force; b.vy -= dy * force;
        }
      }
      // 引力（边）
      graphState.edges.forEach((e) => {
        const a = pos.get(e.source), b = pos.get(e.target);
        if (!a || !b || !visibleIds.has(e.source) || !visibleIds.has(e.target)) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = dist * 0.012;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      });
      // 速度阻尼 + 位置更新 + 边界
      pos.forEach((p) => {
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += p.vx; p.y += p.vy;
        if (p.x < 30) p.x = 30; if (p.x > w - 30) p.x = w - 30;
        if (p.y < 30) p.y = 30; if (p.y > h - 30) p.y = h - 30;
      });
    }

    ctx.clearRect(0, 0, w, h);
    // 边
    ctx.strokeStyle = "rgba(255,255,255,.15)";
    ctx.lineWidth = 1;
    graphState.edges.forEach((e) => {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    // 节点
    const COLOR = { fuzzy: "#6fb3d9", emerging: "#e0a94f", codified: "#5cb87a" };
    visibleNodes.forEach((n) => {
      const p = pos.get(n.id);
      if (!p) return;
      const isSel = graphState.selected && graphState.selected.id === n.id;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isSel ? 12 : 9, 0, Math.PI * 2);
      ctx.fillStyle = COLOR[n.maturity] || "#888";
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isSel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(clip(n.title, 12), p.x, p.y - 14);
    });

    // 点击拾取
    const onCanvasClick = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (evt.clientX - rect.left) * (w / rect.width);
      const my = (evt.clientY - rect.top) * (h / rect.height);
      let hit = null;
      for (const n of visibleNodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        if (Math.hypot(p.x - mx, p.y - my) <= 14) { hit = n; break; }
      }
      graphState.selected = hit;
      renderNodeDetail(hit);
      animateGraph();
    };
    canvas.onclick = onCanvasClick;
  }

  function renderNodeDetail(node) {
    const box = $("nodeDetail");
    if (!node) { box.innerHTML = ""; return; }
    const e = node.elements || {};
    const label = { fuzzy: "探索", emerging: "共识", codified: "已编译" }[node.maturity] || node.maturity;
    box.innerHTML =
      '<div class="node-card">' +
        '<div class="row between"><div class="n-title">' + escapeHtml(node.title) + '</div>' +
        '<span class="badge ' + node.maturity + '">' + label + '</span></div>' +
        '<div class="n-meta">' + (node.type || "") + ' · 触发词 ' + (e.triggers || []).length + ' · 命中 ' + (node.stats?.hitCount || 0) + ' · 反馈 ' + (node.stats?.negativeFeedback || 0) + '</div>' +
        (e.definition ? '<div class="n-def">' + escapeHtml(clip(e.definition, 160)) + '</div>' : "") +
        (e.source ? '<div class="n-meta" style="margin-top:4px">出处: ' + escapeHtml(e.source) + '</div>' : "") +
        '<div class="row" style="margin-top:8px">' +
          '<button class="btn tiny" data-nact="promote">提升 codified</button>' +
          '<button class="btn tiny" data-nact="demote">降级 fuzzy</button>' +
          '<button class="btn tiny" data-nact="triggers">触发词</button>' +
        '</div>' +
      '</div>';
    box.querySelectorAll("button[data-nact]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          if (btn.dataset.nact === "promote") {
            await apiPost("api/bases/" + state.selectedId + "/graph/nodes/" + node.id + "/promote", {});
            notify("已提升");
          } else if (btn.dataset.nact === "demote") {
            if (!confirm("降级为 fuzzy（探索态）？")) return;
            await apiPost("api/bases/" + state.selectedId + "/graph/nodes/" + node.id + "/demote", { reason: "UI 降级" });
            notify("已降级");
          } else {
            showModal("触发词", (e.triggers || []).join("｜") || "无");
            return;
          }
          await loadGraph();
        } catch (err) { notify(err.message); }
      });
    });
  }

  // ============ Wiki 视图 ============
  async function loadWiki() {
    if (!state.selectedId) return;
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/graph");
      const pages = (body.graph.nodes || []).filter((n) => ["wiki-page", "concept", "entity"].includes(n.type));
      const list = $("wikiList");
      if (pages.length === 0) {
        list.innerHTML = '<div class="empty">还没有 Wiki 页面。点击「🧠 Wiki 摄入」把材料摄入。</div>';
        return;
      }
      const label = { "wiki-page": "📄", concept: "💡", entity: "🏷" };
      const typeName = { "wiki-page": "source", concept: "concept", entity: "entity" };
      list.innerHTML = '<div class="wiki-grid">' + pages.map((n) => {
        const tags = (n.elements?.tags || []).map((t) => '<span class="tag">' + escapeHtml(t) + '</span>').join("");
        const refs = '<span class="tag">' + (n.sourceRefs?.length || 0) + ' 来源</span>';
        const isSparse = (n.elements?.definition || "").length < 20;
        return '<div class="wiki-card">' +
          '<div class="w-title">' + label[n.type] + ' ' + escapeHtml(n.title) + '</div>' +
          '<div class="w-meta faint">' + typeName[n.type] + ' · ' + escapeHtml(clip(n.elements?.definition || "无摘要", 120)) + '</div>' +
          '<div class="w-tags">' + tags + refs + (isSparse ? '<span class="flag">稀疏</span>' : "") + '</div>' +
        '</div>';
      }).join("") + '</div>';
    } catch (err) { notify("Wiki 加载失败：" + err.message); }
  }

  // ============ 图谱列表 ============
  async function loadGraphList() {
    if (!state.selectedId) return;
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/graph");
      const nodes = body.graph.nodes || [];
      const list = $("graphList");
      if (nodes.length === 0) {
        list.innerHTML = '<div class="empty">图谱为空。可通过「🌳 一键建树」或「🧠 Wiki 摄入」添加节点。</div>';
        return;
      }
      list.innerHTML = nodes.map((n) => {
        const label = { fuzzy: "探索", emerging: "共识", codified: "已编译" }[n.maturity] || n.maturity;
        return '<div class="node-card">' +
          '<div class="row between"><div class="n-title">' + escapeHtml(n.title) + '</div>' +
          '<span class="badge ' + n.maturity + '">' + label + '</span></div>' +
          '<div class="n-meta">' + n.type + ' · 出边 ' + (n.outbound || []).length + ' · 入边 ' + (n.inbound || []).length + '</div>' +
          '<div class="n-def">' + escapeHtml(clip(n.elements?.definition || "无定义", 140)) + '</div>' +
        '</div>';
      }).join("");
    } catch (err) { notify("图谱加载失败：" + err.message); }
  }

  // ============ 一键建树向导 ============
  function showBuildTreeWizard() {
    const completed = state.items.filter((i) => i.status === "completed" && i.type !== "directory");
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    const opts = completed.length
      ? completed.map((i) => '<option value="' + i.id + '">' + escapeHtml(i.name) + '（' + i.type + '）</option>').join("")
      : '<option value="">（无已完成材料，可手动粘贴文本）</option>';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="row between"><h3>🌳 一键建树（一本书 → 一棵树）</h3><button class="btn" id="wzClose">✕</button></div>' +
        '<div class="wizard-step"><h4>1. 选择来源</h4>' +
          '<select id="wzItem" class="input">' + opts + '</select>' +
          '<div class="faint">或直接粘贴材料全文：</div>' +
          '<textarea id="wzText" class="input" placeholder="材料全文（Markdown 优先，需含章节标题）"></textarea>' +
        '</div>' +
        '<div class="wizard-step"><h4>2. 命名</h4>' +
          '<input id="wzDomain" class="input" placeholder="领域名 / 书名，如 《民法典》">' +
          '<input id="wzMax" class="input" type="number" min="1" max="20" value="8" placeholder="每主干神经元数上限（默认 8）">' +
        '</div>' +
        '<div class="row"><button class="btn primary" id="wzBuild">开始建树</button></div>' +
        '<div id="wzResult"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector("#wzClose").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    const itemSelect = overlay.querySelector("#wzItem");
    const textArea = overlay.querySelector("#wzText");
    itemSelect.addEventListener("change", async () => {
      if (!itemSelect.value) return;
      try {
        const body = await apiGet("api/bases/" + state.selectedId + "/item/" + itemSelect.value);
        textArea.value = body.text || "";
        const nameInput = overlay.querySelector("#wzDomain");
        if (!nameInput.value) nameInput.value = body.item?.name || "";
      } catch (err) { notify(err.message); }
    });

    overlay.querySelector("#wzBuild").addEventListener("click", async () => {
      const text = textArea.value.trim();
      const domain = overlay.querySelector("#wzDomain").value.trim();
      if (!text || !domain) { notify("请提供材料全文与领域名"); return; }
      try {
        const body = await apiPost("api/bases/" + state.selectedId + "/build-tree", {
          domain,
          text,
          maxNeuronsPerBranch: Number(overlay.querySelector("#wzMax").value) || 8,
        });
        const box = overlay.querySelector("#wzResult");
        box.innerHTML = '<div class="wizard-step"><h4>✅ 构建完成：' + body.nodeCount + ' 神经元 / ' + body.edgeCount + ' 突触</h4>' +
          '<div class="faint">文件：' + escapeHtml(body.fileName) + '</div>' +
          '<pre style="max-height:200px;overflow:auto;font-size:11px;line-height:1.6">' + escapeHtml(clip(body.treeMarkdown, 3000)) + '</pre></div>';
        notify("神经树已构建");
        await loadGraph();
      } catch (err) { notify("建树失败：" + err.message); }
    });
  }

  // ============ 验证 / Wiki 摄入 ============
  async function runVerifyTree() {
    if (!state.selectedId) return;
    try {
      const body = await apiPost("api/bases/" + state.selectedId + "/verify-tree", {});
      const r = body.report || {};
      showModal("神经树验证 V1-V17", [
        "健康度：" + r.healthScore + "/100（" + r.healthLevel + "）",
        "通过 " + r.passedCount + " 项 / 失败 " + r.failedCount + " 项",
        "",
        ...(r.checks || []).map((c) => (c.passed ? "✅" : "❌") + " " + c.id + " " + c.name + "：" + c.detail),
      ].join("\\n"));
    } catch (err) { notify("验证失败：" + err.message); }
  }

  async function runWikiIngest() {
    if (!state.selectedId) return;
    const completed = state.items.filter((i) => i.status === "completed" && i.type !== "directory");
    if (completed.length === 0) { notify("没有可摄入的已完成材料"); return; }
    const name = prompt("要摄入哪个材料？（输入名称关键字，留空 = 第一个）");
    const item = name
      ? completed.find((i) => i.name.includes(name)) || completed[0]
      : completed[0];
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/item/" + item.id);
      const result = await apiPost("api/bases/" + state.selectedId + "/wiki-ingest", {
        text: body.text || "",
        itemId: item.id,
        itemName: item.name,
      });
      notify("已摄入「" + item.name + "」（" + (result.usedLlm ? "LLM 增强" : "确定性") + "）· " + result.conceptNodes.length + " 概念 · " + result.contradictions.length + " 矛盾");
    } catch (err) { notify("Wiki 摄入失败：" + err.message); }
  }

  notifyParent();
  refresh();
  setInterval(() => { refreshItems().then(renderDetail); }, 3000);
})();
`;

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function baseName(name: string): string {
  return String(name).split(/[\\/]/).pop() || "file";
}

function firstPathSegment(name: string): string {
  const segments = String(name).split("/").filter(Boolean);
  return segments.length > 1 ? segments[0] : "";
}