# P2 侦察：DSH 插件如何注册 agent 工具 + 本地如何加载验证

> 任务：t2（scout-runtime）· 项目：E:\git\dsh-workspace-mesh · 日期：2026-10-24
> 目的：解除 SPEC §12 P2（`任务板 + 租约 + swarm_*/mesh_* 工具面`）的两个前置未知量：
> (1) cordis 插件里如何注册 agent 可调用的工具；(2) 本地如何以 file: 方式加载本插件并确认工具真的出现。
> 本文件只做侦察，**不修改 `src/` 下任何文件，不修改 SPEC.md**。

---

## 0. 结论速览

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| a1 | 注册 API | `ctx.tools.register(definition)`——`ctx.tools` 是 `@deepseek-ai/dsh-tools` 提供的 Service（构造器 `super(ctx, "tools")`） | 高（源码） |
| a2 | 工具定义构造 | `defineTool({ name, description, parameters, output, execute })`，来自 `@deepseek-ai/dsh-tools`；也可**手写普通对象**（`register` 只校验 `output`） | 高（源码） |
| a3 | 工具名约束 | 无正则白名单；唯一硬约束：不得叫 `run_code`（PTC 传输保留名），同一层内重名抛错；同名在不同 scope（host/agent）允许 | 高（源码） |
| a4 | 参数 schema | **既不是 zod，也不是裸 JSON Schema**：是 dsh 自有 "value schema DSL"（`{type:'string',required:true,description}`）。但 `register()` 直接把 `definition.parameters` 原样投影给模型，因此**手写裸 JSON Schema 也合法** | 高（源码） |
| a5 | 返回值 | `execute` 返回值必须符合 `output.schema`（否则 `ToolOutputError`）；`output.render(args, value)` 把它渲染成模型可见内容块 | 高（源码） |
| a6 | 错误回传 | `execute` 里 `throw` → 变成 `isError: true` 的工具结果，内容为 `Error: <message>`，**不结束本轮** | 高（源码） |
| b1 | config 到达路径 | patch 行 `config:` → `Entry.options.config` → `registry.plugin(plugin, config)` → `resolveConfig(runtime.Config)` 校验 → `apply(ctx, config)` | 高（源码） |
| b2 | config 校验 | 插件导出 **`Config`**（大写，Standard Schema，schemastery `z.object`）；不导出则原样透传 | 高（源码） |
| b3 | 热更新 | 改 config → `fiber.update()` → dispose + 重新 apply（同一进程）；改插件代码 → 需要重导入（见 c3） | 高（源码） |
| b4 | dispose | `ctx.tools.register()` 本身就是 effect，返回 disposer 且随插件 fiber 自动注销；`ctx.effect(() => () => {...})` 仍然正确 | 高（源码） |
| c1 | 本地加载 | `dsh plugin --profile <name> add file:<abs-path>`（内部转发 pnpm）；或 `dsh <profile> --patch ./x.cordis.patch.yml` 临时叠加层 | 高（源码）+ 未实跑 |
| c2 | 生效 | 插件必须在 **agent preset 的 plugins 列表**里才能被模型看见（host 层挂载 = 全局注册，所有 agent 继承） | 中高（源码推断） |
| c3 | 热重载 | `hmr` 行 `config.root: ["."]` 开启源码监视；否则靠"profile recomposition"重载变更过的插件 | 高（README） |
| d | 最小片段 | 本文给出 **A：零依赖手写 definition**（推荐，符合 SPEC §9.4）与 **B：`defineTool`**（需 peer dep）两个候选 | — |
| e | 未验证项 | 见 §5：CLI 命令未实跑（任务纪律禁止 spawn/shell）、PTC 模式可见性、`file:` 目录的 pnpm 行为 | — |

---

## 1. 取证方法与环境

**本机证据（一手，优先级最高）**

- DSH 运行时源码：`D:\programming\dshdt\resources\app.asar\dsh\node_modules\@deepseek-ai\*`
  （`app.asar` 是 Electron asar 虚拟包；`rg`/glob 读不到，但 **Node 的 `fs` 能读到**，本文全部证据用 `node:fs` 直读 asar 得到）
- 用户 profile：`%USERPROFILE%\.dsh\profiles\desktop\`（`cordis.patch.yml`、`package.json`、`node_modules/`）
- 本仓库：`E:\git\dsh-workspace-mesh\`（`src/`、`cordis.patch.yml`、`package.json`、`SPEC.md` v0.2）

**取证纪律**：本任务明确要求"不得 spawn 进程或调用 shell（SPEC §8）"，因此 **所有 CLI 行为均为源码推导，未实际执行 `dsh plugin ...`**；可读文件与 URL 解析用 `node:fs`/`node:url` 纯函数实测。下文用 ⭐ 标注"源码+实测"，用 📄 标注"仅文档/仅源码"。

---

## 2. (a) 注册 API

### 2.1 真实方法名与调用形态 ⭐

```ts
// 插件必须在 export 里声明 inject，否则 ctx.tools 是 undefined
export const inject = ['tools']

