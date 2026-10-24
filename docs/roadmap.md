# Roadmap：dsh-workspace-mesh 怎么推进

> 任务：t3（planner）· 日期 2026-10-24 · 仓库 HEAD `79999fc`（基线 `41e498f`）
> 输入：[spike-p1-transport.md](./spike-p1-transport.md)（下称 **p1**）、[spike-p2-tool-api.md](./spike-p2-tool-api.md)（下称 **t2**）、[SPEC.md](../SPEC.md) v0.2（下称 SPEC）、src/ 现状（955 行，32 测试全绿）。
> 本文只写 docs/，不改 src/ 与 SPEC.md。每个结论都带 file:line 或 spike 章节；估算为人日（1 人日 = 专注 6h）。

---

## 0. 一页结论

**近期目标：完成 SPEC §12 P2 的「mock 闭环」——Lead 在真实 DSH 会话里调 mesh_dispatch，任务经任务板/租约/mock 传输走完 queued→done，拿到最终回复。**

为什么是它：两个前置未知量已被两份侦察解决（p1 定了传输落点 = DSH 核心 Typert；t2 定了注册 API = ctx.tools.register + 方案 A 零依赖），而仓库里 board（租约/fencing 全测）与 mock 传输（五方法全测）已经就绪却**没有连线**——P2 恰好是"把已有零件组装起来"的增量，不是新研究。

三个增量：**P2a** 仓库内 dispatch 闭环（2–3 人日）→ **P2b** 真机工具可见性冒烟（0.5–1 人日）→ **TypertTransport**（2–3 人日，门控于 S0 spike）。
一个 spike：**S0 跨机 Typert 可达性**（U6/U7，1 人日 + 两台机器），它只门控增量 3，不门控 P2a/P2b。

---

## 1. 现状判定：P0–P3 各处于什么状态

