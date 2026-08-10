/**
 * 知识库存储层。
 *
 * 职责：知识库 / 材料 / chunks / raw 文件的 JSON 持久化，材料生命周期
 * 状态机。与 Cherry Studio 的 KnowledgeBaseService/KnowledgeItemService
 * 对应，但去掉 SQLite 与向量库，改用插件 dataDir 下的 JSON 文件。
 *
 * 目录布局（dataDir 由宿主提供，位于插件专属数据目录）：
 *   {dataDir}/bases/{baseId}/meta.json      知识库元数据
 *   {dataDir}/bases/{baseId}/items.json     材料数组（业务状态权威）
 *   {dataDir}/bases/{baseId}/chunks/{itemId}.json  检索 chunk（派生数据）
 *   {dataDir}/bases/{baseId}/raw/...        原始材料字节（flat + 目录子树）
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { assertSafeRelativePath, baseId, itemId } from "./ids";

export type ItemStatus =
  | "idle"
  | "preparing" // directory 展开中
  | "processing" // 叶子被接受、索引前
  | "reading" // 正在读取源文档
  | "embedding" // 正在嵌入 chunk
  | "completed"
  | "failed"
  | "deleting"; // 删除标记，物理清理完成后硬删

export type ItemType = "file" | "directory" | "url" | "note";

export const TERMINAL_STATUSES: ReadonlySet<ItemStatus> = new Set(["completed", "failed"]);
export const ACTIVE_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "idle",
  "preparing",
  "processing",
  "reading",
  "embedding",
]);
/** 业务可见状态：默认列表/搜索排除 deleting。 */
export const VISIBLE_STATUSES: ReadonlySet<ItemStatus> = new Set([
  ...ACTIVE_STATUSES,
  "completed",
  "failed",
]);

export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** completed = 可检索；failed = 可恢复的基级失败（如缺 embedding 模型）。 */
  status: "completed" | "failed" | "deleting";
  error: string | null;
  /** BM25-only 基为 null。 */
  embeddingModelId: string | null;
  dimensions: number | null;
  /** 配置重排序后，检索对候选片段重排（relevance 分数）。null = 不重排。 */
  rerankModelId: string | null;
  documentCount: number;
  threshold: number | null;
}

export interface KnowledgeItem {
  id: string;
  baseId: string;
  type: ItemType;
  name: string;
  status: ItemStatus;
  error: string | null;
  /** 目录层级：子项的 parentId 指向容器。 */
  parentId: string | null;
  /** 逻辑分组树（group 挂载点）。null = 根。 */
  groupId: string | null;
  /** raw/ 下的相对路径（file/directory 导入）。url/note 快照为 snapshots/{id}.md。 */
  relativePath: string | null;
  /** 实际被索引的文件路径（如处理器输出的 md）。 */
  indexedRelativePath: string | null;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeChunk {
  unitId: string;
  text: string;
  charStart: number;
  charEnd: number;
  index: number;
  /** 向量；BM25-only 基为 null。 */
  vector: number[] | null;
}

export interface ChunkFile {
  itemId: string;
  contentHash: string;
  text: string;
  chunks: KnowledgeChunk[];
}

export interface AddItemInput {
  type: ItemType;
  name: string;
  parentId?: string | null;
  groupId?: string | null;
  /** file/directory：导入的目标相对路径（相对 raw/）。 */
  relativePath?: string | null;
  /** url：抓取地址；note：正文内容。 */
  data?: Record<string, unknown>;
}

export type BaseMutation<T> = (ctx: { baseDir: string; base: KnowledgeBase }) => Promise<T>;

export class KnowledgeStore {
  constructor(readonly dataDir: string) {}

  private basesRoot(): string {
    return join(this.dataDir, "bases");
  }

  private baseDir(baseIdValue: string): string {
    return join(this.basesRoot(), baseIdValue);
  }

  private metaPath(baseIdValue: string): string {
    return join(this.baseDir(baseIdValue), "meta.json");
  }

  private itemsPath(baseIdValue: string): string {
    return join(this.baseDir(baseIdValue), "items.json");
  }

  private chunksDir(baseIdValue: string): string {
    return join(this.baseDir(baseIdValue), "chunks");
  }

  private chunkPath(baseIdValue: string, itemIdValue: string): string {
    return join(this.chunksDir(baseIdValue), `${itemIdValue}.json`);
  }

  rawDir(baseIdValue: string): string {
    return join(this.baseDir(baseIdValue), "raw");
  }

  private async ensureBaseDir(baseIdValue: string): Promise<void> {
    await mkdir(this.baseDir(baseIdValue), { recursive: true });
    await mkdir(this.chunksDir(baseIdValue), { recursive: true });
    await mkdir(this.rawDir(baseIdValue), { recursive: true });
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw err;
    }
  }