export function apply(ctx: Context, config: MeshConfig): void {
  ctx.tools.register(defineTool({
    name: 'mesh_list_nodes',
    description: '列出 mesh 已知节点。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [...] },
    async execute(args, exec) { /* ... */ },
  }))
}
```

证据链（本机 asar）：

1. **`ctx.tools` 是什么**：`@deepseek-ai/dsh-tools` 的 `ToolRuntime extends Service`，构造器里 `super(ctx, "tools")`（`dsh-tools/lib/index.js:2798`）→ cordis `Service` 构造器 `ctx.reflect.provide(name, self, check)`（`cordis/src/service.ts:42-57`）→ 服务键就是 `tools`。
2. **注册方法**：`ToolRuntime.register(definition)`（`dsh-tools/lib/types/index.js:468-489`，bundle 同名实现 `lib/index.js:2974`）：
   - 必须有 `output = { schema, render, presentationMeta? }`，否则 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`
   - `assertSupportedJsonSchema(output.schema)`——输出 schema 必须落在受支持的 JSON Schema 子集内
   - `timeoutMs` 必须是正的有限数
   - `name === 'run_code'` → 抛错（保留给 PTC 传输）
   - 末尾 `return this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition), { label: 'tools.register()' })` → **返回值就是精确 disposer，且注册本身是 effect，随插件 fiber 销毁自动注销**
3. **真实范例**（不是文档，是产品代码）：`@deepseek-ai/dsh-tool-goal/lib/index.js:257-303`
   ```js
   const inject = ["agents","goals","tools","systemPrompt","sessionProjections"];
   function apply(ctx, config) {
     const resolved = resolveConfig(config);
     ctx.tools.register(defineTool({
       name: "get_goal",
       description: GET_DESCRIPTION,
       parameters: {},
       output: GOAL_OUTPUT,
       execute(_args, exec) { return Promise.resolve(goalValue(ctx.goals.get(execution.agent))); },
       presentCall: () => present("Read current goal", "read")
     }));
   }
   ```
4. **官方包 README**（`@deepseek-ai/dsh-tools/README.md`，"Register a tool" 一节）给的就是 `ctx.tools.register(defineTool({...}))`，并写明"Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically"。

**⚠ 必须 export `inject`**：cordis 的服务访问靠 inject 声明（`cordis/src/registry.ts:330` `Inject.resolve(plugin.inject)`）。`dsh-tool-goal` 的 inject 列表里有 `"tools"`，而本仓库当前 `src/index.ts` **没有 export inject**——这是落地 P2 时必须补的一行。

### 2.2 工具名字符串的命名约束

| 约束 | 来源 | 结论 |
|---|---|---|
| 不得为 `run_code` | `dsh-tools/lib/types/index.js:485-487` | 硬拒绝，无法 shadow |
| 同层重名 | `NamedEntries` 构造器抛 `tool "<name>" is already registered` | 硬拒绝 |
| 跨 scope 同名 | "Scoped tools shadow globals" | 允许（agent scope 可 shadow host 全局） |
| 正则白名单 | — | **没有**。`register()` 里没有任何 `/^[a-z_]+$/` 之类校验 |
| PTC SDK 可寻址性 | `dsh-tools/lib/index.js:1787` 附近 | 名字若是裸标识符则可 `await tools.name(args)`；含 `-` 等字符需 `await tools["my-tool"](args)` |
| 建议 | 内置工具全用 `snake_case`（`get_goal`、`read_file`、`todo_write`…） | 本项目工具面按 SPEC §18 用 `mesh_*`（下划线，天然是裸标识符，PTC 模式下也能直接寻址） |

> SPEC §18 的草稿工具名是 `mesh_*`（`mesh_list_nodes` / `mesh_dispatch` / `mesh_task_status`…），而 §12 里程碑写的是 `swarm_*`。**建议统一为 `mesh_*`**（与包名、目录名 `src/board`、`src/transport` 一致，且 §18 是"给模型用"的最终面）。这属于命名约定，不受 API 限制。

### 2.3 参数 schema 的写法

**不是 zod，也不是裸 JSON Schema——是 dsh 自有的 value schema DSL**（`dsh-tools/lib/types/schema.js`）：

- `parameters` 是"隐式对象"的属性表：`{ 字段名: { type, required?, description?, ... } }`
- `required` 写在**属性上**（`{ type:'string', required:true }`），不是数组
- 支持的 `type`：`string | number | integer | boolean | null | array | object | json | oneOf`
  - `json` 是"作者专用"的任意 JSON（编译成只有注解的 schema）
  - `object` 必须显式写 `additionalProperties: true|false`
- 注解键：`description | title | default | examples`
- DSL 会被编译成受支持子集的**裸 JSON Schema**（`parameterSchemaSpecToJsonSchema`），再交给模型
- 参数不合法 → `ToolArgsError`（`invalid arguments: ...`，code `INVALID_ARGS`），**是普通工具错误，不结束本轮**

**但是**——`register()` 并不校验 `definition.parameters`，只是原样投影：

> `schemaOf(definition, detachParameters)`：`const { name, description, parameters, deferLoading } = definition` → 直接 `parameters: detached`（`dsh-tools/lib/index.js:3135-3145`）

