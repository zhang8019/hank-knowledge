import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_demote_node";
export const description =
  "降级图谱节点成熟度（codified/emerging → fuzzy，回到探索态）。保留审计快照。常用于 supersede 标记或负面反馈后。";

export const sessionPermission = { kind: "external_side_effect", auto: "review" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    nodeId: { type: "string", description: "目标节点 id" },
    reason: { type: "string", description: "降级原因（写入审计链）" },
  },
  required: ["baseId", "nodeId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const node = await service.demoteNode(input.baseId, input.nodeId, input.reason);
    return okText(`节点「${node.title}」已降级为 fuzzy（探索态）`, { node });
  });
}
