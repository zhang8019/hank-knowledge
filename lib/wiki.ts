/**
 * 简单 Wiki（v3）：摄入材料 → 生成 Markdown 摘要页。
 *
 * 不引入图谱/成熟度等复杂概念。每个知识库有独立 wiki 目录：
 *   {dataDir}/bases/{baseId}/wiki/
 *     index.md        所有页面的索引
 *     {slug}.md       每份材料的摘要页（来源/要点/关键词）
 *
 * 纯确定性摘要（高频关键词 + 首段），零外部依赖。
 */

import { normalizeText } from "./chunker";
import { tokenize } from "./tokenizer";
import type { KnowledgeStore } from "./store";
import { slugify } from "./ids";

export interface WikiIngestInput {
  baseId: string;
  /** 材料 itemId。 */
  itemId: string;
  /** 材料名。 */
  itemName: string;
  /** 材料全文。 */
  text: string;
}

export interface WikiIngestResult {
  slug: string;
  title: string;
  filePath: string;
  summary: string;
  keywords: string[];
}

export class Wiki {
  constructor(private readonly store: KnowledgeStore) {}

  private wikiDir(baseId: string): string {
    return `wiki`;
  }

  /** 摄入材料 → 写摘要页 + 更新 index。 */
  async ingest(input: WikiIngestInput): Promise<WikiIngestResult> {
    const text = normalizeText(input.text);
    if (!text || text.length < 20) throw new Error("材料内容过短，无法生成摘要");

    const summary = this.summarizeDeterministic(text);
    const keywords = this.extractKeywords(text, 8);

    const slug = slugify(input.itemName || "material", 40) || "material";
    const title = input.itemName || "未命名材料";
    const relDir = `${this.wikiDir(input.baseId)}`;
    const filePath = `${relDir}/${slug}.md`;
    const front = [
      `---`,
      `title: "${title}"`,
      `source: ${input.itemId}`,
      `summary: "${summary.slice(0, 120).replace(/"/g, "'")}"`,
      `keywords: ${keywords.map((k) => `"${k}"`).join(", ")}`,
      `created: ${new Date().toISOString().slice(0, 10)}`,
      `---`,
      ``,
      `# ${title}`,
      ``,
      `> 来源材料：${input.itemId}`,
      ``,
      `## 摘要`,
      ``,
      summary,
      ``,
      `## 关键词`,
      ``,
      keywords.map((k) => `- ${k}`).join("\n"),
      ``,
    ].join("\n");
    await this.store.writeRawFile(input.baseId, filePath, front);
    await this.updateIndex(input.baseId, slug, title, summary);

    return { slug, title, filePath, summary, keywords };
  }

  /** 列出全部 wiki 页。 */
  async list(baseId: string): Promise<Array<{ slug: string; title: string }>> {
    const indexPath = `${this.wikiDir(baseId)}/index.md`;
    if (!(await this.store.rawFileExists(baseId, indexPath))) return [];
    const raw = (await this.store.readRawFile(baseId, indexPath)).toString("utf8");
    const pages: Array<{ slug: string; title: string }> = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^\[(.+)\]\((.+)\)/);
      if (m) pages.push({ title: m[1], slug: m[2].replace(/\.md$/, "") });
    }
    return pages;
  }

  /** 读取单个 wiki 页全文。 */
  async read(baseId: string, slug: string): Promise<string | null> {
    const filePath = `${this.wikiDir(baseId)}/${slug}.md`;
    if (!(await this.store.rawFileExists(baseId, filePath))) return null;
    return (await this.store.readRawFile(baseId, filePath)).toString("utf8");
  }

  private async updateIndex(baseId: string, slug: string, title: string, summary: string): Promise<void> {
    const indexPath = `${this.wikiDir(baseId)}/index.md`;
    const existing = (await this.store.rawFileExists(baseId, indexPath))
      ? (await this.store.readRawFile(baseId, indexPath)).toString("utf8")
      : "# Wiki 索引\n\n";
    if (existing.includes(`](${slug}.md)`)) return;
    const line = `- [${title}](${slug}.md) — ${summary.slice(0, 60)}`;
    await this.store.writeRawFile(baseId, indexPath, existing + line + "\n");
  }

  private summarizeDeterministic(text: string): string {
    const tokens = this.extractKeywords(text, 6);
    return `材料要点：${tokens.join("、")}。\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
  }

  private extractKeywords(text: string, limit: number): string[] {
    const freq = new Map<string, number>();
    for (const token of tokenize(text)) {
      if (token.length < 2) continue;
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([token]) => token);
  }
}
