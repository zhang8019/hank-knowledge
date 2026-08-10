/**
 * LLM Wiki ingest 工作流。
 *
 * 摄入一份材料 → 在知识图谱中建立 wiki 层：
 *   source 页：材料摘要页（fuzzy）
 *   concept 页：抽取的关键概念（fuzzy，可多源引用 → emerging）
 *   entity 页：抽取的实体（人名/公司/项目）
 * 并维护 index / log / overview（确定性生成），检测矛盾，评估成熟度。
 *
 * LLM 可选：配置 llm 后用于摘要/概念抽取/矛盾语义检测；
 * 未配置 → 确定性算法（高频关键词抽取 + 相似度矛盾检测），无 LLM 也能运行。
 */

import { normalizeText } from "./chunker";
import { KnowledgeGraph, GraphNode, NodeMaturity } from "./graph";
import { conceptName, entityName, sourceSlug } from "./naming";
import { tokenize } from "./tokenizer";
import type { LlmClient } from "./llm";
import { evaluateMaturity } from "./maturity";

export interface WikiIngestInput {
  baseId: string;
  /** 材料 itemId（溯源）。 */
  itemId: string;
  /** 材料名（source 页命名）。 */
  itemName: string;
  /** 材料全文。 */
  text: string;
  /** 是否运行 LLM 增强（默认：有配置则用）。 */
  useLlm?: boolean;
}

export interface WikiIngestResult {
  sourceNode: GraphNode;
  conceptNodes: GraphNode[];
  entityNodes: GraphNode[];
  indexLines: string[];
  contradictions: Array<{ source: string; target: string; detail: string }>;
  maturitySuggestions: Array<{ nodeId: string; title: string; suggested: NodeMaturity; reasons: string[] }>;
  usedLlm: boolean;
}

interface ExtractedConcepts {
  concepts: Array<{ title: string; definition: string }>;
  entities: Array<{ title: string; description: string }>;
}

