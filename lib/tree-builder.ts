/**
 * 自动建树（一本书 → 一棵神经树）。
 *
 * 两阶段：
 * 阶段 A（大纲抽取，确定性为主）：按 Markdown 标题层级切主干 → 段落聚类成神经元。
 *   可选 LLM 增强（未来 P3 接入）：领域识别 / 神经元命名 / 触发词生成。
 * 阶段 B（落树）：渲染 Markdown 树文件 + 同步 graph 节点（codified）+ 树内突触 + 全局索引。
 *
 * 确定性算法（无 LLM 也能跑）：
 * - 标题解析：`#` 章节 → 主干（按层级分组）
 * - 段落聚类：每主干下按空行分块，超过阈值块切分成神经元候选
 * - 命名：章节标题清洗 → `主干{序号}：{主题}`；神经元用「主题 + 关键词」自动命名
 * - 触发词：从文本提取中英文关键词（复用 tokenizer）+ 章节标题词
 */

import { normalizeText } from "./chunker";
import { KnowledgeGraph, GraphEdge, GraphNode } from "./graph";
import { branchName, neuronName, treeFileName, uniqueName } from "./naming";
import { tokenize } from "./tokenizer";
import type { KnowledgeStore } from "./store";
import { renderTreeMd } from "./tree";
import type { TreeBranch } from "./tree";
import { edgeId } from "./graph";

export interface TreeBuildInput {
  /** 目标知识库 baseId。 */
  baseId: string;
  /** 领域名（书名/主题）。 */
  domain: string;
  /** 材料文本（Markdown 优先）。 */
  text: string;
  /** 关联材料 itemId（溯源）。 */
  sourceRefs?: string[];
  major?: number;
  minor?: number;
  /** 每主干最多神经元数（防超大）。 */
  maxNeuronsPerBranch?: number;
}

export interface TreeBuildResult {
  treeMarkdown: string;
  fileName: string;
  branches: TreeBranch[];
  nodeCount: number;
  edgeCount: number;
}

const DEFAULT_MAX_NEURONS_PER_BRANCH = 8;
const MIN_NEURON_CHARS = 40;

/** 建树阶段的神经元候选（尚未落 graph）。 */
interface RawNeuron {
  title: string;
  content: string;
}

/** 建树阶段的原始分支（尚未落 graph）。 */
interface RawBranch {
  index: number;
  title: string;
  neurons: RawNeuron[];
}

