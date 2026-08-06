/**
 * Embedding 客户端（OpenAI 兼容 /embeddings）。
 *
 * 未配置时知识库保持 BM25-only（与 Cherry 的降级路径一致）。
 * 配置了但调用失败：401/404 视为永久配置错误（escalate），
 * 瞬时错误抛出由调用方决定失败或降级。
 */

import type { HanaPluginConfigStore, HanaPluginNetwork } from "./types";

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0 = 未知，首次索引时自动探测。 */
  dimensions: number;
}

const MAX_PARALLEL = 4;
const MAX_TOKENS_PER_BATCH = 4000;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "network" | "response" | "dimension",
  ) {
    super(message);
  }
}

export class EmbeddingClient {
  constructor(
    private readonly config: EmbeddingConfig,
    private readonly network: HanaPluginNetwork,
  ) {}

  static isConfigured(config: Partial<EmbeddingConfig>): boolean {
    return Boolean(config.baseUrl && config.baseUrl.trim() && config.model && config.model.trim());
  }

  static async fromConfig(
    configStore: HanaPluginConfigStore,
    network: HanaPluginNetwork,
  ): Promise<EmbeddingClient | null> {
    const config: Partial<EmbeddingConfig> = {
      baseUrl: (await configStore.get<string>("embeddingBaseUrl")) ?? "",
      apiKey: (await configStore.get<string>("embeddingApiKey")) ?? "",
      model: (await configStore.get<string>("embeddingModel")) ?? "",
      dimensions: Number((await configStore.get<number>("embeddingDimensions")) ?? 0) || 0,
    };
    if (!EmbeddingClient.isConfigured(config)) return null;
    return new EmbeddingClient(config as EmbeddingConfig, network);
  }

  get model(): string {
    return this.config.model;
  }

  get dimensions(): number | null {
    return this.config.dimensions > 0 ? this.config.dimensions : null;
  }

  /** 自动探测模型输出维度（embed 一个 probe 文本）。 */
  async detectDimensions(probe = "knowledge base"): Promise<number> {
    const vectors = await this.embedMany([probe]);
    const dims = vectors[0]?.length ?? 0;
    if (dims <= 0) {
      throw new EmbeddingError("Embedding 模型返回空向量", "response");
    }
    return dims;
  }

  /**
   * 批量嵌入。输入为空返回 []。按 token 预算分批、限制并发。
   * 返回的向量均校验维度与配置一致。
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const cleaned = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (cleaned.length === 0) return [];

    const dims = this.config.dimensions;
    const results = new Map<string, number[]>();
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;
    for (const text of cleaned) {
      const tokens = estimateTokens(text);
      if (current.length > 0 && currentTokens + tokens > MAX_TOKENS_PER_BATCH) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);

    let queueIndex = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL, batches.length) }, async () => {
      while (queueIndex < batches.length) {
        const batch = batches[queueIndex];
        queueIndex += 1;
        const vectors = await this.requestEmbeddings(batch);
        for (let i = 0; i < batch.length; i += 1) {
          const vector = vectors[i];
          if (dims > 0 && vector && vector.length !== dims) {
            throw new EmbeddingError(
              `Embedding 维度不匹配：期望 ${dims}，实际 ${vector.length}`,
              "dimension",
            );
          }
          results.set(batch[i], vector);
        }
      }
    });
    await Promise.all(workers);

    return cleaned.map((text) => results.get(text) ?? []);
  }

  private async requestEmbeddings(texts: string[]): Promise<number[][]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`;
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
        body: JSON.stringify({ model: this.config.model, input: texts }),
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding 请求失败: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      const status = response.status;
      const body = await response.text().catch(() => "");
      if (status === 401 || status === 403 || status === 404) {
        throw new EmbeddingError(
          `Embedding 配置错误 (${status}): ${body.slice(0, 200)}`,
          "config",
        );
      }
      throw new EmbeddingError(`Embedding 服务错误 (${status}): ${body.slice(0, 200)}`, "response");
    }
    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };
    if (json.error) {
      throw new EmbeddingError(`Embedding 服务返回错误: ${json.error.message ?? "unknown"}`, "response");
    }
    const vectors = (json.data ?? [])
      .map((item) => item.embedding ?? [])
      .filter((vector) => vector.length > 0);
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `Embedding 返回条数不匹配：请求 ${texts.length}，收到 ${vectors.length}`,
        "response",
      );
    }
    return vectors;
  }
}

/** 粗略 token 估算（1 字符 ≈ 0.5 token，中文按 1）。 */
function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x2fff ? 1 : 0.5;
  }
  return Math.max(1, Math.ceil(count));
}