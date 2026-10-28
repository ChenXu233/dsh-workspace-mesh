# DSH Workspace Mesh — 期望形态（SPEC, draft v0.2）

> 状态：设计草案，未实现。日期 2026-10-21。
> 一句话：**不是资源远程访问，是工作区联邦。**

---

## 1. 问题

三台机器：本机（Windows）、上海（阿里云 `<lead-host>`）、腾讯云 `<peer-host>`。
> 真实地址只存在于部署者本机的 SSH 配置里，仓库中一律用占位符。
信息与任务是**按工作区**分布在不同机器上的。今天在 A 机打开 B 机的工作区，实际发生的是：
只代理用户消息与助手回复，agent loop 始终在**工作区归属的那台机器**上执行。

这是对的，不该改。缺的是：**让本机的 Lead 能自动地、批量地、可观测地，把任务按工作区投递到对的机器。**

## 2. 目标 / 非目标

### 目标
1. 三台机器各自跑 DSH，工作区**归属**某台机器（静态分配表）。
2. 任意机器上的 agent 能把任务投递到「属于其他机器的工作区」的会话里，并收回结果。
3. 执行永远在归属机：**调用方从不下发工具调用**，只发消息、收消息。
4. 分配是**静态的**；未分组工作区交给可选的调度子插件。

### 非目标（v1 明确不做）
- 远程 bash / 远程文件读写（不做，且架构上禁止）
- 跨机多 Lead 对同一 session 的并发协同
- 智能调度（留给子插件）
- 工作区自动发现（v1 用显式分配表）
- 多租户 / 多用户（沿用 DSH 的 owner 模型）

## 3. 术语

| 术语 | 定义 |
|---|---|
| Node | 一台跑着 DSH 的机器，持有唯一 nodeId |
| Workspace | DSH 里已有的工作区概念，有 workspaceId |
| WorkspaceRef | { nodeId, workspaceId } — 全局唯一寻址 |
| Assignment | workspaceId → nodeId 的静态映射 |
| Task | 一条要投递到某工作区执行的工作项 |
| Peer | 非 owner 的远程主体，经 remoteAccess 授权 |
| Sidecar | 独立进程，负责连接、身份、路由、任务板 |

## 4. 拓扑与信任边界

```
本机 ──┐
上海 ──┼── Sidecar(hub) ── 任务板 / roster / 分配表
腾讯云 ┘
```

- **网络**：Tailscale / WireGuard 私有网，或公网 + mTLS。禁止明文公网。
- **身份**：每个 Node 一对 Ed25519 密钥；nodeId = base58(pubkey 前 16 字节)。
- **信任边界**：跨机只有「消息」流动，没有「工具」。即使某节点被攻破，攻击者也只能给别的节点**发消息**，不能直接执行命令。

## 5. 核心数据结构

### 5.1 NodeDescriptor（roster 用）

```ts
interface NodeDescriptor {
  nodeId: string;
  label: string;            // "local-win" | "shanghai" | "tencent"
  endpoint: string;         // wss://...
  pubkey: string;           // Ed25519
  dshVersion: string;
  workspaces: WorkspaceSummary[];
  online: boolean;
  lastSeenAt: number;
}
```

### 5.2 WorkspaceSummary（**仅元数据，不含文件内容**）

```ts
interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  path: string;             // 归属机本地路径，仅用于展示
  sessions: {
    sessionId: string;
    title: string;
    updatedAt: number;
    busy: boolean;
  }[];
}
```

### 5.3 Task（任务信封）

```ts
interface Task {
  taskId: string;           // ULID
  target: { nodeId: string; workspaceId: string };
  objective: string;
  context?: string;
  acceptance?: string[];
  policy: {
    sessionMode: 'new' | 'resume';
    sessionId?: string;
    maxDurationMs?: number;
    replyMode: 'final' | 'stream';
  };
  lease: { owner: string; fencingToken: number; expiresAt: number };
  state: 'queued' | 'dispatched' | 'running' | 'done' | 'failed' | 'expired';
  createdAt: number;
}
```

### 5.4 Registry（由广播派生，不是配置）

> **修订**：初稿要求手写 `assignment.yml` 维护 workspace → node 的映射。
> 评审后改为**节点自报**——工作区本来就长在某台机器上，让它自己说就行。
> 手工维护的映射表只会漂移，而且会形成「用 mesh 同步 mesh 自己的配置」的自举依赖。

**节点连上即广播（§6.1）**，hub 据此构建注册表：

```ts
interface NodeManifest {
  nodeId: string
  label: string
  dshVersion: string
  capabilities: {
    workspaces: WorkspaceSummary[]      // 元数据：id / name / path / 会话数
    bundles: BundleInfo[]               // name@version + enabled + error
    presets: string[]                   // 可用 agent preset
    models: string[]                    // 可用模型（不含凭据）
  }
  load: { cpu: number; memUsedRatio: number; tasksInFlight: number }
  lifecycle: { supervisor: 'systemd' | 'docker' | 'pm2' | 'unknown'; pid: number; startedAt: number }
}
```

