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
| D15 | 远程工作区是远端快照的投影：不建本地目录、不写原生 registry 记录，行由浏览器从 `/api/mesh/state` 的 `peers[].workspaces` 派生 | accepted | 已实施 | 见 §3 D15；会话子行由 D19 取代 |
| D16 | 侧栏座位由质子影子托管：官方 entry 经 entry face 原样渲染，远程段是 region contribution，分栏比例存 client store | accepted | 已实施 | 见 §3 D16 |
| D17 | 机器名是行上的后缀与悬浮卡，不写进标题 | accepted | 已实施 | 见 §3 D17 |
| D18 | 对端管理（列目录 / 建目录 / 建 Workspace）走 `MeshTransport.control` + relay 三个 op，不进五方法数据面；加目录的对话框直接渲染官方 `DirectoryBrowser` | accepted | 已实施 | 见 §3 D18 |
| D19 | 远程 Workspace 展开后的会话行是只读投影：摘要来自对端 `sessionList`，行只画标题/运行点/相对时间，点击不在本机打开会话 | accepted | 已实施 | 见 §3 D19 |
| D20 | hero 的 workspace picker 由质子接管座位、只换 kit：远程行并进官方菜单；选中记为派遣目标，不建本机会话 | accepted | 已实施 | 见 §3 D20；派遣面见 D21 |
| D21 | 目标存在时主区域变成对端会话页：座位由质子接管，消息与工具卡用官方装配、官方渲染；事件按需从对端拉取，没有生命周期，也没有回执条 | accepted | 已实施 | 见 §3 D21 |
| D22 | 一键配对链接：把本机地址与「这一对端专用」的密钥编码进 `#mesh-pair=`，对方打开即导入；导入热生效 | accepted | 已实施 | 见 §3 D22 |

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

### D16：侧栏座位由质子托管，官方浏览器原样请回

三条决定：

- `sidebar.workspaces` 由 `dsh-proton-adapter-dsh` 影子（outlet 的 priority 默认 -100，官方注册默认 0，低者占格）。官方 entry 仍在槽里，质子用 entry face 合成它需要的 kit 后渲染**官方原组件**；官方 bundle 不禁用、不替换，其他插件往官方声明的子槽（`directoryFlow`、`session.menu.item`、`session.row.action`、`sidebar.session.row.*`）注册的条目照常渲染。
- 质子在这个座位里分栏：主栏是官方浏览器（`flex:1`，内部滚动），下栏是该 region 的 contributions（本仓库的「远程工作区」就是一条），中间是可拖拽分隔条；比例持久化在 `dsh.proton.split.v1`，与官方视图状态 `dsh.workspace.view` 用同一个 client store 引擎。
- vendor 源码只服务**我们这一段的行**：`ProjectRowItem` 直接从 `vendor/ui-workspace` import，官方的段不经过我们的任何代码。

理由：

- 兼容性：官方仍是被渲染的组件，它的子槽与 store 都还在，别的插件不需要知道座位被影子过。
- 远程行借用官方行组件，才有同一套排版、悬浮卡与机器后缀；这份改动只落在我们段里，改坏了也碰不到官方列表。

代价：

- 质子要维护 kit（locale 绑定、store 实例、selector hook）——这是质子的本职，不是额外的域逻辑。
- vendor 目录留着一份上游源码（pin 在 `dsh-v0.2.1-rc.5`），补丁只动 `Rows.tsx` / `tree.ts` / `Rows.module.css`，构建期打上、跑完还原。
- 分栏比例按槽名存一份；官方浏览器自己不知道下面还有一段。

推翻它的条件：官方给侧栏开出「多区段」的正式机制，那时分栏与 contribution 可以退回普通槽。

### D17：机器名是行上的后缀，不写进标题

- 标题只有仓库名；`@机器名` 是标题后独立的小字（`.machine`），悬浮卡写「在 <机器> 上」并给远端真实路径。
- 归属不新增字段、不新增槽：来源就是 `/api/mesh/state` 的 `nodeLabel`，行不知道自己被谁显示。
- 理由：标题参与搜索与重命名唯一性，把来源塞进标题会把「搜机器名」和「重命名工作区」两件事绑死。远程行不属于本机 registry，没有唯一性约束，不需要这个折中。

推翻它的条件：与 D16 相同——远程行有了自己的 slot，机器名可以做成行的独立 entry。

### D18：对端管理不进五方法数据面

