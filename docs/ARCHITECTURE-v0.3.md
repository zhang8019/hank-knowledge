# hank-knowledge v0.3 — 神经树 × LLM Wiki 融合知识引擎设计

> **状态**：Draft v0.1 | **日期**：2026-08-10
> **目标版本**：v0.3.0（主架构）+ v0.4.0（检索/可视化增量）
> **参考**：通用神经树骨架 v3.1 / llm-wiki-agent / Cherry Studio KB v2（现有 hank-knowledge 实现）

---

## 一、设计目标

现有 hank-knowledge 是「材料库」：文件/目录/URL/笔记导入即快照，BM25/向量/rerank 检索片段。v0.3 在其之上引入 **知识成熟度分层**，让插件从「检索片段」升级为「判定引擎 + 活体 wiki」：

1. **有标准答案的知识 → 神经树（codified）**：法规、SOP、算法、参数阈值——可判定、需精确、现场可执行。
2. **没有标准答案/仍在学习的知识 → LLM Wiki（fuzzy）**：观点、研究前沿、个人笔记、多源争议——持续积累、允许矛盾、随摄入变富。
3. **深度融合可转换**：两者是**同一张知识图谱的两种形态**，按「成熟度」自动双向转换，转换全程审计。
4. **子库可拆分、可融合**：一个知识库可含多棵神经树 + 多个 wiki 主题；合并库时节点/边按成熟度归一。
5. **UI 美化 + 可视化**：管理界面全面重构，新增**神经树可视化视图**（突触图 + 神经元卡片 + 成熟度色带）。
6. **自动命名规范**：节点命名规则化，支持"丢一本书 → 自动生成一棵神经树"。

---

## 二、核心概念：统一知识图谱 + 成熟度状态机

### 2.1 一句话架构

> 底层是**一张节点-边图**（node = 神经元 / wiki 页 / entity / concept，edge = 突触 / wikilink / inferred），
> 每个节点带 `maturity` 字段决定它是「判定单元」还是「wiki 页面」，检索时按成熟度路由并**标注答案类型**。

### 2.2 成熟度状态机（Knowledge Maturity）

```
             证据增多 / 通过审查             反向触发词缺失 / 用户反馈负面
   fuzzy ────────────────▶ emerging ────────────────▶ codified
   探索/草稿              多源共识/成簇            判定单元(神经树神经元)
     ▲                        │                        │
     │◀───────────────────────┴────────────────────────┘
     └── supersede / 证据失效 / 用户多次反馈"不准确" → 降级(保留审计)
```

| maturity | 含义 | 检索行为 | 冲突处理 | 生命周期 |
|---|---|---|---|---|
| `fuzzy` | LLM Wiki 页面，草稿/探索 | 语义检索，输出**综合**（带 wikilink 引用） | 允许矛盾，记录不裁决 | ingest → 更新 → 可 lint |
| `emerging` | 多来源共识，成簇待升级 | 语义 + 触发词，输出综合+置信度 | 矛盾需标注，触发复核 | 达到门槛可提交升级 |
| `codified` | 神经树神经元，判定单元 | 触发词精确命中，输出**判定**（含 L1/L2/L3） | 禁止矛盾（矛盾=错误，触发降级审查） | 10元素完整，验证脚本通过 |

### 2.3 转换规则（深度融合的关键）

| 方向 | 触发 | 动作 | 审计 |
|---|---|---|---|
| `fuzzy → emerging` | 同一主题被 ≥2 个独立来源引用，形成 wikilink 簇 | LLM 汇总各源 claim，生成候选页 | 记录来源页面清单 |
| `emerging → codified` | 用户/Agent 发起「提升为神经树」，且通过 9 项自检 | 映射到 10 元素模板（缺字段标「待补充」），写入突触 | 记录综合来源 + 提交人 |
| `codified → fuzzy` | supersede 标记 / 有效期过期 / 负面反馈加权 ×2 达标 | 保留原判定模板快照，标记降级原因 | 快照归档，可回滚 |

> **硬规则**：`emerging → codified` **永不自动**，必须过「审查」工作流（见 §4.4）。`codified → fuzzy` 自动触发但保留完整快照。

---

## 三、数据模型（落地改动）

### 3.1 现有结构（v0.2）

```text
bases/{baseId}/
  meta.json          # 知识库元数据
  items.json         # 材料数组（file/directory/url/note）
  chunks/{itemId}.json
  raw/
```

### 3.2 v0.3 扩展

