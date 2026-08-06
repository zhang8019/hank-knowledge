import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_search";
export const description =
  "在指定知识库中检索与查询相关的片段（chunk）。返回来源材料、得分与片段文本；结果按相关性排序。检索前请先用 knowledge_list_bases 确认 baseId。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 id" },
    query: { type: "string", description: "检索词 / 问题" },
    topK: {
      type: "number",
      description: "返回条数上限（默认取知识库配置，通常 10）",
    },
  },
  required: ["baseId", "query"],
};

export async function execute(input: { baseId: string; query: string; topK?: number }, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const results = await service.search(input.baseId, input.query, { topK: input.topK });
    if (results.length === 0) {
      return okText("没有检索到相关结果。", { results: [] });
    }
    const lines = results.map((result) => {
      const source = result.itemName ? `《${result.itemName}》` : `[${result.itemId}]`;
      return `${result.rank}. ${source} (score=${result.score.toFixed(4)})\n   ${clip(result.pageContent, 160)}`;
    });
    return okText(lines.join("\n\n"), { results });
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}