注册表规则：
- `hello` → 建条目；`manifest/changed` → 增量更新；心跳丢失 → 标记 offline（**不删除**，历史仍在）
- `mesh_dispatch({ workspaceId })` 直接查注册表，**不再需要 nodeId 参数**
- 同一 workspaceId 出现在两台节点上 → 视为冲突，报错并要求显式指定 nodeId

**保留的唯一人工输入是一张可选的覆盖层**（`overrides.yml`）：

```yaml
overrides:
  - { workspaceId: ws-secret, share: false }        # 不广播、不可调度
  - { workspaceId: ws-blog,   pinNode: shanghai }   # 固定到某台，忽略广播
  - { nodeId: tencent, acceptFrom: [local-win] }    # 只接受指定来源的调度
```

默认全自动，需要干预时才写覆盖层——**配置从「必填」降级为「例外」**。

## 6. 协议：三个平面

### 6.1 控制面（roster / presence / 能力广播）

| 方法 | 方向 | 用途 |
|---|---|---|
| hello(nodeId, pubkey, manifest) | node → hub | 上线 + 首次广播家底 |
| manifest/changed(delta) | node → hub | 工作区增删、插件装卸后增量更新 |
| heartbeat(tick) | node → hub | 15s 一次，3 次丢失标记 offline |
| bye(reason) | node → hub | 主动下线，立即置 offline |

**广播内容 = 能力清单，不是能力本身。** 这是本章最重要的边界：

| 广播 | 不广播 |
|---|---|
| 工作区 id / 名称 / 路径 | 文件内容 |
| 插件名 + 版本 + 是否启用 | 插件源码 |
| preset 名、模型名 | 凭据、API key、token |
| 版本号、负载、生命周期状态 | 会话历史正文 |
| 会话 id + 标题 + 是否 busy | 环境变量 |

理由：让你**知道自己有什么可调度**，而不是让你**能访问一切**。

#### 6.1.1 隐身节点（discoverable: false）

一个节点被攻破就能枚举全网拓扑，这是自动发现固有的代价。缓解：

- `discoverable: false` 的节点**不响应别人的清单查询**，只能主动连出
- 广播只在 `pairing` 认证成功后发生，未配对者连 hello 都发不出
- 广播内容永不包含绝对路径以外的执行细节（路径本身可配置为 `redactPaths: true`）

### 6.2 数据面（消息投递）—— **方法白名单，硬编码**

只允许这 5 个远程方法：

| 方法 | 用途 | 资源 |
|---|---|---|
| workspace/list | 列出归属机工作区 | global |
| workspace/follow | 订阅工作区变更 | global |
| session/create | 在指定工作区建会话 | workspace:<id> |
| session/prompt | 投递用户消息 | session:<id> |
| session/follow | 收历史 + 实时事件 | session:<id> |

**不在白名单内一律拒绝**：任何 bash*、file*、terminal*、plugin*、settings* 方法。

实现方式：为 principal kind **mesh-peer** 注册 policy，只绑定上述 action。
依赖 dsh-api-remote-access 的 registerPolicy(kind, policy)，粒度到 ns/method + 资源。

> ⚠ 待验证：非 owner Peer 的创建入口是否对外开放。这是唯一的真实风险点。

### 6.3 协作面（任务板）
- 权威存储在 hub（SQLite 即可，单机量级）
- 状态机：queued → dispatched → running → done / failed / expired
- 租约：lease.owner + fencingToken + expiresAt，过期可被抢占，fencingToken 单调递增

## 7. 生命周期与失败语义

### 7.1 一次投递
1. Lead 产生 Task，写入任务板（queued）
2. Sidecar 查 assignment → 得到 nodeId
3. 租约冲突则排队或拒绝（配置项）
4. session/create（或 resume）+ session/prompt 投递
5. session/follow 收事件；replyMode=final 时聚合到最后一条 assistant/message
6. 结果写回任务板 + artifacts 摘要

### 7.2 ⚠ 断线重连（必须显式处理）
follow() 重连发出的是**替换 baseline**，不补发断线期间增量。
→ 必须做：本地 offset + 按 seq 去重 + 重连后重建视图。**绝不能假设事件不丢。**

### 7.3 ⚠ 并发（必须实测）
同一 session 同时投两个 prompt 的行为未知。
→ v1 强制：**一个 session 同时只允许一个活跃 Task**（session 级互斥），由 hub 保证。

### 7.4 超时与失败
- 超 maxDurationMs → 标记 expired，尝试中止 session
- 节点离线 → 任务保留 queued，回线后重投（幂等键 = taskId）

