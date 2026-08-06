/** ID 生成与路径安全工具。 */

import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function baseId(): string {
  return newId("kb");
}

export function itemId(): string {
  return newId("it");
}

/** chunk 的稳定 id：相同材料+内容+位置可复现（与 Cherry 的 unit_id 语义一致）。 */
export function unitId(seed: string): string {
  return `u_${sha256(seed).slice(0, 24)}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 校验知识库内部相对路径：只能由安全段组成，禁止
 * 绝对路径、`..`、`.`、空段、反斜杠与 scheme 前缀。
 * 语义与 Cherry 的 assertSafeKnowledgeRelativePath 一致。
 */
export function assertSafeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid relative path: must be a non-empty string.");
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    throw new Error(`Invalid relative path: ${value}`);
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("\0")) {
      throw new Error(`Invalid relative path: ${value}`);
    }
  }
  return normalized;
}

/** 生成安全的显示名（用于 URL/Note 快照文件名）。 */
export function slugify(input: string, max = 60): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return cleaned || "snapshot";
}