所以**手写裸 JSON Schema（`{type:'object', properties:{...}, required:[...]}`）作为 `parameters` 同样合法**，且能让我们彻底不 import `@deepseek-ai/dsh-tools`（见 §4 方案 A）。差别只是：手写时**参数校验要自己写**（`defineTool` 会自动用 `validateArgs` 抛 `ToolArgsError`）。

### 2.4 返回值与错误如何回给模型 ⭐

- `execute(args, exec)` 的返回值 = 规范值（canonical value），必须满足 `output.schema`，否则抛 `ToolOutputError`（`dsh-tools/lib/index.js:3637-3641`）
- `output.render(args, value)` 把规范值渲染成模型可见的内容块（如 `[{ type:'text', text: ... }]`）
- **抛错即错误结果**（`toolErrorResult`，`dsh-tools/lib/index.js:3712-3726`）：
  ```js
  { content: [{ type:'text', text: `Error: ${message}` }], isError: true, error: { message, info? } }
  ```
  → 普通工具失败**不会结束本轮**，模型看到的是一条错误工具结果，可以自行纠正参数重试。
- `HarnessError`（来自 `@deepseek-ai/dsh-llm`）的 `code` 会进 `error.info`，可用于被上游策略路由（`dsh-tool-goal` 就用 `GOAL_TOOL_*` 码）。
- 可选：`finalizeContent`（最终内容变换）、`projectContent`（执行后投影）、`presentCall/presentResult`（Host 本地展示，Web Client 不消费）、`isConcurrencySafe`（并行调度分类）、`timeoutMs`。
- 取消语义：`exec.signal`；超时/取消也会变成 `isError` 结果（`Error: tool call aborted`）。

### 2.5 可见性、作用域与策略（附加，P2 需要知道）

- 全局注册（host ctx）→ **所有 agent 继承**（"a restriction filters what a scope inherits — the global layer and every ancestor layer on its chain"）
- `agent.ctx` 内注册 → 只对该 agent 可见，并 shadow 同名全局工具
- `ctx.tools.restrict({ allow, deny })` → 按 agent 收窄可见集（**必须 scoped ctx**，否则抛错）
- `ctx.tools.guard(fn)` → 单调拒绝（拒绝后不可被后续监听器翻案）
- 流水线事件：`tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result`
- **PTC 模式陷阱**：若 `tools` 行的 `mode` 为 `ptc`，模型**只能直接调用 `run_code`**，其它工具都要从 `run_code` 程序里经 SDK 调用（`dsh-tools/lib/types/index.js:433-435`、`dsh-web-app/cordis.patch.yml:32-38` 用 `DSH_TOOLS_MODE` 环境变量切模式）。**P2 的 `mesh_*` 工具在 PTC 模式下不会作为独立工具出现**，但会出现在生成的 SDK 声明里（名字若是裸标识符则可点式调用）。

---

## 3. (b) 配置传入、热更新与 dispose

### 3.1 从 cordis.patch.yml 到 `apply(ctx, config)` 的完整链路 ⭐

```
~/.dsh/profiles/<profile>/cordis.patch.yml   (用户层)
        + 已安装 bundle 的 dsh.bundle.patch   (bundle 层)
        + dsh <profile> --patch x.yml         (临时叠加层)
              │  composeEntries(layers)  →  entry 列表
              ▼
Entry.init()  →  tree.import(entry.name) → import() 拿模块
              →  registry.plugin(plugin, entry.options.config)   ← config 在这里进入
              →  resolveConfig(runtime.Config)   ← 用插件导出的 Config 校验
              →  apply(ctx, validatedConfig)
```

源码证据：

| 环节 | 证据 |
|---|---|
| 合成 entry 列表 | `dsh-app-boot/lib/index.js:1084 composeEntries` / `1041-1050 loadProfileDirectory` |
| 导入模块 | `cordis-plugin-loader/lib/index.js:453` → `cordis-plugin-loader/src/config/tree.ts:112-128` |
| **config 交给插件** | `cordis-plugin-loader/lib/index.js:463`：`this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber` |
| 校验 + 调 apply | `cordis/src/registry.ts:326`（`runtime = { …, Config: plugin.Config }`）→ `cordis/src/fiber.ts:50-62 resolveConfig` → `cordis/src/fiber.ts:253-259`（`new runtime.callback(this.ctx, this.config)` / `runtime.callback(this.ctx, this.config)`） |
| 插件形态 | 对象插件 `{ apply(ctx, config) }`；`name` 导出可作为运行时名；`inject` 导出声明依赖服务 |

**`Config` 导出（注意大写）**：

- `cordis/src/fiber.ts:50-62`：`if (!runtime.Config) return config`——**不导出 `Config` 时，patch 里的 config 原样透传给 `apply(ctx, config)`**（这正是本仓库现状）
- 导出 `Config` 时，它必须是 **Standard Schema**（`runtime.Config['~standard'].validate(config)`）。DSH 生态用 `@deepseek-ai/schemastery` 的 `z.object({...})`（见 `dsh-tool-goal/lib/index.js` 的 `const Config = z.object({ blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3) })`）
- 校验失败 → 抛 `ValidationError`，插件不启动

