/**
 * 分词器。
 *
 * 面向中英混合文本：
 * - 英文/数字按词切分（小写、去停用词）
 * - 中文按 2-gram 切分（无需词典）
 * - 输出同时包含两类 token，供 BM25 使用
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "on",
  "in", "to", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "we", "you",
  "they", "he", "she", "i", "my", "your", "our", "their", "not", "no", "yes",
  "can", "could", "will", "would", "should", "may", "might", "must", "do", "does",
  "did", "have", "has", "had", "of", "to", "in", "about", "which", "who", "what",
  "when", "where", "why", "how", "all", "any", "each", "more", "most", "some",
]);

const WORD_RE = /[a-z0-9]+/gi;

/** 提取单个文本的全部 token（英文词 + 中文 bigram）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 英文/数字词
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    tokens.push(word);
  }
  // 中文 bigram
  const cjk = extractCjkRuns(text);
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

/** 中文短查询的特殊处理：BM25 直接按 2-gram 命中；2 字以下按单字（与 Cherry 的 LIKE fallback 同思路）。 */
export function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text);
  if (tokens.length > 0) return tokens;
  // 极短中文查询：退化为单字/单字对
  const cjk = extractCjkRuns(text).join("");
  if (!cjk) return [];
  const singles: string[] = [];
  for (let i = 0; i < cjk.length; i += 1) {
    singles.push(cjk.slice(i, i + 1));
  }
  return singles;
}

function extractCjkRuns(text: string): string[] {
  const runs: string[] = [];
  let current = "";
  for (const char of text) {
    if (CJK_RE.test(char)) {
      current += char;
    } else if (current) {
      runs.push(current);
      current = "";
    }
  }
  if (current) runs.push(current);
  return runs;
}