import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_reindex_items";
export const description =
  "重建指定材料（或整个知识库全部根材料）的索引。仅允许对已完结（completed/failed）的材料执行；适用于修改内容后或 embedding 配置变化后。";

export const sessionPermission = {
  kind: "routine",
  description: "重建插件知识库中材料的索引",
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    itemIds: {
      type: "array",
      items: { type: "string" },
      description: "要重建的材料 id；省略则重建全部根材料",
    },
  },
  required: ["baseId"],
};

export async function execute(input: { baseId: string; itemIds?: string[] }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const itemIds = input.itemIds?.length
      ? input.itemIds
      : (await service.listItems(input.baseId))
          .filter((item) => item.parentId === null)
          .map((item) => item.id);
    await service.reindexItems(input.baseId, itemIds);
    return okText(`已接受 ${itemIds.length} 个材料的索引重建，正在后台执行。`, { itemIds });
  });
}