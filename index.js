// lib/types.ts
var HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

// lib/embedding.ts
var MAX_PARALLEL = 4;
var MAX_TOKENS_PER_BATCH = 4e3;
var EmbeddingError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
};
var EmbeddingClient = class _EmbeddingClient {
  constructor(config, network) {
    this.config = config;
    this.network = network;
  }
  static isConfigured(config) {
    return Boolean(config.baseUrl && config.baseUrl.trim() && config.model && config.model.trim());
  }
  static async fromConfig(configStore, network) {
    const config = {
      baseUrl: await configStore.get("embeddingBaseUrl") ?? "",
      apiKey: await configStore.get("embeddingApiKey") ?? "",
      model: await configStore.get("embeddingModel") ?? "",
      dimensions: Number(await configStore.get("embeddingDimensions") ?? 0) || 0
    };
    if (!_EmbeddingClient.isConfigured(config)) return null;
    return new _EmbeddingClient(config, network);
  }
  get model() {
    return this.config.model;
  }
  get dimensions() {
    return this.config.dimensions > 0 ? this.config.dimensions : null;
  }
  /** 自动探测模型输出维度（embed 一个 probe 文本）。 */
  async detectDimensions(probe = "knowledge base") {
    const vectors = await this.embedMany([probe]);
    const dims = vectors[0]?.length ?? 0;
    if (dims <= 0) {
      throw new EmbeddingError("Embedding \u6A21\u578B\u8FD4\u56DE\u7A7A\u5411\u91CF", "response");
    }
    return dims;
  }
  /**
   * 批量嵌入。输入为空返回 []。按 token 预算分批、限制并发。
   * 返回的向量均校验维度与配置一致。
   */
  async embedMany(texts) {
    const cleaned = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (cleaned.length === 0) return [];
    const dims = this.config.dimensions;
    const results = /* @__PURE__ */ new Map();
    const batches = [];
    let current = [];
    let currentTokens = 0;
    for (const text of cleaned) {
      const tokens = estimateTokens(text);
      if (current.length > 0 && currentTokens + tokens > MAX_TOKENS_PER_BATCH) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);
    let queueIndex = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL, batches.length) }, async () => {
      while (queueIndex < batches.length) {
        const batch = batches[queueIndex];
        queueIndex += 1;
        const vectors = await this.requestEmbeddings(batch);
        for (let i = 0; i < batch.length; i += 1) {
          const vector = vectors[i];
          if (dims > 0 && vector && vector.length !== dims) {
            throw new EmbeddingError(
              `Embedding \u7EF4\u5EA6\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${dims}\uFF0C\u5B9E\u9645 ${vector.length}`,
              "dimension"
            );
          }
          results.set(batch[i], vector);
        }
      }
    });
    await Promise.all(workers);
    return cleaned.map((text) => results.get(text) ?? []);
  }
  async requestEmbeddings(texts) {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    let response;
    try {
      response = await this.network.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.config.model, input: texts }),
        timeoutMs: 6e4
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding \u8BF7\u6C42\u5931\u8D25: ${err.message}`, "network");
    }
    if (!response.ok) {
      const status = response.status;
      const body = await response.text().catch(() => "");
      if (status === 401 || status === 403 || status === 404) {
        throw new EmbeddingError(
          `Embedding \u914D\u7F6E\u9519\u8BEF (${status}): ${body.slice(0, 200)}`,
          "config"
        );
      }
      throw new EmbeddingError(`Embedding \u670D\u52A1\u9519\u8BEF (${status}): ${body.slice(0, 200)}`, "response");
    }
    const json = await response.json();
    if (json.error) {
      throw new EmbeddingError(`Embedding \u670D\u52A1\u8FD4\u56DE\u9519\u8BEF: ${json.error.message ?? "unknown"}`, "response");
    }
    const vectors = (json.data ?? []).map((item) => item.embedding ?? []).filter((vector) => vector.length > 0);
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `Embedding \u8FD4\u56DE\u6761\u6570\u4E0D\u5339\u914D\uFF1A\u8BF7\u6C42 ${texts.length}\uFF0C\u6536\u5230 ${vectors.length}`,
        "response"
      );
    }
    return vectors;
  }
};
function estimateTokens(text) {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 12287 ? 1 : 0.5;
  }
  return Math.max(1, Math.ceil(count));
}

// lib/tokenizer.ts
var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "for",
  "of",
  "on",
  "in",
  "to",
  "at",
  "by",
  "with",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "you",
  "they",
  "he",
  "she",
  "i",
  "my",
  "your",
  "our",
  "their",
  "not",
  "no",
  "yes",
  "can",
  "could",
  "will",
  "would",
  "should",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "of",
  "to",
  "in",
  "about",
  "which",
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "more",
  "most",
  "some"
]);
var WORD_RE = /[a-z0-9]+/gi;
function tokenize(text) {
  const tokens = [];
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    tokens.push(word);
  }
  const cjk = extractCjkRuns(text);
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}
function tokenizeQuery(text) {
  const tokens = tokenize(text);
  if (tokens.length > 0) return tokens;
  const cjk = extractCjkRuns(text).join("");
  if (!cjk) return [];
  const singles = [];
  for (let i = 0; i < cjk.length; i += 1) {
    singles.push(cjk.slice(i, i + 1));
  }
  return singles;
}
function extractCjkRuns(text) {
  const runs = [];
  let current = "";
  for (const char of text) {
    if (CJK_RE.test(char)) {
      current += char;
    } else if (current) {
      runs.push(current);
      current = "";
    }
  }
  if (current) runs.push(current);
  return runs;
}

// lib/bm25.ts
var K1 = 1.5;
var B = 0.75;
var Bm25Index = class {
  docs = [];
  postings = /* @__PURE__ */ new Map();
  totalTokens = 0;
  get size() {
    return this.docs.length;
  }
  /** 全量重建。 */
  rebuild(documents) {
    this.docs = [];
    this.postings = /* @__PURE__ */ new Map();
    this.totalTokens = 0;
    for (const doc of documents) {
      this.add(doc);
    }
  }
  /** 增量添加一个文档。 */
  add(doc) {
    const tokens = dedupePreservingFirst(doc.tokens);
    this.docs[doc.docId] = { tokens, docLength: doc.tokens.length };
    this.totalTokens += doc.tokens.length;
    for (const token of tokens) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = [];
        this.postings.set(token, posting);
      }
      const existing = posting.find((p) => p.docId === doc.docId);
      if (existing) {
        existing.tf += 1;
      } else {
        posting.push({ docId: doc.docId, tf: 1 });
      }
    }
  }
  /** 移除一个文档（chunk 重建/删除时）。 */
  remove(docId) {
    const doc = this.docs[docId];
    if (!doc) return;
    for (const token of doc.tokens) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const index = posting.findIndex((p) => p.docId === docId);
      if (index >= 0) {
        posting.splice(index, 1);
        if (posting.length === 0) this.postings.delete(token);
      }
    }
    this.totalTokens = Math.max(0, this.totalTokens - doc.docLength);
    delete this.docs[docId];
  }
  /** 检索：返回 Map<docId, score>。 */
  search(query) {
    const queryTokens = uniqueTokens(tokenizeQuery(query));
    if (queryTokens.length === 0) return /* @__PURE__ */ new Map();
    const docCount = this.docs.length;
    if (docCount === 0) return /* @__PURE__ */ new Map();
    const avgDocLength = this.totalTokens / docCount;
    const scores = /* @__PURE__ */ new Map();
    for (const term of queryTokens) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.length;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      for (const { docId, tf } of posting) {
        const docLength = this.docs[docId]?.docLength ?? 0;
        const denom = tf + K1 * (1 - B + B * (docLength / avgDocLength));
        const score = idf * (tf * (K1 + 1) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }
    return scores;
  }
};
function dedupePreservingFirst(tokens) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}
function uniqueTokens(tokens) {
  return dedupePreservingFirst(tokens);
}

// lib/hybrid.ts
var RRF_K = 60;
function fuseByRrf(lanes, limit) {
  const totals = /* @__PURE__ */ new Map();
  for (const lane of lanes) {
    lane.forEach((item, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      totals.set(item.id, (totals.get(item.id) ?? 0) + contribution);
    });
  }
  return [...totals.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}
function rankedFromMap(scores) {
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

// lib/vectors.ts
var VectorIndex = class {
  docs = /* @__PURE__ */ new Map();
  norms = /* @__PURE__ */ new Map();
  get size() {
    return this.docs.size;
  }
  rebuild(documents) {
    this.docs.clear();
    this.norms.clear();
    for (const doc of documents) {
      this.add(doc);
    }
  }
  add(doc) {
    this.docs.set(doc.docId, doc.vector);
    this.norms.set(doc.docId, l2Norm(doc.vector));
  }
  remove(docId) {
    this.docs.delete(docId);
    this.norms.delete(docId);
  }
  /** 余弦相似度检索：返回 Map<docId, similarity ∈ [-1,1]>。 */
  search(query) {
    const queryNorm = l2Norm(query);
    if (queryNorm === 0) return /* @__PURE__ */ new Map();
    const results = /* @__PURE__ */ new Map();
    for (const [docId, vector] of this.docs) {
      const docNorm = this.norms.get(docId) ?? 0;
      if (docNorm === 0) continue;
      const similarity = dot(vector, query) / (docNorm * queryNorm);
      if (similarity > 0) results.set(docId, similarity);
    }
    return results;
  }
};
function l2Norm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}
function dot(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

// lib/index.ts
var MemoryIndex = class {
  bases = /* @__PURE__ */ new Map();
  base(id) {
    let entry = this.bases.get(id);
    if (!entry) {
      entry = { bm25: new Bm25Index(), vectors: new VectorIndex(), docs: [], nextDocId: 0 };
      this.bases.set(id, entry);
    }
    return entry;
  }
  /** 全量重建一个库的索引。 */
  rebuildBase(baseId2, chunkFiles, itemNames) {
    const entry = this.base(baseId2);
    const docs = [];
    const bm25Docs = [];
    const vectorDocs = [];
    let docId = 0;
    for (const file of chunkFiles) {
      for (const chunk of file.chunks) {
        const meta = {
          docId,
          itemId: file.itemId,
          chunkIndex: chunk.index,
          text: chunk.text,
          itemName: itemNames?.get(file.itemId),
          vector: chunk.vector
        };
        docs.push(meta);
        bm25Docs.push({ docId, tokens: tokenize(chunk.text) });
        if (chunk.vector) {
          vectorDocs.push({ docId, vector: chunk.vector });
        }
        docId += 1;
      }
    }
    entry.docs = docs;
    entry.nextDocId = docId;
    entry.bm25.rebuild(bm25Docs);
    entry.vectors.rebuild(vectorDocs);
  }
  /** 增量更新单个 item 的 chunks（先删旧再插入新）。 */
  upsertItemChunks(baseId2, chunkFile, itemName) {
    const entry = this.base(baseId2);
    this.removeItemChunks(baseId2, chunkFile.itemId);
    for (const chunk of chunkFile.chunks) {
      const meta = {
        docId: entry.nextDocId,
        itemId: chunkFile.itemId,
        chunkIndex: chunk.index,
        text: chunk.text,
        itemName,
        vector: chunk.vector
      };
      entry.docs.push(meta);
      entry.bm25.add({ docId: meta.docId, tokens: tokenize(chunk.text) });
      if (chunk.vector) entry.vectors.add({ docId: meta.docId, vector: chunk.vector });
      entry.nextDocId += 1;
    }
  }
  /** 移除一个 item 的全部文档。 */
  removeItemChunks(baseId2, itemId2) {
    const entry = this.bases.get(baseId2);
    if (!entry) return;
    const removed = entry.docs.filter((doc) => doc.itemId === itemId2);
    for (const doc of removed) {
      entry.bm25.remove(doc.docId);
      if (doc.vector) entry.vectors.remove(doc.docId);
    }
    if (removed.length > 0) {
      entry.docs = entry.docs.filter((doc) => doc.itemId !== itemId2);
    }
  }
  /** 释放一个库的全部索引。 */
  dropBase(baseId2) {
    this.bases.delete(baseId2);
  }
  /**
   * 检索。返回排序后的命中（不在此处过滤 item 状态）。
   * BM25-only 基（useVector=false）走单车道；向量基走 RRF 混合。
   */
  search(baseId2, query, options) {
    const entry = this.bases.get(baseId2);
    if (!entry) return [];
    const overfetch = options.topK * (options.overfetch ?? 5);
    const limit = Math.max(1, overfetch);
    const bm25Scores = entry.bm25.search(query);
    const bm25Lane = rankedFromMap(bm25Scores).slice(0, limit);
    let fused;
    let scoreKind = "ranking";
    if (options.useVector) {
      const queryVector = options.queryVector;
      if (queryVector && queryVector.length > 0) {
        const vectorScores = entry.vectors.search(queryVector);
        const vectorLane = rankedFromMap(vectorScores).slice(0, limit);
        fused = fuseByRrf([bm25Lane, vectorLane], limit);
      } else {
        fused = bm25Lane;
      }
    } else {
      fused = bm25Lane;
    }
    const byDocId = new Map(entry.docs.map((doc) => [doc.docId, doc]));
    return fused.map((item, rank) => {
      const doc = byDocId.get(item.id);
      if (!doc) return null;
      return {
        chunkId: stableChunkId(doc.itemId, doc.chunkIndex),
        itemId: doc.itemId,
        pageContent: doc.text,
        score: item.score,
        scoreKind,
        rank: rank + 1,
        metadata: {
          chunkIndex: doc.chunkIndex,
          ...doc.itemName ? { itemName: doc.itemName } : {}
        }
      };
    }).filter((hit) => hit !== null);
  }
  /** 某个 item 的 chunk 列表（list-item-chunks 用）。 */
  listItemChunks(baseId2, itemId2) {
    const entry = this.bases.get(baseId2);
    if (!entry) return [];
    return entry.docs.filter((doc) => doc.itemId === itemId2).sort((a, b) => a.chunkIndex - b.chunkIndex).map((doc) => ({ chunkIndex: doc.chunkIndex, text: doc.text, vector: doc.vector }));
  }
};
function stableChunkId(itemId2, chunkIndex) {
  return `${itemId2}#${chunkIndex}`;
}