| 里程碑 | 状态 | 代码/侦察事实 |
|---|---|---|
| **P0** 装两个现成插件，三机配对 | **未开始，且降级为"可选人工验证"** | 两个社区插件本机均未安装（p1 §6 U1：`~/.dsh/plugins` 只有 3 个无关包）；三机配对不存在。更要紧的是 P0 的产出（GUI 侧栏呈现）对 agent 工具面**非必需**——p1 (d) 已判定工具面走 Typert，不走 RWS 的 GUI 嵌入链路；且 RWS 是 1:1 单 peer（p1 §4：配置只有单个 `peerBaseUrl`，RWS/src/index.ts:51），三机拓扑存疑 |
| **P1** 摸清 host 路由可否复用 | **已完成**（交付于 05fa37e） | 结论：**需薄适配层，落点是 DSH 核心 Typert 方法面 + remoteAccess 的 mesh-peer policy**，不是回环代理 HTTP（p1 §5）。五能力覆盖：/pair-remote/* 2/5、remoteWebUiPairing 0/5、Typert 4/5（缺 listNodes，须自建） |
| **P2** 任务板 + 租约 + 工具面 | **半成：零件已备，未组装** | 已实现且有测试：src/board/index.ts（租约/fencing，board.test.ts 8 用例）、src/transport/mock.ts（五方法+故障注入+replay baseline，transport.test.ts 13 用例）、src/identity/index.ts（epoch key/token/ReplayGuard，7 用例）、src/lifecycle/index.ts（self-restart，4 用例）。**缺**：① dispatch 管道（无 src/dispatch/，没有任何代码把 board 与 transport 串起来）；② mesh_* 工具面（src/index.ts:64 是 TODO(P2)，没有 `export const inject = ['tools']`，grep 全 src 无一处 ctx.tools）；③ mock 未接线（src/index.ts:31-41 pickTransport 只有 pairing/loopback 分支，mock.ts 仅被 test/ 引用）；④ apply() 零测试（test/ 只有 board/identity/lifecycle/transport 四个文件）。**fail-loudly 桩**：src/transport/pairing.ts:24-38 与 src/transport/loopback.ts:11-25 全部方法抛 TransportUnavailableError——且 pairing 桩的探测前提已被否证（src/transport/pairing.ts:20 猜的三个方法名在两个社区插件源码 0 命中，p1 §2.2），它是**应删除的死代码**，不是"待实现" |
| **P3** 调度子插件 | **未开始（正确）** | SPEC §9.3 自己就标"可选，后做"；P3 的输入是"未分组工作区"，而 P2 之前连分组工作区的投递都不存在 |

测试基线（本轮实测）：`tsc -p tsconfig.test.json && node --test lib-test/test/*.test.js` → **32/32 绿**（8 board + 7 identity + 4 lifecycle + 13 transport）。

---

## 2. 近期目标：P2 mock 闭环（而不是 P3 调度器）

**目标句**：在真实 DSH 会话中，Lead 对模型说"把 X 投到 ws-blog"，模型调用 `mesh_dispatch({workspaceId:'ws-blog', objective:'X'})`，工具返回 taskId；`mesh_task_wait(taskId)` 返回 `{state:'done', summary:'<mock 最终回复>'}`。全程 mock 传输驱动，零网络。

**为什么不是 P3**，三个理由：

1. **依赖方向**：调度器的职责是"给未分组工作区选节点"（SPEC §9.3），它的输出是"分配建议"，消费方正是 P2 的 dispatch 管道。先做 P3 等于给不存在的管道写决策器。
2. **价值顺序**：P2 是用户第一次能感知"mesh 在干活"的点（SPEC §12 P2 验收原文就是"Lead 能 mesh_dispatch 并拿到最终回复"）；P3 只是省去手写 assignment 的便利项，SPEC §5.4 的 overrides 覆盖层已把它降级为"例外才配置"。
3. **风险顺序**：P2 恰好被两个侦察解锁（t2 给了注册 API 与加载验证手段，p1 §5 给了五能力→端点映射表），是全项目里**不确定性最低**的一段；P3 需要真实多节点负载信息，依赖增量 3 之后才有意义。

---

## 3. 三个增量

### 增量 P2a：仓库内 dispatch 闭环（mock + board + 工具面核心）

| 项 | 内容 |
|---|---|
| **交付物** | ① `src/dispatch/index.ts`：dispatcher 把 SPEC §7.1 的六步落成代码——create task(queued) → claim 租约 → `createSession` → `prompt` → `follow` → replyMode=final 时聚合最后一条 `assistant/message` 为 summary → 写回 done/failed；租约过期→expired；节点离线→保留 queued，taskId 幂等（SPEC §7.4）。② `src/tools/mesh-tools.ts`：mesh_list_nodes / mesh_list_workspaces / mesh_dispatch / mesh_task_status / mesh_task_wait 五工具，**方案 A 零依赖手写 definition**（t2 §5 A：裸 JSON Schema 参数 + output{schema,render}，不 import @deepseek-ai/dsh-tools）。③ `src/index.ts` 接线：`export const inject = ['tools']`（t2 §2.1：没有它 ctx.tools 是 undefined）、pickTransport 增加 mock 分支、runtime 持有 dispatcher。④ 删除 src/transport/pairing.ts 的死探测（或改为常返 undefined 并注释指向 p1）。⑤ 新测试 test/dispatch.test.ts、test/tools.test.ts |
| **验收标准** | 一条命令：`node ./node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test lib-test/test/*.test.js` —— 全绿，且新增用例覆盖：全链路 queued→done（mock autoRespond 驱动）、replyMode=final 聚合正确、租约过期→expired、节点离线→queued 保留 + 同 taskId 重投幂等、未配传输时五工具全部返回明确的 isError 结果（不是抛崩） |
| **预估** | 2–3 人日（dispatcher 1–1.5、工具面 0.5–1、测试与接线 0.5） |
| **依赖侦察** | t2 (a)(d)：注册 API 形状、方案 A 写法、错误→isError 语义（execute 抛错不结束本轮，模型可自行纠正）；t2 §4.5：工具挂 host 层 ⇒ 所有 agent 继承。p1 §5 落地表：dispatcher 对 transport 的调用序即该表的 prompt/follow 行 |
| **失败/回退** | 若真机冒烟发现 register 行为与源码结论不符（t2 U3/U5 未实跑项）：dispatcher 与工具面本来就解耦，dispatch 测试不依赖 ctx.tools 存在；工具面按 t2 §5 判别法逐条排（缺 output.render / 缺 inject / 重名），最坏情况把工具面拆到 P2b 收尾。replyMode=stream 不在本增量（final 先行；stream 需要 follow 事件透传，+1 人日另立任务） |

### 增量 P2b：真机挂载与工具可见性冒烟

| 项 | 内容 |
|---|---|
| **交付物** | docs/dev-loop.md：从 build 到"模型看见 mesh_*"的七步操作单（build → `dsh plugin --profile web add file:<repo>` 或 `dsh web --patch ./examples/local.cordis.patch.yml` → 触发 recomposition（改 profile patch 或插件管理器操作，t2 §4.3）→ 新会话 → 让模型调 mesh_list_nodes → 看调用卡片 / tool-change developer message → 失败时按 t2 §4.4 七种判据定位）。P2a 已把 mock 设为默认 transport 时，此冒烟零额外代码 |
| **验收标准** | 一个人工检查：GUI 新会话里 `mesh_list_nodes` 返回 mock roster（JSON 里带 `"kind":"mock"` 标记便于确认来源），且对话流出现该工具的调用卡片（t2 §4.4 判据 4/5） |
| **预估** | 0.5–1 人日（含一次踩坑预算） |
| **依赖侦察** | t2 (c) 全部：file:/link: 锚定、dsh.bundle 声明已存在（package.json:48-50）、hmr recomposition 语义、七种可见性判据；U2 的 file:// URL 修正已进仓库（69104f0） |
| **失败/回退** | --patch 路线挂（ERR_UNSUPPORTED_ESM_URL_SCHEME 等）→ 退回 bundle 安装路线（包名解析，cordis.patch.yml 已是正确写法）；两条都挂说明 profile 组合假设错（web profile 不存在 / base 组合不含 tools 行）→ 单开排查任务，**不阻塞 P2a**（其验收不依赖真机），但增量 3 必须等它 |

### 增量 3：TypertTransport（跨机真传输）

| 项 | 内容 |
|---|---|
| **交付物** | ① `src/transport/typert.ts`：listWorkspaces→`workspace/follow` 首帧（或 `session/list`，U9 定）；createSession→`session/create`；prompt→`session/prompt`；follow→`session/follow`；listNodes→roster 自建（静态 assignment + overrides 派生，p1 §4：roster 不是 DSH 概念）。② mesh-peer policy 注册：`ctx.remoteAccess.registerPolicy('mesh-peer', …)` 只放行 SPEC §6.2 白名单（勘误后版本，见 §7）。③ U3 冒烟：对真对端 curl /pair-remote/ping|inventory 验证社区快速通道（只作诊断辅助，不作依赖） |
| **验收标准** | 人工检查：本机会话 `mesh_dispatch` 到上海机的真实工作区，`mesh_task_wait` 拿到**非 mock**（无 kind:"mock" 标记）的最终回复；对端 remoteAccess 审计里能看到 mesh-peer principal 的 session/prompt 记录 |
| **预估** | 2–3 人日（**前提：S0 spike 通过**） |
| **依赖侦察** | p1 (d) 结论全量：端点清单（p1 §3.4）、peer 必填与 remoteAccess.decide 拦截（index.js:1171,1175-1181）、/connect 入口（dsh-client-connection/README.md:51） |
| **失败/回退** | S0 否定（U6/U7 不可行）：**没有社区回退路**——/pair-remote/* 只有 2/5 能力，缺 prompt/follow，糊不过去（p1 §5 第 4 条）。此时停下，二选一上报用户：(a) 等 DSH 官方开放非 owner peer 入口（issue 跟踪）；(b) 启用 SPEC §4 原案的 sidecar 自建隧道（wss + Ed25519，工作量另评 5+ 人日）。路线图在 S0 出结果后 48h 内修订 |

---

## 4. 关键风险表

| # | 风险 | 触发条件 | 卡住什么 | 缓解 |
|---|---|---|---|---|
| R1 | **传输不可用**：社区插件本机未装、/pair-remote/* 响应未实测（p1 U1/U3） | 增量 3 诊断阶段 | 仅诊断辅助，不卡主线 | P2a/P2b 全程 mock，零网络；U3 步骤已写进 p1 §6 |
| R2 | **三机配对未实测**：RWUI 是否支持 3 节点（SPEC §13 第 2 问），RWS 0.3.22 静态看是 1:1 单 peer | 若未来做 GUI 呈现或 P0 | 不卡 P2（工具面不经配对插件） | 真传输走 Typert /connect，不依赖两社区插件的多 peer 能力；P0 降级为可选（§1） |
| R3 | **cordis 工具 API 变更**：t2 全部机制结论基于 0.2.1-rc.3 发布代码，rc 通道可能 breaking（如 register 签名、inject 语义、run_code 保留名） | DSH 升级后插件挂载失败/工具消失 | P2b、增量 3 | 方案 A 手写 definition 依赖面最小（只依赖 ctx.tools.register 存在 + output 形状）；engines.dsh 钉 ">=0.2.1-rc.2"（package.json:52-54）；升级后先跑 t2 §4.4 判据 7（故意非法注册反证）再跑业务 |
| R4 | **跨机 Typert 未验证**（U6/U7）：host 侧插件能否自造 peer 调 invoke；非 owner mesh-peer 调 session/prompt 是否放行 | S0 spike 失败 | 增量 3 全部（= SPEC §12 P2 真机版验收） | S0 前置为独立任务（§8）；P2a/P2b 不受影响，mock 闭环价值独立成立 |
| R5 | **workspace 枚举替代路径未定**（U9）：workspace/list 不存在，用 workspace/follow 首帧还是 session/list 待验证 | 增量 3 的 listWorkspaces | 增量 3 局部 | 先实现 workspace/follow 首帧取基线，session/list 作 fallback；S0 里顺带观察 |
| R6 | **估算偏差**：replyMode=stream、断线 offset 去重（SPEC §7.2 真语义）若并入 P2a 会各 +1 人日 | 验收时想顺手多做 | 进度 | 本路线图明确把 stream 与真实 offset 语义排除在 P2a 外（见 §5） |

---

## 5. 「不做」清单（近期不碰的 SPEC 章节）

| SPEC 章节 | 不做的部分 | 理由（一句话） |
|---|---|---|
| §14 lifecycle 远控 | mesh_lifecycle 工具、lifecycle/* 端点、draining 拒新任务接线 | 自重启控制器已就位且有测试（src/lifecycle），但"远端发重启"需要跨机面先成立（增量 3 之后），且每台机器还要先有 supervisor 环境 |
| §16 授权矩阵 | grants.yml、T1–T3 分级、TTL/吊销广播、mesh_grants/mesh_grant_revoke/mesh_call | 矩阵是 remoteAccess 的"声明式前端"，没有多节点网格就没有声明对象；近期只随增量 3 做最小 mesh-peer policy |
| §15 插件供给 | mesh_plugin_ensure / mesh_plugin_drift / inspect→install 流水线 | 依赖 plugin-manager 跨机面 + 生命周期重启，两级前置都不存在 |
| §17 密钥三层 | X25519/mTLS/动态密码接线（identity 模块只是纯函数库，未接任何请求路径） | 通道先于密码学：Typert 走的 /connect 已有 token + 签名 cookie；自建密钥层等 sidecar 路线启动再说 |
| §9.3 调度子插件（= P3） | 全部 | 见 §2 依赖方向论证 |
| §18 中 mesh_call / mesh_grant* / mesh_plugin_* / mesh_lifecycle | 这些工具 | 全部属于 §16/§14/§15 的面，随其章节一起推迟 |
| SPEC §7.2 真实 offset 语义 | 断线重连增量去重 | mock 已按 replacement-baseline 建模（src/transport/mock.ts:320-325）；真语义（U10）在增量 3 观察 session/follow 首帧时顺带收集，不前置研究 |

---

## 6. SPEC §13 未决问题状态表

> SPEC §13 原文编号有重复（两个"2"），下表按内容引用并注明。

| 问题 | 状态 | 结论 / 谁能答 |
|---|---|---|
| Q1（§13 第 1 条）host 控制路由能否被 agent 工具直接调用 | **已答**（p1 全文） | 能被 HTTP 直调，但 /pair-remote/* 仅 3 端点覆盖 2/5 能力，缺 prompt/follow；结论=需薄适配层，落点 DSH 核心 Typert + mesh-peer policy |
| Q2a 现有配对插件是否支持 3 台以上节点 | **未答** | 静态分析倾向**否定**（RWS 0.3.22 是 1:1 单 peer，p1 §4），但这是源码结论；需 U1 环境（两插件真实安装 + 三机）实测。谁答：做 P0 可选验证时的人，或直接绕开（真传输走 /connect 不依赖它） |
| Q2b session/follow 的 seq/offset 语义 | **未答** | 增量 3 实施者在真机读首帧/断线帧时回答（p1 U10 已给复现步骤）；v1 用 session 级互斥 + final 聚合规避了对它的依赖 |
| Q3 同一 session 并发 prompt 行为 | **未答** | 同增量 3（p1 U11：三机环境连发两条）；SPEC §7.3 的互斥决策使它不阻塞任何近期交付 |
| Q4 workspace path 跨机是否有意义 | **未答**（低优先） | 展示语义问题；mock 的 path 字段已按"仅展示"处理（src/transport/mock.ts:148），等真机呈现时由用户判断 |
| Q5 artifacts 回传形态 | **未答** | P2 明确只回消息摘要（TaskResult.summary 已有字段，src/types.ts:59-63）；文件引用等增量 3 后按需设计 |
| Q6 三机 DSH 版本是否必须一致 | **未答**（有部分证据） | t1/t2 全部基线 = 0.2.1-rc.3；engines.dsh >=0.2.1-rc.2 与 allow-version 审批命令（t2 §4.1）已就位；跨版本组合只能增量 3 的两台真机验证 |

---

## 7. SPEC 勘误建议（不直接改 SPEC.md，由用户决定）

> 依据 p1 §7.3 与 t2 §7。以下给可直接粘贴的修订文字；**均未写入 SPEC.md**。

### 勘误 1：§6.2 白名单里的 workspace/list 不存在

- **现状**：§6.2 表第一行 `workspace/list | 列出归属机工作区`。
- **事实**：对 @deepseek-ai 全树 grep `workspace/list` 0 命中；workspace 控制器导出 create/delete/follow/rename/pinSession/… **没有 list**（p1 §7.3 第 1 行、p1 §3.4）。
- **建议修订文字**：
  > | 方法 | 用途 | 资源 |
  > |---|---|---|
  > | workspace/follow（首帧基线）或 session/list | 枚举归属机工作区（无一次性 list 端点） | global |
  > | workspace/follow | 订阅工作区变更 | global |
  > | session/create | 在指定工作区建会话 | workspace:<id> |
  > | session/prompt | 投递用户消息 | session:<id> |
  > | session/follow | 收历史 + 实时事件 | session:<id> |
- **不修订的后果**：实现者按白名单去调一个不存在的端点，listWorkspaces 落空且报错形态迷惑（网关层"unknown method"而非"denied"）；mesh-peer policy 会把一条死方法绑定进授权面。

### 勘误 2：§9.4.2 PairingTransport 的前提不成立

- **现状**：§9.4.2 表 `PairingTransport | 探测到 remoteWebUiPairing 服务 | 零包依赖`。
- **事实**：该服务唯一方法 `isPairedDevice(request)`（RWUI/src/pairing-access.ts:33），是请求鉴权谓词，无任何资源枚举/会话投递能力；src/transport/pairing.ts:20 猜的三个方法名在两插件源码 0 命中，探测**永远**返回 undefined（p1 §2.2）。
- **建议修订文字**（替换该表）：
  > | 实现 | 触发条件 | 依赖 |
  > |---|---|---|
  > | MockTransport | transport: 'mock'（测试与 P2 冒烟默认） | 零 |
  > | TypertTransport | 配置了 peer（/connect 凭据） | 零包依赖，走 ctx.typertGateway + mesh-peer policy |
  > | LoopbackTransport | 配置 peerBaseUrl 且只需 listWorkspaces/createSession 两能力 | 零包依赖（社区 /pair-remote/*，仅 2/5 能力，只作诊断/快速通道） |
  >
  > （原 PairingTransport 行删除：remoteWebUiPairing 只有 isPairedDevice(req) 谓词，不构成传输接缝。）
- **不修订的后果**：后续读者继续以为"装上配对插件传输就有了"，在死探测代码上重复投入；P2 实施者可能误把 pairing 桩当"待实现"而非"应删除"。

### 勘误 3：§13 第 1 问把两个插件的产物混称

- **现状**：§13 第 1 条把"/pair-remote/*、回环嵌入代理"统称 `@njjpro/dsh-remote-workspace` 的 host 控制路由；§10 映射表进一步把"传输层/配对"归给 `@linxin666/dsh-remote-web-ui` 说"现成"。
- **事实**：/pair-remote/* 与回环嵌入代理属于 RWS（@njjpro，RWS/src/index.ts:20-23 路由归属声明）；RWUI（@linxin666）拥有的是 /api/pair/* 配对面；两者能力不重叠（p1 §3.2、§7.3 第 3/4 行）。
- **建议修订文字**（§13 第 1 问改写为已答形式）：
  > 1. ~~host 控制路由能否被 agent 工具直接调用~~ **已答（P1 侦察）**：/pair-remote/*（属 @njjpro/dsh-remote-workspace，仅 ping/inventory/session 三端点）可被直接 HTTP 调用但只覆盖 2/5 能力；prompt/follow 必须走 DSH 核心 Typert 面与 mesh-peer policy，适配层落点见 §9.4.2 修订。
- **不修订的后果**：排查问题时找错插件仓库（RWUI 里根本没有 /pair-remote）；对"现成传输层"的期待错位——配对插件给的是身份，不是数据面。

### 附加建议（t2 §7，非本次任务点名但同源）

- §9.4.1 依赖表：`@deepseek-ai/dsh-tools | peerDependency | 必须` → 改"**可选**：仅 defineTool 路线需要；零依赖手写 definition 不需要（profile 内插件解析不到宿主 asar 里的该包，t2 §4.2 实测）"。
- §12 P2 的 `swarm_*` 与 §18 的 `mesh_*` 统一为 **mesh_**（§18 是模型可见的最终面；工具名 snake_case 是 PTC 可寻址的裸标识符形式，t2 §2.2）。src/index.ts:61,64 的 swarm_ 字样随之过时。

---

## 8. S0 spike：跨机 Typert 能否从 host 侧插件调用（U6/U7）

**问题**：host 侧插件能否以自造/准入的 peer 调 `ctx.typertGateway.invoke/stream`（U6）；非 owner principal（拟 mesh-peer）调 session/prompt 是否被 remoteAccess 放行（U7）；principal.kind 的实际取值来源（U8）。

**卡住哪条验收**：增量 3 的全部验收（TypertTransport 无从实现）；间接卡 SPEC §12 P2 的真机版验收。**不卡** P2a/P2b（mock 闭环独立成立）。

**需要的环境**（二选一，前者更真实）：
1. 两台机器：本机（Windows）+ 上海（阿里云），各跑一个 DSH 0.2.1-rc.3 实例；
2. 最小替代：**同一台机器两个 DSH 实例**（两个 profile、两个端口）——Typert 面不关心对端在哪儿，只要有一个能走 `GET /connect?token=…&interactions=answer|none` 的入口造出 Peer（p1 §3.4：该入口立即建 owner principal 的 Peer 并返回 302 + 签名 API Cookie）。

**步骤**（复现口径同 p1 §6 U6/U7/U8）：
1. 对端实例起 web host，拿到 /connect token；
2. 探针插件（临时小插件，不入 src/）调 `ctx.typertGateway.invoke({ peer, endpoint: 'session/list', args: {} })`，记录 assertPeerLive / lookup-unavailable 的报错形态 → 回答 U6；
3. 对端 `ctx.remoteAccess.registerPolicy('mesh-peer', …)` 只放行 session/prompt + 资源 session:<id>，本端再调 → 回答 U7；
4. 在 remoteAccess.decide 处打日志打印 principal.kind 实际值 → 回答 U8（'mesh-peer' 只是拟议名）。

**产出与判定门**：docs/spike-s0-typert-cross-machine.md。通过（U6 可造 peer 且 U7 放行）→ 增量 3 解锁；不通过 → 触发增量 3 回退分支（等官方入口 or sidecar 自建隧道），路线图 48h 内修订。

**预估**：1 人日 + 环境准备（两台机器网络互通占大头）。

---

## 9. 执行顺序与提交纪律

```
P2a（本仓库，立即可做）
  └─ P2b（真机冒烟，依赖 P2a 产物）
S0 spike（可与 P2a 并行启动环境准备，判定不互相依赖）
  └─ 增量 3 TypertTransport（依赖 P2b 通过 + S0 通过）
```

- 每个增量一个独立 commit（延续 41e498f 之后的惯例：05fa37e / 72b89a9 / 69104f0 / 79999fc 均为单主题提交）。
- 每个增量合并前跑：`node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test lib-test/test/*.test.js`。
- SPEC 勘误是否落地由用户决定；落地时单独一个 docs commit，逐条引用本文 §7。