```text
bases/{baseId}/
  meta.json           # + knowledgeMode: "materials" | "hybrid" | "tree"
  items.json          # 保持向后兼容（材料仍是叶子素材源）
  graph.json          # ★ 知识图谱（nodes / edges / index 三段式）
  nodes/              # ★ 节点独立文件（神经元 / wiki 页 / entity / concept）
    {nodeId}.json
  trees/              # ★ 神经树文件（Markdown，可导出/导入）
    神经树_《领域名》_v1.0.md
  wiki/
    index.md
    sources/
    entities/
    concepts/
    syntheses/
  chunks/{itemId}.json
  raw/
```

### 3.3 统一节点类型（新增 `lib/graph.ts`）

```ts
type NodeMaturity = "fuzzy" | "emerging" | "codified";

type GraphNodeType = "neuron" | "wiki-page" | "entity" | "concept";

interface GraphNode {
  id: string;                 // nodeId()："nd_" + uuid
  baseId: string;
  type: GraphNodeType;
  maturity: NodeMaturity;
  title: string;              // 规范化命名（见 §6）
  /** 神经树 10 元素字段（codified 节点完整；fuzzy 节点仅定义/场景/出处） */
  elements?: {
    definition: string;
    scenario: string;
    keyData: string;
    triggers: string[];        // 精确词在前，模糊词在后（// 分层）
    tags: string[];
    decisionTemplate?: string;
    misjudgmentDefenses: string[];
    checkList: string[];
    source: string;            // 出处定位 + L1/L2/L3 可信度
    validity?: { verifiedAt: string; superseded: boolean; nextCheck: string };
  };
  sourceRefs: string[];        // 关联材料 itemId / wiki source slug
  inbound: string[];           // 入边节点 id
  outbound: string[];          // 出边节点 id
  stats: {
    hitCount: number;
    negativeFeedback: number;
    lastHitAt: number | null;
    lastUpdatedAt: number;
  };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "synapse" | "wikilink" | "inferred" | "hierarchy";
  relation?: "因果延伸" | "互斥对比" | "层级深化" | "流程衔接" | "参数共享";
  strength: number;            // ★ ~ ★★★★★
  bidirectional?: boolean;
  inferredConfidence?: number; // inferred 边：0~1
}
```

### 3.4 检索结果扩展

```ts
interface KnowledgeSearchResult {           // 现有字段保持
  pageContent: string;
  score: number;
  scoreKind: "bm25" | "vector" | "rrf" | "rerank";
  rank: number;
  chunkId: string;
  itemId: string;
  // v0.3 新增
  answerKind: "verdict" | "synthesis";
  maturity: NodeMaturity;
  nodeId?: string;
  confidence?: "L1" | "L2" | "L3";
  sourcePage?: string;        // synthesis 时引用的 wiki 页
  contradictions?: string[];  // synthesis 时的矛盾提示
}
```

---

## 四、模块设计（新增/改动 lib/）

### 4.1 `lib/graph.ts`（新）

统一图谱读写。职责：
- `addNode` / `updateNode` / `linkNodes` / `findNodesByTrigger` / `findNodesByTag`
- 触发词倒排索引（与 MemoryIndex 的 BM25 互补：前者结构化精确，后者语义召回）
- 图的持久化：`graph.json`（节点索引 + 边）+ `nodes/{id}.json`（节点正文）

### 4.2 `lib/tree-builder.ts`（新）— 自动建树/命名

把「一本书 / 一批材料」编译为一棵神经树。两阶段：

**阶段 A：大纲抽取（LLM）**
```
输入：材料文本（复用现有 chunking + extract）
→ 领域识别（法律/医学/工程/编程/金融/通用，映射领域架构模板）
→ 主干划分（目录章节 → 主干，每主干 2~8 神经元）
→ 每神经元：定义/场景/要点/触发词（自动从原文提取关键词）
→ 可信度分级（权威来源 L1 / 有依据 L2 / 经验 L3，由材料性质推断）
→ 输出：结构 JSON（供评审）或直接落树（供用户确认）
```

**阶段 B：落树 + 索引**
- 写入 `trees/神经树_《领域名》_v1.0.md`（模板见神经树骨架 01）
- 同步生成 codified 节点写入 `graph.json`，建立树内突触（层级深化/流程衔接）
- 更新全域索引表（树目录 / 触发词索引 / 跨树突触）

### 4.3 `lib/wiki-ingest.ts`（新）

移植 llm-wiki-agent 的 ingest 工作流到插件内：
```
新增材料 → (可选 LLM) 生成 sources/{slug}.md 摘要页
        → 抽取 entity / concept → 建 wiki 页 + wikilink
        → 更新 index.md / overview.md / log.md
        → 矛盾检测：新 claim vs 已有页，冲突则标记
        → 成熟度评估：命中 emerging 门槛则提示可升级
```