> **本仓库现状**：`src/index.ts:43` 是 `export function apply(ctx: Context, rawConfig: MeshConfig = {}): void`，并在函数体内手工兜默认值。这在 cordis 下是**可行的**（无 `Config` → 原样透传），但与 DSH 惯例不同：官方工具插件一律导出 `Config` 并用 `resolveConfig(config)` 取带默认值的配置。**建议 P2 改用 `Config` 导出**，代价是引入 `schemastery` 依赖（见 §4 的依赖权衡）。

### 3.2 热更新 / 重载 / dispose 的正确写法

| 场景 | 机制 | 源码 |
|---|---|---|
| 改 patch 里的 `config` | `Entry.update()` → `fiber.update(config)` → 校验 → **dispose + 重新 apply**（同进程） | `cordis/src/fiber.ts:736-753`、`cordis-plugin-loader/src/config/entry.ts`（`update`/`_patchContext`） |
| 只改"易失"字段 | Loader 直接把新值 commit 进运行中的 fiber，不重启插件 | `cordis-plugin-loader/lib/index.js:395-427 _commitVolatile` |
| 改插件**代码** | 走 §4.3 的 HMR / recomposition | `@deepseek-ai/dsh-hmr/README.md` |
| 插件卸载/禁用 | fiber dispose → **所有 effect 逆序执行** → `ctx.tools.register` 的注册被自动撤销 | `cordis/src/fiber.ts:675-695 _unload` |

**dispose 写法**：

- ✅ `ctx.tools.register(...)` **不需要**手工注销——它内部是 `this.layers.effect(this.ctx, …)`，挂在当前 fiber 上；插件 dispose 时自动移除。
- ✅ 但若要**提前**撤销（重载时先清干净），用返回值：`const dispose = ctx.tools.register(def); ctx.effect(() => dispose)` 或在 `ctx.effect(() => () => dispose())` 里调用。
- ✅ 现有 `src/index.ts:66-69` 的写法正确且应保留：
  ```ts
  ctx.effect(() => () => { void runtime; console.info('[swarm] disposed') })
  ```
- ❌ 不要用 `setInterval`/`setTimeout` 持有资源却不 effect 化——dispose 时不会清。

---

## 4. (c) 本地加载与验证

### 4.1 `dsh plugin --profile <name> add file:<path>` 的准确用法 ⭐📄

**CLI 形态**（`dsh/lib/bin.js:104-129`，commander 定义）：

```
dsh --profile <name> [options] [app-args...]     # 启动某个 profile（dsh <name> 是 --profile <name> 的缩写）
dsh plugin --profile <name> <pnpm-args...>       # 把剩余参数原样转发给 profile 目录里的 pnpm
dsh <name> --patch <path>                        # 启动时叠加一个 patch 层（可重复）
dsh --dump-config                                # 打印合成后的 profile 树并退出
dsh --dump-config-schema                         # 打印 entry/patch 的 JSON Schema
dsh --dump-default-config                        # 打印不含用户层与 --patch 的 bundle 层
```

- `dsh plugin --profile web add file:<repo>` → 内部等价于在 `~/.dsh/profiles/web/` 里执行 pnpm `add file:<repo>`（`dsh/lib/plugin-BiveYA7h.js` 的 `runPlugin` → `runPluginCommand(context, args, options)`）
- **相对路径会被锚定**：`anchorPathSpec(argument, cwd)`（`dsh-plugin-manager/lib/types/operations.js`）把 `file:./x` / `link:../x` 解析成**相对调用目录**的绝对路径；绝对路径原样透传
- 安装完成后 `reconcile()` 会：读取包的 `dsh.bundle.patch` → `loadOverlayPatches('dsh', file)` → 把包名写进 profile `package.json` 的 `dsh.profile.bundles`
- **没有 `dsh.bundle` 的包只会被当成普通依赖**，只打印一条警告：
  `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`
  → **本仓库 `package.json` 已声明 `dsh.bundle.patch: "./cordis.patch.yml"` ✔**
- 另有一条版本兼容审批命令：`dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`（本插件 `engines.dsh: ">=0.2.1-rc.2"`，本机运行时是 `0.2.1-rc.3`，兼容）

**本机 profile 现状**（实测）：`%USERPROFILE%\.dsh\profiles\` 下只有 `desktop`（桌面 App 用的那个）与 `node_modules`；`desktop/package.json` 的 `dsh.profile.bundles` 有 40+ 条，**含 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`**——也就是说 `ctx.tools` 服务在 web 组合里**默认已挂载**（`dsh-base/cordis.patch.yml:499-500` 有 `- id: tools / name: '@deepseek-ai/dsh-tools'`）。

### 4.2 两条加载路线，建议分开用

