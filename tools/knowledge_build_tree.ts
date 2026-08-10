import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_build_tree";
export const description =
  "把一本书/一份材料自动编译为神经树（一本书 → 一棵树）：按章节切主干、聚类生成神经元（codified）、自动命名与触发词、树内突触，返回标准 Markdown 树文件。";

export const sessionPermission = { kind: "external_side_effect", auto: "review" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    domain: { type: "string", description: "领域名 / 书名 / 主题，如 《民法典》" },
    text: { type: "string", description: "材料全文（Markdown 优先，需含章节标题）" },
    maxNeuronsPerBranch: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "每主干最多神经元数，默认 8",
    },
  },
  required: ["baseId", "domain", "text"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const result = await service.buildTree({
      baseId: input.baseId,
      domain: input.domain,
      text: input.text,
      maxNeuronsPerBranch: input.maxNeuronsPerBranch,
    });
    return okText(
      `已构建神经树「${input.domain}」：${result.nodeCount} 个神经元 / ${result.edgeCount} 条突触\n文件：${result.fileName}`,
      {
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        fileName: result.fileName,
        treeMarkdown: result.treeMarkdown,
      },
    );
  });
}
