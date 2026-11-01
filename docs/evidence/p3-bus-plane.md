# P3 侦察：插件间原语（跨节点消息总线）的语义与边界

> 任务：p3（scout-bus）· 项目：E:\git\dsh-workspace-mesh · 日期：2026-10-31
> 目的：定义一个**给插件用**的跨节点原语 —— 插件能感知其它机器、能传递信息 —— 并把它的分布式语义钉死。
>
> 前提澄清（来自本轮讨论，视为已决）：
> **数据不是 mesh 管的，数据由插件自己管；信息传递才是 mesh 搭桥。**
> 因此本平面**不扩展 §6.2 数据面**，也不触碰 §14.1 的数据面隔离 ——
> §6.2 的方法白名单保持硬编码不变，那两条纪律是优点而非约束。
>
> 本文件只做设计与取证，**不修改 `src/` 下任何文件，不修改 SPEC.md**。

---

## 0. 结论速览

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| a1 | 定位 | mesh 是「桥」：只传信息，不搬数据。这与 §6.1「广播内容 = 能力清单，不是能力本身」是同一条原则 | 决策 |
| a2 | 平面归属 | 新增**第四平面**：消息总线平面。与 §6.1 控制面（节点级）、§6.2 数据面（工作区/会话级）、§6.3 协作面（任务级）并列 | 建议 |
| a3 | 与 board 的边界 | bus = 无租约的事件广播；board = 有租约的一次性派活。共用 transport 与 identity，**语义独立，不互相复用** | 建议 |
| a4 | 载荷规范 | **只过指针不过内容**：MeshPointer{kind, workspaceId, path?, commit?, url?}；单消息上限 64 KiB | 建议 |
| a5 | 命名空间 | **mesh 统一定义**：topic 首段必须是 mesh 校验过的 pluginId；其余段语义由插件自决 | 决策 |
| a6 | 授权分工 | mesh 保证「谁发的」（peer 身份 + 首段前缀 + 防重放）；插件决定「能不能看」（自用 capability 比对） | 决策 |
| a7 | 投递语义 | 至少一次 + messageId 幂等；per-(topic, sender) FIFO，跨发送者无序；失败绝不静默，回执点名 | 建议 |
| a8 | 持久档 | `durable: true` → outbox 落盘 + TTL 重投。因为载荷是指针，成本低 | 建议 |
| a9 | 传输落点 | 需在 MeshTransport 上加 publish/subscribe；v0 可先用现有 `session/prompt` + `session/follow` 组合，接口不变后换原生 | 待验证（依赖 S0） |
| a10 | 第一个消费者 | 人格引擎：跨身体同步「在场集合 / 记忆仓库指针 / 租约变更」 | — |
| a11 | 未验证项 | 见 §8 —— bus 方法是否算数据面方法、v0 组合实现是否值得、订阅是否需 mesh 侧粗粒度限制 | — |

---

## 1. 边界澄清：为什么不需要扩展数据面

| mesh 管（信息） | 插件自己管（数据与能力） |
|---|---|
| peer 发现与在场（roster / presence / 能力广播） | 记忆内容（人格工作区 = git 仓库） |
| 消息投递（bus 原语） | 文件与产物（沙箱目录、已发布站点） |
| 任务派发与租约仲裁（board + fencing） | 凭据与密钥（DSH 侧 credentials 记录空间） |
| 跨机请求鉴权与防重放（identity） | 内容搬运与目标机准备（git / SSH） |
| 工作区归属声明（assignment） | 版本一致性（engines 区间、session 格式版本） |

**为什么「只过指针」是自然结论**：既然数据是插件自己的事，跨机传消息时就不该传内容，只该传**指向内容的引用**。这与 §6.1「广播内容 = 能力清单，不是能力本身」是同一条原则的延伸 —— mesh 让别人**知道自己有什么可调度**，而不是**能访问一切**。

**具体化（人格引擎）**：记忆同步 = `git` 搬内容 + `bus` 传「仓库 head 变了」：

```ts
mesh.publish('/persona/p1/memory', {
  personaId: 'p1',
  repo: 'persona/p1',
  head: 'abc123',                       // 对方自己 git pull
  changed: { core: 1, public: 3, venue: 12 },
})
```

推论：内容零过桥 → private 层的隐私天然跟着仓库策略走，桥上不需要理解「哪条是私密的」。

---

## 2. topic 命名空间（mesh 统一定义）

