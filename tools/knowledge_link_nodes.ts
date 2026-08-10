import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_link_nodes";
export const description =
  "在知识图谱中建立节点关联（突触 / wikilink）。relation 可选：因果延伸/互斥对比/层级深化/流程衔接/参数共享。";

export const sessionPermission = { kind: "plugin_output", auto: "allow" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    source: { type: "string", description: "源节点 id" },
    target: { type: "string", description: "目标节点 id" },
    kind: {
      type: "string",
      enum: ["synapse", "wikilink", "inferred", "hierarchy"],
      description: "边类型，默认 synapse（突触）",
    },
    relation: {
      type: "string",
      enum: ["因果延伸", "互斥对比", "层级深化", "流程衔接", "参数共享"],
      description: "关联类型",
    },
    strength: {
      type: "number",
      minimum: 1,
      maximum: 5,
      description: "强度 ★1-5，默认 3",
    },
    bidirectional: {
      type: "boolean",
      description: "是否双向关联，默认 false",
    },
  },
  required: ["baseId", "source", "target"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const edge = await service.linkGraphNodes(input.baseId, {
      source: input.source,
      target: input.target,
      kind: input.kind ?? "synapse",
      relation: input.relation,
      strength: input.strength,
      bidirectional: input.bidirectional,
    });
    return okText(`已建立关联 ${edge.source} → ${edge.target}（${edge.kind}${edge.relation ? `, ${edge.relation}` : ""}, ★${edge.strength}）`, { edge });
  });
}