### 4.4 `lib/maturity.ts`（新）— 成熟度引擎

- `evaluateNodeMaturity(node, stats)`：读 hitCount / negativeFeedback / 来源数，产出升级候选
- `promoteToCodified(node)`：走审查工作流（9 项自检），产出待确认变更，**不自动写**
- `demoteToFuzzy(node, reason)`：快照归档 + 降级标记 + 保留审计链
- 负面反馈回流：`feedback("不准确")` → 节点标记待核查；`feedback("无用")` → 进入评估池权重 ×2

### 4.5 `lib/verifier.ts`（新）

神经树验证器（移植骨架的 `神经树验证器.py`，JS 实现）：
- V1-V17 检查：Header 统计 / 根验证 / 10 元素完整 / 触发词 ≥5 / 判定模板 ≥5 步 / 误判防御 ≥3 / 检查清单 ≥3 / 突触双向 / 出处精确 / 矛盾检测 / 熔断 / 健康度

### 4.6 检索路由（改动 `lib/knowledge.ts` search）

```
query 归一化（同义词表，复用全域索引表附录）
→ 1. 触发词索引精确命中 codified → 输出判定（联动 ≤3 条突触，1 层深）
→ 2. 语义检索（现有 BM25/向量/RRF）命中 fuzzy/emerging → 输出综合
→ 3. rerank 精排（可配置）；answerKind 随结果标注
→ 4. 记录搜索日志 + 决策审计（判定路径 / 突触 / 置信度）
```

---

## 五、UI 可视化设计（routes/page.ts 重构）

### 5.1 视觉体系

- **深色玻璃拟态**（glassmorphism，跟随宿主主题色 CSS 变量），圆角卡片 + 柔和阴影 + 渐变
- **成熟度色带**：`fuzzy` 雾蓝 / `emerging` 琥珀 / `codified` 翡翠绿——全界面统一语义
- **字体**：系统字体栈 + 等宽用于数据/代码，无外部字体请求（保持零外部资源）

### 5.2 页面结构

```
┌─────────────────────────────────────────────────────────┐
│ 侧边栏(知识库列表) │  主区：Tab 切换                        │
│   ● 知识库A        │  [概览] [材料] [神经树] [Wiki] [检索]    │
│   ● 知识库B        │                                         │
│   ➕ 新建知识库     │  ┌─────────────────────────────────┐   │
│                   │  │ 神经树可视化（默认视图）          │   │
│ 成熟度图例         │  │  ┌─┐─┌─┐─┌─┐                  │   │
│  雾蓝 探索         │  │  └─┘─└─┘─└─┘  突触连线         │   │
│  琥珀 共识         │  │  可缩放/拖拽/点击展开卡片         │   │
│  翡翠 已编译       │  └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 5.3 神经树可视化（核心新增）

**交互**：
- **力导向图**（内联实现，不引外部库）：节点=神经元，边=突触；成熟度着色，突触强度映射线宽
- **点击节点** → 展开神经元卡片：10 元素表格 + 来源 + 可信度 + 反馈按钮（有用/无用/不准确）
- **突触悬停** → 显示关联类型 + 逻辑描述
- **筛选**：按成熟度 / 按标签 / 按主干过滤；搜索高亮
- **操作**：右键节点 → 提升/降级/编辑/删除；拖拽布局可保存

**实现约束**：全内联 HTML/CSS/JS，力导向图用轻量手写模拟（~300 行，参考 d3-force 的核心公式），零 CDN。

### 5.4 Wiki 视图

- 主题卡片瀑布流（index.md 渲染）
- 页面正文渲染器：frontmatter + wikilink 高亮跳转 + 矛盾标记徽标
- entity/concept 侧栏关联面板

### 5.5 一键建树向导

```
[新增材料] → 选择"编译为神经树"
  → 选材料（文件/目录/URL/笔记）
  → 选择领域（自动识别，可改）
  → 预览大纲（主干/神经元/触发词草稿，可编辑）
  → 确认 → 后台建树 → 完成后跳转神经树视图
