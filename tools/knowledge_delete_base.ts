import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_delete_base";
export const description = "永久删除知识库及其全部材料与索引（不可恢复，需确认）。";

export const sessionPermission = {
  kind: "review",
  description: "永久删除整个知识库（材料、快照与索引）",
  sideEffect: { summary: "删除知识库全部数据" },
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
  },
  required: ["baseId"],
};

export async function execute(input: { baseId: string }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const base = await service.getBase(input.baseId);
    if (!base) throw new Error(`知识库不存在: ${input.baseId}`);
    await service.deleteBase(input.baseId);
    return okText(`知识库「${base.name}」已删除。`, { deleted: true });
  });
}