/**
 * MinerU 文档解析客户端（零第三方依赖）。
 *
 * 双模式：
 * - Agent 轻量 API（免 Token，≤10MB/20 页，仅 Markdown）
 *   POST /api/v1/agent/parse/file        → { task_id, file_url }
 *   PUT  file_url (原始字节)
 *   GET  /api/v1/agent/parse/{task_id}   → { state, markdown_url }
 * - 精准 API（需 Token，≤200MB/200 页，Zip 含 Markdown+JSON）
 *   POST /api/v4/file-urls/batch         → { batch_id, file_urls[] }
 *   PUT  file_url (原始字节)
 *   GET  /api/v4/extract-results/batch/{batch_id} → { extract_result[]: { state, full_zip_url } }
 *
 * 选择策略：配置了 apiKey 且文件超过 Agent 限额（10MB/20 页）时走精准 API；
 * 否则优先 Agent 轻量 API（无需解 Zip）。精准 API 的 Zip 用内置最小解包器
 * 提取 *.md（仅支持 Store + Deflate，Node 内置 zlib）。
 */

import { inflateRawSync } from "node:zlib";
import type { HanaPluginConfigStore, HanaPluginNetwork } from "./types";

export interface MineruConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  enableTable: boolean;
  enableFormula: boolean;
  ocr: boolean;
  /** PDF 页数超限时自动分段解析（默认开）。 */
  autoSplit: boolean;
  /** 分段时每段最大页数；0 = 用 API 默认上限。 */
  maxPagesPerBatch: number;
}

export interface MineruParseResult {
  markdown: string;
  mode: "agent" | "standard";
  taskId?: string;
  pageCount?: number;
  /** 自动拆分时本次被拆成的段数。 */
  splitCount?: number;
}

/** Agent 轻量 API 的硬限额（超出需走精准 API）。 */
const AGENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_MAX_PAGES = 20;

/** 精准 API 的硬限额。 */
const STANDARD_MAX_BYTES = 200 * 1024 * 1024;
const STANDARD_MAX_PAGES = 200;

/** MinerU 支持的文件扩展名（Agent + 精准 API 交集）。 */
const SUPPORTED_EXTENSIONS = new Set([
  "pdf",
  "png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp",
  "doc", "docx", "ppt", "pptx", "xls", "xlsx",
]);

export class MineruError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "network" | "response" | "parse" | "size" | "unsupported",
  ) {
    super(message);
  }
}

export class MineruClient {
  constructor(
    private readonly config: MineruConfig,
    private readonly network: HanaPluginNetwork,
  ) {}

  static isConfigured(config: Partial<MineruConfig>): boolean {
    return Boolean(config.baseUrl && config.baseUrl.trim());
  }

  static async fromConfig(
    configStore: HanaPluginConfigStore,
    network: HanaPluginNetwork,
  ): Promise<MineruClient | null> {
    const config: Partial<MineruConfig> = {
      baseUrl: (await configStore.get<string>("mineruBaseUrl")) ?? "",
      apiKey: (await configStore.get<string>("mineruApiKey")) ?? "",
      model: (await configStore.get<string>("mineruModel")) ?? "vlm",
      language: (await configStore.get<string>("mineruLanguage")) ?? "ch",
      enableTable: (await configStore.get<boolean>("mineruEnableTable")) ?? true,
      enableFormula: (await configStore.get<boolean>("mineruEnableFormula")) ?? true,
      ocr: (await configStore.get<boolean>("mineruOcr")) ?? false,
      autoSplit: (await configStore.get<boolean>("mineruAutoSplit")) ?? true,
      maxPagesPerBatch: Number((await configStore.get<number>("mineruMaxPagesPerBatch")) ?? 0) || 0,
    };
    if (!MineruClient.isConfigured(config)) return null;
    return new MineruClient(config as MineruConfig, network);
  }

  get model(): string {
    return this.config.model;
  }

  get configuredApiKey(): boolean {
    return Boolean(this.config.apiKey);
  }

  /** 是否支持该文件名（按扩展名）。 */
  static supports(filename: string): boolean {
    return SUPPORTED_EXTENSIONS.has(extensionOf(filename));
  }

  static unsupportedReason(filename: string): string | null {
    if (MineruClient.supports(filename)) return null;
    const ext = extensionOf(filename);
    if (!ext) return `文件没有扩展名，无法判断格式`;
    return `MinerU 不支持 ${ext} 格式`;
  }