| 路线 | 命令 | 优点 | 坑 |
|---|---|---|---|
| **A. 安装成 bundle** | `dsh plugin --profile web add file:<repo>` | 走标准 bundle 流程，patch 层自动挂载，长期可用 | 需要 profile 存在；`file:` 目录在 pnpm 下的落盘形式（软链 or 拷贝）**未实测**（§5） |
| **B. `--patch` 叠加层**（最快迭代） | `dsh web --patch ./examples/local.cordis.patch.yml` | 不装包、不动 profile，改代码→重启 `dsh web` 即可 | 本仓库示例里的 `name: '<repo>/lib/index.js'` **在 Windows 上极可能是错的**（见下） |

**⚠ Windows 路径坑（实测）**：

```js
new URL("<repo>/lib/index.js", "file:///C:/Users/x/profiles/web/").href
// → "e:/git/dsh-workspace-mesh/lib/index.js"   ← 被当成 URL scheme "e:"，不是 file: URL
new URL("file:///<repo>/lib/index.js", "file:///…").href
// → "file:///<repo>/lib/index.js"  ✔
```

Loader 导入走 `tree.import(name)` → `internal.import(name, baseUrl)`（`cordis-plugin-loader/src/config/tree.ts:112-128`），对 `E:/…` 这种串会被 Node 解析成非 `file:` scheme ⇒ **`examples/local.cordis.patch.yml` 现有写法在 Windows 上大概率抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`**。
**修法二选一**：
- 写成 `name: 'file:///<repo>/lib/index.js'`（单测未实跑，但 URL 解析已实测正确），或
- 走路线 A：用**包名** `name: dsh-workspace-mesh`（本仓库 `cordis.patch.yml` 已经是这个，正确——Node 从 profile 目录解析 `node_modules/dsh-workspace-mesh`）。

**⚠ 依赖解析坑（实测）**：以插件自身路径 `file:///<repo>/lib/index.js` 为基准 `createRequire().resolve()`：

| 包 | 结果 |
|---|---|
| `@deepseek-ai/cordis` | ✅ `E:\git\dsh-workspace-mesh\node_modules\.pnpm\@deepseek-ai+cordis@4.0.5\…`（devDependency 已装） |
| `@deepseek-ai/dsh-tools` | ❌ `MODULE_NOT_FOUND` |
| `@deepseek-ai/schemastery` | ❌ `MODULE_NOT_FOUND` |
| `@deepseek-ai/dsh-llm` | ❌ `MODULE_NOT_FOUND` |

而桌面 profile 的 `node_modules/@deepseek-ai/` 里**只有 `cosmokit` 和 `schemastery`**（没有 `dsh-tools`，它随 App 装在 asar 里）。结论：
> **装进 profile 的插件无法 `import '@deepseek-ai/dsh-tools'`**，除非把它加进本仓库自己的依赖并 `pnpm install`（装到 `E:\git\dsh-workspace-mesh\node_modules` 才可解析），或者**完全不用它**（走 §4 方案 A）。
> 这与 SPEC §9.4"零运行时依赖/不 import 别人的包"高度一致——**P2 建议采用方案 A（手写 definition，零 import）**。

### 4.3 插件改动后如何生效

📄 `@deepseek-ai/dsh-hmr/README.md`（本机 asar 内）：

- base bundle 默认 `hmr` 行 `config: { root: [] }`——**只监视配置，不监视源码**
- 开启源码监视：profile patch 里改 `hmr` 行
  ```yaml
  - id: hmr
    disabled: false
    config:
      root: ["."]
  ```
  （`root` 是"模块监视根"，`ignored` 默认排除 `**/node_modules`、`**/.*`、`cache`、`data`）
- 关键句："Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk. This covers installed packages below `node_modules` and **the targets of linked packages**. A package whose files changed in place, such as a linked package whose build output changed … therefore takes effect **without a restart** at the next such recomposition"
  → 对 `file:`/`link:` 装进来的本插件：**改 `lib/` 产物后触发一次 recomposition（改 profile patch / 用插件管理器操作）即可热生效**，不必重启进程
- 换源失败时："A replacement that fails to load stops the previous plugin and is reported as `failed` with its load error"——**加载失败会停掉旧插件**，不是静默回退

**开发闭环（建议）**：
1. `pnpm build`（产出 `lib/`）
2. 触发 recomposition：改一下 profile 的 `cordis.patch.yml`（或 `dsh plugin --profile web add …` 触发一次包操作）
3. 想要"改代码即生效"：把 `hmr.root` 设成 `["<repo>"]` 之类的具体目录（注意 `ignored` 会排除 `**/node_modules`，别把 `lib/` 排除掉）

### 4.4 怎么确认"工具真的出现了"

按可信度从高到低：

