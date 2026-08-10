/**
 * 知识成熟度状态机。
 *
 *   fuzzy ──多源引用──▶ emerging ──人审+验证──▶ codified
 *     ▲                                          │
 *     └────── supersede / 负面反馈×2 ────────────┘（快照降级）
 *
 * 硬规则：
 * - emerging → codified 永不自动，必须由人/Agent 发起（promote 走审查）
 * - codified → fuzzy 自动触发（supersede / 负面反馈加权），但保留完整快照审计
 * - 负面反馈："不准确" → 标记待核查；"无用" → 进入评估池权重 ×2
 */

import type { GraphNode, NodeMaturity } from "./graph";

export interface MaturityEvaluation {
  nodeId: string;
  maturity: NodeMaturity;
  /** 推荐目标成熟度（可能是当前值）。 */
  suggested: NodeMaturity;
  /** 建议原因。 */
  reasons: string[];
  /** 是否建议提升（emerging → codified 需人工确认）。 */
  suggestsPromote: boolean;
  /** 是否建议降级。 */
  suggestsDemote: boolean;
}

export interface MaturityRule {
  /** 达到多少独立来源才认为 emerging。 */
  sourcesToEmerging: number;
  /** 负面反馈多少（加权）触发降级。 */
  demoteNegativeFeedback: number;
  /** 距上次更新超过该毫秒数触发"待核查"提示。 */
  staleAfterMs: number;
}

export const DEFAULT_MATURITY_RULE: MaturityRule = {
  sourcesToEmerging: 2,
  demoteNegativeFeedback: 3,
  staleAfterMs: 90 * 24 * 3600 * 1000, // 90 天
};

/**
 * 评估节点成熟度。
 * 输入节点 + 规则，输出推荐动作（只读，不写）。
 */
export function evaluateMaturity(node: GraphNode, rule: MaturityRule = DEFAULT_MATURITY_RULE): MaturityEvaluation {
  const reasons: string[] = [];
  const sourceCount = node.sourceRefs.length;
  const stats = node.stats;
  // 负面反馈加权：无用 ×2（已体现在 negativeFeedback 计数中）
  const weightedNegative = stats.negativeFeedback;

  let suggested: NodeMaturity = node.maturity;
  let suggestsPromote = false;
  let suggestsDemote = false;

  if (node.maturity === "fuzzy") {
    if (sourceCount >= rule.sourcesToEmerging && stats.hitCount > 0) {
      suggested = "emerging";
      suggestsPromote = true;
      reasons.push(`被 ${sourceCount} 个独立来源引用且已有 ${stats.hitCount} 次命中，达到共识阈值`);
    }
  } else if (node.maturity === "emerging") {
    if (weightedNegative >= rule.demoteNegativeFeedback) {
      suggested = "fuzzy";
      suggestsDemote = true;
      reasons.push(`负面反馈 ${weightedNegative} 次，回落为探索`);
    } else if (stats.hitCount > 0) {
      // emerging → codified 永不自动；仅提示可提交审查
      suggestsPromote = false;
    }
  } else if (node.maturity === "codified") {
    const stale = node.elements?.validity;
    if (stale?.superseded) {
      suggested = "fuzzy";
      suggestsDemote = true;
      reasons.push("已被 supersede 标记，降级回探索并保留审计");
    } else if (weightedNegative >= rule.demoteNegativeFeedback) {
      suggested = "fuzzy";
      suggestsDemote = true;
      reasons.push(`负面反馈 ${weightedNegative} 次，判定不可靠`);
    } else if (stale?.nextCheck && Date.parse(stale.nextCheck) < Date.now()) {
      reasons.push(`已到复核日期（${stale.nextCheck}），建议核查`);
    }
  }

  return { nodeId: node.id, maturity: node.maturity, suggested, reasons, suggestsPromote, suggestsDemote };
}

/**
 * 校验 promote（emerging → codified）门槛。
 * 返回 null 表示通过；否则返回阻止原因。
 * 这是"审查"前置：确保 10 元素关键字段完整。
 */
export function validateCodify(node: GraphNode): string | null {
  const e = node.elements ?? {};
  if (!e.definition || e.definition.trim().length < 8) return "缺少「① 一句话定义」";
  if (!e.scenario || e.scenario.trim().length < 4) return "缺少「② 使用场景」";
  if (!e.keyData || e.keyData.trim().length < 8) return "缺少「③ 核心数据/要点」";
  const triggers = e.triggers ?? [];
  if (triggers.length < 5) return `触发词不足 5 个（当前 ${triggers.length}）`;
  if (!e.source) return "缺少「⑩ 出处定位」";
  if (e.definition.length > 200) return "定义过长，请精简到一句话";
  return null;
}

/** 用户反馈回流：把负面反馈折算为权重（无用 ×2），供评估使用。 */
export function feedbackWeight(kind: "不准确" | "无用"): number {
  return kind === "无用" ? 2 : 1;
}

/** 默认触发"待核查"标记的反馈类型。 */
export function feedbackFlags(kind: "不准确" | "无用"): { pendingReview: boolean; weight: number } {
  return {
    pendingReview: kind === "不准确",
    weight: feedbackWeight(kind),
  };
}
