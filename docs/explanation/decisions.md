# 决策日志

> **状态**：现行
> **日期**：2026-11-01
> **读者**：要改设计、或想推翻某个既有做法的人
> **上游材料**：[SPEC.md](../../SPEC.md)、[roadmap.md](./roadmap.md)、[evidence/](../evidence/README.md)
> **口径**：每条只记录「决定了什么」，不记录过程；正文不可改，只能改状态字段

写新功能前先读这张表：这件事可能已经被决定过，也可能被否决过。

## 1. 两轴状态

「决定有效」和「已经落地」是两件事，所以状态分两轴：

| 轴 | 取值 |
| --- | --- |
| 决策状态 | `proposed` / `accepted` / `rejected` / `superseded` / `deprecated` |
| 实施状态 | 未开始 / 进行中 / 已实施 / 已验证 |

只有一轴时会出现「决定还写着旧做法，而代码已经改了」——读者无法判断哪个是真的。

## 2. 决策表

| # | 决定 | 决策状态 | 实施状态 | 依据 |
| --- | --- | --- | --- | --- |
| D1 | mesh 是工作区联邦，不是资源远程访问：只传消息，agent loop 永远在归属机 | accepted | 已实施 | SPEC §1、§8 |
| D2 | 跨机只允许 5 个数据面方法，白名单硬编码 | accepted | 未开始（无传输） | SPEC §6.2、[p1](../evidence/p1-transport.md) §2.3 |
| D3 | v1 用静态 `assignment.yml` 作归属来源，不做 hub 广播注册表 | accepted | 已实施 | 见 §3 D3 |
| D4 | 传输缺失是降级不是崩溃：插件照常加载，工具返回 `unavailable` | accepted | 已实施 | SPEC §9.4.2 |
| D5 | 跨机传输落点是 DSH 核心 Typert 面，不用回环 HTTP 代理 | accepted | 已实施 | [p1](../evidence/p1-transport.md) §5、[s0](../evidence/s0-typert-cross-machine.md) |
| D6 | 配置不同步，作为任务参数随任务传递 | accepted | 未开始 | SPEC §15.1 |
| D7 | 设置页配置走插件自己的 HTTP 路由 + `$DSH_HOME/mesh-config.json` | accepted | 已实施 | 见 §3 D7 |
| D8 | 「执行」不作为网格服务暴露（没有 T4） | accepted | 已实施（架构上不存在） | SPEC §16.6 |
| D9 | 工具前缀统一 `mesh_`，不用 `swarm_` | accepted | 已实施 | [tools.md](../reference/tools.md) §8 |
| D10 | `mesh_dispatch` 阻塞到最终回复；`taskId` + `mesh_task_wait` 的异步模型推迟 | accepted | 已实施 | 见 §3 D10 |
| D11 | 许可证 Apache-2.0 | accepted | 已实施 | 见 §3 D11 |
| D12 | 删除 `pairing` / `loopback` 适配器，跨机传输只做 Typert | accepted | 已实施 | 见 §3 D12 |
| D13 | 跨机调用复用对端的 owner 登录 token（`/connect` 换 cookie），不实现 mesh-peer 凭据 | accepted | 已实施 | 见 §3 D13 |
| D14 | 浏览器半区改为 esbuild 打包产物，拓扑画布用 `@xyflow/react`（构建期内联，不进 `dependencies`） | accepted | 已实施 | 见 §3 D14 |
| D15 | 远程工作区 = 本地锚点目录的真记录 + `assignment.yml` 旁路归属；「添加远程工作区」只占 `directoryFlow` 选择器位，不接管 `sidebar.workspaces` 席位 | accepted | 进行中 | 见 §3 D15 |
| D16 | UI 扩展收敛到一个前置包（替换包）：下游插件只依赖它的 ProtonRegionMap 契约，不直接注册官方席位；占席位时复刻实现放进可抛弃的独立包 | accepted | 未开始 | 见 §3 D16 |

## 3. 需要展开的几条

### D3：为什么 v1 不建 hub 广播注册表

SPEC §5.4 描述的是「节点自报、hub 派生注册表」的形态。v1 没有 hub 进程，也没有任何跨机通道（传输还是桩），所以实现改为：roster = `assignment.yml` 声明 + 传输回执合并。

代价：归属必须手工维护，未分组工作区无人负责（SPEC §9.3 的调度子插件因此更没有意义）。

