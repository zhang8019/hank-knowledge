/** 工具公共辅助：统一错误处理与响应形状。 */

import { ensureRuntime } from "../lib/runtime";
import type { KnowledgeService } from "../lib/knowledge";

/** 从工具调用上下文获取服务（惰性初始化运行时，不依赖 onload 顺序）。 */
export function serviceOf(ctx: unknown): KnowledgeService {
  return ensureRuntime(ctx as never).service;
}

export function okText(text: string, details: Record<string, unknown> = {}): {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function failText(err: unknown): {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `错误: ${message}` }],
    details: { error: message },
  };
}

/** 工具执行包装：把异常转成可读错误文本返回，避免宿主抛出原始堆栈。 */
export async function guard<T>(
  run: () => Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }>,
): Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }> {
  try {
    return await run();
  } catch (err) {
    return failText(err);
  }
}