// lib/rerank.ts
var RerankError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
};
var RerankClient = class _RerankClient {
  constructor(config, network) {
    this.config = config;
    this.network = network;
  }
  static isConfigured(config) {
    return Boolean(config.baseUrl && config.baseUrl.trim() && config.model && config.model.trim());
  }
  static async fromConfig(configStore, network) {
    const config = {
      baseUrl: await configStore.get("rerankBaseUrl") ?? "",
      apiKey: await configStore.get("rerankApiKey") ?? "",
      model: await configStore.get("rerankModel") ?? ""
    };
    if (!_RerankClient.isConfigured(config)) return null;
    return new _RerankClient(config, network);
  }
  get model() {
    return this.config.model;
  }
  /** 探测配置可用性（用一个最小请求验证端点与鉴权）。 */
  async detect() {
    try {
      await this.rerank("test", ["probe"]);
    } catch (err) {
      throw new RerankError(`\u91CD\u6392\u5E8F\u670D\u52A1\u63A2\u6D4B\u5931\u8D25: ${err.message}`, err instanceof RerankError ? err.code : "network");
    }
  }
  /**
   * 对候选文档重排，返回按相关性降序的命中（含原始索引与 relevance_score）。
   * 输入为空返回 []。
   */
  async rerank(query, documents) {
    const cleaned = documents.map((text) => text.trim()).filter((text) => text.length > 0);
    if (cleaned.length === 0 || !query.trim()) return [];
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/rerank`;
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    let response;
    try {
      response = await this.network.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          query: query.trim(),
          documents: cleaned
        }),
        timeoutMs: 6e4
      });
    } catch (err) {
      throw new RerankError(`Rerank \u8BF7\u6C42\u5931\u8D25: ${err.message}`, "network");
    }
    if (!response.ok) {
      const status = response.status;
      const body = await response.text().catch(() => "");
      if (status === 401 || status === 403 || status === 404) {
        throw new RerankError(`Rerank \u914D\u7F6E\u9519\u8BEF (${status}): ${body.slice(0, 200)}`, "config");
      }
      throw new RerankError(`Rerank \u670D\u52A1\u9519\u8BEF (${status}): ${body.slice(0, 200)}`, "response");
    }
    const json = await response.json();
    if (json.error) {
      throw new RerankError(`Rerank \u670D\u52A1\u8FD4\u56DE\u9519\u8BEF: ${json.error.message ?? "unknown"}`, "response");
    }
    const results = Array.isArray(json.results) ? json.results : [];
    return results.map((item) => ({
      index: Number(item.index),
      relevanceScore: Number(item.relevance_score)
    })).filter((hit) => Number.isFinite(hit.index) && Number.isFinite(hit.relevanceScore)).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
};

// lib/ids.ts
import { createHash, randomUUID } from "node:crypto";
function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
function baseId() {
  return newId("kb");
}
function itemId() {
  return newId("it");
}
function unitId(seed) {
  return `u_${sha256(seed).slice(0, 24)}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function assertSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid relative path: must be a non-empty string.");
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    throw new Error(`Invalid relative path: ${value}`);
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("\0")) {
      throw new Error(`Invalid relative path: ${value}`);
    }
  }
  return normalized;
}
function slugify(input, max = 60) {
  const cleaned = input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return cleaned || "snapshot";
}

