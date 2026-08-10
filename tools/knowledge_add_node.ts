import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_add_node";
export const description =
  "在知识库中创建图谱节点（神经元 / wiki 页 / entity / concept），fuzzy 起步。神经元可携带 10 元素（定义/场景/要点/触发词/标签/出处等），触发词用于精确命中检索。";

export const sessionPermission = { kind: "plugin_output", auto: "allow" };

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "知识库 ID" },
    title: { type: "string", description: "节点标题（按命名规范自动清洗）" },
    type: {
      type: "string",
      enum: ["neuron", "wiki-page", "entity", "concept"],
      description: "节点类型，默认 wiki-page",
    },
    definition: { type: "string", description: "① 一句话定义（neuron 必填）" },
    scenario: { type: "string", description: "② 使用场景（neuron 必填）" },
    keyData: { type: "string", description: "③ 核心数据/要点（≥25 字，含数字）" },
    triggers: {
      type: "array",
      items: { type: "string" },
      description: "④ 触发词（≥5 个，精确词在前）",
    },
    tags: { type: "array", items: { type: "string" }, description: "⑤ 标签，如 #法律/合同法" },
    decisionTemplate: { type: "string", description: "⑥ 判定模板（线性步骤或判定树）" },
    misjudgmentDefenses: {
      type: "array",
      items: { type: "string" },
      description: "⑦ 误判防御（≥3 条）",
    },
    checkList: {
      type: "array",
      items: { type: "string" },
      description: "⑧ 检查清单（≥3 条可现场执行）",
    },
    source: { type: "string", description: "⑩ 出处定位 + 可信度，如 《民法典》§562 → L1" },
    sourceRefs: {
      type: "array",
      items: { type: "string" },
      description: "关联材料 itemId 列表",
    },
    maturity: {
      type: "string",
      enum: ["fuzzy", "emerging"],
      description: "起始成熟度，默认 fuzzy",
    },
  },
  required: ["baseId", "title"],
};

export async function execute(input: any, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const node = await service.addGraphNode(input.baseId, {
      title: input.title,
      type: input.type ?? "wiki-page",
      maturity: input.maturity ?? "fuzzy",
      sourceRefs: input.sourceRefs,
      elements: {
        definition: input.definition,
        scenario: input.scenario,
        keyData: input.keyData,
        triggers: input.triggers,
        tags: input.tags,
        decisionTemplate: input.decisionTemplate,
        misjudgmentDefenses: input.misjudgmentDefenses,
        checkList: input.checkList,
        source: input.source,
      },
    });
    return okText(`已创建节点「${node.title}」(${node.type}, ${node.maturity}, id=${node.id})`, { node });
  });
}