  /**
   * 解析本地文件字节 → Markdown。
   * 自动选择：带 Token 且超限走精准 API；否则 Agent 轻量 API。
   * 页数超限（PDF）时自动分段解析并按页序拼接（autoSplit）。
   */
  async parseFile(
    filename: string,
    buffer: Uint8Array,
    opts: { pageRanges?: string } = {},
  ): Promise<MineruParseResult> {
    if (!MineruClient.supports(filename)) {
      throw new MineruError(MineruClient.unsupportedReason(filename) ?? "不支持的格式", "unsupported");
    }
    const ext = extensionOf(filename);
    const isPdf = ext === "pdf";
    // 配了 Token 优先走精准 API（页数上限 200、支持批量）；无 Token 才用 Agent 轻量 API（20 页）。
    // 仅当文件 >10MB 且无 Token 时才报 Agent 大小超限。
    const useStandard: boolean = Boolean(this.config.apiKey) || buffer.byteLength > AGENT_MAX_BYTES;

    // ---- 大小超限检查 ----
    if (useStandard) {
      if (buffer.byteLength > STANDARD_MAX_BYTES) {
        throw new MineruError(
          `文件 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过精准 API 上限（200MB），无法解析`,
          "size",
        );
      }
    } else if (buffer.byteLength > AGENT_MAX_BYTES) {
      throw new MineruError(
        `文件 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过 Agent 轻量 API 上限（10MB）。请配置 MinerU Token 使用精准 API。`,
        "size",
      );
    }

    // ---- 页数超限自动分段（仅 PDF）----
    if (isPdf && this.config.autoSplit && !opts.pageRanges) {
      const pages = countPdfPages(buffer);
      if (pages !== null && pages > 0) {
        const maxPerBatch = this.effectiveMaxPages(useStandard);
        if (pages > maxPerBatch) {
          const segments = splitPageRanges(pages, maxPerBatch);
          const parts: string[] = [];
          let splitCount = 0;
          // 串行分段：Agent 轻量 API 有 IP 限频，避免并发触发 429
          for (const seg of segments) {
            const result = useStandard
              ? await this.parseFileStandard(filename, buffer, { pageRanges: seg })
              : await this.parseFileAgentRange(filename, buffer, seg);
            parts.push(result.markdown);
            splitCount += 1;
          }
          return {
            markdown: joinSegments(parts, segments),
            mode: useStandard ? "standard" : "agent",
            pageCount: pages,
            splitCount,
          };
        }
      }
    }

    if (useStandard) {
      return this.parseFileStandard(filename, buffer, opts);
    }
    return this.parseFileAgent(filename, buffer);
  }

