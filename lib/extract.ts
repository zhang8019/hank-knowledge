/**
 * 文件文本提取。
 *
 * 纯文本类直接 utf8 读取（GBK 兜底）；HTML 剥离标签；
 * PDF/Office 等二进制格式不提供原生解析——标记为需要转换。
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
  "xml", "log", "ini", "conf", "cfg", "env", "sh", "bash", "zsh", "ps1", "bat",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "hpp", "cc", "cs", "php", "swift", "sql", "lua", "r", "pl", "dart", "html", "htm",
  "css", "scss", "less", "vue", "svelte",
]);

const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export function isTextLike(filename: string): boolean {
  const ext = extensionOf(filename);
  return TEXT_EXTENSIONS.has(ext);
}

export async function extractTextFromBuffer(
  filename: string,
  buffer: Buffer,
): Promise<ExtractResult> {
  const ext = extensionOf(filename);
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制` };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = decodeText(buffer);
    return { ok: true, text };
  }
  if (HTML_EXTENSIONS.has(ext)) {
    const text = htmlToMarkdown(decodeText(buffer));
    return { ok: true, text };
  }
  return {
    ok: false,
    reason: `暂不支持解析 ${ext || "未知"} 格式，请先转换为 txt/md/csv 等文本格式`,
  };
}

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function decodeText(buffer: Buffer): string {
  try {
    const utf8 = buffer.toString("utf8");
    if (!utf8.includes("\uFFFD")) return utf8;
  } catch {
    // fall through
  }
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** 极简 HTML → 文本：去 script/style/标签，还原常见换行。 */
export function htmlToMarkdown(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  return withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}