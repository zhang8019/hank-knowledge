# hank-knowledge 知识库插件测试报告

| 项目 | 内容 |
|---|---|
| 插件 | hank-knowledge（Knowledge Base）v0.1.0 |
| 测试日期 | 2026-08-06（凌晨 04:00 ~ 上午 08:15） |
| 测试环境 | Windows 10.0.26200 / HanaAgent 0.421.24（minAppVersion 要求 0.158.0，满足） |
| 测试方式 | 静态分析 + 模块加载测试 + mock 运行时测试 + 端到端功能测试 + 真实环境加载验证 |
| 最终结论 | **插件功能全部正常，加载链路已修复并验证，可用于日常使用** |

---

## 一、结论摘要

1. **功能层面：全部通过。** 10 个工具按真实使用流程跑通（建库 → 加材料 → 检索 → 读 chunk → 重索引 → 删除），19 项断言全过。
2. **曾存在两个 P0 缺陷，根源是同一件事（打包格式），已修复并验证。**
   - P0-1：页面路由静默注册失败 → UI 打开显示 404
   - P0-2：插件 onload 生命周期不执行
3. **根因**：esbuild 以 `--format=cjs` 打包，输出带 `__esModule` 标记的 CommonJS；而 Hana 用 ESM 动态 `import()` 加载插件，期待 `import(...).default` 直接是路由函数 / 插件类。CJS 产物的 `.default` 是嵌套对象，导致 Hana 加载器静默跳过路由注册与插件实例化（不报错）。
4. **修复**：构建格式改为 `esm`，插件根目录补 `package.json`（`"type": "module"`）。真实环境已验证：`lifecycle onload` 正常执行（4ms），页面路由正常注册。

---

## 二、测试环境

- 操作系统：Windows 11（10.0.26200）
- HanaAgent：桌面版 0.421.24，数据目录 `C:\Users\zy177\.hanako`
- Node.js：`C:\Program Files\nodejs\node.exe`（动态 import 行为与 Hana 运行时一致）
- 插件安装位置：`C:\Users\zy177\.hanako\plugins\hank-knowledge`

---

## 三、测试范围与方法

| # | 方法 | 覆盖内容 |
|---|---|---|
| 1 | 安装包静态验证 | zip 结构、CRC 完整性（Python zipfile 全量校验）、manifest 合法性 |
| 2 | 服务端加载链路源码审查 | 解压判定、目录判定、manifest 解析、插件加载五阶段、路由重写、assets 服务 |
| 3 | 模块加载测试 | node `require()` 与动态 `import()` 两种方式分别加载 index/routes/tools |
| 4 | mock 运行时测试 | 模拟 Hana ctx（dataDir/config/network/bus/log），验证 onload、runtime 初始化 |
| 5 | 路由注册测试 | mock Hono app 接收注册，核对页面路由与 17 条 API 路由 |
| 6 | 端到端功能测试 | 10 个工具按业务流串联，19 项断言 |
| 7 | 搜索专项测试 | 6 组中文查询验证 BM25 分词与命中 |
| 8 | 真实环境验证 | 读取 Hana 插件加载日志，核对五阶段与 onload |

---

## 四、测试结果

### 4.1 安装与加载链路（真实环境）

修复后 Hana 日志（2026-08-06_08-14-25.log）：

```
[08:14:26] loading plugin "hank-knowledge"...
[08:14:27] loaded "hank-knowledge" tools (1483ms)          ✔ 10 个工具注册
[08:14:27] loaded "hank-knowledge" configuration (1ms)     ✔
[08:14:28] loaded "hank-knowledge" routes (175ms)          ✔ 页面 + API 路由
[08:14:28] loaded "hank-knowledge" page (0ms)              ✔
[08:14:28] loaded "hank-knowledge" lifecycle import (68ms) ✔
[08:14:28] loaded "hank-knowledge" lifecycle onload (4ms)  ✔ 修复后出现
[08:14:28] plugin "hank-knowledge" loaded (1732ms)
```

> 修复前同一位置缺失 `lifecycle onload` 阶段，页面路由静默失败，UI 显示 404。

### 4.2 功能测试矩阵（端到端，19/19 通过）

| 测试项 | 工具 | 结果 |
|---|---|---|
| 插件 onload / onunload | — | ✔ |
| runtime 全局槽初始化 | — | ✔ |
| 工具注册完整性 | 10 个 tools | ✔ |
| 创建知识库 | knowledge_create_base | ✔ |
| 列出知识库 | knowledge_list_bases | ✔（含文档数统计） |
| 添加材料（note 类型） | knowledge_add_items | ✔ |
| 全文检索 | knowledge_search | ✔ |
| 列出检索片段 | knowledge_list_item_chunks | ✔ |
| 读取材料全文 | knowledge_read_item | ✔ |
| 重建索引 | knowledge_reindex_items | ✔ |
| 删除材料 | knowledge_delete_items | ✔ |
| 删除知识库 | knowledge_delete_base | ✔ |
| 无效材料重试容错 | knowledge_retry_item | ✔（优雅报错不崩溃） |

