/**
 * 统一知识图谱数据层。
 *
 * 底层是"一张节点-边图"：node = 神经元 / wiki 页 / entity / concept，
 * edge = 突触 / wikilink / inferred / hierarchy。每个节点带 maturity
 * 字段决定形态（fuzzy / emerging / codified）。
 *
 * 持久化（与 store 同构的原子写）：
 *   {dataDir}/bases/{baseId}/graph.json   节点 + 边 + 触发词/tag 倒排索引
 *
 * 设计要点：
 * - 触发词索引与 BM25 互补：前者结构化精确命中，后者语义召回
 * - 全部写入走 store.writeJsonAtomic（Windows rename 原子替换 + per-path 队列）
 */

import { randomUUID } from "node:crypto";
import { tokenize } from "./tokenizer";
import type { KnowledgeStore } from "./store";

// ---- 类型 ----

export type NodeMaturity = "fuzzy" | "emerging" | "codified";
export type GraphNodeType = "neuron" | "wiki-page" | "entity" | "concept";
export type EdgeKind = "synapse" | "wikilink" | "inferred" | "hierarchy";
export type EdgeRelation = "因果延伸" | "互斥对比" | "层级深化" | "流程衔接" | "参数共享";

export interface GraphNodeElements {
  definition?: string;
  scenario?: string;
  keyData?: string;
  triggers?: string[];
  tags?: string[];
  decisionTemplate?: string;
  misjudgmentDefenses?: string[];
  checkList?: string[];
  source?: string;
  validity?: { verifiedAt?: string; superseded?: boolean; nextCheck?: string };
}

export interface GraphNodeStats {
  hitCount: number;
  negativeFeedback: number;
  lastHitAt: number | null;
  lastUpdatedAt: number;
}

export interface GraphNode {
  id: string;
  baseId: string;
  type: GraphNodeType;
  maturity: NodeMaturity;
  title: string;
  elements?: GraphNodeElements;
  /** 关联材料 itemId（溯源）。 */
  sourceRefs: string[];
  inbound: string[];
  outbound: string[];
  stats: GraphNodeStats;
  createdAt: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  relation?: EdgeRelation;
  /** 0~5（★），0 表示未标注。 */
  strength: number;
  bidirectional?: boolean;
  /** inferred 边：0~1 置信度。 */
  inferredConfidence?: number;
  createdAt: number;
}

export interface GraphSnapshot {
  /** 降级/升级前的节点快照（审计）。 */
  node: GraphNode;
  at: number;
  reason?: string;
  by?: string;
}

export interface GraphFile {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 触发词倒排索引：trigger → nodeId[]。 */
  triggerIndex: Record<string, string[]>;
  /** tag 倒排索引：tag → nodeId[]。 */
  tagIndex: Record<string, string[]>;
  /** 节点成熟度变更审计链。 */
  audit: Array<{ nodeId: string; from: NodeMaturity; to: NodeMaturity; at: number; reason?: string }>;
  updatedAt: number;
}

export interface NodeInput {
  type?: GraphNodeType;
  maturity?: NodeMaturity;
  title: string;
  elements?: GraphNodeElements;
  sourceRefs?: string[];
}

export interface EdgeInput {
  source: string;
  target: string;
  kind?: EdgeKind;
  relation?: EdgeRelation;
  strength?: number;
  bidirectional?: boolean;
  inferredConfidence?: number;
}

// ---- 图谱类 ----

export class KnowledgeGraph {
  private cache = new Map<string, GraphFile | null>();

  constructor(private readonly store: KnowledgeStore) {}

  private graphPath(baseId: string): string {
    return `${baseId}/graph.json`;
  }

  /** 读取（带进程内缓存）。不存在返回空图。 */
  async load(baseId: string): Promise<GraphFile> {
    const key = this.graphPath(baseId);
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const data = await this.store.readGraph(baseId);
    const graph = (data as unknown as GraphFile | null) ?? emptyGraph();
    this.cache.set(key, graph);
    return graph;
  }

  async save(baseId: string, graph: GraphFile): Promise<void> {
    graph.updatedAt = Date.now();
    await this.store.writeGraph(baseId, graph);
    this.cache.set(this.graphPath(baseId), graph);
  }

  async invalidate(baseId: string): Promise<void> {
    this.cache.delete(this.graphPath(baseId));
  }

  // ---- 节点 ----

