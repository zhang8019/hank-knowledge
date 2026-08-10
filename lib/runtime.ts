/**
 * 运行时单例：把插件生命周期构建的 service 暴露给
 * 静态 `tools/*.js` 命名导出模块与 routes。
 *
 * 宿主按"文件 + 命名导出"加载 tools，每个文件是独立 bundle，
 * 因此单例必须挂在进程级 globalThis（按 pluginId 隔离），
 * 保证所有工具共享同一份 store / workflow 链 / 内存索引，
 * 避免多个工作流并发写同一数据。
 */

import { EmbeddingClient } from "./embedding";
import { KnowledgeGraph } from "./graph";
import { MemoryIndex } from "./index";
import { KnowledgeService } from "./knowledge";
import { LlmClient } from "./llm";
import { MineruClient } from "./mineru";
import { RerankClient } from "./rerank";
import { KnowledgeStore } from "./store";
import { KnowledgeWorkflow } from "./workflow";
import type { HanaPluginContext } from "./types";

export interface RuntimeBundle {
  ctx: HanaPluginContext;
  store: KnowledgeStore;
  index: MemoryIndex;
  graph: KnowledgeGraph;
  workflow: KnowledgeWorkflow;
  service: KnowledgeService;
}

function globalSlot(pluginId: string): string {
  return `__hankKnowledgeRuntime_${pluginId}`;
}

function globalAny(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export function initRuntime(ctx: HanaPluginContext): RuntimeBundle {
  const store = new KnowledgeStore(ctx.dataDir);
  const index = new MemoryIndex();
  const graph = new KnowledgeGraph(store);
  const getEmbedding = () => EmbeddingClient.fromConfig(ctx.config, ctx.network);
  const getRerank = () => RerankClient.fromConfig(ctx.config, ctx.network);
  const getMineru = () => MineruClient.fromConfig(ctx.config, ctx.network);
  const workflow = new KnowledgeWorkflow({
    store,
    index,
    getEmbedding,
    getMineru,
    network: ctx.network,
    log: ctx.log,
  });
  const getLlm = () => LlmClient.fromConfig(ctx.config, ctx.network);
  const service = new KnowledgeService({
    store,
    index,
    graph,
    workflow,
    getEmbedding,
    getRerank,
    getLlm,
    network: ctx.network,
    config: ctx.config,
    log: ctx.log,
  });
  const bundle: RuntimeBundle = { ctx, store, index, graph, workflow, service };
  globalAny()[globalSlot(ctx.pluginId)] = bundle;
  return bundle;
}

/** routes / tools 可能先于插件 onload 执行：未初始化时用传入 ctx 惰性构建。 */
export function ensureRuntime(ctx: HanaPluginContext): RuntimeBundle {
  const existing = globalAny()[globalSlot(ctx.pluginId)] as RuntimeBundle | undefined;
  return existing ?? initRuntime(ctx);
}

export function getRuntime(pluginId: string): RuntimeBundle {
  const existing = globalAny()[globalSlot(pluginId)] as RuntimeBundle | undefined;
  if (!existing) {
    throw new Error(`hank-knowledge runtime 尚未初始化（插件 ${pluginId} 未加载）`);
  }
  return existing;
}

export function clearRuntime(pluginId: string): void {
  const existing = globalAny()[globalSlot(pluginId)] as RuntimeBundle | undefined;
  if (existing) {
    existing.workflow.stop();
    delete globalAny()[globalSlot(pluginId)];
  }
}