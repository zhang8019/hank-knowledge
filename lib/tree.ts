/**
 * 神经树文档模型与 Markdown 渲染/解析。
 *
 * 一棵神经树 = 领域知识的结构化表示，渲染为对齐骨架 v3.1 模板的 Markdown：
 *   # 神经树｜《领域名》vX.X
 *   > 统计 / 领域 / 版本
 *   ## 🌱 根：一句话穿透本质（3 判断题）
 *   ## 🌿 主干N：{主题}  →  🧠 N{序号}·{名称}（10 元素表格）
 *   ## 🔗 突触区（树内 / 跨树）
 *   ## 📊 自检清单
 *
 * 与 graph.json 双向同步：渲染树时从 GraphNode 生成；解析时回填。
 */

import { GraphNode, GraphEdge, MATURITY_LABELS } from "./graph";
import { neuronName } from "./naming";

export interface TreeBranch {
  index: number;
  title: string;
  neurons: GraphNode[];
}

export interface TreeDocument {
  domain: string;
  version: { major: number; minor: number };
  fileId?: string;
  root?: { essence: string; questions: string[] };
  branches: TreeBranch[];
  treeEdges: GraphEdge[];
  crossTreeEdges: GraphEdge[];
  selfCheck?: string;
}

export interface RenderTreeOptions {
  domain: string;
  major?: number;
  minor?: number;
  root?: { essence: string; questions: string[] };
  branches: TreeBranch[];
  treeEdges?: GraphEdge[];
  crossTreeEdges?: GraphEdge[];
  selfCheck?: string;
}

/** 渲染一棵神经树为 Markdown（对齐骨架模板）。 */
export function renderTreeMd(opts: RenderTreeOptions): string {
  const major = opts.major ?? 1;
  const minor = opts.minor ?? 0;
  const neuronCount = opts.branches.reduce((sum, b) => sum + b.neurons.length, 0);
  const synapseCount = (opts.treeEdges?.length ?? 0) + (opts.crossTreeEdges?.length ?? 0);
  const lines: string[] = [];

  lines.push(`# 神经树｜《${opts.domain}》v${major}.${minor}`);
  lines.push("");
  lines.push(`> **统计：${neuronCount}N / ${synapseCount}突触 / ${endingsCount(opts.branches)}末梢**`);
  lines.push(`> **领域：${opts.domain}**`);
  lines.push(`> **版本：v${major}.${minor} | 由 hank-knowledge 生成**`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // 根
  if (opts.root) {
    lines.push("## 🌱 根（Root）：一句话穿透本质");
    lines.push("");
    lines.push(`> **${opts.root.essence}**`);
    lines.push("");
    if (opts.root.questions.length > 0) {
      lines.push("**3 个判断题验证**：");
      lines.push("");
      opts.root.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q}`);
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // 主干 + 神经元
  for (const branch of opts.branches) {
    lines.push(`## 🌿 主干${branch.index}：${branch.title}`);
    lines.push("");
    for (const neuron of branch.neurons) {
      lines.push(`### 🧠 ${neuron.title}`);
      lines.push("");
      lines.push(renderNeuronTable(neuron));
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  // 突触区
  lines.push("## 🔗 突触区");
  lines.push("");
  if (opts.treeEdges && opts.treeEdges.length > 0) {
    lines.push("### 树内突触");
    lines.push("");
    lines.push("| 突触 | 关系类型 | 强度 | 逻辑 |");
    lines.push("|------|---------|------|------|");
    for (const edge of opts.treeEdges) {
      lines.push(`| ${edge.source} ──${edge.relation ?? ""}── ${edge.target} | ${edge.kind} | ${"★".repeat(edge.strength)} | ${edge.relation ?? ""} |`);
    }
    lines.push("");
  }
  if (opts.crossTreeEdges && opts.crossTreeEdges.length > 0) {
    lines.push("### 跨树突触");
    lines.push("");
    lines.push("| 源节点 | 目标节点 | 关联类型 | 优先级 |");
    lines.push("|--------|---------|---------|--------|");
    for (const edge of opts.crossTreeEdges) {
      lines.push(`| ${edge.source} | ${edge.target} | ${edge.relation ?? ""} | ${"★".repeat(edge.strength)} |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  // 自检清单
  lines.push("## 📊 自检清单");
  lines.push("");
  lines.push("```");
  lines.push(opts.selfCheck ?? "□ 待运行验证器");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/** 渲染单个神经元的 10 元素表格。 */
export function renderNeuronTable(neuron: GraphNode): string {
  const e = neuron.elements ?? {};
  const rows: Array<[string, string]> = [
    ["**① 一句话定义**", e.definition ?? ""],
    ["**② 使用场景**", e.scenario ?? ""],
    ["**③ 核心数据/要点**", e.keyData ?? ""],
    ["**④ 触发词**", (e.triggers ?? []).join("｜")],
    ["**⑤ 标签**", (e.tags ?? []).join(" ")],
    ["**⑥ 判定模板**", e.decisionTemplate ?? ""],
    ["**⑦ 误判防御**", (e.misjudgmentDefenses ?? []).join("；")],
    ["**⑧ 检查清单**", (e.checkList ?? []).map((c) => `□ ${c}`).join(" ")].filter(([_, v]) => Boolean(v)) as [string, string],
  ];
  const extra: Array<[string, string]> = [];
  if (e.source) extra.push(["**⑩ 出处定位**", e.source]);
  if (e.validity?.verifiedAt) {
    const superseded = e.validity.superseded ? "是" : "否";
    extra.push(["**⑪ 证据链/有效期**", `验证日期：${e.validity.verifiedAt}；superseded：${superseded}`]);
  }
  const all = [...rows.filter(([, v]) => Boolean(v)), ...extra];
  const table = [
    "| 元素 | 内容 |",
    "|------|------|",
    ...all.map(([k, v]) => `| ${k} | ${escapeMd(v)} |`),
  ];
  const maturityBadge = `> 成熟度：${MATURITY_LABELS[neuron.maturity]} | 来源材料：${(neuron.sourceRefs ?? []).length} 个`;
  return [maturityBadge, "", ...table].join("\n");
}

/** 解析神经树 Markdown → TreeDocument（尽力而为，供导入/验证用）。 */
export function parseTreeMd(markdown: string, domain = "未知领域"): Partial<TreeDocument> {
  const result: Partial<TreeDocument> = { domain, branches: [] };
  const rootMatch = markdown.match(/🌱\s*根[^\n]*\n\n>?\s*\*\*(.+?)\*\*/);
  if (rootMatch) result.root = { essence: rootMatch[1], questions: [] };
  const questionMatches = markdown.matchAll(/\d\.\s*(.+)/g);
  if (result.root) {
    for (const m of questionMatches) {
      if (result.root.questions.length < 3) result.root.questions.push(m[1]);
    }
  }
  return result;
}

function endingsCount(_branches: TreeBranch[]): number {
  return 0; // 末梢暂由用户自定义，默认 0
}

function escapeMd(text: string): string {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export { neuronName };
