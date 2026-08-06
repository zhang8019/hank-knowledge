import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_read_item";
export const description = "读取知识库中某个材料的完整源文本（file 读 raw 副本、url 读已抓取快照、note 读正文）。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    itemId: { type: "string", description: "材料 id（可由 knowledge_search 的返回结果获得）" },
    maxChars: {
      type: "number",
      description: "返回文本上限字符数，避免超长材料撑爆上下文",
    },
  },
  required: ["baseId", "itemId"],
};

export async function execute(input: { baseId: string; itemId: string; maxChars?: number }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const { text, item } = await service.readItemText(input.baseId, input.itemId);
    const maxChars = input.maxChars && input.maxChars > 0 ? Math.min(input.maxChars, 200_000) : 20_000;
    const shown = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(已截断，全文 ${text.length} 字符)` : text;
    return okText(shown, { item: { id: item.id, name: item.name, type: item.type }, fullLength: text.length });
  });
}