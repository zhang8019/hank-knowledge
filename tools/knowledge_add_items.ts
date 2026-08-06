import { serviceOf } from "./_util";
import { guard, okText } from "./_util";

export const name = "knowledge_add_items";
export const description =
  "向知识库添加材料（导入即复制快照）。支持四种类型：file（文件内容）、note（笔记文本）、url（网页地址，索引时抓取快照）、directory（一组文件）。返回材料 id，索引在后台异步完成。";

export const sessionPermission = {
  kind: "routine",
  description: "向插件知识库写入材料副本并触发后台索引",
};

export const parameters = {
  type: "object",
  properties: {
    baseId: { type: "string", description: "目标知识库 id" },
    items: {
      type: "array",
      description: "要添加的材料列表",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["file", "note", "url", "directory"],
            description: "材料类型",
          },
          name: { type: "string", description: "显示名 / 文件名" },
          content: { type: "string", description: "file/note 的文本内容" },
          url: { type: "string", description: "url 类型的抓取地址" },
          files: {
            type: "array",
            description: "directory 类型的子文件列表",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                content: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["type", "name"],
      },
    },
  },
  required: ["baseId", "items"],
};

export async function execute(input: {
  baseId: string;
  items: Array<{
    type: "file" | "note" | "url" | "directory";
    name: string;
    content?: string;
    url?: string;
    files?: Array<{ name: string; content?: string }>;
  }>;
}, ctx: any) {
  return guard(async () => {
    const service = serviceOf(ctx);
    const base = await service.getBase(input.baseId);
    if (!base) throw new Error(`知识库不存在: ${input.baseId}`);
    const created = await service.addItems(input.baseId, input.items);
    const lines = created.map((item) => `- ${item.name} [${item.id}] ${item.type}`);
    return okText(`已接受 ${created.length} 个材料，正在后台索引：\n${lines.join("\n")}`, {
      baseId: input.baseId,
      items: created.map((item) => ({ id: item.id, name: item.name, type: item.type })),
    });
  });
}