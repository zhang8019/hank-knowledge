import { serviceOf } from "./_util";
import { guard, okText } from "./_util";
import { MATURITY_LABELS } from "../lib/graph";

export const name = "knowledge_list_graph";
export const description = "查看指定知识库的知识图谱：节点（神经元/wiki 页/entity/concept）+ 边 + 成熟度统计。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    maturity: {
      type: "string",
      enum: ["fuzzy", "emerging", "codified"],
      description: "按成熟度过滤（可选）",
    },
  },
  required: ["baseId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const graph = await service.getGraph(input.baseId);
    const nodes = input.maturity
      ? graph.nodes.filter((n: any) => n.maturity === input.maturity)
      : graph.nodes;
    if (nodes.length === 0) {
      return okText("该知识库暂无图谱节点。可使用 knowledge_add_node 创建节点。", { nodes: [], edges: graph.edges });
    }
    const lines = nodes.map((n: any) => {
      const triggers = n.elements?.triggers?.length ?? 0;
      const label = (MATURITY_LABELS as Record<string, string>)[n.maturity] ?? n.maturity;
      return `- [${label}] ${n.title} (${n.type}, id=${n.id}, 触发词 ${triggers}, 边 ${n.outbound.length} 出)`;
    });
    return okText(lines.join("\n"), {
      nodeCount: nodes.length,
      edgeCount: graph.edges.length,
      triggerCount: graph.triggerCount,
      nodes,
      edges: graph.edges,
    });
  });
}
