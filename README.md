# hank-knowledge — Hanko Agent 知识库插件

把 Cherry Studio 的知识库体系移植为 Hanko Agent（openhanako）插件：**管理化材料库**（导入即快照、生命周期状态机、后台异步索引），默认 BM25 全文检索，可配置 embedding 升级为向量 / 混合检索（RRF 融合），可配置 rerank 精排。

## 安装

- **官方市场**：HanaAgent 设置 → 插件 → 插件市场，搜索「知识库」安装（需开启 full-access 插件开关）
- **手动**：将本仓库 `hank-knowledge/` 目录拖入设置页插件安装区，或解压 [Releases](https://github.com/zhang8019/hank-knowledge/releases) 里的安装包后放入 `${HANA_HOME}/plugins/`

## 功能

- **知识库**：一个名称即可创建；BM25-only 起步，之后可在设置中配置 embedding 升级为向量检索
- **材料类型**：`file`（文件快照）/ `directory`（文件夹导入，保留层级）/ `url`（网页快照）/ `note`（笔记）
- **导入即复制**：外部文件的后续修改不影响库内副本；同名冲突自动 `_1` / `_2` 后缀（keep-copy）
- **生命周期状态机**：`idle → preparing → processing → reading → embedding → completed / failed / deleting`，UI 与工具全部基于业务状态，不扫描文件系统
- **检索**：BM25（中文 bigram + 英文词，默认）→ 配置 embedding 后混合检索（BM25 + 向量，RRF 融合）→ 配置 rerank 后对候选片段精排（`relevance` 分数 + 阈值过滤）；返回 `pageContent / score / scoreKind / rank / chunkId / itemId`
- **异步工作流**：建库 / 添加 / 删除 / 重建索引均"接受即返回"，索引在后台按库串行执行；插件重启后自动恢复未完成任务
- **Agent 工具**：建库、增删材料、搜索、读取、查看 chunk、重试失败项
- **管理界面**：插件页面 / 小组件（`/page`、`/widget`）全内联 HTML（中文），提供建库、上传、命中测试、状态监控，零外部资源请求

## 部署

构建产物由宿主直接加载（`manifest.json` / `package.json` / `index.js` / `tools/*.js` / `routes/*.js`），产物为 **ESM**，**零 npm 运行时依赖**（仅构建时需要 Node）。

```bash
# 1. 构建（需要 Node.js >= 20；Windows 可直接双击 build.cmd）
npm install
npm run build

# 2. 拷贝到 Hana 插件目录
#    将整个目录（含 manifest.json、package.json、index.js、tools/、routes/）复制为
#    ${HANA_HOME}/plugins/hank-knowledge
#    （推荐使用安装包 zip，解压后把 hank-knowledge/ 放入 plugins/）

# 3. 重启 Hana，在插件设置中启用
```

> 环境说明：`C:\Program Files\nodejs` 已在**系统 PATH** 中。若当前终端里 `node` / `npm` 仍提示找不到，是因为该进程是 PATH 生效前启动的旧环境快照——**重启终端（或重启 Cursor）即可**，无需手动修改 PATH。构建脚本内部用 `process.execPath` 调用 esbuild，不依赖 PATH 解析 esbuild 二进制。
>
> **不要移除发布包中的 `package.json`**（`"type": "module"`）：宿主以动态 `import()` 加载插件，ESM 产物配合该字段才能被正确解析。

开发期校验：

```bash
npm run typecheck     # tsc --noEmit
npm run build         # 产出 ESM：index.js / tools/*.js / routes/*.js
npm run smoke         # 端到端冒烟：建库→索引→检索→重建→删除→持久化
node tests/load-check.mjs  # 模拟宿主加载：路由函数 / 插件类 / 工具导出

# 真实模型测试（可选，需密钥）：复制 .env.example 为 .env 填入密钥后
node --env-file=.env tests/real-models.mjs  # SiliconFlow bge-m3 + bge-reranker 全链路
```

## 配置 embedding 与 rerank（可选）

未配置时知识库为 **BM25 全文检索**，开箱即用。在插件设置（宿主按 manifest 渲染，中文界面）中填写：

| 配置项 | 说明 |
| --- | --- |
| `embeddingBaseUrl` | 嵌入模型 API 地址：OpenAI 兼容的 `/embeddings` 端点，默认硅基流动 `https://api.siliconflow.cn/v1`，可改为其他兼容服务或本地 Ollama |
| `embeddingApiKey` | 嵌入模型 API 密钥（本地服务如 Ollama 可留空） |
| `embeddingModel` | 嵌入模型名，默认 `BAAI/bge-m3`（硅基流动），可改为 `text-embedding-3-small` / `text-embedding-v3` 等 |
| `embeddingDimensions` | 嵌入向量维度；`0` 表示首次索引时自动探测 |
| `rerankBaseUrl` | 重排序模型 API 地址：兼容 `/rerank` 接口（Jina / Cohere 风格），默认硅基流动 `https://api.siliconflow.cn/v1` |
| `rerankApiKey` | 重排序模型 API 密钥 |
| `rerankModel` | 重排序模型名，默认 `BAAI/bge-reranker-v2-m3`（硅基流动） |
| `searchDefaultDocumentCount` | 默认检索条数 |
| `searchThreshold` | 检索相关性阈值；仅对 rerank 的 `relevance` 分数生效，`0` 为不过滤 |

使用方式：新建知识库勾选"启用向量检索"；对已有库在管理界面点"启用向量"（自动探测维度并全库重建）、"启用重排"（对候选片段精排）。rerank 服务瞬时失败时自动降级为未重排结果，不中断检索。

## 配置 MinerU 文档解析（可选）

导入 PDF / Office（docx/pptx/xlsx 等）/ 图片时，插件会调用 MinerU 自动转换为 **Markdown** 后再索引（Agent 可直接阅读），转换产物落盘缓存，重建索引不重复调用。

| 配置项 | 说明 |
| --- | --- |
| `mineruBaseUrl` | MinerU 解析服务地址，默认 `https://mineru.net`；留空则禁用 |
| `mineruApiKey` | MinerU API Token（从 https://mineru.net/apiManage 创建，有效期三个月） |
| `mineruModel` | 解析模型：`vlm`（推荐）/ `pipeline` / `MinerU-HTML`（HTML 必选） |
| `mineruLanguage` | 文档语言，默认 `ch` |
| `mineruAutoConvert` | 导入二进制文件时自动转换，默认开 |
| `mineruEnableTable` / `mineruEnableFormula` / `mineruOcr` | 表格 / 公式 / OCR 识别开关 |
| `mineruAutoSplit` | PDF 页数超限自动分段解析（默认开） |
| `mineruMaxPagesPerBatch` | 分段每段最大页数；`0` = 用 API 默认上限 |

**两种模式自动选择**：
- 未配置 Token → **Agent 轻量 API**（免 Token，文件 ≤10MB / 20 页，仅输出 Markdown）
- 配置 Token → **精准 API**（≤200MB / 200 页，支持批量与结构化输出）

**超限自动处理**：
- **页数超限**（PDF）：本地探测页数，按 `page_range` / `page_ranges` 分段解析并按页序拼接（如 45 页 → 3 段 `1-20` / `21-40` / `41-45`）
- **大小超限**：Agent 超 10MB → 有 Token 自动升级精准 API；仍超 200MB → 报错提示拆分文件
- 无法探测页数时按单次提交（服务端若报页数超限则失败）

> 文件字节会上传至 MinerU 第三方服务器解析，敏感文件请谨慎。

> **网络白名单**：Hana 插件平台强制 `network.allowedHosts`（manifest 已预置 OpenAI、阿里百炼、硅基流动、智谱、百度千帆、火山方舟、Jina、Cohere、MinerU 等域名，并开放 localhost 供 Ollama）。使用其他服务时需将域名加入 `manifest.json` 的 `network.allowedHosts`（支持 `*.suffix` 通配）后重启。URL 快照抓取同样受此白名单约束。

## Agent 工具

宿主以 `hank-knowledge_knowledge_*` 形式暴露（或按宿主规则加前缀）：

| 工具 | 说明 | 权限 |
| --- | --- | --- |
| `knowledge_list_bases` | 列出全部知识库与材料统计 | 只读 |
| `knowledge_create_base` | 创建知识库（可启用向量） | routine |
| `knowledge_delete_base` | 删除知识库（不可恢复） | review |
| `knowledge_add_items` | 添加 file/note/url/directory 材料 | routine |
| `knowledge_delete_items` | 删除指定材料 | review |
| `knowledge_reindex_items` | 重建索引（仅已完结项） | routine |
| `knowledge_search` | 在指定库中检索片段 | 只读 |
| `knowledge_read_item` | 读取材料全文 | 只读 |
| `knowledge_list_item_chunks` | 查看材料的检索片段 | 只读 |
| `knowledge_retry_item` | 重试失败材料 | routine |
| `knowledge_list_graph` | 查看知识图谱（节点/边/成熟度统计） | 只读 |
| `knowledge_add_node` | 创建图谱节点（神经元/wiki 页/entity/concept，10 元素） | routine |
| `knowledge_link_nodes` | 建立节点关联（突触/wikilink） | routine |
| `knowledge_promote_node` | 提升节点成熟度（emerging→codified，需过字段校验） | review |
| `knowledge_demote_node` | 降级节点成熟度（codified→fuzzy，保留审计） | review |
| `knowledge_build_tree` | 把一本书/材料自动编译为神经树（章节→主干→神经元→突触） | review |
| `knowledge_verify_tree` | 对神经树运行验证器（V1-V17），输出健康度 | 只读 |
| `knowledge_list_tree` | 列出神经树结构（按主干分组展示神经元） | 只读 |

另注册 bus 能力 `hank-knowledge:list-bases` / `hank-knowledge:search` / `hank-knowledge:add-items`，供宿主与其他插件以 `requestBus` 调用。

## 神经树构建（v1.0 新增）

**一本书 → 一棵树**（`lib/tree-builder.ts`）：
1. 章节标题切主干（`## 解除类型` → `主干1：解除类型`）
2. 段落聚类生成神经元（自动命名 `N{序号}·{关键词}`、自动提取触发词）
3. 落 graph（codified 节点）+ 树内突触（流程衔接串联）
4. 渲染标准 Markdown 树文件 `神经树_《领域名》_v1.0.md`

**验证器**（`lib/verifier.ts`，V1-V17）：10 元素完整 / 触发词≥5 / 判定模板可执行 / 误判防御≥3 / 检查清单 / 突触 / 根验证 / Header 统计 / 出处可信度 L1-L3 / 矛盾检测，输出健康度（0-100，优/良/差）。

## 知识图谱（v1.0 新增）

统一知识图谱数据层：节点（神经元 / wiki 页 / entity / concept）+ 边（突触 / wikilink / inferred / hierarchy），每个节点带**成熟度**字段：

```
fuzzy(探索) ──多源引用──▶ emerging(共识) ──人审+字段校验──▶ codified(判定单元)
   ▲                                                          │
   └──────────── supersede / 负面反馈×2 ──────────────────────┘（快照降级）
```

- **命名规范**（`lib/naming.ts`）：神经元 `N{序号}·{短语}`（≤15 字）、主干 `主干{序号}：{主题}`、树文件 `神经树_《领域名》_v1.0.md`、concept/entity `TitleCase`、source kebab-case；冲突自动 `_N` 后缀
- **成熟度引擎**（`lib/maturity.ts`）：评估/提升门槛/降级触发；`emerging→codified` 永不自动（需 10 元素关键字段完整），`codified→fuzzy` 保留审计链
- **触发词索引**：与 BM25 互补，结构化精确命中（codified 优先）

## 架构

```text
tools/*.ts            routes/*.ts（全内联中文管理界面 + REST API）
   \                     /
    └── lib/runtime.ts（进程级单例，globalThis 按 pluginId 隔离）
            ├── KnowledgeService（门面：base / ingestion / query，含 rerank 精排阶段）
            ├── KnowledgeStore（JSON 持久化：meta / items / chunks / raw）
            ├── KnowledgeWorkflow（每库串行队列：prepare-root / index-document / delete-subtree / reindex-subtree）
            └── MemoryIndex（BM25 + 向量双车道内存索引，RRF 融合）
```

数据布局（`ctx.dataDir`，由宿主提供）：

```text
bases/{baseId}/
  meta.json          知识库元数据（embedding 模型 / 维度 / rerank 模型）
  items.json         材料数组（业务状态权威）
  chunks/{itemId}.json  检索片段（派生数据，可重建）
  raw/               原始材料字节（flat；目录导入保留子树）
```

关键设计（对齐 Cherry Studio v2）：

- **业务状态即真相**：UI / 工具读 `items.json` 状态机，从不实时扫描文件系统；`raw/` 是内部字节存储
- **删除是取消原语**：删除标记 `deleting` 后后台清理；重建索引仅允许已完结子树；删库先取消并等待链上任务退出
- **Windows 兼容**：JSON 写入为"写临时文件 → rename"原子替换，带 per-path 串行队列与重试（应对 Windows rename 占用）
- **embedding 去重**：向量按 chunk 文本批量嵌入（同文本复用向量）；维度校验失败即失败该材料，可重试
- **rerank 降级**：重排失败时自动回退到未重排的候选排序（Cherry 语义）；`threshold` 仅对 `relevance` 分数生效

## 已知限制

- **二进制格式**：`txt/md/csv/json/html/代码` 等文本类直接解析；PDF / Office / 图片等二进制配置 MinerU 后自动转换，未配置时保持"需要转换"失败态
- **MinerU 限额**：Agent 轻量 API ≤10MB/20 页；精准 API ≤200MB/200 页；文件上传至第三方服务器，敏感数据请注意
- **检索规模**：向量车道为暴力扫描（与 Cherry 当前实现一致），单库向量行数建议控制在十万以内
- **URL 快照**：首次索引抓取一次并落盘（离线可读）；"刷新"重新抓取；抓取受网络白名单约束
- **阈值语义**：`threshold` 仅对 rerank 的 `relevance` 分数生效；BM25/RRF 的 `ranking` 分数透传不过滤（与 Cherry 当前行为一致）

## 参考与致谢

本项目借鉴了以下开源项目的设计与实现，特此声明并致谢：

| 项目 | 许可证 | 借鉴内容 |
| --- | --- | --- |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) | **设计参考**：知识库 v2 架构（管理化材料库、导入即快照、生命周期状态机、BM25/向量混合检索与 RRF 融合、rerank 精排与阈值语义、异步索引工作流、删除即取消）。本插件为独立实现，未复制其代码。 |
| [openhanako](https://github.com/Ganlin/openhanako)（Hanko Agent） | [Apache-2.0](http://www.apache.org/licenses/LICENSE-2.0) | **代码参考**：`lib/types.ts` 为 `@hana/plugin-runtime` / `@hana/plugin-protocol` 的类型子集（Apache-2.0 允许复制，保留本声明）；插件 manifest 结构、工具命名导出协议、路由注册方式均按其平台规范实现。 |
| [hana-desktop-orchestrator](https://github.com/Ganlin/hana-desktop-orchestrator) | MIT | **实现参考**：插件部署最佳实践（ESM 产物 + `package.json(type: module)`、全内联 HTML 管理界面、相对路径 API 与查询参数继承、发布包结构）。 |

**本项目许可证：MIT**（见 `LICENSE` 文件）。若你有意分发或修改本插件，请遵守各参考项目的许可证条款（尤其 Cherry Studio 的 AGPL-3.0 约束）。
