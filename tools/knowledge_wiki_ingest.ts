import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_wiki_ingest";
export const description =
  "把一份材料摄入到 Wiki 层（LLM Wiki）：生成 source 摘要页 + 抽取 concept/entity 页 + 更新索引 + 矛盾检测 + 成熟度评估。配置 LLM 时增强抽取，否则确定性算法。";

export const sessionPermission = { kind: "external_side_effect", auto: "review" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    text: { type: "string", description: "材料全文" },
    itemName: { type: "string", description: "材料名（source 页命名）" },
    itemId: { type: "string", description: "关联材料 itemId（溯源，可选）" },
    useLlm: { type: "boolean", description: "是否使用 LLM 增强（默认：有配置则用）" },
  },
  required: ["baseId", "text"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const result = await service.wikiIngest({
      baseId: input.baseId,
      itemId: input.itemId ?? "manual",
      itemName: input.itemName ?? "未命名材料",
      text: input.text,
      useLlm: input.useLlm,
    });
    const lines = [
      `已摄入「${input.itemName ?? "材料"}」到 Wiki（${result.usedLlm ? "LLM 增强" : "确定性算法"}）`,
      `  source 页: ${result.sourceNode.title}`,
      `  concept 页: ${result.conceptNodes.map((n) => n.title).join(", ") || "无"}`,
      `  entity 页: ${result.entityNodes.map((n) => n.title).join(", ") || "无"}`,
    ];
    if (result.contradictions.length > 0) {
      lines.push(`  ⚠️ 矛盾 ${result.contradictions.length} 处:`);
      for (const c of result.contradictions) lines.push(`    - ${c.target}: ${c.detail}`);
    }
    const promote = result.maturitySuggestions.filter((s) => s.suggested === "emerging");
    if (promote.length > 0) {
      lines.push(`  💡 建议提升 emerging: ${promote.map((p) => p.title).join(", ")}`);
    }
    return okText(lines.join("\n"), { result });
  });
}
