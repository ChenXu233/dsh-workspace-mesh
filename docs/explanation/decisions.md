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
