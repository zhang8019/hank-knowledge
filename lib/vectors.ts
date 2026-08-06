/**
 * 向量存储与余弦检索（纯 JS，暴力扫描）。
 *
 * 与 Cherry 当前实现一致：不建 ANN 索引，直接扫描向量行按余弦距离排序。
 * 代价随单库向量行数线性增长，适合中小语料库。
 */

export interface VectorDoc {
  docId: number;
  vector: number[];
}

export class VectorIndex {
  private docs = new Map<number, number[]>();
  private norms = new Map<number, number>();

  get size(): number {
    return this.docs.size;
  }

  rebuild(documents: VectorDoc[]): void {
    this.docs.clear();
    this.norms.clear();
    for (const doc of documents) {
      this.add(doc);
    }
  }

  add(doc: VectorDoc): void {
    this.docs.set(doc.docId, doc.vector);
    this.norms.set(doc.docId, l2Norm(doc.vector));
  }

  remove(docId: number): void {
    this.docs.delete(docId);
    this.norms.delete(docId);
  }

  /** 余弦相似度检索：返回 Map<docId, similarity ∈ [-1,1]>。 */
  search(query: number[]): Map<number, number> {
    const queryNorm = l2Norm(query);
    if (queryNorm === 0) return new Map();
    const results = new Map<number, number>();
    for (const [docId, vector] of this.docs) {
      const docNorm = this.norms.get(docId) ?? 0;
      if (docNorm === 0) continue;
      const similarity = dot(vector, query) / (docNorm * queryNorm);
      if (similarity > 0) results.set(docId, similarity);
    }
    return results;
  }
}

export function l2Norm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

export function dot(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}