触发重建的条件：出现常驻 hub 进程，或需要自动发现节点时。在那之前不要往 roster 里加广播逻辑——没有传输的广播是空转。

### D7：为什么不走原生 settings 管道

原生 `settings.describe/mutate` 只投影 profile `include` 根下的条目；本插件由 profile patch `insert` 挂载，没有 namespace，管道改不到它。另一条路 `TypertRemoteService` 也不行：`link:` 安装的目录没有 `node_modules`，解析不到 `@deepseek-ai/dsh-typert-protocol`。

所以设置页自带读写面，落插件自己的覆盖文件。代价：多一个文件、多两条路由，且这两条路由必须和原生 `/api` 一样在 Connection fence 内鉴权。

### D10：为什么先做阻塞而不是异步

异步模型需要持久化任务板 + 后台事件收集器 + 断线重连去重（SPEC §7.2）。三样都没有时，`{ taskId }` 返回给模型等于「任务丢了」。阻塞版至少让调用方拿到确定结果或确定错误。

代价：`replyMode=stream` 目前只返回「已收到的一段文本 + `pending: true`」，任务不会自行推进。推翻它的条件是持久化任务板落地。

### D11：为什么是 Apache-2.0 而不是 copyleft

mesh 只有在多台 DSH 实例说同一种语言时才有用，采用率优先于代码归属。

- **企业能直接用**：Apache-2.0 在几乎所有公司白名单里，可以装进 profile 或烤进镜像而不触发许可证评审。copyleft 会在这一步被否掉，而典型部署是内部使用——内部使用本来就不触发 copyleft，等于白付代价。
- **专利是显式的**：§3 给出专利许可，并对发起专利诉讼者终止授权。MIT 只是隐含。
- **与生态一致**：dsh 与 cordis 都是 MIT，Apache-2.0 可以干净组合。
- **对管不住的事说实话**：没有哪个开源许可证能阻止「fork 了但不分发」。真正保护 mesh 的是 SPEC、包名和参考实现保持领先，不是许可证条款。

需要别的条款请开 issue。

### D13：为什么跨机调用先用 owner token，而不是 mesh-peer 凭据

0.2.1-rc.4 对外开放的入口只有 `GET /connect?token=…&interactions=none` → 签名 cookie，拿到的就是 owner 身份。没有设备凭据、没有长期 token、也没有「非 owner peer 自注册」的通道（SPEC §17 描述的凭据层在宿主里还不存在）。

所以 v1 直接用它：能立刻验证传输本身（事件流、turn 结束、错误映射），而凭据设计可以后置。

代价，三条都要记住：

- **token 每次重启轮换**，配置里的 `peers[].token` 必须人工同步，否则工具报 `denied`；
- **权限是 owner 全权**：对端不会按 SPEC §6.2 的白名单拦方法，白名单目前只是设计约束；
- 谁拿到这个 token 就等于拿到对端登录态。

推翻它的条件：SPEC §17 的凭据层落地，或 DSH 提供设备级长期凭据。在那之前，别把 mesh 暴露到不受信任的网络。

### D12：为什么删掉 pairing 与 loopback，而不是补实现

`pairing` 探测 `remoteWebUiPairing` 的 `listPeers` / `peers` / `listWorkspaces` 三个方法名，而该社区插件一个都没有——它只有 `isPairedDevice(request)` 这个鉴权谓词（[p1](../evidence/p1-transport.md) §2.2）。所以那个适配器不是「待实现」，是永远命中不了。

`loopback` 走社区的 `/pair-remote/*`，但只覆盖五能力中的两个，没有 prompt 与 follow；拿不到结构化事件流（[p1](../evidence/p1-transport.md) §3.2）。它满足不了 `MeshTransport` 接口，补实现也补不出来。

留着它们只有一个效果：让读者以为「装上某个插件就有传输了」，让配置里出现两个选了也没用的选项。所以删掉适配器、把 `transport` 收敛到 `auto`，真实传输只做 Typert。

代价：短期内没有任何跨机能力，`mesh_dispatch` 在真机上一律返回 `unavailable`。这是有意接受的——比返回一个假的成功好。

### D14：为什么浏览器半区要构建，且画布用 @xyflow/react

「拓扑」要能拖、能缩放、能按真实 roster 自动布局，手写 SVG 撑不住：拖拽、视口变换、命中测试、fitView 都是交互框架的活。

三条约束一起看：