  /** 解析远程 URL → Markdown。 */
  async parseUrl(url: string, opts: { pageRanges?: string } = {}): Promise<MineruParseResult> {
    if (!/^https?:\/\//i.test(url)) throw new MineruError(`URL 无效: ${url}`, "parse");
    if (this.config.apiKey && opts.pageRanges !== undefined) {
      return this.parseUrlStandard(url, opts);
    }
    return this.parseUrlAgent(url);
  }

  // ---- Agent 轻量 API ----

  private async parseFileAgent(filename: string, buffer: Uint8Array): Promise<MineruParseResult> {
    const base = this.base();
    const create = await this.requestJson<{ data: { task_id: string; file_url: string } }>(
      `${base}/api/v1/agent/parse/file`,
      {
        method: "POST",
        body: JSON.stringify(this.agentOptions(filename)),
      },
    );
    const { task_id: taskId, file_url: fileUrl } = create.data;
    await this.putBuffer(fileUrl, buffer);
    const markdown = await this.pollAgent(taskId);
    return { markdown, mode: "agent", taskId };
  }

  /** Agent 轻量 API 分段：同一文件每次指定 page_range（from-to 或单页）。 */
  private async parseFileAgentRange(filename: string, buffer: Uint8Array, range: string): Promise<MineruParseResult> {
    const base = this.base();
    const create = await this.requestJson<{ data: { task_id: string; file_url: string } }>(
      `${base}/api/v1/agent/parse/file`,
      {
        method: "POST",
        body: JSON.stringify({ ...this.agentOptions(filename), page_range: range }),
      },
    );
    const { task_id: taskId, file_url: fileUrl } = create.data;
    await this.putBuffer(fileUrl, buffer);
    const markdown = await this.pollAgent(taskId);
    return { markdown, mode: "agent", taskId, pageCount: pageRangeCount(range) };
  }

  private async parseUrlAgent(url: string): Promise<MineruParseResult> {
    const base = this.base();
    const create = await this.requestJson<{ data: { task_id: string } }>(
      `${base}/api/v1/agent/parse/url`,
      {
        method: "POST",
        body: JSON.stringify({ url, ...this.agentOptions(undefined) }),
      },
    );
    const taskId = create.data.task_id;
    const markdown = await this.pollAgent(taskId);
    return { markdown, mode: "agent", taskId };
  }

  private agentOptions(filename: string | undefined): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      language: this.config.language,
      enable_table: this.config.enableTable,
      enable_formula: this.config.enableFormula,
      is_ocr: this.config.ocr,
    };
    if (filename !== undefined) opts.file_name = filename;
    return opts;
  }

  private async pollAgent(taskId: string, timeoutMs = 180_000, intervalMs = 3_000): Promise<string> {
    const base = this.base();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const res = await this.requestJson<{
        data: { state: string; markdown_url?: string; err_msg?: string; err_code?: number };
      }>(`${base}/api/v1/agent/parse/${taskId}`, { method: "GET" });
      const data = res.data ?? {};
      if (data.state === "done" && data.markdown_url) {
        const md = await this.fetchText(data.markdown_url);
        return md;
      }
      if (data.state === "failed") {
        throw new MineruError(`MinerU 解析失败: ${data.err_msg ?? `错误码 ${data.err_code ?? ""}`}`, "parse");
      }
      await sleep(intervalMs);
    }
    throw new MineruError(`MinerU 解析超时（${timeoutMs / 1000}s），task_id=${taskId}`, "parse");
  }

  // ---- 精准 API ----

  private async parseFileStandard(
    filename: string,
    buffer: Uint8Array,
    opts: { pageRanges?: string } = {},
  ): Promise<MineruParseResult> {
    const base = this.base();
    const create = await this.requestJson<{
      data: { batch_id: string; file_urls: string[] };
    }>(
      `${base}/api/v4/file-urls/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          files: [{ name: filename, is_ocr: this.config.ocr, ...(opts.pageRanges ? { page_ranges: opts.pageRanges } : {}) }],
          model_version: this.config.model,
          enable_formula: this.config.enableFormula,
          enable_table: this.config.enableTable,
          language: this.config.language,
        }),
        auth: true,
      },
    );
    const { batch_id: batchId, file_urls: fileUrls } = create.data;
    if (fileUrls.length !== 1) {
      throw new MineruError(`MinerU 上传链接数量异常: ${fileUrls.length}`, "response");
    }
    await this.putBuffer(fileUrls[0], buffer);
    return this.pollStandard(batchId);
  }

  private async parseUrlStandard(
    url: string,
    _opts: { pageRanges?: string },
  ): Promise<MineruParseResult> {
    const base = this.base();
    const create = await this.requestJson<{ data: { batch_id: string } }>(
      `${base}/api/v4/extract/task/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          files: [{ url }],
          model_version: this.config.model,
          enable_formula: this.config.enableFormula,
          enable_table: this.config.enableTable,
          language: this.config.language,
        }),
        auth: true,
      },
    );
    return this.pollStandard(create.data.batch_id);
  }

  private async pollStandard(batchId: string, timeoutMs = 300_000, intervalMs = 5_000): Promise<MineruParseResult> {
    const base = this.base();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const res = await this.requestJson<{
        data: {
          extract_result: Array<{
            state: string;
            full_zip_url?: string;
            err_msg?: string;
            extract_progress?: { total_pages?: number };
          }>;
        };
      }>(`${base}/api/v4/extract-results/batch/${batchId}`, { method: "GET", auth: true });
      const results = res.data?.extract_result ?? [];
      const first = results[0];
      if (!first) {
        await sleep(intervalMs);
        continue;
      }
      if (first.state === "done" && first.full_zip_url) {
        const markdown = await this.extractMarkdownFromZip(first.full_zip_url);
        return { markdown, mode: "standard", taskId: batchId, pageCount: first.extract_progress?.total_pages };
      }
      if (first.state === "failed") {
        throw new MineruError(`MinerU 解析失败: ${first.err_msg ?? "未知错误"}`, "parse");
      }
      await sleep(intervalMs);
    }
    throw new MineruError(`MinerU 解析超时（${timeoutMs / 1000}s），batch_id=${batchId}`, "parse");
  }

  // ---- 传输 ----

  private base(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private effectiveMaxPages(useStandard: boolean): number {
    if (this.config.maxPagesPerBatch > 0) return this.config.maxPagesPerBatch;
    return useStandard ? STANDARD_MAX_PAGES : AGENT_MAX_PAGES;
  }

  private async requestJson<T>(
    url: string,
    init: { method: string; body?: string; auth?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.auth) {
      if (!this.config.apiKey) throw new MineruError("未配置 MinerU API Token", "config");
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.network.fetch(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw new MineruError(`MinerU 请求失败: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new MineruError(`MinerU Token 无效或过期 (${response.status}): ${body.slice(0, 200)}`, "config");
      }
      throw new MineruError(`MinerU 服务错误 (${response.status}): ${body.slice(0, 200)}`, "response");
    }
    return (await response.json()) as T;
  }

  private async putBuffer(url: string, buffer: Uint8Array): Promise<void> {
    try {
      // MinerU OSS 预签名 URL 未将 Content-Type 计入签名，带该头会导致
      // SignatureDoesNotMatch(403)。上传时不能设置 Content-Type。
      const response = await this.network.fetch(url, {
        method: "PUT",
        body: buffer,
        timeoutMs: 120_000,
      });
      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        const body = await response.text().catch(() => "");
        throw new MineruError(`文件上传失败 (${response.status}): ${body.slice(0, 200)}`, "network");
      }
    } catch (err) {
      if (err instanceof MineruError) throw err;
      throw new MineruError(`文件上传失败: ${(err as Error).message}`, "network");
    }
  }

  private async fetchText(url: string): Promise<string> {
    try {
      const response = await this.network.fetch(url, { method: "GET", timeoutMs: 60_000 });
      if (!response.ok) {
        throw new MineruError(`下载解析结果失败 (${response.status})`, "network");
      }
      return await response.text();
    } catch (err) {
      if (err instanceof MineruError) throw err;
      throw new MineruError(`下载解析结果失败: ${(err as Error).message}`, "network");
    }
  }

  // ---- Zip 解包（精准 API 的 full_zip_url） ----

  private async extractMarkdownFromZip(zipUrl: string): Promise<string> {
    let response: Response;
    try {
      response = await this.network.fetch(zipUrl, { method: "GET", timeoutMs: 120_000 });
    } catch (err) {
      throw new MineruError(`下载结果 Zip 失败: ${(err as Error).message}`, "network");
    }
    if (!response.ok) throw new MineruError(`下载结果 Zip 失败 (${response.status})`, "network");
    const buf = Buffer.from(await response.arrayBuffer());
    const md = extractMarkdownFromZipBuffer(buf);
    if (md === null) {
      throw new MineruError("Zip 中未找到 Markdown 文件", "parse");
    }
    return md;
  }
}

/** 从 Zip 字节中提取第一个 *.md 条目（支持 Store + Deflate）。 */
export function extractMarkdownFromZipBuffer(zip: Buffer): string | null {
  if (zip.length < 22) return null;
  // 找 End Of Central Directory 记录
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0 || cdOffset >= zip.length) return null;

  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > zip.length) break;
    const sig = zip.readUInt32LE(cursor);
    if (sig !== 0x02014b50) break; // 中央目录签名
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const isDir = name.endsWith("/");
    const isMarkdown = /\.md$/i.test(name) && !isDir;

    if (isMarkdown) {
      // 定位本地文件头，跳过 name/extra 得到数据起点
      if (localOffset + 30 > zip.length) return null;
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        // Store
        return data.toString("utf8");
      }
      if (method === 8) {
        // Deflate
        try {
          return inflateRawSync(data).toString("utf8");
        } catch {
          return null;
        }
      }
      return null; // 不支持的压缩方式
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function extensionOf(filename: string): string {
  const base = String(filename).split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * 探测 PDF 页数（尽力而为，无需完整解析）。
 * 扫描未压缩的 PDF 对象流中的 /Count N 字段（Pages 树），取最大值。
 * 压缩对象流（/ObjStm）可能无法探测 → 返回 null（调用方按单次提交处理）。
 */
export function countPdfPages(buffer: Uint8Array): number | null {
  const text = Buffer.from(buffer).toString("latin1");
  // /Count 通常出现在 /Pages 或 /Page 字典里；取所有 /Count 的最大值近似总页数。
  const counts: number[] = [];
  const re = /\/Count\s+(\d+)\s*(?=[>\/])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && n < 1_000_000) counts.push(n);
  }
  if (counts.length === 0) return null;
  // 多个 /Count 时取最大（Pages 根节点的 Count 即总页数）
  return Math.max(...counts);
}

/** 将 totalPages 按每段 max 拆成 "from-to" 范围串（1-based）。 */
export function splitPageRanges(totalPages: number, max: number): string[] {
  const ranges: string[] = [];
  if (max <= 0 || totalPages <= 0) return ranges;
  for (let start = 1; start <= totalPages; start += max) {
    const end = Math.min(start + max - 1, totalPages);
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return ranges;
}

/** 解析 "from-to" 或 "from" 范围包含的页数。 */
export function pageRangeCount(range: string): number {
  const dash = range.indexOf("-");
  if (dash < 0) {
    const n = Number(range);
    return Number.isInteger(n) ? 1 : 0;
  }
  const from = Number(range.slice(0, dash));
  const to = Number(range.slice(dash + 1));
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return 0;
  return to - from + 1;
}

/** 拼接多段 Markdown，段间加页范围分隔注释。 */
export function joinSegments(parts: string[], ranges?: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  const joined: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const label = ranges && ranges[i] ? ranges[i] : `第 ${i + 1} 段`;
    joined.push(`<!-- 以下为拆分片段：${label} -->\n\n${parts[i]}`);
  }
  return joined.join("\n\n---\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