- 格式：`/<pluginId>/<ns>/...`，**首段由 mesh 校验 === 发送方插件的注册名**
  （防止 A 插件冒用 B 插件身份发消息 —— 这类问题最难查）
- 保留段：首段以 `_` 开头留给 mesh 自身（如 `/_mesh/...`）
- 段内禁止 `/`；大小写敏感；整条 topic ≤ 128 字节
- **mesh 只校验首段，不解释其余段语义**
- 建议（mesh 不强制，插件自律）：`/<pluginId>/<scope>/<subject>`，
  scope 自述 `public` / `private` / `internal`
- 插件名约束沿用 p2 侦察结论：不得与保留名冲突，同层重名抛错

---

## 3. 消息形态

```ts
export interface MeshPointer {
  kind: 'workspace' | 'repo' | 'site' | 'blob'
  workspaceId: string      // 归属工作区 id（§5.2 WorkspaceSummary 的 id）
  path?: string
  commit?: string           // git sha —— 内容自己取
  url?: string              // 站点直接给 URL
}

export interface MeshMessage {
  id: string                             // 幂等键
  topic: string
  from: { nodeId: string; pluginId: string }
  payload: unknown
  pointers?: MeshPointer[]               // 接收方自己去取
  ts: number
  causationId?: string                   // 因果链：这是在响应哪条消息
}

export interface PublishOptions {
  to?: string[]           // 不给 = 广播到全网格
  ttlMs?: number          // 消息存活期（durable 档用）
  durable?: boolean       // false = 瞬时（离线即失败）；true = 落盘重投
}

export interface PublishReceipt {
  messageId: string
  delivered: string[]
  failed: { nodeId: string; reason: 'offline' | 'unauthorized' | 'backpressure' | 'timeout' }[]
  /** 绝不静默丢弃：没送达的节点必须在回执里点名 */
}

export interface MeshBus {
  // 感知
  peers(): PeerView[]
  onPeerChange(h: (peers: PeerView[]) => void): () => void
  // 传递
  publish(topic: string, payload: unknown, opts?: PublishOptions): Promise<PublishReceipt>
  subscribe(topic: string, h: (msg: MeshMessage) => void): () => void
  request<T>(topic: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>
}
```

---

## 4. 分布式语义（逐条定死，不留含糊）

| 维度 | 契约 | 依据 |
|---|---|---|
| 投递保证 | 至少一次 + messageId 幂等；接收端去重窗口（LRU + TTL） | 分布式不做 exactly-once，只做 at-least-once + 幂等 |
| 顺序 | **per-(topic, sender) FIFO**；跨发送者无序 —— 明确声明，避免使用者误判 | 全局有序不可能，承诺不写清就会被当成 bug |
| 失败 | 两档：瞬时（离线即失败，回执点名）/ 持久（outbox 落盘，上线补投）；**绝不静默丢弃** | 与 §6.3 任务板的 expired 语义同族：显式失败优于假装送达 |
| 幂等与重放 | 复用 identity 现有的 `ReplayGuard` + epochKey/requestToken | 不重造轮子 |
| 安全 | mesh 保证「谁发的」（peer 身份 + 首段前缀校验 + 防重放）；插件决定「能不能看」（自用 capability 比对） | 与 DSH 侧 capability 模型同构：服务端判定，模型无关 |
| 背压 | 每 peer 队列上限 + 溢出策略（拒绝新 / 丢最旧 / 降级持久） | 一个慢节点不能拖垮整网 |
| 本地优先 | 同机插件通信不走网络；网络失败降级为本地排队并**在回执里标注未送达** | loopback transport 已是本地语义 |
| 可观测 | dashboard 增加：每 topic 的 publish/deliver/drop/延迟、offline peer 队列深度 | §9.5 的最小可观测性扩展 |
| 与 board 的关系 | bus 无租约；board 有租约 + fencing。**两套语义，不互相复用** | 混用会出现「谁在等谁」的死锁 |

---

## 5. 传输落点

### 选项 A：扩展 MeshTransport（原生）

在 `MeshTransport` 上加两个方法（形状与现有五方法一致，nodeId 定向）：

```ts
publish(nodeId: string, topic: string, payload: unknown, opts?: PublishOptions): Promise<PublishReceipt>
subscribe(nodeId: string, topic: string, onEvent: (m: MeshMessage) => void): Promise<() => void>
```

