import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_wiki_lint";
export const description =
  "Wiki 全库体检（只读）：孤儿页（无任何连接）/ 稀疏页（内容过短）/ 成熟度提升建议。供周期性检查与数据缺口发现。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
  },
  required: ["baseId"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const report = await service.wikiLint(input.baseId);
    const lines = [
      `Wiki 页面总数: ${report.pageCount}`,
    ];
    if (report.orphans.length > 0) {
      lines.push(`  🔴 孤儿页 ${report.orphans.length}: ${report.orphans.join(", ")}`);
    } else {
      lines.push("  ✅ 无孤儿页");
    }
    if (report.sparse.length > 0) {
      lines.push(`  🟡 稀疏页 ${report.sparse.length}: ${report.sparse.join(", ")}`);
    }
    if (report.maturitySuggestions.length > 0) {
      lines.push(`  💡 成熟度建议 ${report.maturitySuggestions.length}:`);
      for (const s of report.maturitySuggestions.slice(0, 10)) {
        lines.push(`    - ${s.title} → ${s.suggested}（${s.reasons.join("；")}）`);
      }
    }
    return okText(lines.join("\n"), { report });
  });
}