- 侧栏添加远程工作区需要三件工具面没有的能力：列对端目录、在对端建一个文件夹、在对端登记 Workspace。它们落在 `MeshTransport.control`（可缺省）与 relay 的 `browse` / `mkdir` / `workspace-create` 三个 op 上，用 `meshSecret` 换来的 mesh token 鉴权。
- 目录列表按官方对话框要的形状回答：`path`、`home`、`crumbs`（根到当前目录每一跳）、`entries`（只列目录，带 `hidden`）、`truncated`。少一个字段，对话框就会给出错误的路径栏或把隐藏目录当普通目录画出来。
- 对话框本身是官方 `ui-directory-picker-browse` 的 `DirectoryBrowser`（vendor 原样）：Miller 双栏、面包屑、路径编辑、新建文件夹、隐藏文件开关都由它负责；我们只提供那两个线调用与「确认即建 Workspace」的语义。
- 五方法数据面（`workspace/list`、`session/create`、`session/prompt`、`session/follow`、`session/read`）一字不改：那是任务怎么到对端的路，这两条是人在编辑工作区列表时的管理动作。
- 能力缺省时回答 503 并保留对端原文（例如旧对端的 `op must be one of …`），不伪造列表，也不降级成本地路径。

理由：把管理动作塞进数据面会让白名单失去意义（每个 UI 需求都要加一条）；而绕过传输直连 relay 又会让超时、冷却、重试分散在两处。

代价：传输多一个有名字的能力，mock 之外的适配器可以不做（可选方法）；对端版本领先/落后时表现为一条明确的拒绝，而不是一个安静的空列表。

推翻它的条件：DSH 官方把「在远端机器上建 Workspace」做成一条 Remote，届时这里退回纯透传。

### D19：远程会话行是只读投影，不伪装成本机会话

三条决定：

- 会话摘要来自对端快照：transport 用对端 registry 的 `sessionIds` 加 `session/list` 拼出 `{sessionId, title, updatedAt, busy}`，`wirePeer` 原样下发，浏览器的 `projectRemoteWorkspaces` 只做投影。这条路径不新增 relay op。
- 展开后每行只画标题、运行点（busy）与相对时间，`aria-disabled`，悬浮提示写明「会话在 <机器> 上运行」；不挂本机动作，也不发 `openSession`。
- 行的文案读官方 `workspace` 命名空间：行组件是官方源码的 vendor 副本，字典也归官方；区段只拥有自己的文案（`workspaceRemote`）。

理由：

- 本机没有那份 log：`uiWorkspace.openSession(id)` 会拿一个本机不认识的 id 去 Host 取记录，拿到的是错误。把行做成「可点但不做事」比只读更差。
- 摘要本来就在传输层：为了画一行数字另开一条 relay op，会让同一份事实有两个来源。

代价：

- 行是死的：要读历史或继续对话，得先有跨机会话视图（`/api/mesh/session` 已能读对端日志尾部），那是另一条路。
- 摘要随 `/api/mesh/state` 的读取节奏刷新（挂载、聚焦、重新可见，30 秒内合并），不是实时。

推翻它的条件：跨机会话视图落地（本地能流式读对端日志），行可以变成入口。

### D20：远程工作区进 hero picker，选中是派遣目标

- 座位与 kit：`conversation.hero.workspace` 由工作区域包接管（`alwaysShadow`，座位没有 contribution 也要占）。官方 picker 原样渲染，域包只把 `useWorkspaces` 的返回值并上一组远程行，并把 `onPick` 包一层。
- 远程行 id 带 `remote:` 前缀，`pick` 返回 true：不调座位 owner 的 `onPick`，因此不会在本机建 Session（本机没有那个目录，也没有那条记录）。
- 选中记的是**派遣目标**，不是“当前工作区”：hero 的文件夹芯片归会话壳所有，仍显示本机工作区；目标显示在 composer 工具行的芯片上，点一下清除。
- 菜单行没有第二格，机器名写进标题（`<名字> @<节点>`）——这是 D17 在 picker 里的例外。
- registry 快照不动：合并只发生在这一座位的 kit 里，侧栏与其他读 `useWorkspaces` 的地方看不到远程行。

代价：

- 菜单只决定“目标是谁”；目标怎么显示会话、怎么把字送到对端由 D21 负责，picker 本身不碰 composer。
- 远程行没有独立图标（官方菜单项统一文件夹图标），靠标题里的 `@机器` 区分来源。

推翻它的条件：官方给 picker 开出“额外分组”的正式机制，届时合并 kit 可以退回普通注册。

### D21：对端会话页——座位由质子接管，消息走官方装配

**目标存在时**，主区域不是本机会话，而是对端那台机器的那个会话：

