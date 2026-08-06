import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_create_base";
export const description =
  "创建一个知识库。仅需名称；未配置 embedding 时为 BM25 全文检索，配置后可传 enableVector 创建向量知识库。";

export const sessionPermission = { kind: "routine", description: "在插件数据目录内创建知识库" };

export const parameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "知识库名称" },
    enableVector: {
      type: "boolean",
      description: "是否启用向量检索（需要插件已配置 embedding 服务）",
      default: false,
    },
  },
  required: ["name"],
};

export async function execute(input: { name: string; enableVector?: boolean }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const base = await service.createBase(input.name, { enableVector: Boolean(input.enableVector) });
    const mode = base.embeddingModelId ? "向量 + BM25 混合检索" : "BM25 全文检索";
    return okText(`知识库「${base.name}」已创建 [${base.id}]，当前为${mode}。`, {
      base: {
        id: base.id,
        name: base.name,
        embeddingModelId: base.embeddingModelId,
        dimensions: base.dimensions,
      },
    });
  });
}