| # | 手段 | 具体做法 | 期望观察 |
|---|---|---|---|
| 1 | **插件自身打印** | 在 `apply()` 里 `console.info('[swarm] registered mesh_* tools:', N)`（现有代码已有 `console.info('[swarm] loaded without a transport: …')` 的先例） | 启动日志出现该行 |
| 2 | **Loader 日志** | Loader 在 apply 时打 `loader` logger 的 info：`'%s plugin %C'`（`cordis-plugin-loader/src/index.ts` 的 `showLog`） | 看到 `apply plugin dsh-workspace-mesh`；随后 `reload`/`unload` 也各有日志 |
| 3 | **配置是否被合成** | `dsh --profile web --dump-config`（或 `--dump-default-config`） | 打印出的 entry 树里能看到我们的行（id `mesh`）及其 `config` |
| 4 | **模型是否看得见** | GUI 新建会话，直接让模型调用 `mesh_list_nodes` | 对话里出现该工具的调用卡片（Web Client 渲染 tool call 树） |
| 5 | **工具集合变化提示** | Web Client 会把"可见工具集变化"作为 developer message 呈现（`dsh-client-ui-chat/README.md` 的 "Tool-change presentation"） | 会话里出现"added tool mesh_…" |
| 6 | **程序化查询** | Creator mode 的 `cordis_inspect_query`，Host provider id=`Tool`，method=`listTools` → 返回 `ctx.tools.schemas(context.agent)`（`dsh-tool-cordis/lib/types/providers.js:40-52`） | 返回的工具名数组里有 `mesh_*` |
| 7 | **反证** | 故意注册一个非法工具（重名 / `output` 缺 `render`） | `apply` 抛错并在日志里出现，**说明注册路径已通**（这是最直接的"API 存在性"验证） |

> **注意**：GUI 里**没有**"工具列表"面板（本地检索 `dsh-client-ui-*` 的 README 未发现）；工具列表只在模型请求里。所以**第 4/5/6 条才是"模型看得见"的真正判据**，第 1/2/3 条只证明"插件挂上了"。

### 4.5 还要注意：host 挂载 ≠ 模型看得见

- `ctx.tools` 的可见性是"全局层 + scope 链"的并集：**在 host ctx 里注册 ⇒ 所有 agent 继承**（源码：`view(scope)` 的"restriction 只过滤继承来的全局层"）。
- 但 DSH 的官方工具插件（`dsh-tool-bash` 等）**同时**出现在 base 组合（host 行）与 **agent preset 的 `plugins` 列表**（`dsh-web-app/presets/standard.patch.yml`）里——preset 行把它挂进 agent scope，得到按 agent 的配置。
- **实践建议**：
  - 只想让所有 agent 看到 → 只挂 host 层（bundle 即可），插件里 `ctx.tools.register` 走全局注册；
  - 想让某个 preset 专属 → 在该 preset 的 `plugins` 里加一行 `{ id: mesh, name: 'dsh-workspace-mesh' }`，此时插件会在 agent scope 里再注册一次（同名不同 scope，允许，且 shadow 全局）。
- ⚠ 若把工具只挂进 preset 而不挂 host 层，插件的 `apply` 只在 agent scope 跑，`ctx.effect` 生命周期跟随 agent —— 本项目的 transport/board 是全局单例，**建议走 host 层**。

---

## 5. (d) 可直接粘贴的最小片段

> 两个候选。**判别方法**见每个方案末尾。共同前置：本插件必须 `export const inject = ['tools']`。

### 方案 A（推荐）：零依赖手写 definition ⭐ 与 SPEC §9.4 一致

不 import 任何 DSH 包；`ctx.tools` 由 `inject` 拿到；参数用**裸 JSON Schema**（`register` 原样投影，源码已证）。

```ts
// src/tools/mesh-tools.ts
import type { Context } from '@deepseek-ai/cordis'

/** 裸 JSON Schema（注册表原样投影给模型）。 */
interface MeshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }
  execute: (args: any, exec: { signal: AbortSignal; agent?: unknown }) => unknown | Promise<unknown>
}

const text = (v: unknown) => [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]

/** 一个最小可用工具：列出节点。 */
export function meshListNodesTool(ctx: Context): MeshToolDefinition {
  return {
    name: 'mesh_list_nodes',
    description: '列出 mesh 当前已知的节点（nodeId / label / 是否在线）。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: (_args, value) => text(value),
    },
    async execute(_args, _exec) {
      // 真实实现从这里接 board/transport；未配置传输时返回明确的降级结果
      return { nodes: [] }
    },
  }
}

export function registerMeshTools(ctx: Context): void {
  // register 内部是 effect，返回精确 disposer；插件 dispose 时自动注销
  ctx.tools.register(meshListNodesTool(ctx) as never)
}
```

粘进 `src/index.ts`：

```ts
export const inject = ['tools']          // ← 没有这行，ctx.tools 是 undefined

export function apply(ctx: Context, rawConfig: MeshConfig = {}): void {
  const config = { transport: rawConfig.transport ?? 'auto', leaseMs: rawConfig.leaseMs ?? 15 * 60_000, ...rawConfig }
  …
  registerMeshTools(ctx)                 // ← P2 的 TODO(P2) 落点
  console.info('[swarm] registered mesh_* tools')
  ctx.effect(() => () => { void runtime; console.info('[swarm] disposed') })
}
```