- 质子接管三个座位：`conversation.session.header`（换成「机器 · 工作区 · 会话 + 回到本机」）、`conversation.session`（正文换成对端会话）、`main.conversation`（只把会话姿态从「空白首屏」改成「已开始」，让 composer 落到页面底部而不是首屏居中）。没有目标时三个座位都原样画回官方条目，本机页面一个像素都不变。
- 正文不是自己画的聊天气泡：用官方装配器（`ConversationNodeAssembler`）配**同一份**官方节点/视图定义，把对端的事件流装配成 Chat 快照，再交给官方 `conversation.chat.flow` 条目渲染。消息、推理、工具卡、用时、用量都来自官方渲染器，质子只负责把数据接上。
- 会话在对端：第一次发消息时调 `/api/mesh/session/open` 在对端工作区里开会话，之后 `/api/mesh/session/prompt` 发字，页面按 `/api/mesh/session/events` 拉事件（约 0.9s 一轮）。本机不建目录、不写日志、不持有运行时。
- 没有「派遣任务」这个概念了：页面就是一个会话，你发它回，不做任务板、不做回执条、不展示任务状态。任务板仍归模型工具 `mesh_dispatch` 使用。
- 写的过程也照官方走：对端把 agent 的过程帧（`agent/assistant-stream`）按会话滚动保留，页面用 `/api/mesh/session/live` 按 revision 取增量（busy 时约 150ms 一轮），折成 `assistant/live-chunk` 行塞进同一个装配器——于是「深度求索中」和逐字长出来的正文都是官方渲染，耐久消息落地后这些临时行被替换掉。
- 页面借本机一个**空白会话**当 composer 外壳（会话作用域、草稿机、图片规则都跟着它）。它不是本机的对话：只要页面在，它就从工作区列表里隐藏；页面显示的那个对端会话，作为「当前会话」显示在远程工作区那一组的第一个，侧栏因此不会再把这个对话挂到本机目录下。清掉目标，外壳会话回到本机列表。
- composer 仍是官方那一个：适配器包住提交动词先 `ctx.bail`，有目标时改道到对端会话，没目标时原样走官方发送。草稿、附件、模型选择都还是本机 composer 的。

理由：

- 官方渲染器只认「本机会话绑定」：它的事件窗口、注入面、图片缓存都按 sessionId 解析本机。要让对端的日志以官方样式出现，唯一不改宿主的办法是**自己装配、官方渲染**——装配器是公开类，节点定义与渲染器本来就在客户端注册表里。
- 一个页面只有一个 composer：目标存在时它把字送到对端，视觉上和本机会话完全一致。

代价：

- 两跳都是 HTTP 推流（浏览器 ↔ 本机、本机 ↔ 对端），中间任何一跳不支持常开响应就退回 150ms 轮询：表现是「一小段一小段」而不是逐字。
- 过程帧只保留最近 4000 条且不落盘：读者落后到被截断时从头重取当前这一段；对端进程重启则这一段回答本身就不存在了（耐久日志里有多少就是多少）。
- 对端附件（图片）拿不到字节：本机网关不认识对端 attachmentId，图片位是空的。
- 远程消息里的文件链接指向对端的绝对路径，本机不打开它（`openFile` 是空实现）。
- 折叠、Turn 过程折叠用的是「直接改 hidden」，没有官方的折叠动画；Turn 导航条与分组头不渲染（按扁平顺序画）。
- 只拉尾部一页（`maxMessages=200`）：更早的历史目前不往回翻。
- 远程会话行点开是对端的既有会话，**不新建**；点开后再发消息就落到那个会话里。

推翻它的条件：DSH 允许把外部事件源绑定成一个会话（或给装配器开正式的构造入口），那时质子不用自己装配，直接把对端当作一个会话来源即可。

。

### D22：一键配对链接

- 配对的全部门槛在配置面：要抄对端地址、要抄一个会轮换的登录 token、还要两边共享 `meshSecret`。把这三件事塞进一条 URL，剩下的就是「打开」。
- 链接是 `<本机地址>/#mesh-pair=<base64url JSON>`，负载 `{ v, nodeId, url, secret }`。放在片段里而不是查询串：Web UI 对 `/?token=` 会 302 到 `/`，查询串被丢弃，片段才会跟着到达页面；配对代码在页面里跑，读得到片段。
- 地址不能只看请求的 origin：端口转发或隧道下它就是 `127.0.0.1`，链接发出去等于没发。顺序是 `publicUrl` 配置 → `DSH_PUBLIC_URL` → 非回环的 origin → 本机网卡，面板把结果和候选摆出来让人改。
- 密钥改成**每对端一份**（`peers[].secret`，缺省回落到 `meshSecret`）：导入一张名片不该改掉本机与其他对端的密钥。登录 token 仍然保留——它在 cookie 模式里还有用，导入时若有旧值就留着。
- 导入即生效：写 `mesh-config.json` 后重建传输对象并原地替换 `runtime.transport`（路由和工具都读这个对象），不重启容器。
- 握手与中继路由改成**常挂**（空密钥时 503 并说明原因）：生成名片时可能临时才有第一个密钥，路由如果当时没挂，后面就再也接不上。

理由：手工编辑是跨机使用里唯一需要「懂内部结构」的一步；把它压成一个链接，配对就能像分享文件一样完成。

代价：链接本身就是凭据——拿到它的人可以往自己机器上加这台对端。它只能被**打开链接的那台机器**接受，攻击者拿到也只能连上这台机器，做不了别的（relay 只认 mesh token，与登录无关）。

推翻它的条件：DSH 官方给出远程访问的配对/授权机制时，这里退回纯 UI，把链接交给官方格式。