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
    return {
      embeddingConfigured: Boolean(embedding),
      embeddingModel: embedding ? embedding.model : "",
      rerankConfigured: Boolean(rerank),
      rerankModel: rerank ? rerank.model : "",
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

  // ---- 简单 Wiki ----
  app.get("/api/bases/:id/wiki", handler(async (bundle, c) => {
    const pages = await bundle.service.wikiList(c.req.param("id"));
    return { pages };
  }));

  app.get("/api/bases/:id/wiki/:slug", handler(async (bundle, c) => {
    const text = await bundle.service.wikiRead(c.req.param("id"), c.req.param("slug"));
    if (text === null) throw new Error("Wiki 页不存在");
    return { text };
  }));

  app.post("/api/bases/:id/wiki-ingest", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("缺少 text（材料内容）");
    const result = await bundle.service.wikiIngest({
      baseId: c.req.param("id"),
      itemId: typeof body.itemId === "string" ? body.itemId : "manual",
      itemName: typeof body.itemName === "string" && body.itemName ? body.itemName : "未命名材料",
      text: body.text,
    });
    return { result };
  }));

  // UI 兼容：POST /api/bases/:id/delete 与 /rename（管理界面用 apiPost 调用）
  app.post("/api/bases/:id/delete", handler(async (bundle, c) => {
    await bundle.service.deleteBase(c.req.param("id"));
    return { ok: true };
  }));

  app.post("/api/bases/:id/rename", handler(async (bundle, c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string") throw new Error("缺少 name 字段");
    return { base: await bundle.service.renameBase(c.req.param("id"), body.name) };
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
    <h1>知识库</h1>
    <span id="serviceBadge" class="badge muted">…</span>
  </header>
  <div id="toast" class="toast" hidden></div>
  <div class="layout">
    <aside class="side">
      <section class="card">
        <h2>新建知识库</h2>
        <input id="newBaseName" class="input" placeholder="知识库名称">
        <label class="check"><input id="newBaseVector" type="checkbox"> 启用向量检索（需已配置嵌入模型）</label>
        <button id="createBaseBtn" class="btn primary" disabled>创建</button>
      </section>
      <section class="card">
        <h2>知识库列表</h2>
        <div id="baseList" class="list"></div>
      </section>
    </aside>
    <main class="main">
      <section id="empty" class="card empty">选择一个知识库，或创建一个。</section>
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
  --bg: #f5f7fb;
  --panel: #ffffff;
  --border: #e5e9f2;
  --text: #1f2937;
  --text-dim: #6b7280;
  --accent: #4f8ef7;
  --accent-soft: #eef4ff;
  --ok: #10b981;
  --busy: #f59e0b;
  --err: #ef4444;
  --radius: 12px;
  --shadow: 0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04);
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--bg); }
.app { display: flex; flex-direction: column; min-height: 100vh; }
.top { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
.top h1 { font-size: 16px; margin: 0; font-weight: 600; }
.layout { display: flex; gap: 16px; padding: 16px; flex: 1; max-width: 1280px; margin: 0 auto; width: 100%; }
.side { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; }
.main { flex: 1; min-width: 0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; box-shadow: var(--shadow); }
.card h2 { margin: 0 0 12px; font-size: 13px; color: var(--text-dim); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
.card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.input { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: #f9fafb; font-size: 13px; margin-bottom: 8px; color: var(--text); }
.input:focus { outline: none; border-color: var(--accent); background: #fff; }
textarea.input { resize: vertical; font-family: inherit; }
.btn { padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: var(--text); transition: all .15s; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
.btn.primary:hover { background: #3d7ee8; color: #fff; }
.btn.danger { color: var(--err); }
.btn.danger:hover { border-color: var(--err); color: var(--err); }
.btn.tiny { padding: 3px 10px; font-size: 12px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); margin: 6px 0; }
.row { display: flex; align-items: center; gap: 8px; }
.row.between { justify-content: space-between; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; }
.muted { color: var(--text-dim); font-size: 12px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.list-item { text-align: left; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: #fff; cursor: pointer; transition: all .15s; }
.list-item:hover { border-color: var(--accent); }
.list-item.selected { border-color: var(--accent); background: var(--accent-soft); }
.list-item .name { font-weight: 600; font-size: 13px; }
.list-item .meta { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.badge { padding: 2px 9px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--text-dim); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: var(--ok); background: rgba(16,185,129,.08); }
.badge.err { color: var(--err); border-color: var(--err); background: rgba(239,68,68,.08); }
.badge.busy { color: var(--busy); border-color: var(--busy); background: rgba(245,158,11,.08); }
.badge.muted { color: var(--text-dim); }
.empty { color: var(--text-dim); font-size: 13px; padding: 32px 0; text-align: center; }
.item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 6px; background: #fff; transition: box-shadow .15s; }
.item:hover { box-shadow: var(--shadow); }
.item.child { margin-left: 26px; }
.item .info { flex: 1; min-width: 0; }
.item .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .err { font-size: 11px; color: var(--err); }
.result { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 8px; background: #fff; }
.result .head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.result .rank { color: var(--accent); font-weight: 700; }
.result .text { margin-top: 6px; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.toast { position: fixed; top: 16px; right: 16px; background: #1f2937; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 13px; z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,.2); }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.kv { font-size: 12px; color: var(--text-dim); }
.kv b { color: var(--text); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 40; }
.modal { background: #fff; border-radius: 14px; padding: 18px; width: min(720px, 92vw); max-height: 82vh; display: flex; flex-direction: column; box-shadow: 0 16px 48px rgba(0,0,0,.2); }
.modal pre { flex: 1; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap; font-family: inherit; margin: 8px 0 0; color: var(--text-dim); }
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
      '<div class="card">' +
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
          '<button class="btn" id="uploadBtn">上传文件</button>' +
          '<input type="file" id="fileInput" multiple hidden>' +
          '<label class="check"><input type="checkbox" id="dirMode">按文件夹导入</label>' +
          '<button class="btn" id="addUrlBtn">添加 URL</button>' +
          '<button class="btn" id="addNoteBtn">添加笔记</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>命中测试</h3>' +
        '<div class="row"><input class="input grow" id="searchInput" placeholder="输入检索词…" style="margin:0"><button class="btn primary" id="searchBtn">检索</button></div>' +
        '<div id="results" style="margin-top:10px"></div>' +
      '</div>' +
      '<div class="card"><h3>材料</h3><div id="itemList"></div></div>' +
      '<div class="card"><h3>🧠 Wiki 摘要</h3><div id="wikiList"></div></div>';

    const baseId = base.id;
    $("renameBtn").addEventListener("click", async () => {
      const name = await promptDialog("新名称", base.name);
      if (name) { try { await apiPost("api/bases/" + baseId + "/rename", { name }); notify("已重命名"); await refresh(); } catch (e) { notify(e.message); } }
    });
    $("reindexAllBtn").addEventListener("click", async () => {
      if (!(await confirmDialog("重建全部材料的索引？"))) return;
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
      if (!(await confirmDialog("确认永久删除知识库「" + base.name + "」及其全部材料？"))) return;
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
      const url = await promptDialog("网页地址（https://…）");
      if (!url) return;
      try { await apiPost("api/bases/" + baseId + "/url", { url }); notify("已添加 URL，正在后台抓取快照"); } catch (e) { notify(e.message); }
    });
    $("addNoteBtn").addEventListener("click", async () => {
      const content = await promptDialog("笔记内容");
      if (!content) return;
      try { await apiPost("api/bases/" + baseId + "/note", { content }); notify("已添加笔记，正在后台索引"); } catch (e) { notify(e.message); }
    });
    $("searchBtn").addEventListener("click", runSearch);
    $("searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });

    renderItems();
    renderWiki();
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

  async function renderWiki() {
    const list = $("wikiList");
    if (!list) return;
    try {
      const body = await apiGet("api/bases/" + state.selectedId + "/wiki");
      const pages = body.pages || [];
      if (!pages.length) { list.innerHTML = '<div class="empty">还没有 Wiki 页。材料索引完成后可用 knowledge_wiki_ingest 生成。</div>'; return; }
      list.innerHTML = pages.map((p) =>
        '<div class="item"><span>📄</span><div class="info"><div class="name">' + escapeHtml(p.title) + '</div></div>' +
        '<button class="btn tiny" data-wiki="' + escapeHtml(p.slug) + '">查看</button></div>'
      ).join("");
      list.querySelectorAll("button[data-wiki]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const r = await apiGet("api/bases/" + state.selectedId + "/wiki/" + btn.dataset.wiki);
            showModal(btn.dataset.wiki, r.text || "无内容");
          } catch (e) { notify(e.message); }
        });
      });
    } catch { list.innerHTML = '<div class="empty">Wiki 加载失败</div>'; }
  }

  function itemActions(item) {
    const baseId = state.selectedId;
    const actions = [];
    if (item.status === "completed") {
      actions.push('<button class="btn tiny" data-action="view" data-item="' + item.id + '">查看</button>');
      actions.push('<button class="btn tiny" data-action="reindex" data-item="' + item.id + '">重建</button>');
      actions.push('<button class="btn tiny" data-action="wiki" data-item="' + item.id + '">生成 Wiki</button>');
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
        if (!(await confirmDialog("删除该材料？"))) return;
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
      } else if (action === "wiki") {
        const body = await apiGet("api/bases/" + baseId + "/item/" + itemId);
        const result = await apiPost("api/bases/" + baseId + "/wiki-ingest", {
          itemId,
          itemName: body.item?.title || "材料",
          text: body.text || "",
        });
        notify("已生成 Wiki 摘要页「" + (result.result?.title || itemId) + "」");
        renderWiki();
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

  /** 自定义确认框（替代 confirm，兼容 Hana iframe 沙箱）。返回 Promise<boolean>。 */
  function confirmDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-backdrop";
      overlay.innerHTML =
        '<div class="modal" style="width:min(420px,92vw)">' +
          '<p style="margin:0 0 16px;font-size:14px;color:var(--text);line-height:1.6">' + escapeHtml(message) + '</p>' +
          '<div class="row" style="justify-content:flex-end">' +
            '<button class="btn" id="dgNo">取消</button>' +
            '<button class="btn danger" id="dgYes" style="margin-left:8px">确认</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector("#dgYes").addEventListener("click", () => close(true));
      overlay.querySelector("#dgNo").addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    });
  }

  /** 自定义输入框（替代 prompt）。返回 Promise<string|null>（取消=null）。 */
  function promptDialog(message, defaultValue) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-backdrop";
      overlay.innerHTML =
        '<div class="modal" style="width:min(440px,92vw)">' +
          '<p style="margin:0 0 12px;font-size:14px;color:var(--text)">' + escapeHtml(message) + '</p>' +
          '<input id="dgInput" class="input" value="' + escapeHtml(String(defaultValue || "")) + '">' +
          '<div class="row" style="justify-content:flex-end;margin-top:12px">' +
            '<button class="btn" id="dgNo">取消</button>' +
            '<button class="btn primary" id="dgYes" style="margin-left:8px">确定</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector("#dgYes").addEventListener("click", () => close(overlay.querySelector("#dgInput").value));
      overlay.querySelector("#dgNo").addEventListener("click", () => close(null));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector("#dgInput").focus();
      overlay.querySelector("#dgInput").addEventListener("keydown", (e) => { if (e.key === "Enter") close(overlay.querySelector("#dgInput").value); });
    });
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

  notifyParent();
  refresh();
  // 局部轮询：刷新 base 列表与材料列表，不重建详情区（保持滚动/焦点/事件）
  setInterval(async () => {
    try {
      const [basesBody] = await Promise.all([apiGet("api/bases")]);
      state.bases = basesBody.bases || [];
      renderBases();
      if (state.selectedId) {
        await refreshItems();
        renderItems();
      }
    } catch {
      // 静默
    }
  }, 3000);
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