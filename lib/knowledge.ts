/**
 * 知识库服务门面。
 *
 * 组合存储层 + 内存检索索引 + 异步工作流，对外暴露
 * Agent 工具与 UI 路由共用的业务操作。对应 Cherry 的
 * KnowledgeService（base / ingestion / query 三块）。
 */

import type { EmbeddingClient } from "./embedding";
import { EmbeddingError } from "./embedding";
import type { KnowledgeGraph, NodeInput, EdgeInput, GraphNode, GraphEdge } from "./graph";
import { MATURITY_LABELS } from "./graph";
import type { RerankClient } from "./rerank";
import { RerankError } from "./rerank";
import { assertSafeRelativePath, slugify } from "./ids";
import type { MemoryIndex, IndexSearchHit } from "./index";
import { tokenizeQuery } from "./tokenizer";
import type { AddItemInput, ItemType, KnowledgeItem, KnowledgeStore } from "./store";
import { KnowledgeWorkflow } from "./workflow";
import type { HanaPluginConfigStore, HanaPluginLogger, HanaPluginNetwork } from "./types";
import { evaluateMaturity, validateCodify, DEFAULT_MATURITY_RULE } from "./maturity";
import type { MaturityRule } from "./maturity";

export interface SearchOptions {
  topK?: number;
  threshold?: number | null;
}

export interface KnowledgeSearchResult extends IndexSearchHit {
  itemName?: string;
  itemType?: string;
}