**判别方法**：如果 `ctx.tools` 存在但 `register` 抛 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }` ⇒ 说明你缺 `output.render`；抛 `tool "<name>" is already registered` ⇒ 同名冲突；抛 `Cannot use 'in' operator…`/`ctx.tools is undefined` ⇒ 缺 `inject: ['tools']` 或 `ctx.tools` 服务没挂载（本机 base 组合里 `id: tools` 是默认挂载的，web profile 继承 base）。

### 方案 B：官方 `defineTool`（有类型、有自动参数校验）

需要把 `@deepseek-ai/dsh-tools` 加成 **peerDependency + devDependency** 并在本仓库 `pnpm install`（否则 §4.2 的解析实测表明 import 不到）。

```ts
// src/tools/mesh-tools.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerMeshTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'mesh_list_nodes',
    description: '列出 mesh 当前已知的节点（nodeId / label / 是否在线）。',
    parameters: {},                       // DSL：{ 字段: { type, required?, description? } }
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, _exec) {
      return { nodes: [] }
    },
  }))
}
```

`package.json` 需要：

```json
"peerDependencies": { "@deepseek-ai/cordis": "~4.0.5", "@deepseek-ai/dsh-tools": "0.2.1-rc.3" },
"devDependencies": { "@deepseek-ai/dsh-tools": "0.2.1-rc.3" }
```

**判别方法**：`import` 报 `MODULE_NOT_FOUND` ⇒ 没在本地装（本仓库 `node_modules` 里确实没有，§4.2 实测）；装上后若类型报 `defineTool` 不存在 ⇒ 版本对不上（宿主用 `0.2.1-rc.3`，见 `app.asar/dsh/package.json`）。

### 两方案的差异表

| 维度 | A 手写 definition | B defineTool |
|---|---|---|
| 运行时依赖 | **0**（只用 `ctx.tools`） | 需 `@deepseek-ai/dsh-tools` 可解析 |
| 参数 schema | 裸 JSON Schema | DSL（编译成同样的 JSON Schema） |
| 参数校验 | 需自己写 | 自动，失败抛 `ToolArgsError` |
| 类型 | 需自己写 interface（可用 `as never` 绕过） | 完整推导 |
| 符合 SPEC §9.4 | ✅ | ⚠ 需在 §9.4.1 表里把 `dsh-tools` 从"必须 peerDep"改成"可选" |
| 推荐度 | **P2 首选** | 若要严格类型与自动校验，选它并接受 peer 依赖 |

> **给 P2 实施者的建议**：先用 **A** 打通闭环（零依赖、零安装、判定最快），把 `defineTool` 留作"类型化重构"的后续项；两者的 `register` 调用点完全一致，迁移成本只有参数 schema 的写法。

---

## 6. (e) 未验证项（附复现步骤）

| # | 未验证项 | 为什么没验 | 复现步骤 |
|---|---|---|---|
| U1 | `dsh plugin --profile web add file:<path>` 的**实际**行为（pnpm 对 `file:` 目录是软链还是拷贝；`reconcile` 是否把包写进 `dsh.profile.bundles`；`file:` 相对路径锚定到调用目录） | 任务纪律禁止 spawn 进程/调用 shell，未执行 CLI | ① `cd <repo>` ② `dsh plugin --profile web add file:<repo>` ③ 看 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` ④ 看 `~/.dsh/profiles/web/node_modules/dsh-workspace-mesh` 是软链还是实体目录（软链 ⇒ 改 `lib/` 立即可见，HMR 友好） ⑤ `dsh --profile web --dump-config` 看 `id: mesh` 行是否在合成树里 |
| U2 | `name: 'E:/…/lib/index.js'` 在 Loader 里的**实际**导入结果 | 同上；但 URL 解析行为已用 `node:url` 实测（被解析为 scheme `e:`） | ① 写 `examples/local.cordis.patch.yml` → `name: 'file:///<repo>/lib/index.js'` ② `dsh web --patch ./examples/local.cordis.patch.yml` ③ 观察是否出现 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（用原写法）或成功挂载（用 file:// 写法） |
| U3 | 我们插件的 `apply` 是否真的能拿到 `ctx.tools`（`inject: ['tools']` 是否足够、web profile 是否默认挂了 `id: tools`） | 未实跑 | ① 在 `src/index.ts` 加 `export const inject = ['tools']` + `console.info('[swarm] tools service:', typeof ctx.tools?.register)` ② 挂载后看启动日志 ③ 若 `undefined`，检查 profile 合成树里 `id: tools` 行是否存在（`dsh --profile web --dump-config`） |
| U4 | 工具在 **PTC 模式**下的可见性 | 未实跑 | 设 `DSH_TOOLS_MODE=ptc` 启动 `dsh web`，观察 `mesh_*` 是否出现在生成的 SDK 声明里（应为 `await tools.mesh_list_nodes({})`）而非独立工具 |
| U5 | 全局注册是否被**默认 agent preset** 继承（host 挂载 ⇒ 模型看得见） | 源码推断（`view(scope)` 的层级合并规则），未实跑 | ① 只挂 host 层 ② 新建会话问模型"列出你的工具"或直接调用 `mesh_list_nodes` ③ 若不可见，检查 preset 的 `plugins` 列表是否需要补一行 |
| U6 | `cordis_inspect_query` 的 `Tool.listTools` 在本机是否可用 | Creator mode 未启用 | 启用 `@deepseek-ai/dsh-tool-cordis` 的 preset 行后调用 `cordis_inspect_query(provider='Tool', method='listTools')` |
| U7 | `dsh-tools` 的 `0.2.1-rc.3` 是否与本仓库 peer 范围兼容 | 未安装 | `pnpm add -D @deepseek-ai/dsh-tools@0.2.1-rc.3` 后 `pnpm typecheck` |
| U8 | 官网上是否有更权威的插件开发文档 | 未联网检索（本任务以本机源码为准） | 检索 DSH 官方文档站 `docs/user/develop/` 下的 basic/config 与 plugin 章节，与本文结论交叉印证 |