## 8. 安全模型

| 层 | 机制 |
|---|---|
| 传输 | mTLS 或 Tailscale 私有网；公网必须 TLS |
| 身份 | Ed25519 签名挑战；nodeId 绑定公钥 |
| 授权 | principal kind mesh-peer + 方法白名单 + workspaceId 资源过滤 |
| 审计 | 所有跨机调用落审计日志（who / what / when / taskId） |
| 授权 | 服务分级 T1–T4，**默认拒绝**，逐条 grant + 强制 TTL（详见 §16） |
| 红线（已修订） | 架构性禁令 → 策略性默认拒绝：T4 执行类服务**默认永不开放**，开放需 `acknowledge: remote-code-execution`。理由见 §16.6 |

## 9. 插件拆分

### 9.1 核心插件 dsh-plugin-mesh（必做）
- roster / presence / 心跳
- assignment 表读取
- 方法白名单与 policy 注册
- 任务板读写
- 暴露给模型的工具：
  - mesh_list_nodes()
  - mesh_list_workspaces(nodeId?)
  - mesh_dispatch({ workspaceId, objective, acceptance, sessionMode })
  - mesh_task_status(taskId) / mesh_task_wait(taskId, timeoutMs)
  - mesh_cancel(taskId)

### 9.2 鉴权插件 dsh-plugin-mesh-auth（独立）
- Ed25519 握手、签名验证、token / mTLS 适配
- 可单独替换（接 SSO、Vault 等）
- 与核心解耦：核心只要求「给我一个已认证的 nodeId + 公钥」

### 9.3 调度子插件 dsh-plugin-mesh-scheduler（可选，后做）
- 输入：**未分组工作区**（assignment 表里没有的）
- 职责：决定投到哪台机器
- 依据：在线状态、负载、模型可用性、亲和性
- **只产出「分配建议」，不直接投递**；投递仍由核心完成
- 卸载后系统退化为「仅静态分配」，且不报错

> 满足需求：没有智能调度，只有工作区分配；智能调度用子插件实现，代理未分组工作区。

### 9.4 依赖策略（浅依赖原则）

> 核心原则：**不 import 别人的包，只在运行期探测别人的服务。**
> 范本：`@njjpro/dsh-remote-workspace` 自己就是这么做的——文档原文「本包在构建期独立于
> `@linxin666/dsh-remote-web-ui`（不 import、不声明包依赖），只在运行期通过 cordis 服务
> `remoteWebUiPairing` 读取该插件的配对身份」。

#### 9.4.1 依赖分级

| 依赖 | 类型 | 必要性 | 退路 |
|---|---|---|---|
| `@deepseek-ai/dsh`、`@deepseek-ai/cordis` | peerDependency | 必须 | 无（这是宿主） |
| `@deepseek-ai/dsh-tools` / `schemastery` | peerDependency | 必须 | 无（注册工具要用） |
| cordis 服务 `remoteWebUiPairing` | **运行期探测** | 可选 | 探测不到 → 走直连模式 |
| `@linxin666/dsh-remote-web-ui` | **不依赖** | — | 只探测它的服务 |
| `@njjpro/dsh-remote-workspace` | **不依赖** | — | 它是 UI 层，我们不需要 |
| `react` / `react-dom` | 不依赖 | — | 本插件只做 host 半区，不做 UI |

#### 9.4.2 传输接缝（seam）

插件内部定义一个极小的传输接口，实现可替换：

```ts
interface MeshTransport {
  listNodes(): Promise<NodeDescriptor[]>;
  listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]>;
  createSession(nodeId: string, workspaceId: string): Promise<string>;
  prompt(nodeId: string, sessionId: string, text: string): Promise<void>;
  follow(nodeId: string, sessionId: string, onEvent: (e: unknown) => void): Promise<() => void>;
}
```

两种实现，按探测结果选：

| 实现 | 触发条件 | 依赖 |
|---|---|---|
| `PairingTransport` | 探测到 `remoteWebUiPairing` 服务 | 零包依赖 |
| `LoopbackTransport` | 未探测到，但配置了 `peerBaseUrl` | 零包依赖（fetch 回环代理） |

**都探测不到** → 插件仍能加载，工具返回明确错误「未配置任何传输」，
而不是启动失败。这是浅依赖的关键：**依赖缺失是降级，不是崩溃**。

#### 9.4.3 为什么不做硬依赖

1. 社区包版本迭代快，硬依赖会被对方的 breaking change 拖死。
2. 运行时服务探测让「有没有装对方」不影响本插件加载。
3. 未来 DSH 内核若自带配对能力，只需换一个 transport 实现，其余不动。

### 9.5 可观测性（最小）
- 任务板即仪表盘：状态、耗时、节点、结果摘要
- 事件计数与丢帧告警

