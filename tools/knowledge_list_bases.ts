import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_list_bases";
export const description = "列出当前用户可见的全部知识库及其材料统计（只读，无需参数）。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute(_input: unknown, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const bases = await service.listBases();
    if (bases.length === 0) {
      return okText("当前没有任何知识库。可使用 knowledge_create_base 创建。", { bases: [] });
    }
    const lines = bases.map((base) => {
      const vector = base.embeddingModelId ? `（向量: ${base.embeddingModelId}）` : "（BM25 全文检索）";
      return `- ${base.name} [${base.id}] ${base.status}${base.status === "failed" ? `: ${base.error ?? "未知错误"}` : ""} ${vector} 材料 ${base.itemCount} 项 / 已完成 ${base.completedCount}`;
    });
    return okText(lines.join("\n"), { bases });
  });
}