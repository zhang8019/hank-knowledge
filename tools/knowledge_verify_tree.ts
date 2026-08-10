import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_verify_tree";
export const description =
  "对知识库中的神经树运行验证器（V1-V17）：10元素完整 / 触发词≥5 / 判定模板可执行 / 误判防御≥3 / 检查清单 / 突触 / 根验证 / Header统计 / 出处可信度 / 矛盾检测等，输出健康度。";

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
    const report = await service.verifyTree(input.baseId);
    const lines = [
      `健康度：${report.healthScore}/100（${report.healthLevel}）`,
      `通过 ${report.passedCount} 项 / 失败 ${report.failedCount} 项`,
      "",
      ...report.checks.map((c) => `${c.passed ? "✅" : "❌"} ${c.id} ${c.name}：${c.detail}`),
    ];
    return okText(lines.join("\n"), { report });
  });
}