## 10. 与既有 DSH 组件的映射

| 需求 | 复用 | 备注 |
|---|---|---|
| 远程调用 / 流 / 取消 | dsh-api-gateway（Typert RPC） | 已具备 |
| 方法级鉴权 | dsh-api-remote-access | 注册 mesh-peer policy |
| 工作区枚举与变更流 | dsh-api-workspace-controller | workspace namespace |
| 会话创建 / prompt / follow | dsh-api-session-controller | session namespace |
| 本机多角色协作 | dsh-experimental-agent-team | 仅本机内，与 swarm 叠加 |
| 传输层 / 配对 | `@linxin666/dsh-remote-web-ui`（npm 0.4.8） | 现成：扫码配对、一次性令牌、设备凭据、可撤销 |
| 远端工作区呈现在本机 | `@njjpro/dsh-remote-workspace`（npm 0.3.22） | 现成：侧栏列远端工作区、中列回环嵌入远端会话 |
| 任务投递 API | — | **这才是要写的部分** |

## 11. 生态现状

> **勘误**：本 SPEC 初稿曾断言「无现成实现」。那是只查了 GitHub 通用检索与本地发行包得出的**错误结论**。
> 正确查法：npm 搜 `dsh-plugin` 关键词（共 9451 个包）+ GitHub `topic:dsh-plugin`。以下为修正后的结论。

### 11.1 DSH 生态内：底座已经存在

| 层 | 现成插件 | 版本 | 覆盖到什么程度 |
|---|---|---|---|
| 配对与设备凭据 | `@linxin666/dsh-remote-web-ui` | 0.4.8 | 扫码把手机/PC 配进同一个 Web GUI；一次性令牌；可撤销设备；依赖含 `cloudflared` |
| 工作区联邦呈现 | `@njjpro/dsh-remote-workspace` | 0.3.22 | 远端项目与会话出现在本机侧栏；点开远端会话，**对端真实 GUI 经回环嵌入代理**渲染在本地中列；可在远端新建对话 |
| 远端工作区（SSH 派） | `@goodandready/dsh-remote-workspace` | 0.3.17 | SSH2 连接池 + SFTP + 三向冲突感知镜像同步 + 端口转发（**资源型**，与本 SPEC 的 message 型相反） |
| 多 agent 编排 | `dsh-swarm` / `dsh-swarm-orchestrator` / `@joekytc/dsh-swarm` | 0.0.1 等 | 角色化 swarm 编排；`dsh-swarm` 目前是**占位包，首个版本开发中** |
| 本机团队 | `@nanmicoder/dsh-agent-teams` | — | AgentTeams（同进程） |
| 定时派活 | `dsh-task-dispatch-table` | — | 定时触发 agent 任务（非跨机） |

**结论**：第 4 章「配对/身份」与第 6 章「传输层」**不需要自研**。
`@njjpro/dsh-remote-workspace` 已经实现了本 SPEC 的核心叙事——远端工作区当本机用、远端会话就地打开、
执行仍在归属机。它缺的只有一件事：**给 agent 用的编程接口**。

### 11.2 仍然空白的部分（本 SPEC 的真正范围）

| 缺口 | 说明 |
|---|---|
| 无 agent 可调用的投递 API | 现有插件是**人点侧栏**触发的；没有 `mesh_dispatch` 这类工具 |
| 无任务板与租约 | 跨机任务没有状态机、没有 fencing、没有结果聚合 |
| 无静态分配表 | 工作区与节点的归属没有声明式表达 |
| 无调度子插件 | 未分组工作区的分配策略无人负责 |

### 11.3 非 DSH 开源对照（仅参考语义）

| 项目 | 是什么 | 为何不能直接用 |
|---|---|---|
| ACP（Zed） | 编辑器 ↔ agent 协议 | 单 agent 单客户端 |
| A2A | agent 间互操作 | 无 workspace 概念 |
| OpenHands Remote Agent Server | 远端 agent + 沙箱 | 执行在远端，本 SPEC 要求执行在归属机 |
| MCP gateway（metamcp / mcp-proxy） | 工具联邦 | 方向相反 |
| CrewAI / AutoGen / Swarm | 进程内多角色 | 单进程 |

## 12. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| P0 | 装两个现成插件，三机配对 | 本机侧栏能看到三台机器的工作区，并打开远端会话 |
| P1 | 摸清现有插件的 host 路由能否被复用（`/pair-remote/*`、回环嵌入代理） | 得出「直接调用」还是「需薄适配层」的结论 |
| P2 | 任务板 + 租约 + `swarm_*` 工具面 | Lead 能 mesh_dispatch 并拿到最终回复 |
| P3 | 调度子插件 | 未分组工作区可按负载自动分配；卸载后无副作用 |

## 13. 未决问题

