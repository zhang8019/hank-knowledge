import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_delete_items";
export const description = "从知识库删除指定材料（含子项与索引，需确认）。可传入多个材料 id。";

export const sessionPermission = {
  kind: "review",
  description: "删除知识库中的材料（副本、快照与索引）",
  sideEffect: { summary: "删除知识库内材料" },
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    itemIds: {
      type: "array",
      items: { type: "string" },
      description: "要删除的材料 id 列表",
    },
  },
  required: ["baseId", "itemIds"],
};

export async function execute(input: { baseId: string; itemIds: string[] }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    await service.deleteItems(input.baseId, input.itemIds);
    return okText(`已接受删除 ${input.itemIds.length} 个材料，正在后台清理。`, {
      itemIds: input.itemIds,
    });
  });
}