  async addNode(baseId: string, input: NodeInput): Promise<GraphNode> {
    const graph = await this.load(baseId);
    const existing = graph.nodes.find((n) => n.title === input.title && n.type === (input.type ?? "wiki-page"));
    if (existing) throw new Error(`节点已存在: ${input.title}`);
    const node: GraphNode = {
      id: nodeId(),
      baseId,
      type: input.type ?? "wiki-page",
      maturity: input.maturity ?? "fuzzy",
      title: input.title,
      elements: input.elements ?? {},
      sourceRefs: input.sourceRefs ?? [],
      inbound: [],
      outbound: [],
      stats: emptyStats(),
      createdAt: Date.now(),
    };
    graph.nodes.push(node);
    rebuildIndexes(graph);
    await this.save(baseId, graph);
    return node;
  }

  async getNode(baseId: string, nodeIdValue: string): Promise<GraphNode | null> {
    const graph = await this.load(baseId);
    return graph.nodes.find((n) => n.id === nodeIdValue) ?? null;
  }

  async requireNode(baseId: string, nodeIdValue: string): Promise<GraphNode> {
    const node = await this.getNode(baseId, nodeIdValue);
    if (!node) throw new Error(`节点不存在: ${nodeIdValue}`);
    return node;
  }

  async updateNode(baseId: string, nodeIdValue: string, patch: Partial<Pick<GraphNode, "title" | "elements" | "sourceRefs">>): Promise<GraphNode> {
    const graph = await this.load(baseId);
    const index = graph.nodes.findIndex((n) => n.id === nodeIdValue);
    if (index < 0) throw new Error(`节点不存在: ${nodeIdValue}`);
    const next: GraphNode = { ...graph.nodes[index], ...patch, id: nodeIdValue, baseId };
    if (patch.title) {
      const dup = graph.nodes.find((n) => n.id !== nodeIdValue && n.title === patch.title);
      if (dup) throw new Error(`标题冲突: ${patch.title}`);
    }
    graph.nodes[index] = next;
    rebuildIndexes(graph);
    await this.save(baseId, graph);
    return next;
  }

  async deleteNode(baseId: string, nodeIdValue: string): Promise<void> {
    const graph = await this.load(baseId);
    graph.nodes = graph.nodes.filter((n) => n.id !== nodeIdValue);
    graph.edges = graph.edges.filter((e) => e.source !== nodeIdValue && e.target !== nodeIdValue);
    graph.audit = graph.audit.filter((a) => a.nodeId !== nodeIdValue);
    rebuildIndexes(graph);
    await this.save(baseId, graph);
  }

  // ---- 边 ----

  async linkNodes(baseId: string, input: EdgeInput): Promise<GraphEdge> {
    const graph = await this.load(baseId);
    const sourceNode = graph.nodes.find((n) => n.id === input.source);
    const targetNode = graph.nodes.find((n) => n.id === input.target);
    if (!sourceNode) throw new Error(`源节点不存在: ${input.source}`);
    if (!targetNode) throw new Error(`目标节点不存在: ${input.target}`);
    const dup = graph.edges.find((e) => e.source === input.source && e.target === input.target);
    if (dup) return dup;

    const edge: GraphEdge = {
      id: edgeId(),
      source: input.source,
      target: input.target,
      kind: input.kind ?? "synapse",
      relation: input.relation,
      strength: input.strength ?? 3,
      bidirectional: input.bidirectional ?? false,
      inferredConfidence: input.inferredConfidence,
      createdAt: Date.now(),
    };
    graph.edges.push(edge);
    linkRefs(sourceNode, targetNode, input.bidirectional ?? false);
    await this.save(baseId, graph);
    return edge;
  }

  async unlinkNodes(baseId: string, edgeIdValue: string): Promise<void> {
    const graph = await this.load(baseId);
    const edge = graph.edges.find((e) => e.id === edgeIdValue);
    if (!edge) return;
    graph.edges = graph.edges.filter((e) => e.id !== edgeIdValue);
    // 重算关联（保守：直接重算所有受影响节点的 in/out）
    for (const node of graph.nodes) {
      node.inbound = graph.edges.filter((e) => e.target === node.id).map((e) => e.source);
      node.outbound = graph.edges.filter((e) => e.source === node.id).map((e) => e.target);
    }
    await this.save(baseId, graph);
  }

  // ---- 检索（触发词 / tag） ----

  /** 触发词精确命中 → 节点（按成熟度排序：codified 优先）。 */
  async findByTrigger(baseId: string, query: string): Promise<GraphNode[]> {
    const graph = await this.load(baseId);
    const tokens = tokenize(query);
    const hits = new Set<string>();
    // 精确触发词 + token 重叠
    const rawQuery = query.toLowerCase();
    for (const [trigger, ids] of Object.entries(graph.triggerIndex)) {
      if (rawQuery.includes(trigger.toLowerCase()) || tokens.some((t) => trigger.toLowerCase().includes(t))) {
        for (const id of ids) hits.add(id);
      }
    }
    return graph.nodes
      .filter((n) => hits.has(n.id))
      .sort((a, b) => maturityRank(b.maturity) - maturityRank(a.maturity));
  }