/** Agent/UI 添加材料的统一输入（字节在服务层落盘，导入即复制）。 */
export interface KnowledgeAddInput {
  type: ItemType;
  name: string;
  /** file / note：内容；directory：忽略。 */
  content?: string | Uint8Array;
  /** url：抓取地址。 */
  url?: string;
  /** directory：子文件清单。 */
  files?: Array<{ name: string; content?: string | Uint8Array }>;
}

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  index: MemoryIndex;
  graph: KnowledgeGraph;
  workflow: KnowledgeWorkflow;
  getEmbedding: () => Promise<EmbeddingClient | null>;
  getRerank: () => Promise<RerankClient | null>;
  network: HanaPluginNetwork;
  config: HanaPluginConfigStore;
  log: HanaPluginLogger;
}

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

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
          completedCount: items.filter((item) => item.status === "completed").length,
        };
      }),
    );
    return summaries;
  }

  async getBase(id: string) {
    return this.deps.store.getBase(id);
  }

  async createBase(name: string, opts: { enableVector?: boolean } = {}) {
    const embedding = opts.enableVector ? await this.deps.getEmbedding() : null;
    if (opts.enableVector && !embedding) {
      throw new Error("尚未配置 embedding 服务，无法创建向量知识库（请先在插件设置中配置）");
    }
    let dimensions: number | null = null;
    let model: string | null = null;
    if (embedding) {
      try {
        dimensions = await embedding.detectDimensions();
        model = embedding.model;
      } catch (err) {
        if (err instanceof EmbeddingError && err.code === "config") throw err;
        throw new Error(`embedding 探测失败: ${(err as Error).message}`);
      }
    }
    return this.deps.store.createBase(name, {
      embeddingModelId: model,
      dimensions,
      documentCount: await this.defaultDocumentCount(),
      threshold: await this.defaultThreshold(),
    });
  }

  /** 把 BM25-only 基升级为向量基（需已配置 embedding）。 */
  async enableEmbedding(baseId: string): Promise<void> {
    const base = await this.deps.store.requireBase(baseId);
    if (base.embeddingModelId) return;
    const embedding = await this.deps.getEmbedding();
    if (!embedding) throw new Error("尚未配置嵌入模型");
    const dimensions = await embedding.detectDimensions();
    await this.deps.store.patchBase(baseId, {
      embeddingModelId: embedding.model,
      dimensions,
      status: "completed",
      error: null,
    });
    // 升级后全库重建
    const items = await this.deps.store.listItems(baseId);
    const roots = items.filter((item) => item.parentId === null);
    await this.deps.workflow.reindexItems(baseId, roots.map((item) => item.id));
  }

  /** 为知识库启用重排序（需已配置 rerank 服务）。 */
  async enableRerank(baseId: string): Promise<void> {
    const base = await this.deps.store.requireBase(baseId);
    if (base.rerankModelId) return;
    const rerank = await this.deps.getRerank();
    if (!rerank) throw new Error("尚未配置重排序服务");
    await rerank.detect();
    await this.deps.store.patchBase(baseId, { rerankModelId: rerank.model });
  }

  /** 关闭知识库的重排序。 */
  async disableRerank(baseId: string): Promise<void> {
    await this.deps.store.patchBase(baseId, { rerankModelId: null });
  }

  async renameBase(baseId: string, name: string) {
    return this.deps.store.renameBase(baseId, name);
  }

  async deleteBase(baseId: string): Promise<void> {
    // Cherry 语义：取消该库 active jobs，等退出后再物理删除
    this.deps.workflow.cancelBase(baseId);
    await this.deps.workflow.drain(baseId);
    await this.deps.graph.dropBase(baseId);
    await this.deps.store.deleteBase(baseId);
    this.deps.index.dropBase(baseId);
  }

  // ---- 知识图谱 ----

  /** 读取整张图谱（节点 + 边 + 审计）。 */
  async getGraph(baseId: string) {
    const graph = await this.deps.graph.load(baseId);
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      audit: graph.audit,
      triggerCount: Object.keys(graph.triggerIndex).length,
      updatedAt: graph.updatedAt,
    };
  }

  /** 新增节点（fuzzy 起步）。 */
  async addGraphNode(baseId: string, input: NodeInput): Promise<GraphNode> {
    await this.deps.store.requireBase(baseId);
    return this.deps.graph.addNode(baseId, input);
  }

  /** 更新节点。 */
  async updateGraphNode(baseId: string, nodeIdValue: string, patch: { title?: string; elements?: Record<string, unknown>; sourceRefs?: string[] }): Promise<GraphNode> {
    return this.deps.graph.updateNode(baseId, nodeIdValue, patch);
  }

  /** 删除节点（连带其边）。 */
  async deleteGraphNode(baseId: string, nodeIdValue: string): Promise<void> {
    await this.deps.graph.deleteNode(baseId, nodeIdValue);
  }

  /** 建立节点关联（突触 / wikilink）。 */
  async linkGraphNodes(baseId: string, input: EdgeInput): Promise<GraphEdge> {
    return this.deps.graph.linkNodes(baseId, input);
  }

  /** 解除关联。 */
  async unlinkGraphNodes(baseId: string, edgeIdValue: string): Promise<void> {
    await this.deps.graph.unlinkNodes(baseId, edgeIdValue);
  }

  /** 节点邻居（含关联边）。 */
  async graphNeighbors(baseId: string, nodeIdValue: string) {
    return this.deps.graph.neighbors(baseId, nodeIdValue);
  }

  /** 触发词检索图谱节点（codified 优先）。 */
  async searchGraph(baseId: string, query: string): Promise<GraphNode[]> {
    return this.deps.graph.findByTrigger(baseId, query);
  }

  /**
   * 提升节点（emerging → codified）。
   * 硬规则：必须过 validateCodify 门槛（10 元素关键字段完整），否则拒绝。
   */
  async promoteNode(baseId: string, nodeIdValue: string, opts: { force?: boolean } = {}): Promise<GraphNode> {
    const node = await this.deps.graph.requireNode(baseId, nodeIdValue);
    if (node.maturity !== "emerging") {
      throw new Error(`仅 emerging 节点可提升（当前 ${MATURITY_LABELS[node.maturity]}）`);
    }
    if (!opts.force) {
      const blocker = validateCodify(node);
      if (blocker) {
        throw new Error(`无法提升：${blocker}。请先补全神经元元素，或使用 force 强制`);
      }
    }
    return this.deps.graph.setMaturity(baseId, nodeIdValue, "codified", "提升为神经树判定单元");
  }

  /** 降级节点（codified/emerging → fuzzy，保留审计快照）。 */
  async demoteNode(baseId: string, nodeIdValue: string, reason = "人工降级"): Promise<GraphNode> {
    const node = await this.deps.graph.requireNode(baseId, nodeIdValue);
    if (node.maturity === "fuzzy") throw new Error("节点已在探索态");
    return this.deps.graph.setMaturity(baseId, nodeIdValue, "fuzzy", reason);
  }

  /** 评估节点成熟度（只读建议）。 */
  async evaluateNode(baseId: string, nodeIdValue: string, rule?: MaturityRule) {
    const node = await this.deps.graph.requireNode(baseId, nodeIdValue);
    return evaluateMaturity(node, rule ?? DEFAULT_MATURITY_RULE);
  }

  /** 记录检索命中（供成熟度评估）。 */
  async recordGraphHit(baseId: string, nodeIdValue: string, negative = false): Promise<void> {
    await this.deps.graph.recordHit(baseId, nodeIdValue, negative);
  }

  // ---- 材料 ----

  async listItems(baseId: string): Promise<KnowledgeItem[]> {
    const items = await this.deps.store.listItems(baseId);
    return items.filter((item) => item.status !== "deleting");
  }

  async addItems(baseId: string, inputs: KnowledgeAddInput[]) {
    const store = this.deps.store;
    const base = await store.requireBase(baseId);
    if (base.status !== "completed") {
      throw new Error("知识库当前不可用，无法添加材料");
    }
    const addInputs: AddItemInput[] = [];
    for (const input of inputs) {
      if (input.type === "file") {
        const relativePath = await this.writeImportFile(baseId, input.name, input.content ?? "");
        addInputs.push({ type: "file", name: input.name, relativePath, data: {} });
      } else if (input.type === "directory") {
        const dirName = sanitizeFilename(slugify(input.name || "folder"));
        const dirPath = await this.uniqueRawPath(baseId, dirName);
        const fileRefs: Array<{ name: string; relativePath: string }> = [];
        for (const file of input.files ?? []) {
          const safeName = sanitizeFilename(file.name);
          if (!safeName) continue;
          const rel = `${dirPath}/${await this.uniqueRawPath(baseId, `${dirPath}/${safeName}`)}`;
          await store.writeRawFile(baseId, rel, file.content ?? "");
          fileRefs.push({ name: file.name, relativePath: rel });
        }
        addInputs.push({ type: "directory", name: input.name, relativePath: dirPath, data: { files: fileRefs } });
      } else if (input.type === "url") {
        if (!input.url || !/^https?:\/\//i.test(input.url)) {
          throw new Error(`URL 无效: ${input.url ?? ""}`);
        }
        addInputs.push({ type: "url", name: input.name || input.url, data: { url: input.url } });
      } else if (input.type === "note") {
        if (!input.content || !String(input.content).trim()) {
          throw new Error("笔记内容为空");
        }
        addInputs.push({ type: "note", name: input.name || "笔记", data: { content: String(input.content) } });
      }
    }
    return this.deps.workflow.addItems(baseId, addInputs);
  }

  /** 导入即复制：写 raw 文件，同名冲突自动 `_N` 后缀（keep-copy）。 */
  private async writeImportFile(
    baseId: string,
    name: string,
    content: string | Uint8Array,
  ): Promise<string> {
    const safeName = sanitizeFilename(name);
    if (!safeName) throw new Error(`文件名无效: ${name}`);
    const relativePath = await this.uniqueRawPath(baseId, safeName);
    await this.deps.store.writeRawFile(baseId, relativePath, content);
    return relativePath;
  }

  private async uniqueRawPath(baseId: string, relativePath: string): Promise<string> {
    const safe = assertSafeRelativePath(relativePath);
    if (!(await this.deps.store.rawFileExists(baseId, safe))) return safe;
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    for (let n = 1; n < 1000; n += 1) {
      const candidate = `${stem}_${n}${ext}`;
      if (!(await this.deps.store.rawFileExists(baseId, candidate))) return candidate;
    }
    throw new Error(`文件名冲突过多: ${relativePath}`);
  }

  async deleteItems(baseId: string, itemIds: string[]) {
    await this.deps.workflow.deleteItems(baseId, itemIds);
  }

  async reindexItems(baseId: string, itemIds: string[]) {
    await this.deps.workflow.reindexItems(baseId, itemIds);
  }

  /** URL 刷新：删快照后重建（重新抓取）。 */
  async refreshUrlItem(baseId: string, itemId: string): Promise<void> {
    const item = await this.deps.store.requireItem(baseId, itemId);
    if (item.type !== "url") throw new Error("仅 URL 材料支持刷新");
    if (item.status === "deleting") throw new Error("材料正在删除");
    if (item.indexedRelativePath) {
      await this.deps.store.deleteRawFile(baseId, item.indexedRelativePath);
    }
    await this.deps.store.updateItem(baseId, itemId, { indexedRelativePath: null });
    await this.deps.workflow.reindexItems(baseId, [itemId]);
  }

  /** 重试失败材料（= 对终结子树重建）。 */
  async retryItem(baseId: string, itemId: string): Promise<void> {
    const item = await this.deps.store.requireItem(baseId, itemId);
    if (item.status !== "failed" && item.status !== "completed") {
      throw new Error("仅 completed / failed 状态的材料可以重试");
    }
    await this.deps.workflow.reindexItems(baseId, [itemId]);
  }

  // ---- 检索 ----

  /**
   * 搜索。语义与 Cherry 一致：
   * 1. 拒绝 failed 基与无可检索 token 的查询
   * 2. 按基配置推导检索模式（向量基 → 混合；否则 BM25）
   * 3. 超取后过滤（源项缺失 / deleting / 非 completed）
   * 4. 截断到 documentCount ?? 10，赋值 rank
   */
  async search(baseId: string, query: string, options: SearchOptions = {}): Promise<KnowledgeSearchResult[]> {
    const base = await this.deps.store.requireBase(baseId);
    if (base.status === "failed") {
      throw new Error("知识库不可用（可能缺少 embedding 模型配置），请先恢复");
    }
    if (base.status === "deleting") {
      throw new Error("知识库正在删除");
    }
    const queryTokens = tokenizeQuery(query);
    if (queryTokens.length === 0) {
      throw new Error("查询内容过短，无法检索");
    }

    const topK = options.topK ?? base.documentCount ?? 10;
    const vectorBase = Boolean(base.embeddingModelId && base.dimensions);

    let queryVector: number[] | null = null;
    if (vectorBase) {
      const embedding = await this.deps.getEmbedding();
      if (embedding) {
        const vectors = await embedding.embedMany([query]);
        queryVector = vectors[0] ?? null;
      }
    }

    const hits = this.deps.index.search(baseId, query, {
      topK,
      overfetch: 5,
      useVector: vectorBase && Boolean(queryVector),
      queryVector: queryVector ?? undefined,
    });

    // 过滤：源项存在、completed、非 deleting
    const items = await this.deps.store.listItems(baseId);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const filtered: KnowledgeSearchResult[] = [];
    const seenChunks = new Set<string>();
    for (const hit of hits) {
      const item = itemById.get(hit.itemId);
      if (!item || item.status !== "completed") continue;
      if (seenChunks.has(hit.chunkId)) continue;
      seenChunks.add(hit.chunkId);
      filtered.push({
        ...hit,
        itemName: item.name,
        itemType: item.type,
      });
    }

    // 重排序：base 配置了 rerank 模型时对候选片段重排（scoreKind → relevance）
    let ranked = filtered;
    if (base.rerankModelId && ranked.length > 0) {
      const rerank = await this.deps.getRerank();
      if (rerank) {
        try {
          const scores = await rerank.rerank(
            query,
            ranked.map((hit) => hit.pageContent),
          );
          const byOriginalIndex = new Map(scores.map((score) => [score.index, score.relevanceScore]));
          const reranked: KnowledgeSearchResult[] = [];
          ranked.forEach((hit, index) => {
            const score = byOriginalIndex.get(index);
            if (score !== undefined) {
              reranked.push({ ...hit, score, scoreKind: "relevance" });
            }
          });
          ranked = reranked.sort((a, b) => b.score - a.score);
        } catch (err) {
          // 重排失败降级为候选排序（Cherry：瞬时失败回退，配置错误记日志）
          this.deps.log.warn(
            `[knowledge] rerank 失败，跳过重排: ${(err as Error).message}`,
            err instanceof RerankError ? { code: err.code } : undefined,
          );
        }
      }
    }

    // threshold 仅对 relevance 分数生效（BM25/RRF ranking 分数透传）
    const threshold = options.threshold ?? base.threshold ?? 0;
    if (threshold > 0) {
      ranked = ranked.filter((hit) => hit.scoreKind !== "relevance" || hit.score >= threshold);
    }

    const trimmed = ranked.slice(0, topK).map((hit, index) => ({ ...hit, rank: index + 1 }));
    return trimmed;
  }

  async listItemChunks(baseId: string, itemId: string) {
    const base = await this.deps.store.requireBase(baseId);
    if (base.status === "failed") throw new Error("知识库不可用");
    const item = await this.deps.store.requireItem(baseId, itemId);
    if (item.status === "deleting") throw new Error("材料正在删除");
    if (item.status !== "completed") throw new Error("材料尚未完成索引");
    return this.deps.index.listItemChunks(baseId, itemId);
  }

  /** 读取材料源文本（Agent 的 read 工具用）。 */
  async readItemText(baseId: string, itemId: string): Promise<{ text: string; item: KnowledgeItem }> {
    const store = this.deps.store;
    const item = await store.requireItem(baseId, itemId);
    if (item.status === "deleting") throw new Error("材料正在删除");
    if (item.type === "note") {
      const content = typeof item.data?.content === "string" ? item.data.content : "";
      return { text: content, item };
    }
    if (item.type === "url") {
      const snapshotPath = item.indexedRelativePath;
      if (!snapshotPath) throw new Error("该 URL 尚未抓取快照（材料可能仍在索引中）");
      const buffer = await store.readRawFile(baseId, snapshotPath);
      return { text: buffer.toString("utf8"), item };
    }
    const relativePath = item.indexedRelativePath ?? item.relativePath;
    if (!relativePath) throw new Error("缺少材料文件路径");
    if (!(await store.rawFileExists(baseId, relativePath))) {
      throw new Error(`材料源文件缺失: ${relativePath}`);
    }
    const buffer = await store.readRawFile(baseId, relativePath);
    return { text: buffer.toString("utf8"), item };
  }

  // ---- 内部 ----

  private async defaultDocumentCount(): Promise<number> {
    const value = await this.deps.config.get("searchDefaultDocumentCount");
    const parsed = Number(value ?? 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
  }

  private async defaultThreshold(): Promise<number | null> {
    const value = await this.deps.config.get("searchThreshold");
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
}

/** 文件名净化：去路径分隔符与 Windows 保留字符，防止路径逃逸。 */
export function sanitizeFilename(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}