### 4.3 路由注册（mock app 验证）

- 页面路由：`GET /page` ✔（HTML 含 `#root`，script 指向 `/api/plugins/hank-knowledge/assets/panel.js`）
- API 路由 17 条：`/api/status`、`/api/bases`（CRUD）、`/api/upload`、`/api/search`、`/api/chunks`、`/api/reindex` 等 ✔

### 4.4 搜索专项（BM25 中文分词）

| 查询 | 结果 | 评分说明 |
|---|---|---|
| 检索 | 命中 m1（score 1） | 单词命中 |
| 检索验证 | 命中 m1（score 2） | 词组匹配加权更高 |
| 本地优先 | 命中 m2（score 2） | ✔ |
| 修复 / AI / ESM | 均命中 | 短词正常 |

> 注意：`knowledge_add_items` 后索引为**异步构建**，立即搜索可能短暂查不到（回归测试曾出现）。等待约 2 秒后全部命中。属正常时序，非缺陷，但建议使用方注意。

---

## 五、发现的问题清单

### P0-1（已修复）页面 404：路由注册被静默跳过
- **现象**：安装后 UI 打开 Knowledge Base 显示 404 Not Found
- **根因**：esbuild `--format=cjs` 产物带 `__esModule` 标记，Hana 动态 `import()` 后 `.default` 为嵌套对象 `{ default: fn }` 而非函数，加载器 `typeof l.default == "function"` 判定失败，路由注册被**无提示跳过**
- **修复**：`scripts/build.mjs` 的 `--format=cjs` → `--format=esm`

### P0-2（已修复）onload 生命周期不执行
- **现象**：加载日志缺少 `lifecycle onload` 阶段，插件激活状态不完整
- **根因**：同 P0-1，插件类未通过 default 导出暴露
- **修复**：同 P0-1（ESM 输出后 `import().default` 为类）

### P1（已确认正常，注意使用）异步索引时序
- `add_items` 返回后立即检索可能命中不到新内容；索引异步完成（约秒级）
- 建议：UI 提示或检索前等待；如需强一致可考虑 add_items 同步构建

### P1（待改进）zip 直装链路
- **现象**：安装时选择 zip 包，文件选择器无响应/未进入安装流程；解压后选文件夹可正常安装
- **定位**：插件包本身字节级健康（CRC、结构、manifest 全过），服务端 zip 分支逻辑正常；问题疑似在前端 select-plugin 对话框 → IPC 返回路径 → POST /plugins/install 链路
- **建议**：如需彻底修复需继续排查前端对话框链路；当前可用"解压后选文件夹"方式规避，另建议打包时确保 zip 顶层为单目录

### P2（操作项）备份目录引发 id 冲突警告
- **现象**：日志出现 `plugin id "hank-knowledge" 冲突（source "community", 目录 "hank-knowledge.bak-cjs"），跳过`
- **原因**：排查期备份目录 `C:\Users\zy177\.hanako\plugins\hank-knowledge.bak-cjs` 未删除
- **处理**：确认新版本稳定后删除该目录（无害，但每次启动产生警告）

---

## 六、给开发者的修改建议清单

1. **构建脚本**（scripts/build.mjs）已改为 `--format=esm`，保持即可；**不要回退 cjs**。
2. **package.json 已加 `"type": "module"`，打包发布时必须包含该文件**，否则安装后 .js 被 Node 按 CJS 解析、ESM 语法直接报错。
3. **发布 zip 清单**：至少包含 `manifest.json`、`package.json`、`index.js`、`tools/`、`routes/`、`assets/`、`README.md`。建议写一个打包脚本（可用 `scripts/` 下加 `release.mjs`），自动校验上述文件齐全再出 zip。
4. **建议 bump 版本号到 0.1.1** 并更新 README 的安装说明（标注"选择文件夹安装"）。
5. **索引时序**：考虑在 `knowledge_add_items` 的返回信息中提示"索引异步构建中"；或提供 force 参数。
6. **生命周期**：当前 `onload` 中初始化 runtime（全局槽），逻辑正确；若后续增加页面交互功能，确保页面 handler 走 `ensureRuntime(ctx)` 兜底（已有该机制）。
7. **参考模板**：可参考内置插件 beautify（ESM `export default class`）与 desktop-orchestrator（原生 ESM + 具名导出 tools + default 函数 routes）的写法。

---

## 七、附：关键测试数据

