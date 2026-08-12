import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_wiki_ingest";
export const description =
  "把材料摄入到知识库的 Wiki（生成 Markdown 摘要页 + 关键词，索引更新）。材料可以是已完成索引的 itemId，或直接传文本。";

export const sessionPermission = {
  kind: "routine",
  description: "在知识库 Wiki 中写入摘要页",
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "目标知识库 id" },
    itemId: { type: "string", description: "材料 itemId（读取其全文生成摘要）" },
    text: { type: "string", description: "直接传材料文本（与 itemId 二选一）" },
    name: { type: "string", description: "材料名（wiki 页标题）" },
  },
  required: ["baseId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);

    let text = input.text ?? "";
    let name = input.name ?? "未命名材料";
    if (input.itemId) {
      const { text: full, item } = await service.readItemText(input.baseId, input.itemId);
      text = full;
      name = item.name || name;
    }
    if (!text || !text.trim()) throw new Error("需要 itemId 或 text（材料内容）");

    const result = await service.wikiIngest({ baseId: input.baseId, itemId: input.itemId ?? "manual", itemName: name, text });
    const lines = [
      `已生成 Wiki 页「${result.title}」`,
      `  文件: ${result.filePath}`,
      `  关键词: ${result.keywords.join(", ") || "无"}`,
      `  摘要: ${result.summary.slice(0, 100)}${result.summary.length > 100 ? "…" : ""}`,
    ];
    return okText(lines.join("\n"), { result });
  });
}