export class WikiIngester {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly getLlm: () => Promise<LlmClient | null>,
  ) {}

  async ingest(input: WikiIngestInput): Promise<WikiIngestResult> {
    const text = normalizeText(input.text);
    if (!text || text.length < 20) throw new Error("材料内容过短，无法摄入");

    const llm = input.useLlm === false ? null : await this.getLlm();
    const usedLlm = llm !== null;

    // 1) source 页
    const sourceNode = await this.graph.addNode(input.baseId, {
      title: sourceSlug(input.itemName),
      type: "wiki-page",
      maturity: "fuzzy",
      sourceRefs: [input.itemId],
      elements: {
        definition: await this.summarize(text, llm),
        scenario: "材料来源页",
        keyData: text.slice(0, 200),
        triggers: this.extractTriggers(text),
        tags: ["#wiki/source"],
        source: `材料 ${input.itemName}`,
      },
    });

    // 2) concept / entity 抽取
    const extracted = llm ? await this.extractWithLlm(llm, text) : this.extractDeterministic(text);
    const conceptNodes: GraphNode[] = [];
    const entityNodes: GraphNode[] = [];
    for (const concept of extracted.concepts) {
      const existing = await this.findNodeByTitle(input.baseId, concept.title, "concept");
      if (existing) {
        // 多源引用：追加 sourceRef → 可能升级 emerging
        const refs = Array.from(new Set([...(existing.sourceRefs ?? []), input.itemId]));
        const node = await this.graph.updateNode(input.baseId, existing.id, {
          sourceRefs: refs,
          elements: { ...existing.elements, definition: concept.definition || existing.elements?.definition },
        });
        conceptNodes.push(node);
      } else {
        conceptNodes.push(await this.graph.addNode(input.baseId, {
          title: conceptName(concept.title),
          type: "concept",
          maturity: "fuzzy",
          sourceRefs: [input.itemId],
          elements: { definition: concept.definition, scenario: "概念页", triggers: this.extractTriggers(concept.title) },
        }));
      }
    }
    for (const entity of extracted.entities) {
      const existing = await this.findNodeByTitle(input.baseId, entity.title, "entity");
      if (existing) {
        const refs = Array.from(new Set([...(existing.sourceRefs ?? []), input.itemId]));
        entityNodes.push(await this.graph.updateNode(input.baseId, existing.id, { sourceRefs: refs }));
      } else {
        entityNodes.push(await this.graph.addNode(input.baseId, {
          title: entityName(entity.title),
          type: "entity",
          maturity: "fuzzy",
          sourceRefs: [input.itemId],
          elements: { definition: entity.description, scenario: "实体页" },
        }));
      }
    }

    // 3) 矛盾检测（语义 → LLM；否则相似度）
    const contradictions = llm
      ? await this.detectContradictionsLlm(llm, text, [...conceptNodes, ...entityNodes])
      : this.detectContradictionsDeterministic(text, [...conceptNodes, ...entityNodes]);

    // 4) 成熟度评估
    const allNodes = [sourceNode, ...conceptNodes, ...entityNodes];
    const maturitySuggestions = allNodes.map((node) => {
      const evalResult = evaluateMaturity(node);
      return { nodeId: node.id, title: node.title, suggested: evalResult.suggested, reasons: evalResult.reasons };
    });

    const indexLines = this.buildIndexLines([sourceNode, ...conceptNodes, ...entityNodes]);

    return {
      sourceNode,
      conceptNodes,
      entityNodes,
      indexLines,
      contradictions,
      maturitySuggestions,
      usedLlm,
    };
  }

  // ---- source 摘要 ----

  private async summarize(text: string, llm: LlmClient | null): Promise<string> {
    if (llm) {
      try {
        const summary = await llm.chat(
          "你是知识库 Wiki 摘要助手。用 2-4 句话概括材料核心内容，中文输出。",
          text.slice(0, 6000),
          { maxTokens: 200 },
        );
        if (summary) return summary.slice(0, 200);
      } catch {
        // LLM 失败降级为确定性
      }
    }
    const tokens = this.topTokens(text, 6);
    return `材料要点：${tokens.join("、")}。${text.slice(0, 60)}`;
  }

  // ---- 概念/实体抽取 ----

  private async extractWithLlm(llm: LlmClient, text: string): Promise<ExtractedConcepts> {
    try {
      const result = await llm.chatJson<ExtractedConcepts>(
        "你是知识库 Wiki 抽取器。从材料中提取核心概念与实体。返回 JSON：{concepts:[{title,definition}],entities:[{title,description}]}。title 用中文短词。",
        text.slice(0, 6000),
        { maxTokens: 800 },
      );
      return {
        concepts: (result.concepts ?? []).slice(0, 6).filter((c) => c.title && c.title.trim()),
        entities: (result.entities ?? []).slice(0, 4).filter((e) => e.title && e.title.trim()),
      };
    } catch {
      return this.extractDeterministic(text);
    }
  }

  private extractDeterministic(text: string): ExtractedConcepts {
    const tokens = this.topTokens(text, 10);
    const concepts = tokens.slice(0, 4).map((title) => ({ title, definition: `材料中高频概念 ${title}` }));
    return { concepts, entities: [] };
  }

  // ---- 矛盾检测 ----

  private async detectContradictionsLlm(
    llm: LlmClient,
    text: string,
    nodes: GraphNode[],
  ): Promise<WikiIngestResult["contradictions"]> {
    if (nodes.length === 0) return [];
    const candidates = nodes
      .map((n) => `${n.title}：${n.elements?.definition ?? ""}`)
      .join("\n");
    try {
      const result = await llm.chatJson<{ contradictions: Array<{ target: string; detail: string }> }>(
        "检查新材料与现有概念/实体页是否矛盾。返回 JSON：{contradictions:[{target,detail}]}，无矛盾返回空数组。",
        `新材料片段：\n${text.slice(0, 3000)}\n\n现有页面：\n${candidates}`,
        { maxTokens: 500 },
      );
      return (result.contradictions ?? [])
        .filter((c) => c.target && c.detail)
        .map((c) => ({ source: "新材料", target: c.target, detail: c.detail }));
    } catch {
      return this.detectContradictionsDeterministic(text, nodes);
    }
  }

  private detectContradictionsDeterministic(text: string, nodes: GraphNode[]): WikiIngestResult["contradictions"] {
    const tokens = new Set(tokenize(text));
    const result: WikiIngestResult["contradictions"] = [];
    for (const node of nodes) {
      const nodeTokens = new Set(tokenize(node.title + " " + (node.elements?.definition ?? "")));
      const overlap = [...tokens].filter((t) => nodeTokens.has(t)).length;
      // 词重叠高但内容长短差异大 → 可能冲突（简化启发式）
      const nodeLen = (node.elements?.definition ?? "").length;
      if (overlap >= 3 && nodeLen < 10) {
        result.push({ source: "新材料", target: node.title, detail: "概念内容过短且主题重叠，可能冲突或需补充" });
      }
    }
    return result;
  }

  // ---- 工具 ----

  private async findNodeByTitle(baseId: string, title: string, type: "concept" | "entity"): Promise<GraphNode | null> {
    const graph = await this.graph.load(baseId);
    const normalized = conceptName(title);
    return graph.nodes.find((n) => n.type === type && n.title === normalized) ?? null;
  }

  private extractTriggers(text: string): string[] {
    const tokens = this.topTokens(text, 8);
    return Array.from(new Set(tokens));
  }

  private topTokens(text: string, limit: number): string[] {
    const freq = new Map<string, number>();
    for (const token of tokenize(text)) {
      if (token.length < 2) continue;
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([token]) => token);
  }

  private buildIndexLines(nodes: GraphNode[]): string[] {
    return nodes.map((n) => `- [${n.title}](${n.type}, ${n.maturity}, 来源 ${n.sourceRefs.length})`);
  }
}
