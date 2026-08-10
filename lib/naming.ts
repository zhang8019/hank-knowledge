/**
 * 知识图谱节点命名规范与自动命名。
 *
 * 命名规则（对齐神经树骨架 SOP v3.1）：
 * - 神经树文件：`神经树_《领域名》_v{major}.{minor}.md`
 * - 主干：`主干{序号}：{主题}`
 * - 神经元：`N{序号}·{动词/名词短语}`（≤15 字，动词+宾语优先）
 * - wiki concept：`TitleCase`（英文） / 中文名词短语
 * - wiki entity：`TitleCase`（人名/公司/项目）
 * - source 页：kebab-case（对应材料文件名）
 * - 节点 id：`nd_` + uuid（技术标识，不参与命名）
 *
 * 自动命名两级：
 * - 一级（确定性，无 LLM）：文件/主干/source 由来源名清洗生成
 * - 二级（LLM 辅助，人工确认）：神经元「动词+宾语」模板、触发词从原文提取
 * 冲突自动 `_1` / `_2` 后缀（复用 keep-copy 语义）。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export interface NeuronNameOptions {
  /** 主干序号（1-based）。 */
  branchIndex: number;
  /** 动词短语或名词短语，如 "判定解除类型"。 */
  subject: string;
  /** 是否使用 N 前缀（默认 true）。 */
  withPrefix?: boolean;
}

/** 生成神经元名：`N{序号}·{短语}`。总长 ≤15 字（含前缀）。 */
export function neuronName(opts: NeuronNameOptions): string {
  const prefix = opts.withPrefix === false ? "" : `N${opts.branchIndex}·`;
  const subjectMax = 15 - prefix.length;
  const subject = cleanPhrase(opts.subject, subjectMax);
  if (!subject) throw new Error("神经元名称不能为空");
  return `${prefix}${subject}`;
}

/** 生成主干名：`主干{序号}：{主题}`。 */
export function branchName(index: number, topic: string): string {
  const clean = cleanPhrase(topic, 30);
  if (!clean) throw new Error("主干主题不能为空");
  return `主干${index}：${clean}`;
}

/** 生成神经树文件名：`神经树_《领域名》_v{major}.{minor}.md`。 */
export function treeFileName(domain: string, major = 1, minor = 0): string {
  const clean = cleanPhrase(domain, 40);
  if (!clean) throw new Error("领域名不能为空");
  return `神经树_《${clean}》_v${major}.${minor}.md`;
}

/** wiki concept 页名：中文名词短语或英文 TitleCase。 */
export function conceptName(title: string): string {
  const clean = cleanPhrase(title, 40);
  if (!clean) throw new Error("概念名不能为空");
  if (CJK_RE.test(clean)) return clean;
  return titleCase(clean);
}

/** wiki entity 页名：人名/公司/项目，TitleCase。 */
export function entityName(title: string): string {
  const clean = cleanPhrase(title, 40);
  if (!clean) throw new Error("实体名不能为空");
  return CJK_RE.test(clean) ? clean : titleCase(clean);
}

/** source 页 slug：kebab-case，对应材料文件名。 */
export function sourceSlug(filename: string): string {
  const base = String(filename).split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(md|markdown|txt|pdf|docx?|pptx?|xlsx?)$/i, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "source";
}

/**
 * 生成不冲突的名字：在 `exists` 集合内追加 `_N` 后缀（keep-copy 语义）。
 * 返回 `base` 或 `base_1` / `base_2` ...（跳过已占用）。
 */
export function uniqueName(base: string, exists: Iterable<string>): string {
  const taken = new Set(exists);
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`名称冲突过多: ${base}`);
}

/** 校验神经元名是否符合规范（长度 ≤ 15 + 含分隔符）。 */
export function validateNeuronName(name: string): string | null {
  if (name.length > 15) return `神经元名称过长（${name.length} > 15 字）`;
  if (name.length === 0) return "神经元名称为空";
  return null;
}

/** 校验神经树文件名格式。 */
export function validateTreeFileName(name: string): string | null {
  if (!/^神经树_《.+》_v\d+\.\d+\.md$/.test(name)) {
    return `神经树文件名不符合规范: ${name}`;
  }
  return null;
}

/** 清洗短语：去首尾空白与多余空格、压缩换行、截断。 */
function cleanPhrase(input: string, max: number): string {
  return String(input)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[《》]/g, "")
    .slice(0, max);
}

/** 英文/拉丁 TitleCase：`attention mechanism` → `AttentionMechanism`。 */
function titleCase(input: string): string {
  return input
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}