export class TreeBuilder {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly graph: KnowledgeGraph,
  ) {}

  /** 构建一棵树：生成 Markdown + 写入 graph 节点/突触。 */
  async build(input: TreeBuildInput): Promise<TreeBuildResult> {
    const text = normalizeText(input.text);
    if (!text || text.length < 50) {
      throw new Error("材料内容过短，无法构建神经树");
    }
    const baseId = input.baseId;
    const maxPerBranch = input.maxNeuronsPerBranch ?? DEFAULT_MAX_NEURONS_PER_BRANCH;
    const sections = this.parseSections(text);
    const branches: RawBranch[] = [];

    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const neurons = this.buildNeurons(section, i + 1, maxPerBranch);
      if (neurons.length === 0) continue;
      branches.push({ index: i + 1, title: section.title, neurons });
    }
    if (branches.length === 0) {
      throw new Error("无法从材料中提取主干结构，请使用带章节标题的 Markdown");
    }

    // 落树到 graph（codified 神经元 + 树内突触）
    const graphBranches = await this.syncToGraph(baseId, branches);

    const treeMarkdown = renderTreeMd({
      domain: input.domain,
      major: input.major ?? 1,
      minor: input.minor ?? 0,
      root: { essence: `${input.domain} 的神经树判定引擎`, questions: ["该领域最底层的运作逻辑？", "反过来描述还成立吗？", "一句话讲给外行听？"] },
      branches: graphBranches,
      treeEdges: this.buildTreeEdges(graphBranches),
      selfCheck: `□ 10元素完整？\n□ 触发词≥5？\n□ 判定模板可执行？\n□ 误判防御≥3？\n□ 出处含可信度？`,
    });

    const fileName = treeFileName(input.domain, input.major ?? 1, input.minor ?? 0);
    const totalNeurons = graphBranches.reduce((sum, b) => sum + b.neurons.length, 0);
    return {
      treeMarkdown,
      fileName,
      branches: graphBranches,
      nodeCount: totalNeurons,
      // 树内突触 = 全树神经元串联（首神经元无入边），总神经元 - 1
      edgeCount: Math.max(0, totalNeurons - 1),
    };
  }

  // ---- 阶段 A：文本结构解析 ----

  private parseSections(text: string): Array<{ title: string; body: string }> {
    const lines = text.split("\n");
    const sections: Array<{ title: string; body: string }> = [];
    let current: { title: string; body: string[] } | null = null;
    let headingLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        // 顶层标题（# 或 ##）作为主干边界
        if (level <= 2) {
          if (current && current.body.join("\n").trim().length >= MIN_NEURON_CHARS) {
            sections.push({ title: headingMatch[2].trim(), body: current.body.join("\n") });
          }
          current = { title: headingMatch[2].trim(), body: [] };
          headingLevel = level;
          continue;
        }
      }
      if (current) current.body.push(line);
      void headingLevel;
    }
    if (current && current.body.join("\n").trim().length >= MIN_NEURON_CHARS) {
      sections.push({ title: current.title, body: current.body.join("\n") });
    }
    return sections;
  }

  private buildNeurons(section: { title: string; body: string }, branchIndex: number, max: number): RawNeuron[] {
    // 段落聚类
    const blocks = section.body
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b.length >= MIN_NEURON_CHARS);

    const neurons: RawNeuron[] = [];
    const perBlock = Math.ceil(blocks.length / max);
    for (let i = 0; i < blocks.length; i += perBlock) {
      if (neurons.length >= max) break;
      const chunk = blocks.slice(i, i + perBlock).join("\n\n");
      if (chunk.trim().length < MIN_NEURON_CHARS) continue;
      const keywords = this.extractKeywords(chunk);
      const title = uniqueName(
        neuronName({ branchIndex, subject: keywords[0] ?? section.title }),
        neurons.map((n) => n.title),
      );
      neurons.push({ title, content: chunk });
    }
    return neurons.slice(0, max);
  }

  private extractKeywords(text: string): string[] {
    const tokens = tokenize(text);
    const freq = new Map<string, number>();
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    // 中英文各取频率最高且较长的
    return [...freq.entries()]
      .filter(([token]) => token.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([token]) => token);
  }

  // ---- 阶段 B：落树到 graph ----

  private async syncToGraph(baseId: string, branches: RawBranch[]): Promise<TreeBranch[]> {
    const result: TreeBranch[] = [];
    let prev: GraphNode | null = null;

    for (const branch of branches) {
      const graphNodes: GraphNode[] = [];
      for (const neuron of branch.neurons) {
        const node = await this.graph.addNode(baseId, {
          title: neuron.title,
          type: "neuron",
          maturity: "codified",
          sourceRefs: [],
          elements: {
            definition: neuron.content.slice(0, 80),
            scenario: branch.title,
            keyData: neuron.content.slice(0, 120),
            triggers: this.extractKeywords(neuron.content).slice(0, 8),
            tags: [`#${branch.title}`],
            source: `由「${branch.title}」章节自动生成 → L3`,
            validity: { verifiedAt: new Date().toISOString().slice(0, 10), superseded: false, nextCheck: addMonths(6) },
          },
        });
        graphNodes.push(node);
        if (prev) {
          await this.graph.linkNodes(baseId, {
            source: prev.id,
            target: node.id,
            kind: "synapse",
            relation: "流程衔接",
            strength: 3,
          });
        }
        prev = node;
      }
      result.push({ index: branch.index, title: branch.title, neurons: graphNodes });
    }
    return result;
  }

  private buildTreeEdges(branches: TreeBranch[]): GraphEdge[] {
    const edges: GraphEdge[] = [];
    let prev: GraphNode | null = null;
    for (const branch of branches) {
      for (const node of branch.neurons) {
        if (prev) {
          edges.push({
            id: edgeId(),
            source: prev.id,
            target: node.id,
            kind: "synapse",
            relation: "流程衔接",
            strength: 3,
            createdAt: Date.now(),
          });
        }
        prev = node;
      }
    }
    return edges;
  }
}

function addMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export { branchName };
