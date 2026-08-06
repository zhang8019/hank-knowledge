import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_list_item_chunks";
export const description = "查看知识库中某个已完成材料被切分出的检索片段（chunk）清单，含片段序号与是否带向量。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    itemId: { type: "string", description: "材料 id" },
    limit: { type: "number", description: "最多返回的片段数（默认 50）" },
  },
  required: ["baseId", "itemId"],
};

export async function execute(input: { baseId: string; itemId: string; limit?: number }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const chunks = await service.listItemChunks(input.baseId, input.itemId);
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 50;
    const shown = chunks.slice(0, limit);
    const lines = shown.map((chunk) => {
      const vector = chunk.vector ? "向量 ✓" : "纯文本";
      return `[#${chunk.chunkIndex} ${vector}] ${clip(chunk.text, 120)}`;
    });
    return okText(
      `共 ${chunks.length} 个片段（显示前 ${shown.length} 个）：\n${lines.join("\n")}`,
      { chunkCount: chunks.length, chunks: shown },
    );
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}