- 宿主的客户端模块加载器只解析平台模块表（`react`、`react-dom`、`zod` 等），npm 包只能在**构建时**内联进 `client/client.js`；
- `test/tools.test.ts` 钉死 `package.json.dependencies === undefined`，所以画布库只能进 `devDependencies` 并被内联；
- 布局算法必须可测，所以它和「payload → 节点/边」的推导放在 `src/graph/`（零依赖纯函数，node:test 直接跑），浏览器与宿主共用同一份。

代价：

- `client/client.js` 从手写 992 行变成约 1 万行的构建产物（484 KB，其中绝大部分是画布库），改 UI 必须先 `node scripts/build-client.mjs`；
- 仓库第一次有前端构建依赖（esbuild + `@xyflow/react`），审计只放行 `dependencies` 为空，不再等于「零第三方代码」；
- 打包库必须随附其许可证声明（见根目录 `NOTICE`）。

推翻它的条件：平台模块表直接提供画布库，或交互需求回落到「静态图 + 表格」。

### D15：远程工作区做成「锚点目录 + 旁路归属」，不接管侧栏席位

三条决定：

- 远程工作区在原生 registry 里是**一条真记录**，`path` 指向本地锚点目录（`%LOCALAPPDATA%\dsh-mesh\anchors\<sha256(nodeId)>\<sha256(JSON.stringify([nodeId, workspaceId, remoteCwd]))>`），不是远端路径；归属（`workspaceId → nodeId / remoteCwd`）落在 `assignment.yml`，不进 workspace 记录。
- 「添加远程工作区」不抢 `sidebar.workspaces` 席位，只占 `sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow` 两个 single 槽，把选目录交互扩成「本地 / 远程」两路；本机那一半调 `remote.directoryPicker.pick()`，不重写 OS 选择器。
- 来源只写进 `title`（`<仓库名> @<机器名>`）。

理由：

- 工作区在本地的定义就是真实目录：`create()` 走 `node:fs/promises` 的 `realpath` 与 `stat().isDirectory()`，`attachSession` 用同一套 canon 要求 `SessionHeader.cwd` 真实存在。远程路径过不去；锚点是唯一能让原生分组、排序、置顶、归档、会话归属、搜索全部免费复用的形态。
- 记录加不了字段：`WorkspaceRecord` 是 `z.object({ path, title, sessionIds, createdAt, updatedAt })`，zod 默认剥掉未声明键，`nodeId` 存不进去；绕过它直接写 domain 表会跳过 `validateStoredState` 与实体缓存，升级时最先坏。
- 工作区行没有 slot：`sidebar.session.row.*` 是会话行级，工作区那一层要加东西只能接管 `sidebar.workspaces`（single，占用方 `ui-workspace`），代价是复刻分组、搜索、排序、置顶、归档，且不能再 import 它的运行时值。

代价，六条都要记住：

- 锚点目录会被文件树、终端、LSP 当成真实项目根，里面是空的。放 `.dsh-remote.json` 与 README 让它自解释，但「本地空目录」消除不掉。
- 一个远程工作区一个锚点目录，不能共用：`create()` 的唯一性是规范路径字符串相等，共用同一个目录只会得到一条记录。
- 锚点被删 → `status()` 变 `missing-dir`，需要启动时按 `assignment.yml` 重建。
- `rename` 要求 title 唯一非空，两台机器上的同名仓库必须靠机器名区分；title 只是显示，绑定只能按 `workspaceId` 查表。
- 占 `directoryFlow` 就是替换选择器后端随附的 client half；`pick` 在 browse-only 部署会被拒，需要回退到 `list` / `createDirectory`。`busy` 期间 owner 拒绝重复打开，对话框必须尊重它。
- 搜索只匹配标题与 id，所以「搜机器名」只能靠 title 里带机器名。

推翻它的条件：DSH 给工作区行开出 slot（哪怕只是行尾 seat），或 `WorkspaceRecord` 支持扩展字段。在那之前不要接管 `sidebar.workspaces`。

上述「工作区必须真实目录」「记录 schema」「`directoryFlow` 交互约定」「席位与 `panellist` 语义」四条依据来自 DSH 上游，不在本仓库内：`packages/workspace/workspace/src/paths.ts`、同包 `spec.ts`、`packages/client/ui-workspace/README.zh.md`、`packages/client/ui-sidebar/README.zh.md`，以及文档站 `reference/subsystems/workspace` 与 `reference/subsystems/slots`。

