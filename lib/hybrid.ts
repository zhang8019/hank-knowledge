/**
 * 混合检索：BM25 与向量两条车道的 RRF 融合。
 *
 * 与 Cherry 一致：基于排名的融合（rank-based），因此两条车道
 * 不兼容的分数量纲无需归一化。
 */

export interface RankedItem {
  id: number;
  score: number;
}

const RRF_K = 60;

/**
 * @param lanes 每条车道的候选（已按各自分数降序），长度不限。
 * @param limit 融合后的条数上限。
 */
export function fuseByRrf(lanes: RankedItem[][], limit: number): RankedItem[] {
  const totals = new Map<number, number>();
  for (const lane of lanes) {
    lane.forEach((item, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      totals.set(item.id, (totals.get(item.id) ?? 0) + contribution);
    });
  }
  return [...totals.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 把 Map<docId, score> 转成降序 RankedItem[]。 */
export function rankedFromMap(scores: Map<number, number>): RankedItem[] {
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}