1. **`@njjpro/dsh-remote-workspace` 的 host 控制路由能否被 agent 工具直接调用？** 还是必须自建薄适配层（走回环代理发 HTTP）。这是现在最关键的一条，取代了初稿的「peer 创建入口」问题。
2. 现有配对插件是否支持 **3 台以上**节点（本 SPEC 需要 3 台）。
2. session/follow 的 seq 语义能否支撑精确 offset 与去重？
3. 同一 session 并发 prompt 的真实行为？
4. workspace 的 path 跨机是否有意义（同一仓库不同路径）？
5. 任务成果（artifacts）如何回传：只回消息摘要，还是也要文件引用？
6. 三机的 DSH 版本是否必须一致？

## 14. 生命周期控制（实例运维 + 插件开发闭环）

> 需求来源：`dsh` 的插件开发闭环是「改代码 → 让远端实例加载 → 观察行为」。
> 如果只能 SSH 上去手动敲命令，mesh 就退化成只读看板。所以要能给远端实例**发重启指令**。

### 14.1 与数据面严格隔离

生命周期**不属于** §6.2 的消息白名单。它是独立 plane + 独立 role：

| 方法 | 作用 |
|---|---|
| lifecycle/status | 进程状态、启动方式、pid、启动时间、已加载 bundle 清单 |
| lifecycle/reload | 触发热重载（profile 启用 dsh-hmr 时优先走这条） |
| lifecycle/restart | 优雅退出，由外部 supervisor 拉起 |
| lifecycle/stop | 停止——**默认不提供**，需显式开启 |

授权：`mesh-peer` 默认**没有** lifecycle role。必须单独配置：

```yaml
lifecycle:
  enabled: true
  allow: [restart, reload]      # stop 不在此列
  confirmToken: true            # 每次操作需二次确认令牌
```

### 14.2 三条实现路径（按侵入性排序）

| 路径 | 做法 | 侵入性 | 建议 |
|---|---|---|---|
| **A. 自重启 + supervisor** | 收到 restart → flush → `process.exit(0)`，systemd / docker / pm2 自动拉起 | 无（不调用任何命令） | **首选** |
| B. 白名单命令 | 调用预配置的 `systemctl restart dsh-web` 之类 | 中（需要 shell） | 仅 opt-in 的独立插件 |
| C. HMR 热重载 | profile 启用 `dsh-hmr`，改文件即重载 | 最低 | 开发期首选 |

**A 的关键**：插件自己不 spawn 进程、不碰 shell，只把「我要退出」变成一个正常退出。
谁来拉起它，交给外部 supervisor。§8 的红线因此仍然不破。

配合 systemd 的最小单元：

```ini
[Service]
ExecStart=/usr/bin/node /opt/dsh/lib/bin.js --profile web --no-open --port 3080
Restart=always
RestartSec=2
```

### 14.3 状态机与任务安全

```
running ──restart──▶ draining ──exit──▶ offline ──supervisor──▶ starting ──hello──▶ running
```

- 进入 **draining** 后立即拒绝新 task 投递
- 在飞任务：租约到期自动回收，节点回线后按 taskId **幂等重投**
- 重启后必须重新 `hello`（同一 nodeId），roster 才恢复 online
- **fencingToken 跨重启必须单调递增**——持久化在 hub 侧，绝不依赖节点内存

### 14.4 开发闭环（插件作者视角）

```ts
mesh_dev({
  nodeId: 'shanghai',
  pluginPath: '<repo>',   // 或 npm 包名
  action: 'install' | 'uninstall' | 'reload',
  restart: true,
})
→ { loaded: true, bundleVersion: '0.1.1', loadErrors: [] }
```

注意返回值是**加载结果**而不是退出码：重启后是新进程，只能靠新进程回报。

### 14.5 安全红线

- 默认关闭；开启需显式配置 + 二次确认令牌（防误触、防 CSRF）
- 审计日志：谁、从哪个 nodeId、请求了什么、何时
- `stop` 默认不提供——停机无法自愈，只能人工介入
- 公网部署时 lifecycle 必须走 mTLS
- **永不允许**通过 lifecycle 传递任意命令或参数

## 15. 工作区上下文与插件供给

> **修订说明**：本章初稿写的是「配置同步」。评审后判定方向错了——
> **配置不该同步，插件也不该在节点级同步，而应按工作区供给。**

### 15.1 配置：不同步，随任务传递

配置是**节点的属性**，一旦同步就会漂移，且写入会污染宿主。改成**任务的参数**之后，一切都变成无状态的：

```ts
mesh_dispatch({
  workspaceId: 'ws-blog',
  objective: '...',
  context: {
    preset: 'standard',          // 该会话使用的 agent preset
    model: 'deepseek-official/deepseek-flash',
    env: { NODE_ENV: 'production' },   // 仅注入该会话的 shell
    instructions: '...',         // 额外指令，追加到会话上下文
  },
})
```