### D16：UI 扩展收敛到一个前置包，前置只承诺契约不承诺席位

三条决定：

- 所有 UI 扩展收敛到一个**前置包**，其他插件只依赖前置声明的 ProtonRegionMap 契约，不直接注册官方席位。前置的角色就是官方文档里的**替换包**。
- 前置只做两件事：把下游的注册映射到官方**已有**的槽（如 `sidebar.session.row.trailing` 这类 list 槽）；官方没有的槽，由前置在自己占住的席位内部声明子槽并承载。
- 占席位是降级手段，不是默认路径。真要占时，复刻实现放进单独的、可抛弃的包，前置只依赖它的接口；前置自己的键名按官方命名习惯设计，保证官方补槽后能原地对齐、实现可换。

理由：

- `ui-sidebar` 的 README 把「替换包」写成了机制名：声明感知的 `slots.inject()` 让替换包无论先于还是后于侧边栏激活都能生效。一个包接管、其余往它里面注册，是这套 slot 系统预留的位置，不是变通。
- 席位占用方是唯一有权声明子槽的一方（「只在拥有并渲染某个位置的组件中声明新的 child slot」）。所以前置一旦占位，就能给下游开一套自己的键；下游仍用 `ctx.proton.inject()` / `register()`，手感与官方槽无差别。
- 多个插件各自抢同一个 single 席位时，rc5 由 `priority` 仲裁，低 `priority` 获胜（single 与已占用的 keyed cell 就是替换点）。收敛到一个前置，可以把下游映射与占位决策集中管理。

代价，四条都要记住：

- 前置把「哪个键落到哪个官方槽」变成一份要维护的映射。官方改 key 或 cardinality 时，`import type` 引入的 ProtonRegionMap 声明会在编译期炸（早发现）；但行为漂移不会炸，只会慢慢不一致。
- 一旦真占席位，等于复刻 `ui-workspace` 的整列行为（分组与树形、水位线、搜索、拖拽、置顶、归档、行菜单、悬浮卡、通知、`directoryFlow` 接洽、键盘导航）。这份复刻不属于前置，必须单独可抛弃。
- 下游从此依赖前置的键而不是官方键：「官方补齐后丢掉前置」只在键名一一对应时成立，否则下游要跟着改。
- 前置是额外的失效面：它挂了，所有依赖它的下游 UI 一起消失。

推翻它的条件：官方为工作区行等位置开出正式槽，且键名能与前置契约一一映射 —— 那时把前置的实现换成「注册官方槽」，契约不动，或直接删除前置。若官方长期不开槽、而需求增长到 `sidebar.panellist` 承载不了，则重新评估是否值得长期维护那个复刻包。

上述三条机制依据来自 DSH 上游，不在本仓库内：`packages/client/ui-sidebar/README.zh.md`（替换包与声明感知 `inject`）、`packages/client/ui-workspace/README.zh.md`（被复刻的行为清单）、文档站 `reference/subsystems/slots`（owner 声明子槽、single 是替换点、每个声明只有一个存活 owner）。

### D17：机器名由席位档在行上渲染，标题保留来源语义

`title` 仍是 `<仓库名> @<机器名>`：搜索只匹配标题与 id，两台机器上的同名仓库也要靠它区分。区别在渲染——席位档（`dsh-proton-workspace-seat`）接管 `sidebar.workspaces`，把标题里那段 ` @<机器名>` 拆成独立的小字标签，并按 `GET /api/mesh/anchors` 的答案换图标、补 hover 卡片。

- 归属不新增字段、不新增槽：来源用 `describe(path)` 回答「哪台机器、远端哪个路径」，它不知道自己被谁显示。
- 远端答案来得比第一帧晚，所以来源还要实现 `subscribe()`；`WorkspaceSources` 汇成 `onMarkChange()`，席位据此让问过的那一行再问一次。
- 席位是**替换**不是叠加：官方 `ui-workspace` 必须从 profile 停掉，否则两套 apply 各自往同一批 slot 注册行操作，菜单会出现两遍。
- 代价：上游 UI 变成 vendor 副本 + 补丁。上游动到同一处时以补丁冲突出现，要人工裁决；`scripts/with-vendor-patches.mjs` 让「打过补丁的树」只存在于构建期间。

推翻它的条件：官方给工作区行开出 slot（哪怕只是行尾 seat）。那时席位可以退回普通插件，vendor 副本直接丢弃。