// lib/knowledge.ts
var KnowledgeService = class {
  constructor(deps) {
    this.deps = deps;
  }
  // ---- 知识库管理 ----
  async listBases() {
    const bases = await this.deps.store.listBases();
    const summaries = await Promise.all(
      bases.map(async (base) => {
        const items = await this.deps.store.listItems(base.id);
        return {
          id: base.id,
          name: base.name,
          status: base.status,
          error: base.error,
          embeddingModelId: base.embeddingModelId,
          dimensions: base.dimensions,
          rerankModelId: base.rerankModelId,
          documentCount: base.documentCount,
          threshold: base.threshold,
          createdAt: base.createdAt,
          itemCount: items.length,
          completedCount: items.filter((item) => item.status === "completed").length
        };
      })
    );
    return summaries;
  }
  async getBase(id) {
    return this.deps.store.getBase(id);
  }
  async createBase(name, opts = {}) {
    const embedding = opts.enableVector ? await this.deps.getEmbedding() : null;
    if (opts.enableVector && !embedding) {
      throw new Error("\u5C1A\u672A\u914D\u7F6E embedding \u670D\u52A1\uFF0C\u65E0\u6CD5\u521B\u5EFA\u5411\u91CF\u77E5\u8BC6\u5E93\uFF08\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u914D\u7F6E\uFF09");
    }
    let dimensions = null;
    let model = null;
    if (embedding) {
      try {
        dimensions = await embedding.detectDimensions();
        model = embedding.model;
      } catch (err) {
        if (err instanceof EmbeddingError && err.code === "config") throw err;
        throw new Error(`embedding \u63A2\u6D4B\u5931\u8D25: ${err.message}`);
      }
    }
    return this.deps.store.createBase(name, {
      embeddingModelId: model,
      dimensions,
      documentCount: await this.defaultDocumentCount(),
      threshold: await this.defaultThreshold()
    });
  }
  /** 把 BM25-only 基升级为向量基（需已配置 embedding）。 */
  async enableEmbedding(baseId2) {
    const base = await this.deps.store.requireBase(baseId2);
    if (base.embeddingModelId) return;
    const embedding = await this.deps.getEmbedding();
    if (!embedding) throw new Error("\u5C1A\u672A\u914D\u7F6E\u5D4C\u5165\u6A21\u578B");
    const dimensions = await embedding.detectDimensions();
    await this.deps.store.patchBase(baseId2, {
      embeddingModelId: embedding.model,
      dimensions,
      status: "completed",
      error: null
    });
    const items = await this.deps.store.listItems(baseId2);
    const roots = items.filter((item) => item.parentId === null);
    await this.deps.workflow.reindexItems(baseId2, roots.map((item) => item.id));
  }
  /** 为知识库启用重排序（需已配置 rerank 服务）。 */
  async enableRerank(baseId2) {
    const base = await this.deps.store.requireBase(baseId2);
    if (base.rerankModelId) return;
    const rerank = await this.deps.getRerank();
    if (!rerank) throw new Error("\u5C1A\u672A\u914D\u7F6E\u91CD\u6392\u5E8F\u670D\u52A1");
    await rerank.detect();
    await this.deps.store.patchBase(baseId2, { rerankModelId: rerank.model });
  }
  /** 关闭知识库的重排序。 */
  async disableRerank(baseId2) {
    await this.deps.store.patchBase(baseId2, { rerankModelId: null });
  }
  async renameBase(baseId2, name) {
    return this.deps.store.renameBase(baseId2, name);
  }
  async deleteBase(baseId2) {
    this.deps.workflow.cancelBase(baseId2);
    await this.deps.workflow.drain(baseId2);
    await this.deps.store.deleteBase(baseId2);
    this.deps.index.dropBase(baseId2);
  }
  // ---- 材料 ----
  async listItems(baseId2) {
    const items = await this.deps.store.listItems(baseId2);
    return items.filter((item) => item.status !== "deleting");
  }
  async addItems(baseId2, inputs) {
    const store = this.deps.store;
    const base = await store.requireBase(baseId2);
    if (base.status !== "completed") {
      throw new Error("\u77E5\u8BC6\u5E93\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u6DFB\u52A0\u6750\u6599");
    }
    const addInputs = [];
    for (const input of inputs) {
      if (input.type === "file") {
        const relativePath = await this.writeImportFile(baseId2, input.name, input.content ?? "");
        addInputs.push({ type: "file", name: input.name, relativePath, data: {} });
      } else if (input.type === "directory") {
        const dirName = sanitizeFilename(slugify(input.name || "folder"));
        const dirPath = await this.uniqueRawPath(baseId2, dirName);
        const fileRefs = [];
        for (const file of input.files ?? []) {
          const safeName = sanitizeFilename(file.name);
          if (!safeName) continue;
          const rel = `${dirPath}/${await this.uniqueRawPath(baseId2, `${dirPath}/${safeName}`)}`;
          await store.writeRawFile(baseId2, rel, file.content ?? "");
          fileRefs.push({ name: file.name, relativePath: rel });
        }
        addInputs.push({ type: "directory", name: input.name, relativePath: dirPath, data: { files: fileRefs } });
      } else if (input.type === "url") {
        if (!input.url || !/^https?:\/\//i.test(input.url)) {
          throw new Error(`URL \u65E0\u6548: ${input.url ?? ""}`);
        }
        addInputs.push({ type: "url", name: input.name || input.url, data: { url: input.url } });
      } else if (input.type === "note") {
        if (!input.content || !String(input.content).trim()) {
          throw new Error("\u7B14\u8BB0\u5185\u5BB9\u4E3A\u7A7A");
        }
        addInputs.push({ type: "note", name: input.name || "\u7B14\u8BB0", data: { content: String(input.content) } });
      }
    }
    return this.deps.workflow.addItems(baseId2, addInputs);
  }
  /** 导入即复制：写 raw 文件，同名冲突自动 `_N` 后缀（keep-copy）。 */
  async writeImportFile(baseId2, name, content) {
    const safeName = sanitizeFilename(name);
    if (!safeName) throw new Error(`\u6587\u4EF6\u540D\u65E0\u6548: ${name}`);
    const relativePath = await this.uniqueRawPath(baseId2, safeName);
    await this.deps.store.writeRawFile(baseId2, relativePath, content);
    return relativePath;
  }
  async uniqueRawPath(baseId2, relativePath) {
    const safe = assertSafeRelativePath(relativePath);
    if (!await this.deps.store.rawFileExists(baseId2, safe)) return safe;
    const dot2 = safe.lastIndexOf(".");
    const stem = dot2 > 0 ? safe.slice(0, dot2) : safe;
    const ext = dot2 > 0 ? safe.slice(dot2) : "";
    for (let n = 1; n < 1e3; n += 1) {
      const candidate = `${stem}_${n}${ext}`;
      if (!await this.deps.store.rawFileExists(baseId2, candidate)) return candidate;
    }
    throw new Error(`\u6587\u4EF6\u540D\u51B2\u7A81\u8FC7\u591A: ${relativePath}`);
  }
  async deleteItems(baseId2, itemIds) {
    await this.deps.workflow.deleteItems(baseId2, itemIds);
  }
  async reindexItems(baseId2, itemIds) {
    await this.deps.workflow.reindexItems(baseId2, itemIds);
  }
  /** URL 刷新：删快照后重建（重新抓取）。 */
  async refreshUrlItem(baseId2, itemId2) {
    const item = await this.deps.store.requireItem(baseId2, itemId2);
    if (item.type !== "url") throw new Error("\u4EC5 URL \u6750\u6599\u652F\u6301\u5237\u65B0");
    if (item.status === "deleting") throw new Error("\u6750\u6599\u6B63\u5728\u5220\u9664");
    if (item.indexedRelativePath) {
      await this.deps.store.deleteRawFile(baseId2, item.indexedRelativePath);
    }
    await this.deps.store.updateItem(baseId2, itemId2, { indexedRelativePath: null });
    await this.deps.workflow.reindexItems(baseId2, [itemId2]);
  }
  /** 重试失败材料（= 对终结子树重建）。 */
  async retryItem(baseId2, itemId2) {
    const item = await this.deps.store.requireItem(baseId2, itemId2);
    if (item.status !== "failed" && item.status !== "completed") {
      throw new Error("\u4EC5 completed / failed \u72B6\u6001\u7684\u6750\u6599\u53EF\u4EE5\u91CD\u8BD5");
    }
    await this.deps.workflow.reindexItems(baseId2, [itemId2]);
  }
  // ---- 检索 ----
  /**
   * 搜索。语义与 Cherry 一致：
   * 1. 拒绝 failed 基与无可检索 token 的查询
   * 2. 按基配置推导检索模式（向量基 → 混合；否则 BM25）
   * 3. 超取后过滤（源项缺失 / deleting / 非 completed）
   * 4. 截断到 documentCount ?? 10，赋值 rank
   */
  async search(baseId2, query, options = {}) {
    const base = await this.deps.store.requireBase(baseId2);
    if (base.status === "failed") {
      throw new Error("\u77E5\u8BC6\u5E93\u4E0D\u53EF\u7528\uFF08\u53EF\u80FD\u7F3A\u5C11 embedding \u6A21\u578B\u914D\u7F6E\uFF09\uFF0C\u8BF7\u5148\u6062\u590D");
    }
    if (base.status === "deleting") {
      throw new Error("\u77E5\u8BC6\u5E93\u6B63\u5728\u5220\u9664");
    }
    const queryTokens = tokenizeQuery(query);
    if (queryTokens.length === 0) {
      throw new Error("\u67E5\u8BE2\u5185\u5BB9\u8FC7\u77ED\uFF0C\u65E0\u6CD5\u68C0\u7D22");
    }
    const topK = options.topK ?? base.documentCount ?? 10;
    const vectorBase = Boolean(base.embeddingModelId && base.dimensions);
    let queryVector = null;
    if (vectorBase) {
      const embedding = await this.deps.getEmbedding();
      if (embedding) {
        const vectors = await embedding.embedMany([query]);
        queryVector = vectors[0] ?? null;
      }
    }
    const hits = this.deps.index.search(baseId2, query, {
      topK,
      overfetch: 5,
      useVector: vectorBase && Boolean(queryVector),
      queryVector: queryVector ?? void 0
    });
    const items = await this.deps.store.listItems(baseId2);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const filtered = [];
    const seenChunks = /* @__PURE__ */ new Set();
    for (const hit of hits) {
      const item = itemById.get(hit.itemId);
      if (!item || item.status !== "completed") continue;
      if (seenChunks.has(hit.chunkId)) continue;
      seenChunks.add(hit.chunkId);
      filtered.push({
        ...hit,
        itemName: item.name,
        itemType: item.type
      });
    }
    let ranked = filtered;
    if (base.rerankModelId && ranked.length > 0) {
      const rerank = await this.deps.getRerank();
      if (rerank) {
        try {
          const scores = await rerank.rerank(
            query,
            ranked.map((hit) => hit.pageContent)
          );
          const byOriginalIndex = new Map(scores.map((score) => [score.index, score.relevanceScore]));
          const reranked = [];
          ranked.forEach((hit, index) => {
            const score = byOriginalIndex.get(index);
            if (score !== void 0) {
              reranked.push({ ...hit, score, scoreKind: "relevance" });
            }
          });
          ranked = reranked.sort((a, b) => b.score - a.score);
        } catch (err) {
          this.deps.log.warn(
            `[knowledge] rerank \u5931\u8D25\uFF0C\u8DF3\u8FC7\u91CD\u6392: ${err.message}`,
            err instanceof RerankError ? { code: err.code } : void 0
          );
        }
      }
    }
    const threshold = options.threshold ?? base.threshold ?? 0;
    if (threshold > 0) {
      ranked = ranked.filter((hit) => hit.scoreKind !== "relevance" || hit.score >= threshold);
    }
    const trimmed = ranked.slice(0, topK).map((hit, index) => ({ ...hit, rank: index + 1 }));
    return trimmed;
  }
  async listItemChunks(baseId2, itemId2) {
    const base = await this.deps.store.requireBase(baseId2);
    if (base.status === "failed") throw new Error("\u77E5\u8BC6\u5E93\u4E0D\u53EF\u7528");
    const item = await this.deps.store.requireItem(baseId2, itemId2);
    if (item.status === "deleting") throw new Error("\u6750\u6599\u6B63\u5728\u5220\u9664");
    if (item.status !== "completed") throw new Error("\u6750\u6599\u5C1A\u672A\u5B8C\u6210\u7D22\u5F15");
    return this.deps.index.listItemChunks(baseId2, itemId2);
  }
  /** 读取材料源文本（Agent 的 read 工具用）。 */
  async readItemText(baseId2, itemId2) {
    const store = this.deps.store;
    const item = await store.requireItem(baseId2, itemId2);
    if (item.status === "deleting") throw new Error("\u6750\u6599\u6B63\u5728\u5220\u9664");
    if (item.type === "note") {
      const content = typeof item.data?.content === "string" ? item.data.content : "";
      return { text: content, item };
    }
    if (item.type === "url") {
      const snapshotPath = item.indexedRelativePath;
      if (!snapshotPath) throw new Error("\u8BE5 URL \u5C1A\u672A\u6293\u53D6\u5FEB\u7167\uFF08\u6750\u6599\u53EF\u80FD\u4ECD\u5728\u7D22\u5F15\u4E2D\uFF09");
      const buffer2 = await store.readRawFile(baseId2, snapshotPath);
      return { text: buffer2.toString("utf8"), item };
    }
    const relativePath = item.indexedRelativePath ?? item.relativePath;
    if (!relativePath) throw new Error("\u7F3A\u5C11\u6750\u6599\u6587\u4EF6\u8DEF\u5F84");
    if (!await store.rawFileExists(baseId2, relativePath)) {
      throw new Error(`\u6750\u6599\u6E90\u6587\u4EF6\u7F3A\u5931: ${relativePath}`);
    }
    const buffer = await store.readRawFile(baseId2, relativePath);
    return { text: buffer.toString("utf8"), item };
  }
  // ---- 内部 ----
  async defaultDocumentCount() {
    const value = await this.deps.config.get("searchDefaultDocumentCount");
    const parsed = Number(value ?? 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
  }
  async defaultThreshold() {
    const value = await this.deps.config.get("searchThreshold");
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
};
function sanitizeFilename(name) {
  const cleaned = String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 200);
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}

// lib/store.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
var ACTIVE_STATUSES = /* @__PURE__ */ new Set([
  "idle",
  "preparing",
  "processing",
  "reading",
  "embedding"
]);
var VISIBLE_STATUSES = /* @__PURE__ */ new Set([
  ...ACTIVE_STATUSES,
  "completed",
  "failed"
]);
var KnowledgeStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  basesRoot() {
    return join(this.dataDir, "bases");
  }
  baseDir(baseIdValue) {
    return join(this.basesRoot(), baseIdValue);
  }
  metaPath(baseIdValue) {
    return join(this.baseDir(baseIdValue), "meta.json");
  }
  itemsPath(baseIdValue) {
    return join(this.baseDir(baseIdValue), "items.json");
  }
  chunksDir(baseIdValue) {
    return join(this.baseDir(baseIdValue), "chunks");
  }
  chunkPath(baseIdValue, itemIdValue) {
    return join(this.chunksDir(baseIdValue), `${itemIdValue}.json`);
  }
  rawDir(baseIdValue) {
    return join(this.baseDir(baseIdValue), "raw");
  }
  async ensureBaseDir(baseIdValue) {
    await mkdir(this.baseDir(baseIdValue), { recursive: true });
    await mkdir(this.chunksDir(baseIdValue), { recursive: true });
    await mkdir(this.rawDir(baseIdValue), { recursive: true });
  }
  async readJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return fallback;
      throw err;
    }
  }
  /** 每个文件的串行写队列：同一路径的写入排队执行，避免多入口并发写坏同一文件。 */
  writeQueues = /* @__PURE__ */ new Map();
  writeJsonAtomic(path, value) {
    const previous = this.writeQueues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => this.doWriteJsonAtomic(path, value));
    this.writeQueues.set(path, next);
    return next;
  }
  async doWriteJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        const code = err.code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOENT" || code === "EBUSY") {
          await unlink(path).catch(() => void 0);
          await unlink(tmp).catch(() => void 0);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
            continue;
          }
        }
        throw err;
      }
    }
  }
  // ---- 知识库 ----
  async listBases() {
    let names;
    try {
      names = await readdirSafe(this.basesRoot());
    } catch {
      return [];
    }
    const bases = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const base = await this.readJson(this.metaPath(name), null);
      if (base && base.id) bases.push(base);
    }
    return bases.sort((a, b) => b.createdAt - a.createdAt);
  }
  async createBase(name, opts = {}) {
    const id = baseId();
    const now = Date.now();
    const base = {
      id,
      name: name.trim() || "\u672A\u547D\u540D\u77E5\u8BC6\u5E93",
      createdAt: now,
      updatedAt: now,
      status: "completed",
      error: null,
      embeddingModelId: opts.embeddingModelId ?? null,
      dimensions: opts.dimensions ?? null,
      rerankModelId: opts.rerankModelId ?? null,
      documentCount: opts.documentCount ?? 10,
      threshold: opts.threshold ?? null
    };
    await this.ensureBaseDir(id);
    await this.writeJsonAtomic(this.metaPath(id), base);
    await this.writeJsonAtomic(this.itemsPath(id), []);
    return base;
  }
  async getBase(id) {
    const base = await this.readJson(this.metaPath(id), null);
    return base && base.id ? base : null;
  }
  async requireBase(id) {
    const base = await this.getBase(id);
    if (!base) throw new Error(`\u77E5\u8BC6\u5E93\u4E0D\u5B58\u5728: ${id}`);
    return base;
  }
  async patchBase(id, patch) {
    const base = await this.requireBase(id);
    const next = { ...base, ...patch, id, updatedAt: Date.now() };
    await this.writeJsonAtomic(this.metaPath(id), next);
    return next;
  }
  async deleteBase(id) {
    await rm(this.baseDir(id), { recursive: true, force: true });
  }
  async renameBase(id, name) {
    return this.patchBase(id, { name: name.trim() || "\u672A\u547D\u540D\u77E5\u8BC6\u5E93" });
  }
  // ---- 材料 ----
  async listItems(baseIdValue) {
    return this.readJson(this.itemsPath(baseIdValue), []);
  }
  async getItem(baseIdValue, id) {
    const items = await this.listItems(baseIdValue);
    return items.find((item) => item.id === id) ?? null;
  }
  async requireItem(baseIdValue, id) {
    const item = await this.getItem(baseIdValue, id);
    if (!item) throw new Error(`\u6750\u6599\u4E0D\u5B58\u5728: ${id}`);
    return item;
  }
  /** 创建材料行（业务状态权威）。不触发任何索引工作。 */
  async addItems(baseIdValue, inputs) {
    const base = await this.requireBase(baseIdValue);
    if (base.status !== "completed") {
      throw new Error("\u77E5\u8BC6\u5E93\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u6DFB\u52A0\u6750\u6599");
    }
    const items = await this.listItems(baseIdValue);
    const now = Date.now();
    const created = [];
    for (const input of inputs) {
      const item = {
        id: itemId(),
        baseId: baseIdValue,
        type: input.type,
        name: input.name || "\u672A\u547D\u540D",
        status: "idle",
        error: null,
        parentId: input.parentId ?? null,
        groupId: input.groupId ?? null,
        relativePath: input.relativePath ?? null,
        indexedRelativePath: null,
        data: input.data ?? {},
        createdAt: now,
        updatedAt: now
      };
      items.push(item);
      created.push(item);
    }
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), items);
    return created;
  }
  async updateItem(baseIdValue, id, patch) {
    const items = await this.listItems(baseIdValue);
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`\u6750\u6599\u4E0D\u5B58\u5728: ${id}`);
    const next = { ...items[index], ...patch, id, baseId: baseIdValue, updatedAt: Date.now() };
    items[index] = next;
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), items);
    return next;
  }
  async setItemStatus(baseIdValue, id, status, error = null) {
    return this.updateItem(baseIdValue, id, { status, error });
  }
  /** 硬删除材料行。 */
  async deleteItems(baseIdValue, ids) {
    const items = await this.listItems(baseIdValue);
    const keep = items.filter((item) => !ids.includes(item.id));
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), keep);
    for (const id of ids) {
      await this.deleteChunks(baseIdValue, id).catch(() => void 0);
    }
  }
  // ---- raw 文件 ----
  /** 解析 raw 相对路径到绝对路径，防目录穿越。 */
  rawAbsPath(baseIdValue, relativePath) {
    const safe = assertSafeRelativePath(relativePath);
    const root = normalize(this.rawDir(baseIdValue));
    const abs = normalize(join(root, safe));
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new Error(`\u975E\u6CD5\u8DEF\u5F84: ${relativePath}`);
    }
    return abs;
  }
  async writeRawFile(baseIdValue, relativePath, content) {
    const abs = this.rawAbsPath(baseIdValue, relativePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return relativePath;
  }
  async readRawFile(baseIdValue, relativePath) {
    const abs = this.rawAbsPath(baseIdValue, relativePath);
    return readFile(abs);
  }
  async rawFileExists(baseIdValue, relativePath) {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  }
  async deleteRawFile(baseIdValue, relativePath) {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await unlink(abs);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  /** 递归删除 raw 下的目录子树（directory 导入）。 */
  async deleteRawTree(baseIdValue, relativePath) {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await rm(abs, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  // ---- chunks ----
  async saveChunks(baseIdValue, itemIdValue, text, chunks) {
    const file = {
      itemId: itemIdValue,
      contentHash: hashText(text),
      text,
      chunks
    };
    await mkdir(this.chunksDir(baseIdValue), { recursive: true });
    await this.writeJsonAtomic(this.chunkPath(baseIdValue, itemIdValue), file);
    return file;
  }
  async getChunks(baseIdValue, itemIdValue) {
    return this.readJson(this.chunkPath(baseIdValue, itemIdValue), null);
  }
  async deleteChunks(baseIdValue, itemIdValue) {
    try {
      await unlink(this.chunkPath(baseIdValue, itemIdValue));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  /** 扫描一个库的全部 chunk（检索索引重建用）。 */
  async scanChunks(baseIdValue) {
    let names;
    try {
      names = await readdirSafe(this.chunksDir(baseIdValue));
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = await this.readJson(join(this.chunksDir(baseIdValue), name), null);
      if (file && Array.isArray(file.chunks)) files.push(file);
    }
    return files;
  }
};
function hashText(text) {
  return createHash2("sha256").update(text).digest("hex");
}
async function readdirSafe(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// lib/chunker.ts
var DEFAULT_MAX_CHUNK_SIZE = 800;
var DEFAULT_OVERLAP = 80;
function splitIntoChunks(content, maxChunkSize = DEFAULT_MAX_CHUNK_SIZE, overlap = DEFAULT_OVERLAP) {
  const normalized = normalizeText(content);
  if (!normalized) return [];
  const paragraphs = splitParagraphs(normalized);
  const chunks = [];
  let bufferStart = 0;
  let bufferEnd = 0;
  const flush = (end) => {
    if (end <= bufferStart) return;
    const text = normalized.slice(bufferStart, end);
    if (text.trim()) {
      chunks.push({ text, charStart: bufferStart, charEnd: end });
    }
    bufferStart = end;
    bufferEnd = end;
  };
  for (const para of paragraphs) {
    const start = para.start;
    const end = para.end;
    if (end - bufferStart > maxChunkSize && bufferEnd > bufferStart) {
      flush(bufferEnd);
    }
    if (end - start >= maxChunkSize) {
      flush(Math.max(bufferStart, start));
      cutLongRun(normalized, start, end, maxChunkSize, overlap, chunks);
      bufferStart = end;
      bufferEnd = end;
    } else {
      if (bufferStart === 0 || bufferEnd === 0) {
        bufferStart = start;
        bufferEnd = end;
      } else {
        bufferEnd = end;
      }
    }
  }
  flush(normalized.length);
  return chunks.filter((chunk) => {
    if (chunk.text.trim() === "") return false;
    if (chunk.text !== normalized.slice(chunk.charStart, chunk.charEnd)) {
      throw new Error("chunk offset invariant violated");
    }
    return true;
  });
}
function cutLongRun(text, start, end, maxChunkSize, overlap, out) {
  let cursor = start;
  const step = Math.max(1, maxChunkSize - overlap);
  while (cursor < end) {
    const chunkEnd = Math.min(end, cursor + maxChunkSize);
    const piece = text.slice(cursor, chunkEnd);
    if (piece.trim()) {
      out.push({ text: piece, charStart: cursor, charEnd: chunkEnd });
    }
    if (chunkEnd >= end) break;
    cursor += step;
  }
}
function splitParagraphs(text) {
  const paragraphs = [];
  let start = 0;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const newline = text.indexOf("\n", index);
    if (newline < 0) {
      paragraphs.push({ start, end: length });
      break;
    }
    index = newline + 1;
    while (index < length && (text[index] === "\n" || text[index] === "\r")) {
      index += 1;
    }
    if (index >= length) {
      paragraphs.push({ start, end: length });
      break;
    }
    paragraphs.push({ start, end: newline });
    start = index;
  }
  return paragraphs.filter((p) => p.end > p.start);
}
function normalizeText(input) {
  return input.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// lib/extract.ts
var MAX_FILE_BYTES = 20 * 1024 * 1024;
var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "log",
  "ini",
  "conf",
  "cfg",
  "env",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "php",
  "swift",
  "sql",
  "lua",
  "r",
  "pl",
  "dart",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "vue",
  "svelte"
]);
var HTML_EXTENSIONS = /* @__PURE__ */ new Set(["html", "htm", "xhtml"]);
async function extractTextFromBuffer(filename, buffer) {
  const ext = extensionOf(filename);
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: `\u6587\u4EF6\u8D85\u8FC7 ${MAX_FILE_BYTES / 1024 / 1024}MB \u9650\u5236` };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = decodeText(buffer);
    return { ok: true, text };
  }
  if (HTML_EXTENSIONS.has(ext)) {
    const text = htmlToMarkdown(decodeText(buffer));
    return { ok: true, text };
  }
  return {
    ok: false,
    reason: `\u6682\u4E0D\u652F\u6301\u89E3\u6790 ${ext || "\u672A\u77E5"} \u683C\u5F0F\uFF0C\u8BF7\u5148\u8F6C\u6362\u4E3A txt/md/csv \u7B49\u6587\u672C\u683C\u5F0F`
  };
}
function extensionOf(filename) {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot2 = base.lastIndexOf(".");
  return dot2 > 0 ? base.slice(dot2 + 1).toLowerCase() : "";
}
function decodeText(buffer) {
  try {
    const utf8 = buffer.toString("utf8");
    if (!utf8.includes("\uFFFD")) return utf8;
  } catch {
  }
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}
function htmlToMarkdown(html) {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  return withoutScripts.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}

// lib/url.ts
var MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
async function fetchUrlSnapshot(url, network) {
  let response;
  try {
    response = await network.fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml,text/markdown,*/*;q=0.8" },
      timeoutMs: 3e4,
      maxResponseBytes: MAX_SNAPSHOT_BYTES
    });
  } catch (err) {
    throw new Error(`\u6293\u53D6 URL \u5931\u8D25\uFF08\u53EF\u80FD\u4E0D\u5728\u7F51\u7EDC\u767D\u540D\u5355\u5185\uFF09: ${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`\u6293\u53D6 URL \u5931\u8D25: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let body;
  try {
    body = await response.text();
  } catch {
    throw new Error("URL \u54CD\u5E94\u4F53\u8FC7\u5927\u6216\u4E0D\u53EF\u8BFB");
  }
  if (/html/i.test(contentType)) {
    return { title: htmlTitle(body), url, markdown: htmlToMarkdown(body), fetchedAt: Date.now() };
  }
  if (/markdown|text\/plain/i.test(contentType) || looksLikeMarkdown(body)) {
    return { title: firstHeading(body) ?? url, url, markdown: body.trim(), fetchedAt: Date.now() };
  }
  return { title: url, url, markdown: body.trim().slice(0, 2e5), fetchedAt: Date.now() };
}
function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/<[^>]+>/g, "").trim().slice(0, 200) : "";
}
function firstHeading(markdown) {
  const line = markdown.split("\n").find((line2) => /^#\s+/.test(line2.trim()));
  return line ? line.trim().replace(/^#+\s*/, "").slice(0, 200) : null;
}
function looksLikeMarkdown(text) {
  return /^#\s/m.test(text) || /\[[^\]]+\]\(https?:\/\/[^)]+\)/m.test(text);
}

// lib/workflow.ts
var MAX_CHUNK_SIZE = 800;
var CHUNK_OVERLAP = 80;
var KnowledgeWorkflow = class {
  constructor(deps) {
    this.deps = deps;
  }
  chains = /* @__PURE__ */ new Map();
  stopped = false;
  cancelledBases = /* @__PURE__ */ new Set();
  stop() {
    this.stopped = true;
  }
  /** 取消某库的后续任务（deleteBase 语义：cancel active jobs）。 */
  cancelBase(baseId2) {
    this.cancelledBases.add(baseId2);
  }
  /** 等待该库链上所有任务结束（配合 cancelBase 使用：先取消再 drain）。 */
  async drain(baseId2) {
    const chain = this.chains.get(baseId2);
    if (chain) await chain;
  }
  // ---- 每库串行执行（替代 KeyedMutex） ----
  enqueue(baseId2, job) {
    const previous = this.chains.get(baseId2) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(async () => {
      if (this.stopped || this.cancelledBases.has(baseId2)) return;
      try {
        this.deps.log.info(`[kb:job] start ${job.type} ${job.baseId} ${"itemId" in job ? job.itemId : ""}`);
        await this.runJob(job);
        this.deps.log.info(`[kb:job] end   ${job.type} ${job.baseId} ${"itemId" in job ? job.itemId : ""}`);
      } catch (err) {
        this.deps.log.error(`[knowledge] job ${job.type} failed`, err);
        await this.markJobFailed(job, err);
      }
    });
    this.chains.set(baseId2, next);
    return next;
  }
  // ---- API 入口（返回 = 任务已接受） ----
  /** 添加材料：创建行 + 写 raw 字节（导入即复制），然后调度索引。 */
  async addItems(baseId2, inputs) {
    const store = this.deps.store;
    const created = await store.addItems(baseId2, inputs);
    for (const item of created) {
      if (item.type === "directory") {
        await this.scheduleItem(baseId2, item.id, "preparing");
      } else {
        await this.scheduleItem(baseId2, item.id, "processing");
      }
    }
    return created;
  }
  /** 删除：折叠到顶层根 → 标记 deleting → 入队物理清理。 */
  async deleteItems(baseId2, itemIds) {
    const store = this.deps.store;
    const roots = await this.collapseToRoots(baseId2, itemIds);
    if (roots.length === 0) return;
    for (const root of roots) {
      await this.markSubtree(baseId2, root.id, "deleting");
    }
    void this.enqueue(baseId2, { type: "delete-subtree", baseId: baseId2, rootIds: roots.map((root) => root.id) });
  }
  /** 重建索引：仅允许终结子树。 */
  async reindexItems(baseId2, itemIds) {
    const store = this.deps.store;
    const roots = await this.collapseToRoots(baseId2, itemIds);
    for (const root of roots) {
      const subtree = await this.loadSubtree(baseId2, root.id);
      for (const item of subtree) {
        if (item.status === "deleting" || ACTIVE_STATUSES.has(item.status)) {
          throw new Error(`\u6750\u6599 "${item.name}" \u6B63\u5728\u5904\u7406\u4E2D\uFF0C\u65E0\u6CD5\u91CD\u5EFA\u7D22\u5F15`);
        }
      }
    }
    void this.enqueue(baseId2, { type: "reindex-subtree", baseId: baseId2, rootIds: roots.map((root) => root.id) });
  }
  // ---- 调度 ----
  async scheduleItem(baseId2, itemIdValue, startStatus) {
    const store = this.deps.store;
    const item = await store.getItem(baseId2, itemIdValue);
    if (!item) return;
    await store.setItemStatus(baseId2, itemIdValue, startStatus);
    if (item.type === "directory") {
      void this.enqueue(baseId2, { type: "prepare-root", baseId: baseId2, itemId: itemIdValue });
    } else {
      void this.enqueue(baseId2, { type: "index-document", baseId: baseId2, itemId: itemIdValue });
    }
  }
  // ---- Job 执行 ----
  async runJob(job) {
    switch (job.type) {
      case "prepare-root":
        await this.runPrepareRoot(job.baseId, job.itemId);
        break;
      case "index-document":
        await this.runIndexDocument(job.baseId, job.itemId);
        break;
      case "delete-subtree":
        await this.runDeleteSubtree(job.baseId, job.rootIds);
        break;
      case "reindex-subtree":
        await this.runReindexSubtree(job.baseId, job.rootIds);
        break;
    }
  }
  /** 展开 directory：创建子项行并逐个调度。 */
  async runPrepareRoot(baseId2, itemIdValue) {
    const store = this.deps.store;
    const item = await store.requireItem(baseId2, itemIdValue);
    if (item.status === "deleting") return;
    const files = Array.isArray(item.data?.files) ? item.data.files : [];
    const childInputs = files.map((file) => ({
      type: "file",
      name: file.name,
      parentId: itemIdValue,
      groupId: null,
      relativePath: file.relativePath
    }));
    const children = childInputs.length > 0 ? await store.addItems(baseId2, childInputs) : [];
    await store.setItemStatus(baseId2, itemIdValue, "processing");
    for (const child of children) {
      await this.scheduleItem(baseId2, child.id, "processing");
    }
    await this.reconcileContainer(baseId2, itemIdValue);
  }
  /** 叶子索引：读源 → 归一化 → 切块 → (嵌入) → 写 chunks + 更新索引。 */
  async runIndexDocument(baseId2, itemIdValue) {
    const { store, index } = this.deps;
    const item = await store.requireItem(baseId2, itemIdValue);
    if (item.status === "deleting") return;
    await store.setItemStatus(baseId2, itemIdValue, "reading");
    const source = await this.readItemSource(item);
    const text = normalizeText(source.text);
    const slices = splitIntoChunks(text, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
    const base = await store.requireBase(baseId2);
    const vectorBase = Boolean(base.embeddingModelId && base.dimensions);
    let vectors = null;
    if (vectorBase && slices.length > 0) {
      await store.setItemStatus(baseId2, itemIdValue, "embedding");
      const embedding = await this.deps.getEmbedding();
      if (!embedding) {
        throw new Error("\u77E5\u8BC6\u5E93\u914D\u7F6E\u4E86 embedding \u4F46\u5F53\u524D\u65E0\u6CD5\u83B7\u53D6 embedding \u5BA2\u6237\u7AEF");
      }
      vectors = await embedding.embedMany(slices.map((slice) => slice.text));
    }
    const chunks = slices.map((slice, index2) => ({
      unitId: unitId(`${itemIdValue}:${text.slice(slice.charStart, slice.charEnd)}:${slice.charStart}:${slice.charEnd}`),
      text: slice.text,
      charStart: slice.charStart,
      charEnd: slice.charEnd,
      index: index2,
      vector: vectors ? vectors[index2] ?? null : null
    }));
    await store.saveChunks(baseId2, itemIdValue, text, chunks);
    const chunkFile = await store.getChunks(baseId2, itemIdValue);
    if (chunkFile) index.upsertItemChunks(baseId2, chunkFile, item.name);
    await store.setItemStatus(baseId2, itemIdValue, "completed");
    if (item.parentId) {
      await this.reconcileContainer(baseId2, item.parentId);
    }
  }
  /** 读取材料源文本。 */
  async readItemSource(item) {
    const store = this.deps.store;
    if (item.type === "note") {
      const content = typeof item.data?.content === "string" ? item.data.content : "";
      if (!content.trim()) throw new Error("\u7B14\u8BB0\u5185\u5BB9\u4E3A\u7A7A");
      return { text: content };
    }
    if (item.type === "url") {
      const url = typeof item.data?.url === "string" ? item.data.url : "";
      if (!url) throw new Error("\u7F3A\u5C11 URL");
      const snapshotPath = item.indexedRelativePath ?? `snapshots/${item.id}.md`;
      if (await store.rawFileExists(item.baseId, snapshotPath)) {
        const buffer2 = await store.readRawFile(item.baseId, snapshotPath);
        return { text: buffer2.toString("utf8") };
      }
      const snapshot = await fetchUrlSnapshot(url, this.deps.network);
      await store.writeRawFile(item.baseId, snapshotPath, snapshot.markdown);
      await store.updateItem(item.baseId, item.id, { indexedRelativePath: snapshotPath });
      return { text: snapshot.markdown };
    }
    const relativePath = item.indexedRelativePath ?? item.relativePath;
    if (!relativePath) throw new Error("\u7F3A\u5C11\u6750\u6599\u6587\u4EF6\u8DEF\u5F84");
    if (!await store.rawFileExists(item.baseId, relativePath)) {
      throw new Error(`\u6750\u6599\u6E90\u6587\u4EF6\u7F3A\u5931: ${relativePath}`);
    }
    const buffer = await store.readRawFile(item.baseId, relativePath);
    const extracted = await extractTextFromBuffer(relativePath, buffer);
    if (!extracted.ok) throw new Error(extracted.reason);
    return extracted;
  }
  async runDeleteSubtree(baseId2, rootIds) {
    const { store, index } = this.deps;
    const all = await this.loadSubtrees(baseId2, rootIds);
    for (const item of all) {
      index.removeItemChunks(baseId2, item.id);
      await store.deleteChunks(baseId2, item.id);
    }
    for (const item of all) {
      if (!item.relativePath) continue;
      if (item.type === "directory") {
        await store.deleteRawTree(baseId2, item.relativePath);
      } else {
        await store.deleteRawFile(baseId2, item.relativePath);
      }
    }
    for (const item of all) {
      if ((item.type === "url" || item.type === "note") && item.indexedRelativePath) {
        await store.deleteRawFile(baseId2, item.indexedRelativePath);
      }
    }
    await store.deleteItems(baseId2, all.map((item) => item.id));
  }
  async runReindexSubtree(baseId2, rootIds) {
    const { store, index } = this.deps;
    const roots = (await store.listItems(baseId2)).filter((item) => rootIds.includes(item.id));
    for (const root of roots) {
      const subtree = await this.loadSubtree(baseId2, root.id);
      for (const item of subtree) {
        index.removeItemChunks(baseId2, item.id);
        await store.deleteChunks(baseId2, item.id);
      }
      const descendants = subtree.filter((item) => item.id !== root.id && item.parentId !== null);
      await store.deleteItems(baseId2, descendants.map((item) => item.id));
      if (root.type === "directory") {
        await store.setItemStatus(baseId2, root.id, "idle", null);
        await this.scheduleItem(baseId2, root.id, "preparing");
      } else {
        await store.setItemStatus(baseId2, root.id, "idle", null);
        await this.scheduleItem(baseId2, root.id, "processing");
      }
    }
  }
  // ---- 容器聚合 ----
  /** 容器状态 = 子项聚合：无活跃子项即 completed（错误显示在子项上）。 */
  async reconcileContainer(baseId2, containerId) {
    const store = this.deps.store;
    const item = await store.getItem(baseId2, containerId);
    if (!item || item.type !== "directory" || item.status === "deleting") return;
    const children = (await store.listItems(baseId2)).filter((child) => child.parentId === containerId);
    const hasActive = children.some((child) => ACTIVE_STATUSES.has(child.status));
    if (!hasActive) {
      await store.setItemStatus(baseId2, containerId, "completed");
    }
  }
  // ---- 子树工具 ----
  async collapseToRoots(baseId2, itemIds) {
    const store = this.deps.store;
    const items = await store.listItems(baseId2);
    const selected = items.filter((item) => itemIds.includes(item.id));
    const selectedIds = new Set(selected.map((item) => item.id));
    return selected.filter((item) => !(item.parentId && selectedIds.has(item.parentId)));
  }
  async loadSubtree(baseId2, rootId) {
    const store = this.deps.store;
    const items = await store.listItems(baseId2);
    const result = [];
    const walk = (parentId) => {
      for (const item of items) {
        if (item.parentId === parentId) {
          result.push(item);
          if (item.type === "directory") walk(item.id);
        }
      }
    };
    const root = items.find((item) => item.id === rootId);
    if (root) {
      result.push(root);
      if (root.type === "directory") walk(root.id);
    }
    return result;
  }
  async loadSubtrees(baseId2, rootIds) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const rootId of rootIds) {
      const subtree = await this.loadSubtree(baseId2, rootId);
      for (const item of subtree) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
      }
    }
    return result;
  }
  async markSubtree(baseId2, rootId, status) {
    const store = this.deps.store;
    const subtree = await this.loadSubtree(baseId2, rootId);
    for (const item of subtree) {
      await store.setItemStatus(baseId2, item.id, status);
    }
  }
  /** job 失败兜底：把相关材料标记 failed（deleting 任务失败不覆盖状态）。 */
  async markJobFailed(job, err) {
    const message = err?.message ?? String(err);
    try {
      if (job.type === "index-document" || job.type === "prepare-root") {
        const item = await this.deps.store.getItem(job.baseId, job.itemId);
        if (item && item.status !== "deleting") {
          await this.deps.store.setItemStatus(job.baseId, job.itemId, "failed", message);
          if (item.parentId) await this.reconcileContainer(job.baseId, item.parentId);
        }
      }
    } catch (inner) {
      this.deps.log.error("[knowledge] failed to persist job failure", inner);
    }
  }
  // ---- 启动恢复 ----
  /** 恢复：重建索引 + 重试非终结任务 + 幂等删除清理。 */
  async recover() {
    const { store, index } = this.deps;
    const bases = await store.listBases();
    for (const base of bases) {
      if (base.status === "deleting") continue;
      const items = await store.listItems(base.id);
      const itemNames = new Map(items.map((item) => [item.id, item.name]));
      const chunkFiles = await store.scanChunks(base.id);
      index.rebuildBase(base.id, chunkFiles, itemNames);
      const deletingRoots = items.filter((item) => item.status === "deleting" && (item.parentId === null || !items.some((p) => p.id === item.parentId && p.status === "deleting")));
      if (deletingRoots.length > 0) {
        void this.enqueue(base.id, { type: "delete-subtree", baseId: base.id, rootIds: deletingRoots.map((item) => item.id) });
      }
      for (const item of items) {
        if (item.status === "deleting") continue;
        if (ACTIVE_STATUSES.has(item.status) || item.status === "idle") {
          if (item.type === "directory") {
            await this.scheduleItem(base.id, item.id, "preparing");
          } else {
            await this.scheduleItem(base.id, item.id, "processing");
          }
        }
      }
    }
  }
};