约束：
- 只作用于**本次会话**，绝不写入节点的 settings / cordis.patch.yml
- 会话结束即失效；下一次投递要重新带
- **凭据永不跨机**（延续 §8）：`env` 里不允许出现密钥类变量名，hub 侧做拒绝

这样做的收益：**没有漂移，因为不存状态**；没有写入，因此也不需要 L2 白名单那套机制。

### 15.2 插件：为什么要落到远端

DSH 的客户端模块机制（`dsh-client-modules`）是：

> 宿主半侧扫描已启用的 Loader 条目并组合启动图，可用的 Web 载体通过 `/plugins` 提供每个 bundle；浏览器半侧按需惰性加载。

因此**浏览器里看到的 UI 全部来自「提供这个页面的那台 Host」**。
而远端工作区嵌的是**对端的真实 GUI**（回环嵌入代理），所以：

| 插件部分 | 必须装在哪 | 原因 |
|---|---|---|
| host 半区（工具、服务） | 远端 | agent loop 在远端跑 |
| **client 半区（Web UI）** | **远端** | 嵌入的 GUI 由远端的 `/plugins` 提供 |

> 一句话：**本地装了这个插件也没用**，因为本地不渲染远端工作区的 UI。

### 15.3 供给流程（复用 plugin-manager + lifecycle）

```
inspect(spec) → installBundle(requestId) → enable → [restart] → verify(listBundles)
```

| 步骤 | 依赖 | 失败处理 |
|---|---|---|
| inspect | `pluginManager.inspect(spec)` | 直接报错，不安装 |
| install | `installBundle`，日志经 `plugin-manager/install-log` 流式回传 | 记录失败原因，不留半装状态 |
| enable | 更新 profile `cordis.patch.yml` 的 `disabled` | 回滚到 disabled |
| restart | §14 生命周期（无 HMR 时必需） | 超时则标记节点 offline |
| verify | `listBundles` 读回 version / error | 版本不符则报 drift |

**幂等**：已装且版本一致 → 整条跳过，只回报 "already satisfied"。

### 15.4 版本一致性

- mesh 定期收集每个节点的 `listBundles` 指纹：`name@version + enabled`
- `mesh_plugin_drift()` 报告差异：缺少、版本不同、被禁用
- **只报告不自动修**——自动装插件等于自动改别人的运行环境，风险等同于远程执行代码

### 15.5 红线

| 禁止 | 原因 |
|---|---|
| 不走 plugin-manager，直接写 node_modules | 绕过版本校验与审批 |
| 接受任意 spec（任意 URL / tarball） | 等于远程任意代码执行 |
| 同步凭据 | 延续 §8 |
| 自动修复 drift | 装插件是破坏性操作，必须显式触发 |

允许的 spec 来源只有两类：**registry 包名**、**本地 `link:` 路径**（开发期）。

## 16. 服务网格与授权矩阵

> **方向修正**：初稿把跨机交互设计成「hub → node 单向投递」。
> 评审后判定过窄——分布式系统里服务天然对等，A 能给 B 投消息，B 同样能给 A 投。
> agent loop 仍在归属机，但**服务是可被对等调用的**。

### 16.1 服务分级（这是整个安全模型的地基）

| 层级 | 服务 | 默认 | 说明 |
|---|---|---|---|
| **T1 元数据** | workspace.list / follow、manifest.read | ✅ 允许 | 不产生副作用，泄露面仅限拓扑 |
| **T2 会话** | session.create / prompt / follow | ✅ 允许（限 scope） | 只递话，执行在对端 |
| **T3 运维** | plugin.install / enable、lifecycle.restart | ⚠️ 显式授权 | 改对端运行环境 |
| ~~T4 执行~~ | **不作为网格服务暴露** | — | bash / file 是归属机的**本地能力**，由该机自己的 loop 调用；网格里根本没有这个入口 |

关键判断：**矩阵本身不制造危险，开放 T4 才制造危险。**
所以分级不是为了好看，是为了让「默认配置就是安全的」这件事成立。

### 16.2 寻址与调用路径

```
服务地址： mesh://<nodeId>/<service>/<method>#<scope>
例：      mesh://shanghai/session/prompt#ws-blog
```

| 路径 | 何时用 | 代价 |
|---|---|---|
| **直连** | 双方网络可达（Tailscale/内网） | 最低延迟；需要地址簿（来自 roster） |
| **中继** | 一方在 NAT 后或只出站 | hub 转发但**不解释内容**；端到端签名保留 |

hub 在网格里的角色降级为：**发现 + 授权分发 + 吊销广播 + 审计汇聚**，不做数据面必由之路。

### 16.3 授权矩阵

