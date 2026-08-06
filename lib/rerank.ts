/**
 * Rerank 客户端（兼容 /rerank 接口，Jina / Cohere 风格）。
 *
 * 与 Cherry 的检索语义一致：配置了 rerank 模型时，检索对候选片段
 * 重排并产出 relevance 分数（threshold 只对 relevance 生效）；
 * 未配置或瞬时失败时降级为未重排的 ranking 结果。
 */

import type { HanaPluginConfigStore, HanaPluginNetwork } from "./types";

export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

export class RerankError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "network" | "response",
  ) {
    super(message);
  }
}

export class RerankClient {
  constructor(
    private readonly config: RerankConfig,
    private readonly network: HanaPluginNetwork,
  ) {}

  static isConfigured(config: Partial<RerankConfig>): boolean {
    return Boolean(config.baseUrl && config.baseUrl.trim() && config.model && config.model.trim());
  }

  static async fromConfig(
    configStore: HanaPluginConfigStore,
    network: HanaPluginNetwork,
  ): Promise<RerankClient | null> {
    const config: Partial<RerankConfig> = {
      baseUrl: (await configStore.get<string>("rerankBaseUrl")) ?? "",
      apiKey: (await configStore.get<string>("rerankApiKey")) ?? "",
      model: (await configStore.get<string>("rerankModel")) ?? "",
    };
    if (!RerankClient.isConfigured(config)) return null;
    return new RerankClient(config as RerankConfig, network);
  }

  get model(): string {
    return this.config.model;
  }

  /** 探测配置可用性（用一个最小请求验证端点与鉴权）。 */
  async detect(): Promise<void> {
    try {
      await this.rerank("test", ["probe"]);
    } catch (err) {
      throw new RerankError(`重排序服务探测失败: ${(err as Error).message}`, err instanceof RerankError ? err.code : "network");
    }
  }

  /**
   * 对候选文档重排，返回按相关性降序的命中（含原始索引与 relevance_score）。
   * 输入为空返回 []。
   */
  async rerank(query: string, documents: string[]): Promise<RerankHit[]> {
    const cleaned = documents
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    if (cleaned.length === 0 || !query.trim()) return [];

    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/rerank`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.network.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          query: query.trim(),
          documents: cleaned,
        }),
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw new RerankError(`Rerank 请求失败: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      const status = response.status;
      const body = await response.text().catch(() => "");
      if (status === 401 || status === 403 || status === 404) {
        throw new RerankError(`Rerank 配置错误 (${status}): ${body.slice(0, 200)}`, "config");
      }
      throw new RerankError(`Rerank 服务错误 (${status}): ${body.slice(0, 200)}`, "response");
    }
    const json = (await response.json()) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
      error?: { message?: string };
    };
    if (json.error) {
      throw new RerankError(`Rerank 服务返回错误: ${json.error.message ?? "unknown"}`, "response");
    }
    const results = Array.isArray(json.results) ? json.results : [];
    return results
      .map((item) => ({
        index: Number(item.index),
        relevanceScore: Number(item.relevance_score),
      }))
      .filter((hit) => Number.isFinite(hit.index) && Number.isFinite(hit.relevanceScore))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}