**另外说明**：本文所有"DSH 内部机制"结论都来自 **本机 asar 内的发布代码**（版本 `0.2.1-rc.3`），未使用任何外部文档；因此不存在"文档说的 vs 代码实际的分歧"——**只有代码实际**。若官方文档后续更新，以代码为准。

---

## 7. 对 SPEC 的影响（**仅建议，未改 SPEC.md**）

1. **§9.4.1 依赖表**：`@deepseek-ai/dsh-tools` 标注为"必须 peerDependency"——按 §4.2 的解析实测，**装进 profile 的插件默认解析不到宿主 asar 里的 `dsh-tools`**。建议改述为"peerDependency（可选）：仅当采用 `defineTool` 时需要；零依赖手写 definition 路线不需要"。
2. **§9.4 原则**："不 import 别人的包，只在运行期探测别人的服务"——本次结论**支持**该原则：工具注册不需要 import 任何包，`ctx.tools` 是运行期服务。
3. **§12 P2 验收"Lead 能 mesh_dispatch 并拿到最终回复"** → 工具名前缀建议统一为 §18 的 `mesh_*`（当前 §12 写的是 `swarm_*`）。
4. **§5.4 assignment 文件**与本仓库 `src/board/`：与工具注册无耦合，不受影响。
5. **§14.4 开发闭环**（`mesh_dev({pluginPath, action, restart})`）→ 本次结论支持其可行性：`file:`/`link:` 装入的包，其产物变更可在下次 recomposition 生效（§4.3 引用了 dsh-hmr README 原文）。

---

## 8. 证据索引

| 主题 | 文件（相对 `app.asar/dsh/node_modules/@deepseek-ai/`） | 位置 |
|---|---|---|
| 工具注册 API 文档 | `dsh-tools/README.md` | "Register a tool" 节 |
| `defineTool` 实现 | `dsh-tools/lib/types/schema.js` | `export function defineTool` |
| 参数 DSL 编译 | `dsh-tools/lib/types/schema.js` | `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` |
| `register` 实现 | `dsh-tools/lib/types/index.js:468-489`；bundle `lib/index.js:2974+ ` | — |
| `ctx.tools` 服务键 | `dsh-tools/lib/index.js:2798` `super(ctx,"tools")` | — |
| 工具名约束 | `dsh-tools/lib/types/index.js:485-487`（`run_code` 保留） | — |
| 参数投影（裸 JSON Schema 合法） | `dsh-tools/lib/index.js:3135-3145` `schemaOf` | — |
| 错误 → 模型 | `dsh-tools/lib/index.js:3712-3726` `toolErrorResult` | — |
| 官方工具插件范例 | `dsh-tool-goal/lib/index.js:107-115, 256-303` | `inject`/`Config`/`apply`/`register` |
| config 注入链路 | `cordis-plugin-loader/lib/index.js:463`；`cordis/src/registry.ts:316-336`；`cordis/src/fiber.ts:50-62, 253-259` | — |
| config 热更新 | `cordis/src/fiber.ts:736-753`；`cordis-plugin-loader/lib/index.js:395-427` | — |
| 插件装载/导入 | `cordis-plugin-loader/src/config/tree.ts:112-128`；`src/index.ts` `showLog` | — |
| profile/patch 合成 | `dsh-app-boot/lib/index.js:529-570, 1015-1089` | — |
| CLI 定义 | `dsh/lib/bin.js:104-129`；`dsh/lib/plugin-BiveYA7h.js` | — |
| `file:`/`link:` 锚定 | `dsh-plugin-manager/lib/types/operations.js` `anchorPathSpec`/`reconcile` | — |
| HMR 语义 | `dsh-hmr/README.md`（"Use this package" 节） | — |
| 工具集合查询 | `dsh-tool-cordis/lib/types/providers.js:40-52` | — |
| base 组合含 tools 行 | `dsh-base/cordis.patch.yml:499-500` | — |
| PTC 模式开关 | `dsh-web-app/cordis.patch.yml:32-38`（`DSH_TOOLS_MODE`） | — |
| agent preset 挂工具 | `dsh-web-app/presets/standard.patch.yml` | — |
| 本机 profile 实文件 | `%USERPROFILE%\.dsh\profiles\desktop\{package.json,cordis.patch.yml}` | — |
| 依赖解析实测 | `createRequire("file:///<repo>/lib/index.js")` | 本机实测 |
| URL 解析实测 | `new URL("E:/…", "file:///…")` | 本机实测 |
