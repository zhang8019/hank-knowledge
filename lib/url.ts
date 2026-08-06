/**
 * URL 快照抓取。
 *
 * Cherry 语义：URL 材料是"快照"而非实时引用——首次索引时抓取一次，
 * 之后离线可读；刷新 = 重新抓取并覆盖索引。
 *
 * 注意：插件平台对 network.fetch 有域名白名单（manifest network.allowedHosts），
 * 白名单外的站点抓取会失败，这是平台安全模型的预期行为。
 */

import type { HanaPluginNetwork } from "./types";
import { htmlToMarkdown } from "./extract";

export interface UrlSnapshot {
  title: string;
  url: string;
  /** 归一化后的正文 markdown。 */
  markdown: string;
  fetchedAt: number;
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export async function fetchUrlSnapshot(
  url: string,
  network: HanaPluginNetwork,
): Promise<UrlSnapshot> {
  let response: Response;
  try {
    response = await network.fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml,text/markdown,*/*;q=0.8" },
      timeoutMs: 30_000,
      maxResponseBytes: MAX_SNAPSHOT_BYTES,
    });
  } catch (err) {
    throw new Error(`抓取 URL 失败（可能不在网络白名单内）: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`抓取 URL 失败: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new Error("URL 响应体过大或不可读");
  }
  if (/html/i.test(contentType)) {
    return { title: htmlTitle(body), url, markdown: htmlToMarkdown(body), fetchedAt: Date.now() };
  }
  if (/markdown|text\/plain/i.test(contentType) || looksLikeMarkdown(body)) {
    return { title: firstHeading(body) ?? url, url, markdown: body.trim(), fetchedAt: Date.now() };
  }
  // 兜底：当作文本
  return { title: url, url, markdown: body.trim().slice(0, 200_000), fetchedAt: Date.now() };
}

function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/<[^>]+>/g, "").trim().slice(0, 200) : "";
}

function firstHeading(markdown: string): string | null {
  const line = markdown.split("\n").find((line) => /^#\s+/.test(line.trim()));
  return line ? line.trim().replace(/^#+\s*/, "").slice(0, 200) : null;
}

function looksLikeMarkdown(text: string): boolean {
  return /^#\s/m.test(text) || /\[[^\]]+\]\(https?:\/\/[^)]+\)/m.test(text);
}