  async findByTag(baseId: string, tag: string): Promise<GraphNode[]> {
    const graph = await this.load(baseId);
    const ids = graph.tagIndex[tag] ?? [];
    return graph.nodes.filter((n) => ids.includes(n.id));
  }

  /** 节点出边（含关联节点）。 */
  async neighbors(baseId: string, nodeIdValue: string): Promise<{ node: GraphNode; edge: GraphEdge }[]> {
    const graph = await this.load(baseId);
    const result: { node: GraphNode; edge: GraphEdge }[] = [];
    for (const edge of graph.edges) {
      let targetId: string | null = null;
      if (edge.source === nodeIdValue) targetId = edge.target;
      else if (edge.target === nodeIdValue && edge.bidirectional) targetId = edge.source;
      if (targetId === null) continue;
      const node = graph.nodes.find((n) => n.id === targetId);
      if (node) result.push({ node, edge });
    }
    return result;
  }

  // ---- 成熟度 ----

  /** 变更节点成熟度（写审计链）。 */
  async setMaturity(baseId: string, nodeIdValue: string, maturity: NodeMaturity, reason?: string): Promise<GraphNode> {
    const graph = await this.load(baseId);
    const index = graph.nodes.findIndex((n) => n.id === nodeIdValue);
    if (index < 0) throw new Error(`节点不存在: ${nodeIdValue}`);
    const from = graph.nodes[index].maturity;
    if (from === maturity) return graph.nodes[index];
    const node = { ...graph.nodes[index], maturity };
    graph.nodes[index] = node;
    graph.audit.push({ nodeId: nodeIdValue, from, to: maturity, at: Date.now(), reason });
    await this.save(baseId, graph);
    return node;
  }

  /** 记录命中统计（检索命中时调用）。 */
  async recordHit(baseId: string, nodeIdValue: string, negative = false): Promise<void> {
    const graph = await this.load(baseId);
    const index = graph.nodes.findIndex((n) => n.id === nodeIdValue);
    if (index < 0) return;
    const stats = graph.nodes[index].stats;
    graph.nodes[index] = {
      ...graph.nodes[index],
      stats: {
        hitCount: stats.hitCount + 1,
        negativeFeedback: stats.negativeFeedback + (negative ? 1 : 0),
        lastHitAt: Date.now(),
        lastUpdatedAt: stats.lastUpdatedAt,
      },
    };
    await this.save(baseId, graph);
  }

  // ---- 级联 ----

  /** 删除知识库时的清理（随 base 删除，此处仅清缓存）。 */
  async dropBase(baseId: string): Promise<void> {
    this.cache.delete(this.graphPath(baseId));
  }
}

// ---- 工具 ----

export function nodeId(): string {
  return `nd_${randomUUID().replace(/-/g, "")}`;
}

export function edgeId(): string {
  return `ed_${randomUUID().replace(/-/g, "")}`;
}

export function emptyGraph(): GraphFile {
  return { version: 1, nodes: [], edges: [], triggerIndex: {}, tagIndex: {}, audit: [], updatedAt: Date.now() };
}

/** 从节点 elements 重建触发词/tag 倒排索引。 */
export function rebuildIndexes(graph: GraphFile): void {
  const triggerIndex: Record<string, string[]> = {};
  const tagIndex: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    for (const trigger of node.elements?.triggers ?? []) {
      const key = trigger.trim();
      if (!key) continue;
      (triggerIndex[key] ??= []).push(node.id);
    }
    for (const tag of node.elements?.tags ?? []) {
      const key = tag.trim();
      if (!key) continue;
      (tagIndex[key] ??= []).push(node.id);
    }
  }
  graph.triggerIndex = triggerIndex;
  graph.tagIndex = tagIndex;
}

function linkRefs(source: GraphNode, target: GraphNode, bidirectional: boolean): void {
  if (!source.outbound.includes(target.id)) source.outbound.push(target.id);
  if (!target.inbound.includes(source.id)) target.inbound.push(source.id);
  if (bidirectional) {
    if (!target.outbound.includes(source.id)) target.outbound.push(source.id);
    if (!source.inbound.includes(target.id)) source.inbound.push(target.id);
  }
}

export function maturityRank(maturity: NodeMaturity): number {
  return maturity === "codified" ? 3 : maturity === "emerging" ? 2 : 1;
}

export function emptyStats(): GraphNodeStats {
  return { hitCount: 0, negativeFeedback: 0, lastHitAt: null, lastUpdatedAt: Date.now() };
}

export const MATURITY_LABELS: Record<NodeMaturity, string> = {
  fuzzy: "探索",
  emerging: "共识",
  codified: "已编译",
};