```yaml
# mesh/grants.yml —— 默认全拒，逐条开放
defaults:
  posture: deny

grants:
  # 本地 → 上海：只做会话投递，且限定两个工作区
  - from: local-win
    to: shanghai
    tiers: [T1, T2]
    scope:
      workspaces: [ws-blog, ws-newapi]
    ttl: 24h

  # 上海 → 本地：对称地允许它回调（分布式对等）
  - from: shanghai
    to: local-win
    tiers: [T1, T2]
    scope:
      workspaces: [ws-dev]
    ttl: 24h

  # 腾讯云 → 上海：允许运维，但不给执行
  - from: tencent
    to: shanghai
    tiers: [T1, T2, T3]
    scope: { workspaces: [ws-blog] }
    ttl: 1h

  # T4 需要单独的危险级别确认，且必须写 expires
  - from: local-win
    to: shanghai
    tiers: [T4]
    scope: { workspaces: [ws-newapi] }
    ttl: 30m
    acknowledge: 'remote-code-execution'
```

矩阵的四条硬规则：

1. **默认拒绝**：没写的就是不能调
2. **双向显式**：A→B 与 B→A 是两条独立授权，不存在对称推断
3. **强制 TTL**：任何授权都会过期，最长 7 天；T4 最长 30 分钟
4. **scope 必填**：不允许「对该节点全部工作区开放」

### 16.4 与 DSH 既有机制的映射

| 矩阵概念 | DSH 既有 | 备注 |
|---|---|---|
| principal | `remoteAccess` 的 principal kind `mesh-peer` | 每个节点一个 principal |
| tiers → 方法集合 | role（限定资源种类的 action 集合） | 每层一个 role |
| scope.workspaces | `typert.resources` 的 `workspaceId` | 已存在 |
| ttl | policy 的 condition + `invalidate()` | 过期即重算快照 |
| 吊销 | `invalidate(principal)` | 广播给所有节点 |

也就是说：**矩阵不是新造的安全层，它是 `remoteAccess` 的声明式前端**。

### 16.5 审计与吊销

- 每次跨节点调用落一条审计：`from / to / service / method / scope / grantId / result / latency`
- 审计汇到 hub，单点可查；节点本地保留最近 1 万条
- 吊销是**广播式**的：hub 撤销 → 所有节点在下一个心跳周期内失效该 peer 的快照
- 本地快照失效前，节点仍可能接受调用——所以 T4 授权必须短 TTL + 强确认

### 16.6 关于「执行」的最终结论

初稿把 bash / file 当成需要禁止的**网格服务**。这个前提是错的：

> **agent loop 永远在归属机，bash 由归属机自己的 agent 请求执行。**
> 网格只传消息，不传执行。

因此：

| 常见误解 | 实际 |
|---|---|
| 危险来自「A 调用 B 的 bash」 | 网格里**没有** B 的 bash 这个服务 |
| 需要禁止 `tool.invoke` | 不需要——它压根不该被注册为服务 |
| 授权矩阵要管执行 | 矩阵只管 T1–T3（元数据 / 会话 / 运维） |

**真正的风险换了位置**：不是「远程执行」，而是「别人的消息让我的模型决定执行」。
这是**语义层**的注入风险，加密救不了它，只能靠：

- 对端消息一律标记为 *untrusted content*，不得当作用户指令
- 只有人类可以提升意图等级（§17.6）
- 执行一律走归属机自己的沙箱与审批策略

所以矩阵保留 T1–T3 三级即可。`T4` 从设计里删除——不是因为禁止，而是因为**不存在**。
## 17. 信任、通道与动态凭据

> 安全边界不建立在「禁止能力」上，而建立在 **身份、通道、时效** 上。
> bash 会被模型调用，这是事实；能守住的不是「叫它别调」，而是「只有对的人的消息进得来，且每条消息都可追溯、会过期」。

### 17.1 三层密钥

| 层 | 算法 | 生命周期 | 用途 |
|---|---|---|---|
| **身份密钥** | Ed25519 | 长期（设备级） | nodeId = base58(sha256(pubkey))[:16]；签名握手 |
| **通道证书** | X25519 / TLS 1.3 | 中期（90 天） | mTLS 双向认证，证书 pinning |
| **会话密钥** | HKDF(X25519 ECDH) | **按 epoch 轮换（10 分钟）** | 每条请求的 MAC；即「动态密码」 |

三层分开的意义：身份密钥泄露可以吊销证书而不用换身份；会话密钥泄露只影响一个 epoch。

### 17.2 配对：人是唯一授权源

```
① 节点 B 打开「配对」→ 显示二维码（含 nodeId + 一次性 pairToken + 6 位校验码）
② 节点 A 扫码 → 双方各显示 6 位码 → **人眼比对** → A 侧确认
③ A 用 pairToken 换取 B 签发的设备证书（绑定 A 的 Ed25519 公钥）
④ 初始 grants 只含 T1（元数据）；T2/T3 需人类在任一端显式授予
```

