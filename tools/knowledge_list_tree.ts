import { serviceOf } from "./_util";
import { guard, okText } from "./_util";
import { MATURITY_LABELS } from "../lib/graph";

export const name = "knowledge_list_tree";
export const description =
  "列出知识库中的神经树结构：按主干分组展示神经元（codified 节点）+ 突触连接，供 Agent 快速了解树形态。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    verbose: { type: "boolean", description: "是否输出神经元详情（10元素），默认 false" },
  },
  required: ["baseId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const graph = await service.getGraph(input.baseId);
    const neurons = graph.nodes.filter((n: any) => n.type === "neuron");
    if (neurons.length === 0) {
      return okText("该知识库没有神经树。可使用 knowledge_build_tree 从材料构建。", { branches: [] });
    }
    // 按 tag 分组展示
    const groups = new Map<string, any[]>();
    for (const n of neurons) {
      const tag = n.elements?.tags?.[0] ?? "未分类";
      const list = groups.get(tag) ?? [];
      list.push(n);
      groups.set(tag, list);
    }
    const lines: string[] = [];
    const branches: any[] = [];
    let idx = 0;
    for (const [tag, nodes] of groups) {
      idx += 1;
      lines.push(`主干${idx}：${tag}`);
      branches.push({ title: tag, neurons: nodes });
      for (const n of nodes) {
        const label = (MATURITY_LABELS as Record<string, string>)[n.maturity] ?? n.maturity;
        const triggers = (n.elements?.triggers ?? []).join(" | ");
        lines.push(`  - ${n.title} [${label}] 触发词: ${triggers || "—"}`);
        if (input.verbose) {
          const e = n.elements ?? {};
          lines.push(`    定义: ${e.definition ?? "—"}`);
          lines.push(`    场景: ${e.scenario ?? "—"}`);
          lines.push(`    出处: ${e.source ?? "—"}`);
        }
      }
    }
    const synapseCount = graph.edges.filter((e: any) => e.kind === "synapse").length;
    return okText(`神经树共 ${neurons.length} 神经元 / ${synapseCount} 突触\n\n${lines.join("\n")}`, {
      branchCount: branches.length,
      neuronCount: neurons.length,
      synapseCount,
      branches,
    });
  });
}
