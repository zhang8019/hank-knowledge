/**
 * BM25 全文检索（纯 JS 实现）。
 *
 * 对应 Cherry 检索双车道中的 keyword/BM25 lane。索引在内存构建，
 * 随 chunks 增量更新；短中文查询退化为单字命中（LIKE fallback 思路）。
 */

import { tokenize, tokenizeQuery } from "./tokenizer";

export interface Bm25Document {
  /** 全局文档序号（指向索引持有方的 chunk 记录）。 */
  docId: number;
  tokens: string[];
}

interface Posting {
  docId: number;
  tf: number;
}

const K1 = 1.5;
const B = 0.75;

export class Bm25Index {
  private docs: Array<{ tokens: string[]; docLength: number }> = [];
  private postings = new Map<string, Posting[]>();
  private totalTokens = 0;

  get size(): number {
    return this.docs.length;
  }

  /** 全量重建。 */
  rebuild(documents: Bm25Document[]): void {
    this.docs = [];
    this.postings = new Map();
    this.totalTokens = 0;
    for (const doc of documents) {
      this.add(doc);
    }
  }

  /** 增量添加一个文档。 */
  add(doc: Bm25Document): void {
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
  remove(docId: number): void {
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
  search(query: string): Map<number, number> {
    const queryTokens = uniqueTokens(tokenizeQuery(query));
    if (queryTokens.length === 0) return new Map();

    const docCount = this.docs.length;
    if (docCount === 0) return new Map();
    const avgDocLength = this.totalTokens / docCount;

    const scores = new Map<number, number>();
    for (const term of queryTokens) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.length;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      for (const { docId, tf } of posting) {
        const docLength = this.docs[docId]?.docLength ?? 0;
        const denom = tf + K1 * (1 - B + B * (docLength / avgDocLength));
        const score = idf * ((tf * (K1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }
    return scores;
  }
}

function dedupePreservingFirst(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

function uniqueTokens(tokens: string[]): string[] {
  return dedupePreservingFirst(tokens);
}

export { tokenize }; // 复用入口