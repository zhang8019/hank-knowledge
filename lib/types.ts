/**
 * 插件协议类型定义（自包含版本）。
 *
 * 从 openhanako 的 `@hana/plugin-runtime` / `@hana/plugin-protocol` 提取的
 * 类型子集，仅保留本插件实际用到的部分。宿主加载 `tools/*.js` 时读取
 * 命名导出（name / description / parameters / sessionPermission / execute），
 * 类型仅用于开发期校验，不参与运行时。
 */

export type MaybePromise<T> = T | Promise<T>;

export type JsonSchema = Record<string, unknown>;

/** 工具调用在会话权限体系中的分类。 */
export type HanaToolSessionPermissionKind =
  | 'read'
  | 'read_only'
  | 'plugin_output'
  | 'session_file_output'
  | 'workspace_write'
  | 'external_side_effect'
  | 'review'
  | string;

export interface HanaToolInvocationTarget {
  type: string;
  id: string;
  label?: string;
}

export interface HanaToolInvocationDescriptor {
  action: string;
  kind: 'read' | 'routine' | 'review';
  capability: string;
  target?: HanaToolInvocationTarget;
  sideEffect?: Record<string, unknown>;
}

export interface HanaToolSessionPermission<Input = unknown> {
  /** 纯读工具：只访问已授权数据，可在只读会话中运行。 */
  readOnly?: boolean;
  kind?: HanaToolSessionPermissionKind;
  auto?: 'allow' | 'review';
  description?: string;
  sideEffect?: Record<string, unknown>;
  resolveInvocation?: (input: Input) => HanaToolInvocationDescriptor | null;
}

export interface HanaToolResult {
  content?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface HanaEventBus {
  emit(type: string, payload?: unknown): unknown;
  subscribe(
    callback: (event: unknown, sessionPath?: string | null) => void,
    filter?: { types?: string[] | Set<string> },
  ): () => void;
  request<T = unknown>(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<T>;
  hasHandler?(type: string): boolean;
  handle?(type: string, handler: (payload: unknown) => MaybePromise<unknown>): () => void;
  getCapability?(type: string): unknown;
  listCapabilities?(): unknown[];
}

export interface HanaPluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface HanaPluginConfigStore {
  get<T = unknown>(key: string, options?: Record<string, unknown>): MaybePromise<T | undefined>;
  set<T = unknown>(key: string, value: T, options?: Record<string, unknown>): MaybePromise<void>;
  getSchema?(): JsonSchema;
}

export interface HanaPluginNetwork {
  fetch(input: string | URL | Request, init?: Record<string, unknown>): Promise<Response>;
}

export interface HanaSessionFile {
  id?: string | null;
  fileId?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  realPath?: string;
  displayName?: string;
  filename?: string;
  label?: string;
  ext?: string | null;
  mime?: string;
  size?: number;
  kind?: string;
  isDirectory?: boolean;
  [key: string]: unknown;
}

export type HanaResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string }
  | { kind: 'session-file'; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'url'; url: string };

export interface HanaResourceReadResult {
  resourceKey: string;
  resource: Record<string, unknown>;
  content: Uint8Array;
  filePath?: string;
}

export interface HanaResourceStat {
  resourceKey: string;
  resource: Record<string, unknown>;
  exists: boolean;
  isDirectory: boolean;
  filePath?: string;
}

export interface HanaResourceListResult {
  resourceKey: string;
  resource: Record<string, unknown>;
  items: Array<{ name: string; isDirectory: boolean; size: number | null; mtimeMs: number }>;
}

export interface HanaPluginResources {
  stat(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceStat>;
  read(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceReadResult>;
  list(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceListResult>;
  write(ref: HanaResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, options?: unknown): Promise<unknown>;
  mkdir(ref: HanaResourceRef | Record<string, unknown>, options?: unknown): Promise<unknown>;
  delete(ref: HanaResourceRef | Record<string, unknown>, options?: unknown): Promise<unknown>;
}

/** 插件工具定义。静态 `tools/*.js` 通过命名导出被宿主发现。 */
export interface HanaToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters?: JsonSchema;
  promptSnippet?: string;
  promptGuidelines?: string;
  sessionPermission?: HanaToolSessionPermission<Input>;
  metadata?: Record<string, unknown>;
  execute(input: Input, ctx: HanaToolContext): MaybePromise<Output>;
}

export interface HanaToolContext {
  serverId: string;
  userId: string;
  studioId: string;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sessionId?: string | null;
  sessionRef?: { sessionId: string; sessionPath?: string | null } | null;
  bus: HanaEventBus;
  network: HanaPluginNetwork;
  resources: HanaPluginResources;
  config: HanaPluginConfigStore;
  log: HanaPluginLogger;
  registerSessionFile?: (input: Record<string, unknown>) => HanaSessionFile;
  stageFile?: (input: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

export interface HanaPluginContext {
  serverId: string;
  userId: string;
  studioId: string;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sessionId?: string | null;
  bus: HanaEventBus;
  network: HanaPluginNetwork;
  resources: HanaPluginResources;
  config: HanaPluginConfigStore;
  log: HanaPluginLogger;
  registerTool?: (tool: HanaToolDefinition) => () => void;
  registerSessionFile?: (input: Record<string, unknown>) => HanaSessionFile;
  stageFile?: (input: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

export type HanaPluginDisposable = () => void;

export interface HanaPluginLifecycle {
  onload?(ctx: HanaPluginContext, helpers: { register(disposable: HanaPluginDisposable): void }): MaybePromise<void>;
  onunload?(ctx: HanaPluginContext): MaybePromise<void>;
}

export const HANA_BUS_SKIP = Symbol.for('hana.event-bus.skip');