  /** 每个文件的串行写队列：同一路径的写入排队执行，避免多入口并发写坏同一文件。 */
  private writeQueues = new Map<string, Promise<void>>();

  private writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const previous = this.writeQueues.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.doWriteJsonAtomic(path, value));
    this.writeQueues.set(path, next);
    return next;
  }

  private async doWriteJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // Windows 下 rename 覆盖已存在目标或目标正被读取时会抛 EPERM/EACCES/ENOENT，
    // 退化为"删目标再 rename"，并带指数退避重试。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOENT" || code === "EBUSY") {
          await unlink(path).catch(() => undefined);
          await unlink(tmp).catch(() => undefined);
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

  async listBases(): Promise<KnowledgeBase[]> {
    let names: string[];
    try {
      names = await readdirSafe(this.basesRoot());
    } catch {
      return [];
    }
    const bases: KnowledgeBase[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const base = await this.readJson<KnowledgeBase | null>(this.metaPath(name), null);
      if (base && base.id) bases.push(base);
    }
    return bases.sort((a, b) => b.createdAt - a.createdAt);
  }

  async createBase(
    name: string,
    opts: {
      embeddingModelId?: string | null;
      dimensions?: number | null;
      rerankModelId?: string | null;
      documentCount?: number;
      threshold?: number | null;
    } = {},
  ): Promise<KnowledgeBase> {
    const id = baseId();
    const now = Date.now();
    const base: KnowledgeBase = {
      id,
      name: name.trim() || "未命名知识库",
      createdAt: now,
      updatedAt: now,
      status: "completed",
      error: null,
      embeddingModelId: opts.embeddingModelId ?? null,
      dimensions: opts.dimensions ?? null,
      rerankModelId: opts.rerankModelId ?? null,
      documentCount: opts.documentCount ?? 10,
      threshold: opts.threshold ?? null,
    };
    await this.ensureBaseDir(id);
    await this.writeJsonAtomic(this.metaPath(id), base);
    await this.writeJsonAtomic(this.itemsPath(id), []);
    return base;
  }

  async getBase(id: string): Promise<KnowledgeBase | null> {
    const base = await this.readJson<KnowledgeBase | null>(this.metaPath(id), null);
    return base && base.id ? base : null;
  }

  async requireBase(id: string): Promise<KnowledgeBase> {
    const base = await this.getBase(id);
    if (!base) throw new Error(`知识库不存在: ${id}`);
    return base;
  }

  async patchBase(id: string, patch: Partial<KnowledgeBase>): Promise<KnowledgeBase> {
    const base = await this.requireBase(id);
    const next: KnowledgeBase = { ...base, ...patch, id, updatedAt: Date.now() };
    await this.writeJsonAtomic(this.metaPath(id), next);
    return next;
  }

  async deleteBase(id: string): Promise<void> {
    await rm(this.baseDir(id), { recursive: true, force: true });
  }

  async renameBase(id: string, name: string): Promise<KnowledgeBase> {
    return this.patchBase(id, { name: name.trim() || "未命名知识库" });
  }

  // ---- 材料 ----

  async listItems(baseIdValue: string): Promise<KnowledgeItem[]> {
    return this.readJson<KnowledgeItem[]>(this.itemsPath(baseIdValue), []);
  }

  async getItem(baseIdValue: string, id: string): Promise<KnowledgeItem | null> {
    const items = await this.listItems(baseIdValue);
    return items.find((item) => item.id === id) ?? null;
  }

  async requireItem(baseIdValue: string, id: string): Promise<KnowledgeItem> {
    const item = await this.getItem(baseIdValue, id);
    if (!item) throw new Error(`材料不存在: ${id}`);
    return item;
  }

  /** 创建材料行（业务状态权威）。不触发任何索引工作。 */
  async addItems(baseIdValue: string, inputs: AddItemInput[]): Promise<KnowledgeItem[]> {
    const base = await this.requireBase(baseIdValue);
    if (base.status !== "completed") {
      throw new Error("知识库当前不可用，无法添加材料");
    }
    const items = await this.listItems(baseIdValue);
    const now = Date.now();
    const created: KnowledgeItem[] = [];
    for (const input of inputs) {
      const item: KnowledgeItem = {
        id: itemId(),
        baseId: baseIdValue,
        type: input.type,
        name: input.name || "未命名",
        status: "idle",
        error: null,
        parentId: input.parentId ?? null,
        groupId: input.groupId ?? null,
        relativePath: input.relativePath ?? null,
        indexedRelativePath: null,
        data: input.data ?? {},
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      created.push(item);
    }
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), items);
    return created;
  }

  async updateItem(
    baseIdValue: string,
    id: string,
    patch: Partial<Omit<KnowledgeItem, "id" | "baseId">>,
  ): Promise<KnowledgeItem> {
    const items = await this.listItems(baseIdValue);
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`材料不存在: ${id}`);
    const next: KnowledgeItem = { ...items[index], ...patch, id, baseId: baseIdValue, updatedAt: Date.now() };
    items[index] = next;
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), items);
    return next;
  }

  async setItemStatus(
    baseIdValue: string,
    id: string,
    status: ItemStatus,
    error: string | null = null,
  ): Promise<KnowledgeItem> {
    return this.updateItem(baseIdValue, id, { status, error });
  }

  /** 硬删除材料行。 */
  async deleteItems(baseIdValue: string, ids: string[]): Promise<void> {
    const items = await this.listItems(baseIdValue);
    const keep = items.filter((item) => !ids.includes(item.id));
    await this.writeJsonAtomic(this.itemsPath(baseIdValue), keep);
    for (const id of ids) {
      await this.deleteChunks(baseIdValue, id).catch(() => undefined);
    }
  }

  // ---- raw 文件 ----

  /** 解析 raw 相对路径到绝对路径，防目录穿越。 */
  private rawAbsPath(baseIdValue: string, relativePath: string): string {
    const safe = assertSafeRelativePath(relativePath);
    const root = normalize(this.rawDir(baseIdValue));
    const abs = normalize(join(root, safe));
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new Error(`非法路径: ${relativePath}`);
    }
    return abs;
  }

  async writeRawFile(baseIdValue: string, relativePath: string, content: string | Uint8Array): Promise<string> {
    const abs = this.rawAbsPath(baseIdValue, relativePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return relativePath;
  }

  async readRawFile(baseIdValue: string, relativePath: string): Promise<Buffer> {
    const abs = this.rawAbsPath(baseIdValue, relativePath);
    return readFile(abs);
  }

  async rawFileExists(baseIdValue: string, relativePath: string): Promise<boolean> {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  async deleteRawFile(baseIdValue: string, relativePath: string): Promise<void> {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** 递归删除 raw 下的目录子树（directory 导入）。 */
  async deleteRawTree(baseIdValue: string, relativePath: string): Promise<void> {
    try {
      const abs = this.rawAbsPath(baseIdValue, relativePath);
      await rm(abs, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // ---- chunks ----

  async saveChunks(
    baseIdValue: string,
    itemIdValue: string,
    text: string,
    chunks: KnowledgeChunk[],
  ): Promise<ChunkFile> {
    const file: ChunkFile = {
      itemId: itemIdValue,
      contentHash: hashText(text),
      text,
      chunks,
    };
    await mkdir(this.chunksDir(baseIdValue), { recursive: true });
    await this.writeJsonAtomic(this.chunkPath(baseIdValue, itemIdValue), file);
    return file;
  }

  async getChunks(baseIdValue: string, itemIdValue: string): Promise<ChunkFile | null> {
    return this.readJson<ChunkFile | null>(this.chunkPath(baseIdValue, itemIdValue), null);
  }

  async deleteChunks(baseIdValue: string, itemIdValue: string): Promise<void> {
    try {
      await unlink(this.chunkPath(baseIdValue, itemIdValue));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** 扫描一个库的全部 chunk（检索索引重建用）。 */
  async scanChunks(baseIdValue: string): Promise<ChunkFile[]> {
    let names: string[];
    try {
      names = await readdirSafe(this.chunksDir(baseIdValue));
    } catch {
      return [];
    }
    const files: ChunkFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = await this.readJson<ChunkFile | null>(join(this.chunksDir(baseIdValue), name), null);
      if (file && Array.isArray(file.chunks)) files.push(file);
    }
    return files;
  }

  // ---- 知识图谱 ----

  /** 读取知识库图谱（不存在返回 null）。 */
  async readGraph(baseIdValue: string): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown> | null>(this.graphPath(baseIdValue), null);
  }

  /** 写入知识库图谱（原子替换）。 */
  async writeGraph(baseIdValue: string, graph: unknown): Promise<void> {
    await this.writeJsonAtomic(this.graphPath(baseIdValue), graph);
  }

  /** 删除知识库图谱（删库时）。 */
  async deleteGraph(baseIdValue: string): Promise<void> {
    try {
      await unlink(this.graphPath(baseIdValue));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private graphPath(baseIdValue: string): string {
    return join(this.baseDir(baseIdValue), "graph.json");
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}