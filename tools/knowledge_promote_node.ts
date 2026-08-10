import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_promote_node";
export const description =
  "提升图谱节点成熟度（emerging → codified，即编译为神经树判定单元）。需节点 10 元素关键字段完整（定义/场景/要点/触发词≥5/出处），否则报错；可 force 强制。";

export const sessionPermission = { kind: "external_side_effect", auto: "review" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    nodeId: { type: "string", description: "目标节点 id" },
    force: {
      type: "boolean",
      description: "跳过字段完整性校验（不推荐），默认 false",
    },
  },
  required: ["baseId", "nodeId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const node = await service.promoteNode(input.baseId, input.nodeId, { force: Boolean(input.force) });
    return okText(`节点「${node.title}」已提升为 codified（神经树判定单元）`, { node });
  });
}