- 优点：语义干净、无 agent 会话副作用
- 代价：跨机实现依赖 TypertTransport（门控于 S0 spike）；需在 SPEC 里明确 bus 方法**不属于 §6.2 数据面白名单**（否则会被「不在白名单内一律拒绝」误伤）

### 选项 B：v0 用现有五方法组合

每个节点保留一个 bus session：publish → `session/prompt`；subscribe → `session/follow`。

- 优点：零 transport 改动，立刻能验证语义与插件 API 形状
- 代价：消息带 agent 会话语义、占用一个 session、批量与背压难做

### 建议

**接口先定死，实现先 B 后 A** —— 插件侧代码在切换时一行不用改。B 的价值是验证语义与 API，不是成为终态。

---

## 6. 与既有组件的接缝

| 组件 | 关系 |
|---|---|
| `identity`（epochKey / requestToken / ReplayGuard） | bus 消息的跨机鉴权与防重放直接复用，不重造 |
| §6.1 控制面（roster / presence） | `peers()` 与 `onPeerChange` 直接来自控制面，不另设一套发现 |
| §6.3 协作面（board / lease / fencing） | 租约与 fencing **不进 bus**；两套语义分开 |
| §14 生命周期控制 | 不经 bus（与数据面隔离同理） |
| DSH 侧插件 | `inject: ['mesh']` 取服务；mesh 侧 `provide('mesh')` |

---

## 7. 第一个消费者：人格引擎（牵引，避免空转）

| 场景 | bus 载荷 | 数据怎么到 |
|---|---|---|
| 记忆仓库推进 | personaId + repo + head + changed 计数 | 接收方 `git pull` |
| 在场集合变化 | 场所 key + 状态 | 本身就在 bus 里 |
| 主人指令跨身体 | 指令内容（短文本） | 直接在 bus 里 |
| 租约 / fencing 变更 | personaId + fence 序号 | standby 副本据此自检 |
| 产物发布 | MeshPointer{kind:'site', url} | 对方直接用 URL |

**这五个场景决定了 bus 的语义必须「无租约、可广播、载荷小」。**

顺带回答一个设计分叉：同一 personaId 是**单主单活**（一具持租约的身体连 channel，其余待命）还是**多副本常驻**？若要多副本常驻，副本之间的上下文同步（在场集合 / 记忆 / 租约）**必须**有 bus，否则各副本的上下文会各自腐化 —— bus 的存在与否，实际上决定了这个答案。

---

## 8. 未决问题

1. **bus 方法算不算数据面方法？** 建议：另立平面，§6.2 白名单一字不改（否则「不在白名单内一律拒绝」会误伤 bus）。
2. **v0 组合实现是否值得？** 取决于 TypertTransport 的时间；若 Typert 短期内能通，直接上选项 A。
3. **订阅是否需要 mesh 侧粗粒度限制？** 例如「A 插件能否订阅 B 插件的 topic」。
   倾向**不禁止** —— 插件之间需要互相发现（人格要知道 DSH 侧发生了什么），但要在 dashboard 里可观测。
4. **持久档是否 P3 必做？** 载荷是指针，落盘很便宜；但要定 TTL 上限与重投退避。
5. **topic 段数上限与 64 KiB 载荷上限**是否合适，需与 §6.2 的资源粒度风格对齐。

---

## 9. 工作量估算（1 人日 = 专注 6h）

| 项 | 人日 | 依赖 |
|---|---|---|
| 契约与类型（本文 §2–§4 落成 TS） | 0.5 | — |
| v0 语义实现（loopback / mock） | 1.5 | — |
| transport 扩展 + 跨机 | 2–3 | **门控于 S0（Typert 跨机可达性）** |
| 持久档 outbox + 重投 | 1–1.5 | 契约冻结 |
| dashboard 指标 | 0.5 | — |
| 双机集成测试 + 故障注入 | 1.5 | 需要第二台机器 |

---

## 10. 与 SPEC 的对接（**待本文评审通过后再改 SPEC**）

- §6：新增「6.4 消息总线平面（plugin bus）」，并把标题「三个平面」改为「四个平面」
- §7：补 bus 的失败语义（离线、重复、顺序、背压）
- §9：插件拆分 —— bus 的**机制**入核心插件（需要 transport 与 identity），**语义**留在各插件
- §9.5：可观测性补 bus 指标
- §13：把 §8 的未决问题 1 与 3 收进 SPEC 的未决问题表
