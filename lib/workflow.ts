/**
 * 知识库异步索引工作流。
 *
 * 复刻 Cherry Studio 的 workflow 模型（prepare-root / index-documents /
 * delete-subtree / reindex-subtree），用插件进程内的每库串行队列
 * 替代 JobManager。API 入口在"任务已接受"即返回，物理副作用异步完成；
 * 启动时扫描非终结状态恢复未完成任务。
 *
 * 状态机：
 *   idle → preparing(directory 展开) → processing(叶子被接受)
 *        → reading(读源) → embedding(可选) → completed / failed
 *   deleting = 用户可见删除意图，物理清理完成后硬删。
 */

import { join } from "node:path";
import { normalizeText, splitIntoChunks } from "./chunker";
import type { EmbeddingClient } from "./embedding";
import { extractTextFromBuffer, isTextLike } from "./extract";
import { unitId, slugify } from "./ids";
import type { MemoryIndex } from "./index";
import type { MineruClient } from "./mineru";
import type {
  AddItemInput,
  ItemStatus,
  KnowledgeChunk,
  KnowledgeItem,
  KnowledgeStore,
} from "./store";
import { ACTIVE_STATUSES } from "./store";
import type { HanaPluginLogger, HanaPluginNetwork } from "./types";
import { fetchUrlSnapshot } from "./url";

export interface WorkflowDeps {
  store: KnowledgeStore;
  index: MemoryIndex;
  getEmbedding: () => Promise<EmbeddingClient | null>;
  getMineru: () => Promise<MineruClient | null>;
  network: HanaPluginNetwork;
  log: HanaPluginLogger;
}

const MAX_CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 80;

type Job =
  | { type: "prepare-root"; baseId: string; itemId: string }
  | { type: "index-document"; baseId: string; itemId: string }
  | { type: "delete-subtree"; baseId: string; rootIds: string[] }
  | { type: "reindex-subtree"; baseId: string; rootIds: string[] };

export class KnowledgeWorkflow {
  private chains = new Map<string, Promise<void>>();
  private stopped = false;
  private cancelledBases = new Set<string>();

