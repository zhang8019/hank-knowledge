import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_retry_item";
export const description = "重试失败（failed）的知识库材料：重新读取源并重建索引。用于 embedding 配置修复或临时网络故障后。";

export const sessionPermission = {
  kind: "routine",
  description: "重建插件知识库中失败材料的索引",
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    itemId: { type: "string", description: "失败的材料 id" },
  },
  required: ["baseId", "itemId"],
};

export async function execute(input: { baseId: string; itemId: string }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    await service.retryItem(input.baseId, input.itemId);
    return okText(`已接受重试，正在后台重建索引。`, { itemId: input.itemId });
  });
}