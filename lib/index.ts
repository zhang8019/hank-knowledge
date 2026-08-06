/**
 * 检索门面：按知识库维护 BM25 + 向量双车道内存索引。
 *
 * 文档元数据表记录 docId → chunk 归属，供检索结果映射与
 * item 状态过滤。chunks 变化时增量更新（重建单 item）。
 */

import { Bm25Index } from "./bm25";
import { fuseByRrf, rankedFromMap } from "./hybrid";
import { tokenize } from "./tokenizer";
import { VectorIndex } from "./vectors";
import type { ChunkFile, KnowledgeChunk } from "./store";

export interface IndexSearchHit {
  chunkId: string;
  itemId: string;
  pageContent: string;
  score: number;
  scoreKind: "relevance" | "ranking";
  rank: number;
  metadata: {
    chunkIndex: number;
    itemName?: string;
  };
}

export interface IndexSearchOptions {
  topK: number;
  /** 超取倍数（Cherry: topK × overfetch，供过滤/截断）。 */
  overfetch?: number;
  useVector?: boolean;
  /** 查询向量（useVector 时由调用方嵌入）。 */
  queryVector?: number[];
}

interface DocMeta {
  docId: number;
  itemId: string;
  chunkIndex: number;
  text: string;
  itemName?: string;
  vector: number[] | null;
}

interface BaseIndex {
  bm25: Bm25Index;
  vectors: VectorIndex;
  docs: DocMeta[];
  nextDocId: number;
}

export class MemoryIndex {
  private bases = new Map<string, BaseIndex>();

  private base(id: string): BaseIndex {
    let entry = this.bases.get(id);
    if (!entry) {
      entry = { bm25: new Bm25Index(), vectors: new VectorIndex(), docs: [], nextDocId: 0 };
      this.bases.set(id, entry);
    }
    return entry;
  }

  /** 全量重建一个库的索引。 */
  rebuildBase(baseId: string, chunkFiles: ChunkFile[], itemNames?: Map<string, string>): void {
    const entry = this.base(baseId);
    const docs: DocMeta[] = [];
    const bm25Docs = [];
    const vectorDocs = [];
    let docId = 0;
    for (const file of chunkFiles) {
      for (const chunk of file.chunks) {
        const meta: DocMeta = {
          docId,
          itemId: file.itemId,
          chunkIndex: chunk.index,
          text: chunk.text,
          itemName: itemNames?.get(file.itemId),
          vector: chunk.vector,
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
  upsertItemChunks(baseId: string, chunkFile: ChunkFile, itemName?: string): void {
    const entry = this.base(baseId);
    this.removeItemChunks(baseId, chunkFile.itemId);
    for (const chunk of chunkFile.chunks) {
      const meta: DocMeta = {
        docId: entry.nextDocId,
        itemId: chunkFile.itemId,
        chunkIndex: chunk.index,
        text: chunk.text,
        itemName,
        vector: chunk.vector,
      };
      entry.docs.push(meta);
      entry.bm25.add({ docId: meta.docId, tokens: tokenize(chunk.text) });
      if (chunk.vector) entry.vectors.add({ docId: meta.docId, vector: chunk.vector });
      entry.nextDocId += 1;
    }
  }

  /** 移除一个 item 的全部文档。 */
  removeItemChunks(baseId: string, itemId: string): void {
    const entry = this.bases.get(baseId);
    if (!entry) return;
    const removed = entry.docs.filter((doc) => doc.itemId === itemId);
    for (const doc of removed) {
      entry.bm25.remove(doc.docId);
      if (doc.vector) entry.vectors.remove(doc.docId);
    }
    if (removed.length > 0) {
      entry.docs = entry.docs.filter((doc) => doc.itemId !== itemId);
    }
  }

  /** 释放一个库的全部索引。 */
  dropBase(baseId: string): void {
    this.bases.delete(baseId);
  }

  /**
   * 检索。返回排序后的命中（不在此处过滤 item 状态）。
   * BM25-only 基（useVector=false）走单车道；向量基走 RRF 混合。
   */
  search(baseId: string, query: string, options: IndexSearchOptions): IndexSearchHit[] {
    const entry = this.bases.get(baseId);
    if (!entry) return [];
    const overfetch = options.topK * (options.overfetch ?? 5);
    const limit = Math.max(1, overfetch);

    const bm25Scores = entry.bm25.search(query);
    const bm25Lane = rankedFromMap(bm25Scores).slice(0, limit);

    let fused: Array<{ id: number; score: number }>;
    let scoreKind: "relevance" | "ranking" = "ranking";

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
    return fused
      .map((item, rank): IndexSearchHit | null => {
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
            ...(doc.itemName ? { itemName: doc.itemName } : {}),
          },
        };
      })
      .filter((hit): hit is IndexSearchHit => hit !== null);
  }

  /** 某个 item 的 chunk 列表（list-item-chunks 用）。 */
  listItemChunks(baseId: string, itemId: string): Array<{ chunkIndex: number; text: string; vector: number[] | null }> {
    const entry = this.bases.get(baseId);
    if (!entry) return [];
    return entry.docs
      .filter((doc) => doc.itemId === itemId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((doc) => ({ chunkIndex: doc.chunkIndex, text: doc.text, vector: doc.vector }));
  }
}

/** 无持久化 unitId 时的稳定性兜底：chunk id 与 Cherry 语义等价（itemId + 内容 + 序号）。 */
function stableChunkId(itemId: string, chunkIndex: number): string {
  return `${itemId}#${chunkIndex}`;
}

export type { KnowledgeChunk, ChunkFile };