```

---

## 六、节点命名规范（自动命名）

### 6.1 命名规则（`lib/naming.ts`）

| 节点类型 | 规则 | 示例 |
|---|---|---|
| 神经树文件 | `神经树_《领域名》_v{major}.{minor}.md` | `神经树_《民法典·合同解除》_v1.0.md` |
| 神经元 | `{主干序号}·{动词短语/名词短语}`，≤15 字，优先动宾 | `N1·判定解除类型`、`N3·计算解除后果` |
| 主干 | 领域架构段名，`{层级词}{序号}：{主题}` | `主干1：解除类型` |
| wiki 页（concept） | `TitleCase`（英文）/ 中文名词短语 | `AttentionMechanism` / `注意力机制` |
| wiki 页（entity） | `TitleCase`（人名/公司/项目） | `SamAltman` / `MetaAI` |
| source 页 | kebab-case 对应材料文件名 | `attention-is-all-you-need.md` |
| 节点 id | `nd_` + uuid（技术标识，不参与命名） | `nd_a1b2...` |

### 6.2 自动命名策略

- **一级命名（确定性，无 LLM）**：由来源推导——文件名 slug、章节标题清洗、Tag 映射。示例："输入《民法典》→ 树名 `神经树_《民法典》_v1.0.md`，主干取篇/章标题。
- **二级命名（LLM 辅助，人工确认）**：神经元命名用「动词+宾语」模板约束输出；触发词从原文高频关键词 + 同义词映射表生成；命名冲突时 `_1` / `_2` 后缀（复用现有 keep-copy 逻辑）。
- **强制校验**：命名不符规范（长度/字符/重复）时验证器 V 类检查报错，阻止落树。

### 6.3 "一本书 → 一棵树" 端到端示例

```
输入：上传《民法典合同编》PDF/MD
→ 领域识别：法律（→ 法律架构模板：原则→类型→程序→后果→例外）
→ 主干：原则 / 订立 / 效力 / 履行 / 变更转让 / 权利义务终止 / 违约责任
→ 神经元：每章 3~8 个，如「N2·区分要约与要约邀请」「N7·判断合同是否成立」
→ 触发词：合同成立|要约|承诺|§470 ...
→ 树内突触：流程衔接（要约→承诺→成立）、层级深化（成立→生效）
→ 全域索引表更新
→ 验证器跑通 → 生成 codified 神经元 + 树文件
→ 若材料含多源争议观点（如学术讨论），单独进 wiki（fuzzy）
```

---

## 七、Agent 工具扩展

| 工具 | 说明 | 权限 |
|---|---|---|
| `knowledge_build_tree` | 由材料编译神经树（自动命名/大纲预览） | review |
| `knowledge_add_neuron` | 增神经元（10 元素，缺字段标待补充） | routine |
| `knowledge_list_tree` | 查看树/节点/突触（供 UI 可视化数据源） | 只读 |
| `knowledge_promote_node` | 节点提升（emerging→codified，走审查） | review |
| `knowledge_demote_node` | 节点降级（codified→fuzzy，快照审计） | review |
| `knowledge_wiki_ingest` | 材料 → wiki 页（source/entity/concept） | routine |
| `knowledge_verify_tree` | 运行神经树验证器 | 只读 |

现有工具保持兼容，新增参数 `maturityFilter` / `answerKindFilter`。

---

## 八、版本规划

| 版本 | 范围 | 验收 |
|---|---|---|
| v0.3.0 | graph.json + 节点模型 + maturity 状态机 + 检索 answerKind | 材料可编译为 fuzzy/codified 节点并检索 |
| v0.3.1 | 命名规范 lib + 验证器 + 自动建树向导（无 UI 时 API 可调用） | 一本书 → 一棵树（CLI/工具层面） |
| v0.4.0 | UI 重构 + 神经树可视化 + wiki 视图 + 一键建树向导 | 可视化界面可用，零外部资源 |
| v0.5.0 | wiki ingest 工作流 + 矛盾检测 + 成熟度自动评估 | ingest 多格式 → 自动建页 |
| v0.6.0 | 升降级闭环 + 决策审计 + 图谱导出/导入 | 全生命周期闭环 |

---

## 九、风险与边界

1. **LLM 幻觉注入神经树**：`emerging→codified` 必须人审 + 验证器，禁止自动；出处 L 分级强制。
2. **兼容性**：v0.2 的 items.json / chunks / 检索 API 全部保留；`knowledgeMode` 默认 `materials`（老库行为不变），新库可选 `hybrid`。
3. **检索规模**：触发词索引 O(log n) 精确命中；图谱边存储用 JSON，节点量建议 <5 万；可视化力导向图惰性加载（只渲染当前子树）。
4. **离线**：全内联可视化，无 CDN；LLM 功能（自动建树/wiki ingest/成熟度评估）未配置模型时自动降级为手动模板 + 确定性命名。
5. **持久化原子性**：图写入沿用现有「写临时文件 → rename」原子替换 + per-path 队列。

---

*本文档为设计稿，实现细节以代码为准。*