// lib/runtime.ts
function globalSlot(pluginId) {
  return `__hankKnowledgeRuntime_${pluginId}`;
}
function globalAny() {
  return globalThis;
}
function initRuntime(ctx) {
  const store = new KnowledgeStore(ctx.dataDir);
  const index = new MemoryIndex();
  const getEmbedding = () => EmbeddingClient.fromConfig(ctx.config, ctx.network);
  const getRerank = () => RerankClient.fromConfig(ctx.config, ctx.network);
  const workflow = new KnowledgeWorkflow({
    store,
    index,
    getEmbedding,
    network: ctx.network,
    log: ctx.log
  });
  const service = new KnowledgeService({
    store,
    index,
    workflow,
    getEmbedding,
    getRerank,
    network: ctx.network,
    config: ctx.config,
    log: ctx.log
  });
  const bundle = { ctx, store, index, workflow, service };
  globalAny()[globalSlot(ctx.pluginId)] = bundle;
  return bundle;
}
function clearRuntime(pluginId) {
  const existing = globalAny()[globalSlot(pluginId)];
  if (existing) {
    existing.workflow.stop();
    delete globalAny()[globalSlot(pluginId)];
  }
}

// index.ts
var HankKnowledgePlugin = class {
  disposables = [];
  async onload() {
    const bundle = initRuntime(this.ctx);
    const ctx = bundle.ctx;
    ctx.log.info("[hank-knowledge] plugin loaded, dataDir=", ctx.dataDir);
    await bundle.workflow.recover();
    if (ctx.bus.handle) {
      const service = bundle.service;
      this.disposables.push(
        ctx.bus.handle("hank-knowledge:list-bases", async () => {
          return { ok: true, bases: await service.listBases() };
        })
      );
      this.disposables.push(
        ctx.bus.handle("hank-knowledge:search", async (payload) => {
          if (!payload || typeof payload.baseId !== "string" || typeof payload.query !== "string") {
            return HANA_BUS_SKIP;
          }
          const results = await service.search(payload.baseId, payload.query, {
            topK: typeof payload.topK === "number" ? payload.topK : void 0
          });
          return { ok: true, results };
        })
      );
      this.disposables.push(
        ctx.bus.handle("hank-knowledge:add-items", async (payload) => {
          if (!payload || typeof payload.baseId !== "string" || !Array.isArray(payload.items)) {
            return HANA_BUS_SKIP;
          }
          const items = await service.addItems(payload.baseId, payload.items);
          return { ok: true, items };
        })
      );
    }
    this.ctx.log.info("[hank-knowledge] ready");
  }
  async onunload() {
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
    clearRuntime(this.ctx.pluginId);
    this.ctx.log.info("[hank-knowledge] plugin unloaded");
  }
};
export {
  HankKnowledgePlugin as default
};
