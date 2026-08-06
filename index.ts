/**
 * hank-knowledge 插件入口。
 *
 * 生命周期：onload 构建运行时单例并恢复未完成任务（启动恢复）；
 * 注册 bus 能力供宿主与其他插件调用。
 */

import { HANA_BUS_SKIP } from "./lib/types";
import { clearRuntime, getRuntime, initRuntime } from "./lib/runtime";

export default class HankKnowledgePlugin {
  declare ctx: any;

  private disposables: Array<() => void> = [];

  async onload(): Promise<void> {
    const bundle = initRuntime(this.ctx);
    const ctx = bundle.ctx;

    ctx.log.info("[hank-knowledge] plugin loaded, dataDir=", ctx.dataDir);

    // 启动恢复：重建内存索引 + 重试未完成任务 + 幂等删除清理
    await bundle.workflow.recover();

    // 注册 bus 能力（供宿主/其他插件以 requestBus 调用）
    if (ctx.bus.handle) {
      const service = bundle.service;

      this.disposables.push(
        ctx.bus.handle("hank-knowledge:list-bases", async () => {
          return { ok: true, bases: await service.listBases() };
        }),
      );

      this.disposables.push(
        ctx.bus.handle("hank-knowledge:search", async (payload: any) => {
          if (!payload || typeof payload.baseId !== "string" || typeof payload.query !== "string") {
            return HANA_BUS_SKIP;
          }
          const results = await service.search(payload.baseId, payload.query, {
            topK: typeof payload.topK === "number" ? payload.topK : undefined,
          });
          return { ok: true, results };
        }),
      );

      this.disposables.push(
        ctx.bus.handle("hank-knowledge:add-items", async (payload: any) => {
          if (!payload || typeof payload.baseId !== "string" || !Array.isArray(payload.items)) {
            return HANA_BUS_SKIP;
          }
          const items = await service.addItems(payload.baseId, payload.items);
          return { ok: true, items };
        }),
      );
    }

    this.ctx.log.info("[hank-knowledge] ready");
  }

  async onunload(): Promise<void> {
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
    clearRuntime(this.ctx.pluginId);
    this.ctx.log.info("[hank-knowledge] plugin unloaded");
  }
}

export { getRuntime };