  constructor(private readonly deps: WorkflowDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** 取消某库的后续任务（deleteBase 语义：cancel active jobs）。 */
  cancelBase(baseId: string): void {
    this.cancelledBases.add(baseId);
  }

  /** 等待该库链上所有任务结束（配合 cancelBase 使用：先取消再 drain）。 */
  async drain(baseId: string): Promise<void> {
    const chain = this.chains.get(baseId);
    if (chain) await chain;
  }

  // ---- 每库串行执行（替代 KeyedMutex） ----

  private enqueue(baseId: string, job: Job): Promise<void> {
    const previous = this.chains.get(baseId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped || this.cancelledBases.has(baseId)) return;
        try {
          this.deps.log.info(`[kb:job] start ${job.type} ${job.baseId} ${"itemId" in job ? job.itemId : ""}`);
          await this.runJob(job);
          this.deps.log.info(`[kb:job] end   ${job.type} ${job.baseId} ${"itemId" in job ? job.itemId : ""}`);
        } catch (err) {
          this.deps.log.error(`[knowledge] job ${job.type} failed`, err);
          await this.markJobFailed(job, err);
        }
      });
    this.chains.set(baseId, next);
    return next;
  }

  // ---- API 入口（返回 = 任务已接受） ----

  /** 添加材料：创建行 + 写 raw 字节（导入即复制），然后调度索引。 */
  async addItems(baseId: string, inputs: AddItemInput[]): Promise<KnowledgeItem[]> {
    const store = this.deps.store;
    const created = await store.addItems(baseId, inputs);
    for (const item of created) {
      if (item.type === "directory") {
        await this.scheduleItem(baseId, item.id, "preparing");
      } else {
        await this.scheduleItem(baseId, item.id, "processing");
      }
    }
    return created;
  }

  /** 删除：折叠到顶层根 → 标记 deleting → 入队物理清理。 */
  async deleteItems(baseId: string, itemIds: string[]): Promise<void> {
    const store = this.deps.store;
    const roots = await this.collapseToRoots(baseId, itemIds);
    if (roots.length === 0) return;
    for (const root of roots) {
      await this.markSubtree(baseId, root.id, "deleting");
    }
    void this.enqueue(baseId, { type: "delete-subtree", baseId, rootIds: roots.map((root) => root.id) });
  }

  /** 重建索引：仅允许终结子树。 */
  async reindexItems(baseId: string, itemIds: string[]): Promise<void> {
    const store = this.deps.store;
    const roots = await this.collapseToRoots(baseId, itemIds);
    for (const root of roots) {
      const subtree = await this.loadSubtree(baseId, root.id);
      for (const item of subtree) {
        if (item.status === "deleting" || ACTIVE_STATUSES.has(item.status)) {
          throw new Error(`材料 "${item.name}" 正在处理中，无法重建索引`);
        }
      }
    }
    void this.enqueue(baseId, { type: "reindex-subtree", baseId, rootIds: roots.map((root) => root.id) });
  }

  // ---- 调度 ----

  private async scheduleItem(baseId: string, itemIdValue: string, startStatus: "preparing" | "processing"): Promise<void> {
    const store = this.deps.store;
    const item = await store.getItem(baseId, itemIdValue);
    if (!item) return;
    await store.setItemStatus(baseId, itemIdValue, startStatus);
    // 入队即返回：索引在后台链式执行（API 语义 = 任务已接受）
    if (item.type === "directory") {
      void this.enqueue(baseId, { type: "prepare-root", baseId, itemId: itemIdValue });
    } else {
      void this.enqueue(baseId, { type: "index-document", baseId, itemId: itemIdValue });
    }
  }

  // ---- Job 执行 ----

  private async runJob(job: Job): Promise<void> {
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
  private async runPrepareRoot(baseId: string, itemIdValue: string): Promise<void> {
    const store = this.deps.store;
    const item = await store.requireItem(baseId, itemIdValue);
    if (item.status === "deleting") return;

    const files = Array.isArray(item.data?.files) ? (item.data.files as Array<{ name: string; relativePath: string }>) : [];
    const childInputs: AddItemInput[] = files.map((file) => ({
      type: "file",
      name: file.name,
      parentId: itemIdValue,
      groupId: null,
      relativePath: file.relativePath,
    }));
    const children = childInputs.length > 0 ? await store.addItems(baseId, childInputs) : [];

    // 展开完成：容器进入 processing，等待子项
    await store.setItemStatus(baseId, itemIdValue, "processing");
    for (const child of children) {
      await this.scheduleItem(baseId, child.id, "processing");
    }
    await this.reconcileContainer(baseId, itemIdValue);
  }

  /** 叶子索引：读源 → 归一化 → 切块 → (嵌入) → 写 chunks + 更新索引。 */
  private async runIndexDocument(baseId: string, itemIdValue: string): Promise<void> {
    const { store, index } = this.deps;
    const item = await store.requireItem(baseId, itemIdValue);
    if (item.status === "deleting") return;

    await store.setItemStatus(baseId, itemIdValue, "reading");
    const source = await this.readItemSource(item);

    const text = normalizeText(source.text);
    const slices = splitIntoChunks(text, MAX_CHUNK_SIZE, CHUNK_OVERLAP);

    // 决定是否走向量：基配置了 embedding 模型
    const base = await store.requireBase(baseId);
    const vectorBase = Boolean(base.embeddingModelId && base.dimensions);
    let vectors: number[][] | null = null;
    if (vectorBase && slices.length > 0) {
      await store.setItemStatus(baseId, itemIdValue, "embedding");
      const embedding = await this.deps.getEmbedding();
      if (!embedding) {
        throw new Error("知识库配置了 embedding 但当前无法获取 embedding 客户端");
      }
      vectors = await embedding.embedMany(slices.map((slice) => slice.text));
    }

    const chunks: KnowledgeChunk[] = slices.map((slice, index) => ({
      unitId: unitId(`${itemIdValue}:${text.slice(slice.charStart, slice.charEnd)}:${slice.charStart}:${slice.charEnd}`),
      text: slice.text,
      charStart: slice.charStart,
      charEnd: slice.charEnd,
      index,
      vector: vectors ? vectors[index] ?? null : null,
    }));

    await store.saveChunks(baseId, itemIdValue, text, chunks);
    const chunkFile = await store.getChunks(baseId, itemIdValue);
    if (chunkFile) index.upsertItemChunks(baseId, chunkFile, item.name);
    await store.setItemStatus(baseId, itemIdValue, "completed");

    // 若是目录子项，父容器需要重新聚合
    if (item.parentId) {
      await this.reconcileContainer(baseId, item.parentId);
    }
  }

  /** 读取材料源文本。 */
  private async readItemSource(item: KnowledgeItem): Promise<{ text: string }> {
    const store = this.deps.store;
    if (item.type === "note") {
      const content = typeof item.data?.content === "string" ? item.data.content : "";
      if (!content.trim()) throw new Error("笔记内容为空");
      return { text: content };
    }
    if (item.type === "url") {
      const url = typeof item.data?.url === "string" ? item.data.url : "";
      if (!url) throw new Error("缺少 URL");
      // 快照优先：已有快照离线可读；reindex 不重复抓取。
      const snapshotPath = item.indexedRelativePath ?? `snapshots/${item.id}.md`;
      if (await store.rawFileExists(item.baseId, snapshotPath)) {
        const buffer = await store.readRawFile(item.baseId, snapshotPath);
        return { text: buffer.toString("utf8") };
      }
      // 首次索引：抓取并落地快照（导入即快照语义）。
      const snapshot = await fetchUrlSnapshot(url, this.deps.network);
      await store.writeRawFile(item.baseId, snapshotPath, snapshot.markdown);
      await store.updateItem(item.baseId, item.id, { indexedRelativePath: snapshotPath });
      return { text: snapshot.markdown };
    }
    // file：读取 raw 下的副本（快照语义）
    const relativePath = item.indexedRelativePath ?? item.relativePath;
    if (!relativePath) throw new Error("缺少材料文件路径");
    if (!(await store.rawFileExists(item.baseId, relativePath))) {
      throw new Error(`材料源文件缺失: ${relativePath}`);
    }
    const buffer = await store.readRawFile(item.baseId, relativePath);

    // 二进制格式（PDF/Office/图片）：优先读已转换缓存，否则走 MinerU
    if (!isTextLike(relativePath)) {
      const converted = await this.ensureMineruConverted(item, relativePath, buffer);
      return { text: converted };
    }

    const extracted = await extractTextFromBuffer(relativePath, buffer);
    if (!extracted.ok) throw new Error(extracted.reason);
    return extracted;
  }

  /** MinerU 转换：命中缓存或调用 API，产物写 raw/converted/{itemId}.md。 */
  private async ensureMineruConverted(
    item: KnowledgeItem,
    sourcePath: string,
    buffer: Buffer,
  ): Promise<string> {
    const store = this.deps.store;
    const convertedPath = `converted/${item.id}.md`;
    if (item.indexedRelativePath === convertedPath || (await store.rawFileExists(item.baseId, convertedPath))) {
      return (await store.readRawFile(item.baseId, convertedPath)).toString("utf8");
    }
    const mineru = await this.deps.getMineru();
    if (!mineru) {
      throw new Error(
        `二进制格式（${sourcePath.split(".").pop()}），请配置 MinerU 自动转换，或先转换为文本`,
      );
    }
    const result = await mineru.parseFile(item.name || "document", buffer);
    await store.writeRawFile(item.baseId, convertedPath, result.markdown);
    await store.updateItem(item.baseId, item.id, { indexedRelativePath: convertedPath });
    this.deps.log.info(`[mineru] converted ${item.name} (${result.mode}), ${result.markdown.length} chars`);
    return result.markdown;
  }

  private async runDeleteSubtree(baseId: string, rootIds: string[]): Promise<void> {
    const { store, index } = this.deps;
    const all = await this.loadSubtrees(baseId, rootIds);
    // 物理清理：chunks + 索引
    for (const item of all) {
      index.removeItemChunks(baseId, item.id);
      await store.deleteChunks(baseId, item.id);
    }
    // raw 文件：directory 按子树递归删，叶子按文件删
    for (const item of all) {
      if (!item.relativePath) continue;
      if (item.type === "directory") {
        await store.deleteRawTree(baseId, item.relativePath);
      } else {
        await store.deleteRawFile(baseId, item.relativePath);
      }
    }
    // url/note 快照
    for (const item of all) {
      if ((item.type === "url" || item.type === "note") && item.indexedRelativePath) {
        await store.deleteRawFile(baseId, item.indexedRelativePath);
      }
    }
    // 硬删行
    await store.deleteItems(baseId, all.map((item) => item.id));
  }

  private async runReindexSubtree(baseId: string, rootIds: string[]): Promise<void> {
    const { store, index } = this.deps;
    const roots = (await store.listItems(baseId)).filter((item) => rootIds.includes(item.id));
    for (const root of roots) {
      // 1) 删旧 chunks（保留 raw 源文件）
      const subtree = await this.loadSubtree(baseId, root.id);
      for (const item of subtree) {
        index.removeItemChunks(baseId, item.id);
        await store.deleteChunks(baseId, item.id);
      }
      // 2) 移除容器展开产物（descendants），根保留
      const descendants = subtree.filter((item) => item.id !== root.id && item.parentId !== null);
      await store.deleteItems(baseId, descendants.map((item) => item.id));
      // 3) 重置根状态并重新调度
      if (root.type === "directory") {
        await store.setItemStatus(baseId, root.id, "idle", null);
        await this.scheduleItem(baseId, root.id, "preparing");
      } else {
        await store.setItemStatus(baseId, root.id, "idle", null);
        await this.scheduleItem(baseId, root.id, "processing");
      }
    }
  }

  // ---- 容器聚合 ----

  /** 容器状态 = 子项聚合：无活跃子项即 completed（错误显示在子项上）。 */
  private async reconcileContainer(baseId: string, containerId: string): Promise<void> {
    const store = this.deps.store;
    const item = await store.getItem(baseId, containerId);
    if (!item || item.type !== "directory" || item.status === "deleting") return;
    const children = (await store.listItems(baseId)).filter((child) => child.parentId === containerId);
    const hasActive = children.some((child) => ACTIVE_STATUSES.has(child.status));
    if (!hasActive) {
      await store.setItemStatus(baseId, containerId, "completed");
    }
  }

  // ---- 子树工具 ----

  private async collapseToRoots(baseId: string, itemIds: string[]): Promise<KnowledgeItem[]> {
    const store = this.deps.store;
    const items = await store.listItems(baseId);
    const selected = items.filter((item) => itemIds.includes(item.id));
    // 折叠：排除"其某个祖先也在选中集合中"的项
    const selectedIds = new Set(selected.map((item) => item.id));
    return selected.filter((item) => !(item.parentId && selectedIds.has(item.parentId)));
  }

  private async loadSubtree(baseId: string, rootId: string): Promise<KnowledgeItem[]> {
    const store = this.deps.store;
    const items = await store.listItems(baseId);
    const result: KnowledgeItem[] = [];
    const walk = (parentId: string | null): void => {
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

  private async loadSubtrees(baseId: string, rootIds: string[]): Promise<KnowledgeItem[]> {
    const seen = new Set<string>();
    const result: KnowledgeItem[] = [];
    for (const rootId of rootIds) {
      const subtree = await this.loadSubtree(baseId, rootId);
      for (const item of subtree) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
      }
    }
    return result;
  }

  private async markSubtree(baseId: string, rootId: string, status: ItemStatus): Promise<void> {
    const store = this.deps.store;
    const subtree = await this.loadSubtree(baseId, rootId);
    for (const item of subtree) {
      await store.setItemStatus(baseId, item.id, status);
    }
  }

  /** job 失败兜底：把相关材料标记 failed（deleting 任务失败不覆盖状态）。 */
  private async markJobFailed(job: Job, err: unknown): Promise<void> {
    const message = (err as Error)?.message ?? String(err);
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
  async recover(): Promise<void> {
    const { store, index } = this.deps;
    const bases = await store.listBases();
    for (const base of bases) {
      if (base.status === "deleting") continue;
      // 1) 重建内存索引
      const items = await store.listItems(base.id);
      const itemNames = new Map(items.map((item) => [item.id, item.name]));
      const chunkFiles = await store.scanChunks(base.id);
      index.rebuildBase(base.id, chunkFiles, itemNames);

      // 2) 恢复任务
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
}