| 测试批次 | 场景 | 结果 |
|---|---|---|
| e2e 功能测试（CJS 旧版, require 加载） | 19 项断言 | 19 通过 |
| 回归测试（ESM 修复版, import 加载） | 13 项断言 | 13 通过 |
| 搜索专项 | 6 组查询 | 6 命中 |
| 真实环境加载 | Hana 日志 | 全绿 + onload 执行 |
| zip 字节级校验 | CRC/结构 | 全部通过 |

---

## 八、v0.2.0 更新记录（2026-08-06 下午）

针对上表 P0 修复与产品反馈（设置界面汉化、缺 rerank、页面加载）的增量验证。

### 8.1 本次变更

| # | 变更 | 说明 |
|---|---|---|
| 1 | 构建产物改 **ESM**（`--format=esm`） | 落实 P0-1/P0-2 修复：`import().default` 直接为路由函数 / 插件类，宿主加载器不再跳过注册 |
| 2 | 发布包补 `package.json`（`"type": "module"`） | 落实报告"给开发者的建议 #2"，安装后 .js 按 ESM 解析 |
| 3 | 页面改为**全内联 HTML**（CSS/JS 内联） | 不再引用 `/assets/panel.js`，彻底消除静态资源 404 的可能；同时注册 `/page` 与 `/widget` |
| 4 | 设置界面**全中文化** | manifest `contributes.configuration` 的 `title` / `description` 全部中文（宿主设置页直接渲染） |
| 5 | 新增**重排序（rerank）** | manifest 新增 `rerankBaseUrl` / `rerankApiKey` / `rerankModel`；`enable-rerank` 后检索对候选片段精排，产出 `relevance` 分数，`searchThreshold` 仅对 relevance 生效（Cherry 语义）；瞬时失败自动降级 |
| 6 | `minAppVersion` 0.158.0 → 0.170.0、补 `ui.hostCapabilities` | 对齐 desktop-orchestrator 参考插件 |
| 7 | 移除 React UI 构建（`ui/`、`assets/`） | 构建脚本只产出 `index.js` / `tools/*.js` / `routes/*.js`，依赖面更小 |
| 8 | 新增 `tests/load-check.mjs`（ESM 加载验证） | 模拟宿主动态 `import()`：路由 default 为函数、生命周期 default 为类、10 个工具具名导出完整 |

### 8.2 v0.2.0 验证结果

| 测试项 | 结果 |
|---|---|
| `tsc --noEmit` 类型检查 | ✔ 0 错误 |
| `npm run build`（ESM） | ✔ |
| `tests/load-check.mjs`（模拟宿主加载） | ✔ 全过（路由函数、插件类、工具导出） |
| `tests/smoke.mjs`（端到端，ESM 产物） | ✔ 20/20 ALL PASS（建库→索引→检索→重建→删除→持久化） |
| rerank 未配置降级 | ✔ 检索走 BM25/混合，`scoreKind=ranking`，不报错 |
| 页面路由 | ✔ `/page` 与 `/widget` 均返回全内联 HTML，零外部资源请求 |

### 8.3 真实模型端到端测试（SiliconFlow，2026-08-06）

| 项目 | 结果 |
|---|---|
| 嵌入模型 | `BAAI/bge-m3`（`https://api.siliconflow.cn/v1`） |
| 重排序模型 | `BAAI/bge-reranker-v2-m3` |
| 向量维度自动探测 | ✔ bge-m3 = **1024 维** |
| 真实 embedding 索引 | ✔ 4 个中英文材料全部完成，chunks 均带 1024 维向量 |
| 混合检索（BM25 + 向量，RRF） | ✔ 中文/英文查询均命中对应文档 |
| 启用重排 | ✔ `rerankModelId` 固化，结果 `scoreKind=relevance`，分数 ∈ [0,1] |
| 阈值过滤（threshold=0.5） | ✔ 仅保留 ≥0.5 的 relevance 结果 |
| rerank 判别质量 | ✔ 包含查询词的文档 0.965，不匹配文档 0.000016（近零） |
| 测试脚本 | `tests/real-models.mjs`（17 项断言全过） |

> 说明：`rerankModel` 配置项默认值已是 `jina-reranker-v2-base-multilingual`，测试中使用 `BAAI/bge-reranker-v2-m3`（SiliconFlow 端点）同样正常——插件调用的是兼容 `/rerank` 接口，模型名由配置决定。

### 8.4 遗留事项（更新）

- **备份目录清理（P2）**：重启后日志出现两个 id 冲突警告（`hank-knowledge.bak-cjs` 与 `hank-knowledge.bak-v01`）。主插件加载正常，但建议确认稳定后删除这两个备份目录，消除每次启动的警告。
- **zip 直装链路（P1）**：仍建议"解压后选文件夹"安装；安装包顶层为单目录 `hank-knowledge/`。

---

*报告生成：2026-08-06 08:15（v0.1.0）· v0.2.0 增量：2026-08-06*
