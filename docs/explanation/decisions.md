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
| D15 | 远程工作区是远端快照的投影：不建本地目录、不写原生 registry 记录，行由浏览器从 `/api/mesh/state` 的 `peers[].workspaces` 派生 | accepted | 已实施 | 见 §3 D15 |
| D16 | 工作区整列由 `ui-workspace` 的 vendor 分叉承接；组合里停用官方 bundle，改动只以补丁存在 | accepted | 已实施 | 见 §3 D16 |
| D17 | 机器名是行上的后缀与悬浮卡，不写进标题 | accepted | 已实施 | 见 §3 D17 |
| D18 | 对端管理（列目录 / 建 Workspace）走 `MeshTransport.control` + relay 两个 op，不进五方法数据面 | accepted | 已实施 | 见 §3 D18 |

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

### D15：远程工作区是远端快照的投影，本机不落任何记录

三条决定：

- 远程工作区没有本地目录、也没有原生 registry 记录。显示的唯一来源是 `/api/mesh/state` 的 `peers[].workspaces`，浏览器把它投影成列表里的行。
- 行是派生的：分组键 `remote:<nodeId>:<workspaceId>`，路径取远端真实目录，`workspaceId` 为 `undefined`，所以本机动作（拖动排序、重命名、删除、新建会话）在派生这一刻就挂不上去。
- 远端会话列表不在这一层：会话计数来自对端注册表回执，但本机没有这些会话的摘要，展开后是空的。

理由：

- 工作区在本地的定义是真实目录：`create()` 走 `realpath` 与 `stat().isDirectory()`，`attachSession` 也要求 `SessionHeader.cwd` 真实存在，远端路径过不去。伪造一个本地空目录能让原生分组免费复用，代价是那条记录会出现在**普通工作区列表**里、文件树/终端/LSP 把空目录当项目根、锚点被删后记录变 `missing-dir`。这三个副作用都不是「远程工作区」该有的。
- 记录加不了字段：`WorkspaceRecord` 是 `z.object({ path, title, sessionIds, createdAt, updatedAt })`，zod 默认剥掉未声明键，`nodeId` 存不进去。

代价：

- 远程行只有展开/收起与悬浮卡，没有本地动作；要新建远端会话得走 `mesh_dispatch`，不是点行上的按钮。
- 投影只在挂载、窗口重新获得焦点、页面重新可见时读 `/api/mesh/state`，30 秒内合并成一次，不按定时器轮询——这条路由会扇出到每个对端。对端离线时行还在，只是地球图标变淡。

添加远程工作区是另一条路：侧栏「远程工作区」段的加号走 `/api/mesh/remote` 的 `workspace-create`，把那台机器上的目录登记成**它的** Workspace（见 D18）。本机仍然不落目录、不落记录。

推翻它的条件：relay 能给出远端会话摘要，届时远程行可以长出会话子行；或者 DSH 的 Workspace 记录接受远端身份。

### D16：工作区整列由 `ui-workspace` 的 vendor 分叉承接

三条决定：

- 上游 `packages/client/ui-workspace` 源码整份放进 `packages/workspace-remote-mesh/vendor/ui-workspace`，`vendor/PROVENANCE.json` 记 tag 与 commit；该目录**永远保持上游原样**。
- 本仓库的改动只以 `packages/workspace-remote-mesh/patches/*.patch` 存在，构建与 typecheck 由 `scripts/with-vendor-patches.mjs` 打上、跑完还原。补丁套不上直接失败，不会静默丢改动。
- 组合里 `- id: ui-workspace` 用 `disabled: true` 停掉官方 bundle，本包的客户端半区注册同一批 slot：`sidebar.workspaces`（含 `directoryFlow` 与行菜单/行操作子槽）、`conversation.hero.workspace`、`shell.overlay`。

理由：

- 远程行要和本地行同一套 CSS、同一套搜索与排序、同一个悬浮卡；只有这样它才不是「另一个列表」。官方组件不提供工作区行级 slot，唯一能复用的形态就是整列归我们。
- 两套 apply 同时存在会让同一批 Session 行菜单注册两遍（条目 id 相同），菜单出现两条；所以停用官方 bundle 是硬条件，不是优化。

代价：

- 上游动到补丁触碰的行时以冲突出现，要人工裁决；`node scripts/vendor-upstream.mjs --check` 负责发现 vendor 树被改过。
- 官方 bundle 停用后它的 host 半区也不加载。该半区是空 `apply()`，没有副作用。

推翻它的条件：官方给工作区行开出 slot（哪怕只是行尾 seat），那时远程行可以退回普通插件，vendor 副本直接丢弃。

### D17：机器名是行上的后缀，不写进标题

- 标题只有仓库名；`@机器名` 是标题后独立的小字（`.machine`），悬浮卡写「在 <机器> 上」并给远端真实路径。
- 归属不新增字段、不新增槽：来源就是 `/api/mesh/state` 的 `nodeLabel`，行不知道自己被谁显示。
- 理由：标题参与搜索与重命名唯一性，把来源塞进标题会把「搜机器名」和「重命名工作区」两件事绑死。远程行不属于本机 registry，没有唯一性约束，不需要这个折中。

推翻它的条件：与 D16 相同——远程行有了自己的 slot，机器名可以做成行的独立 entry。

### D18：对端管理不进五方法数据面

- 侧栏添加远程工作区需要两件工具面没有的能力：列对端目录、在对端登记 Workspace。它们落在 `MeshTransport.control`（可缺省）与 relay 的 `browse` / `workspace-create` 两个 op 上，用 `meshSecret` 换来的 mesh token 鉴权。
- 五方法数据面（`workspace/list`、`session/create`、`session/prompt`、`session/follow`、`session/read`）一字不改：那是任务怎么到对端的路，这两条是人在编辑工作区列表时的管理动作。
- 能力缺省时回答 503 并保留对端原文（例如旧对端的 `op must be one of …`），不伪造列表，也不降级成本地路径。

理由：把管理动作塞进数据面会让白名单失去意义（每个 UI 需求都要加一条）；而绕过传输直连 relay 又会让超时、冷却、重试分散在两处。

代价：传输多一个有名字的能力，mock 之外的适配器可以不做（可选方法）；对端版本领先/落后时表现为一条明确的拒绝，而不是一个安静的空列表。

推翻它的条件：DSH 官方把「在远端机器上建 Workspace」做成一条 Remote，届时这里退回纯透传。
