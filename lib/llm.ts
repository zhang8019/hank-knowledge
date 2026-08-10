/**
 * LLM 客户端（OpenAI 兼容 /chat/completions）。
 *
 * 用途：Wiki 摄入（摘要 / 概念抽取 / 矛盾检测）等可选增强。
 * 未配置时返回 null —— 调用方降级为确定性算法（无 LLM 也能运行）。
 */

import type { HanaPluginConfigStore, HanaPluginNetwork } from "./types";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "network" | "response",
  ) {
    super(message);
  }
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly network: HanaPluginNetwork,
  ) {}

  static isConfigured(config: Partial<LlmConfig>): boolean {
    return Boolean(config.baseUrl && config.baseUrl.trim() && config.model && config.model.trim());
  }

  static async fromConfig(
    configStore: HanaPluginConfigStore,
    network: HanaPluginNetwork,
  ): Promise<LlmClient | null> {
    const config: Partial<LlmConfig> = {
      baseUrl: (await configStore.get<string>("llmBaseUrl")) ?? "",
      apiKey: (await configStore.get<string>("llmApiKey")) ?? "",
      model: (await configStore.get<string>("llmModel")) ?? "",
    };
    if (!LlmClient.isConfigured(config)) return null;
    return new LlmClient(config as LlmConfig, network);
  }

  get model(): string {
    return this.config.model;
  }

  /** 单轮对话，返回文本。options.temperature 默认 0（摘要任务）。 */
  async chat(system: string, user: string, options: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: options.temperature ?? 0,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    };
    let response: Response;
    try {
      response = await this.network.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw new LlmError(`LLM 请求失败: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(`LLM 配置错误 (${response.status}): ${text.slice(0, 200)}`, "config");
      }
      throw new LlmError(`LLM 服务错误 (${response.status}): ${text.slice(0, 200)}`, "response");
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (json.error) throw new LlmError(`LLM 服务返回错误: ${json.error.message ?? "unknown"}`, "response");
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LlmError("LLM 返回空内容", "response");
    return content.trim();
  }

  /** 请求 JSON 输出（抽取类任务）。解析失败抛错。 */
  async chatJson<T>(system: string, user: string, options: { temperature?: number; maxTokens?: number } = {}): Promise<T> {
    const text = await this.chat(system, user, options);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new LlmError(`LLM 未返回 JSON: ${text.slice(0, 120)}`, "response");
    try {
      return JSON.parse(match[0]) as T;
    } catch (err) {
      throw new LlmError(`LLM JSON 解析失败: ${(err as Error).message}`, "response");
    }
  }
}
