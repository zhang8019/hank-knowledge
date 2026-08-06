/**
 * 文本分块器。
 *
 * 语义与 Cherry 一致：chunk 必须是原文本的精确切片
 * （content.text.slice(charStart, charEnd) === chunk.text），
 * 因此使用保偏移的分割器，禁止事后 indexOf 推断。
 *
 * 策略：优先按段落合并到目标大小；超长段落按窗口切分并保留少量重叠。
 */

export interface ChunkSlice {
  text: string;
  charStart: number;
  charEnd: number;
}

const DEFAULT_MAX_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 80;

export function splitIntoChunks(
  content: string,
  maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): ChunkSlice[] {
  const normalized = normalizeText(content);
  if (!normalized) return [];

  const paragraphs = splitParagraphs(normalized);
  const chunks: ChunkSlice[] = [];
  let bufferStart = 0;
  let bufferEnd = 0;

  const flush = (end: number): void => {
    if (end <= bufferStart) return;
    const text = normalized.slice(bufferStart, end);
    if (text.trim()) {
      chunks.push({ text, charStart: bufferStart, charEnd: end });
    }
    bufferStart = end;
    bufferEnd = end;
  };

  for (const para of paragraphs) {
    const start = para.start;
    const end = para.end;
    if (end - bufferStart > maxChunkSize && bufferEnd > bufferStart) {
      // 当前缓冲已满：先落盘
      flush(bufferEnd);
    }
    if (end - start >= maxChunkSize) {
      // 超长段落：按窗口切
      flush(Math.max(bufferStart, start));
      cutLongRun(normalized, start, end, maxChunkSize, overlap, chunks);
      bufferStart = end;
      bufferEnd = end;
    } else {
      if (bufferStart === 0 || bufferEnd === 0) {
        // 首个段落直接作为缓冲起点
        bufferStart = start;
        bufferEnd = end;
      } else {
        // 合并段落（段落间有分隔符，直接拼到缓冲末尾）
        bufferEnd = end;
      }
    }
  }
  flush(normalized.length);

  // 空 chunk 过滤 + 偏移校验
  return chunks.filter((chunk) => {
    if (chunk.text.trim() === "") return false;
    if (chunk.text !== normalized.slice(chunk.charStart, chunk.charEnd)) {
      throw new Error("chunk offset invariant violated");
    }
    return true;
  });
}

function cutLongRun(
  text: string,
  start: number,
  end: number,
  maxChunkSize: number,
  overlap: number,
  out: ChunkSlice[],
): void {
  let cursor = start;
  const step = Math.max(1, maxChunkSize - overlap);
  while (cursor < end) {
    const chunkEnd = Math.min(end, cursor + maxChunkSize);
    const piece = text.slice(cursor, chunkEnd);
    if (piece.trim()) {
      out.push({ text: piece, charStart: cursor, charEnd: chunkEnd });
    }
    if (chunkEnd >= end) break;
    cursor += step;
  }
}

interface Paragraph {
  start: number;
  end: number;
}

/** 按换行分组（保留 \n 边界于段落 end 内），连续空行并入前一段的结束。 */
function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let start = 0;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const newline = text.indexOf("\n", index);
    if (newline < 0) {
      paragraphs.push({ start, end: length });
      break;
    }
    // 跳过连续空行（把它们并入当前段结尾）
    index = newline + 1;
    while (index < length && (text[index] === "\n" || text[index] === "\r")) {
      index += 1;
    }
    if (index >= length) {
      paragraphs.push({ start, end: length });
      break;
    }
    paragraphs.push({ start, end: newline });
    start = index;
  }
  return paragraphs.filter((p) => p.end > p.start);
}

/** 归一化：统一换行、合并重复空行。归一化在切块前完成，偏移基于归一化文本。 */
export function normalizeText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}