关键点：**pairToken 一次性、短时效（5 分钟）、且必须人眼比对短码**。
中间人无法同时骗过两端的人眼校验。

### 17.3 动态密码（不传输的口令）

```
epoch       = floor(unixNow / 600)              // 每 10 分钟一轮
sharedKey   = X25519(localSk, remotePk)         // 配对时建立，永不上网
epochKey_n  = HKDF-SHA256(sharedKey, salt=epoch_n, info='mesh-v1')
token       = HMAC-SHA256(epochKey_n, requestId || method || bodyHash)[0..16]
```

校验方用同一 epoch 重算，**时钟容差 ±1 epoch**（即 ±10 分钟）。

为什么比 TOTP 好：口令**从不在网络上出现**，也没有「种子」需要分发；
它是双方各自从 ECDH 共享秘密 + 公开的 epoch 推导出来的。

防重放：每个 epoch 维护已用 requestId 的短窗口集合，命中即拒。
轮换：不需要重新握手，epoch 递增即自动换钥。

### 17.4 通道

| 要求 | 做法 |
|---|---|
| 加密 | TLS 1.3 only，禁用降级；不允许明文回退 |
| 双向认证 | mTLS，证书绑定 nodeId |
| 防中间人 | 证书 pinning + 配对期人眼校验 |
| 中继模式 | hub 只转发密文；**端到端应用层签名**，hub 无法解密或伪造 |
| 审计 | 每条请求记 from/to/method/grantId/tokenHash/结果；链式哈希防篡改 |

### 17.5 与既有配对插件的关系

`@linxin666/dsh-remote-web-ui` 已经提供「一次性令牌 + 可撤销设备凭据」的配对层。
本插件**复用其配对身份**（§9.4 运行时服务探测），在其上叠加：

- epoch 轮换的会话密钥（它没有）
- 请求级 MAC 与防重放（它没有）
- 按 tier 的授权矩阵（它只有「配对了就能看」）

### 17.6 残留风险：人不是唯一的泄露面，人是唯一的授权源

需要纠正一句容易说过头的话：**「把人变成唯一泄露面」在工程上做不到**。真实的面至少有三个：

| 泄露面 | 例子 | 加密能否防护 |
|---|---|---|
| 人 | 点了恶意配对、授了过度权限 | 部分（人眼校验 + 短 TTL） |
| **模型** | 对端消息里的提示注入，诱导本机 loop 执行 | ❌ **完全不能** |
| 供应链 | 装了恶意插件 | ❌ 不能 |

所以准确的表述是：**人是唯一的授权源**——任何提升意图等级的动作都必须经过人。
而通道加密负责的是「消息确实来自声称的对端，且未被篡改或重放」。

两者合起来才完整：

- 加密保证**来源可信**
- 授权矩阵保证**范围可控**
- 消息标注（untrusted content）+ 人类确认保证**意图不被冒充**

缺任何一层，另外两层都会被绕过。
## 18. 附录：工具面草案（给模型用）

```ts
mesh_list_nodes(): NodeDescriptor[]
mesh_list_workspaces(nodeId?): { nodeId, workspaces }[]

mesh_dispatch({
  workspaceId: string,
  nodeId?: string,          // 省略则查 assignment / 交调度子插件
  objective: string,
  context?: string,
  acceptance?: string[],
  sessionMode?: 'new' | 'resume',
  sessionId?: string,
  maxDurationMs?: number,
  replyMode?: 'final' | 'stream',
}): { taskId }

mesh_task_status(taskId): Task
mesh_task_wait(taskId, timeoutMs): { state, summary, artifacts? }
mesh_cancel(taskId): void

mesh_lifecycle({ nodeId, action: 'status' | 'reload' | 'restart' }) -> LifecycleStatus

// 插件供给：只装在「工作区所在的那台机器」，因为 client bundle 由它的 /plugins 提供
mesh_plugin_ensure({
  nodeId: string,
  spec: string,              // registry 包名，或本地 link: 路径
  enable?: boolean,
  restart?: boolean,
}) -> { installed: boolean, version?: string, restarted?: boolean, error?: string }

mesh_call({
  target: string,            // 'mesh://shanghai/session/prompt#ws-blog'
  args: unknown,
  timeoutMs?: number,
}) -> { ok: boolean, result?: unknown, error?: MeshError }

mesh_grants(nodeId?): Grant[]
mesh_grant_revoke({ grantId }) -> { revoked: boolean, propagatedTo: string[] }

mesh_plugin_drift(nodeId?): {
  missing: string[]
  outdated: { name: string; want: string; have: string }[]
  disabledRows: string[]
}
```
