# 参考：模型可见的工具面

> **状态**：已实施（P2 范围）
> **日期**：2026-11-01
> **读者**：改 `src/tools/` 的人；排查「模型为什么看不见 `mesh_*`」的人
> **上游材料**：[SPEC.md](../../SPEC.md) §18（设计意图）、[p2-tool-api.md](../evidence/p2-tool-api.md)（注册 API 取证）
> **口径**：描述 HEAD 的实现，依据 `src/tools/*.ts`；用例数等数字见 [baselines.md](./baselines.md)

本文是**当前实现**的唯一归属。SPEC §18 是设计意图；两者不一致处集中在 §8。不一致不是「本文优先」，而是偏差信号——要么 SPEC 该改，要么代码该改，按 [AGENTS.md](../../AGENTS.md) §2 裁决。

## 1. 注册

`src/index.ts` 导出 `inject = ['tools']`（少了它宿主不会注入工具运行时），`apply()` 调 `registerMeshTools()`，逐个 `host.tools.register(definition)`。

注册顺序：`mesh_list_nodes` → `mesh_status` → `mesh_dispatch` → `mesh_task_status`。

宿主没有 `tools` 服务时（headless 组合）插件照常加载，只打一条 `[mesh] tool runtime unavailable`，`mesh_*` 不存在。

工具定义是零依赖的普通对象，不 import `@deepseek-ai/dsh-tools`（取证见 [p2-tool-api.md](../evidence/p2-tool-api.md) §5）：

| 字段 | 作用 |
| --- | --- |
| `name` | 模型看到的工具名，`snake_case` |
| `description` | 模型读的说明，必须写明降级语义 |
| `parameters` | 裸 JSON Schema，原样投影给模型 |
| `output` | `{ schema, render }`；`render` 把返回值变成 `[{ type: 'text', text }]` |
| `timeoutMs` | 宿主超时，目前只有 `mesh_dispatch` 设置 |
| `execute` | `async (args, exec) => unknown` |

**抛错与返回值的分工**：参数错误（未知键、缺必填、类型不对）**抛异常**，由宿主转成普通 `isError` 结果；业务失败**返回数据** `{ ok: false, error: { code, message } }`。抛错会终止本轮，返回值让模型能自己纠正。

## 2. 工具清单

| 工具 | 作用 | 会发起跨机调用 |
| --- | --- | --- |
| `mesh_list_nodes` | roster：assignment 声明与传输回执合并 | 有传输时会 |
| `mesh_status` | 本地健康快照 | 否 |
| `mesh_dispatch` | 投递任务并**阻塞**到最终回复 | 会 |
| `mesh_task_status` | 读任务板上某个 taskId | 否 |

## 3. mesh_list_nodes

参数（都可选，可组合）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `nodeId` | string | 只返回该节点 |
| `workspaceId` | string | 只返回承载该工作区的节点（assignment 或传输回执） |

返回：

```text
{ transport: { configured, mode, kind, reason },
  peers: [ { nodeId, label, endpoint, online, status, source,
             lastSeenAt?, workspaces[], assignedWorkspaceIds[] } ],
  notes: string[] }
```

- `status` 取 `online` / `offline` / `unknown`，只来自传输回执；没有回执就是 `unknown`，**绝不伪造 online**。
- `transport.kind` 是 `typert`（配了 `peers`）或 `mock`（测试构造）；没配 `peers` 时为空字符串，`configured: false` 且 `reason` 说明原因。
- `source` 取 `assignment` / `transport` / `both`，说明这条记录从哪来。
- DSH 没有核心 roster 服务（[p1-transport.md](../evidence/p1-transport.md) §2.3），所以这里不调任何 `ctx.*`；节点清单由 assignment.yml 派生。
- SPEC §18 的 `mesh_list_workspaces(nodeId?)` 折进 `peers[].workspaces`，没有独立工具。

## 4. mesh_status

参数：无（空对象；传未知键会被拒）。

返回：

```text
{ plugin,
  transport: { configured, mode, kind, reason },
  assignment: { configured, file, nodes, assignments },
  board: { total, queued, dispatched, running, done, failed, expired },
  lifecycle: { state, supervisor, pid, startedAt } }
```

不发起跨机调用，所以没有传输时仍然可用——这正是它的用途：先分清「本地没配好」还是「对端不通」。它**不替代** `mesh_task_status`。

## 5. mesh_dispatch

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspaceId` | string | 是 | 目标工作区 id（assignment.yml 里的 workspaceId） |
| `objective` | string | 是 | 交给远端会话的任务目标 |
| `nodeId` | string | 否 | 显式指定节点；省略时按 assignment.yml 解析，显式优先 |
| `context` | string | 否 | 随 prompt 一起发送的上下文 |
| `acceptance` | string[] | 否 | 验收标准，作为编号列表附在 prompt 后 |
| `sessionMode` | `new` / `resume` | 否 | 默认 `new` |
| `sessionId` | string | `resume` 时必填 | 复用的会话 |
| `maxDurationMs` | number | 否 | 等待上限；默认与上限都是 `dispatchTimeoutMs`，想等更久请改配置 |
| `replyMode` | `final` / `stream` | 否 | 默认 `final`；`stream` 在 prompt 后立即返回已收到的文本 |

返回：

```text
{ ok, taskId?, state, target?: { nodeId, workspaceId }, result?, error? }
state  : done | failed | expired | running
result : { summary, sessionId?, artifacts?, pending? }
error  : { code, message, details? }
```

行为要点：

1. 六步：任务板 `create(queued)` → claim 租约 → `createSession` → `follow`（先启动 collector）→ `prompt` → 收 `turn/end`（或 `final:true` / `session/idle`）→ 写回 `done`/`failed` → 释放租约。
2. **阻塞语义**：SPEC §18 的 `{ taskId }` + `mesh_task_wait` 模型没有实现（需要持久化任务板），本工具直接返回结果。
3. `replyMode=stream`：prompt 返回后立即返回 `state: "running"`、`result.pending: true`。P2 没有后台收集器，该任务**不会自行推进**，只能靠 `mesh_task_status` 读到 `running`。
4. **不变量**：`leaseMs > dispatchTimeoutMs`，否则返回 `denied`（否则慢投递会被自己的过期租约 fence 掉）；`maxDurationMs` 被截断到 `dispatchTimeoutMs`。
5. 宿主超时 = `max(dispatchTimeoutMs + 30s, 60s)`，保证宿主取消不会早于自身截止时间。
6. **基线边界**：collector 在 `follow()` 之前启动；传输用 `onBaselineDone` 回调或 `{ type: "mesh/baseline/end" }` 事件宣告基线结束，边界前的文本与终态一律丢弃；事件带 `seq` 时只接受更大的 seq。
7. 没有传输 → `unavailable`。这是本地降级，不是远端失败。

## 6. mesh_task_status

参数：`taskId`（必填，来自 `mesh_dispatch` 的返回）。

返回 Task 信封：

```text
{ taskId, target: { nodeId, workspaceId }, objective, context?, acceptance?,
  policy: { sessionMode, sessionId?, maxDurationMs?, replyMode },
  lease: { owner, fencingToken, expiresAt },
  state, createdAt, updatedAt, result?, error? }
```

直接读进程内任务板（`TaskBoard.get`）。未知 id 抛错，由宿主转成普通工具错误。任务板在内存里，进程重启即清空。

## 7. 错误码

`code` 的取值是封闭集合：

| 码 | 来源 | 是否可重试 | 说明 |
| --- | --- | --- | --- |
| `unavailable` | 本地 | 修配置后 | 没有传输，或任务板拒绝本地写 |
| `unknown-node` | 目标 | 修 nodeId 后 | 显式 nodeId 不存在；不再伪装成 `node-offline` |
| `invalid-target` | 目标 | 修 workspace/node 后 | workspace 没有 assignment，或传输报 unknown-workspace / unknown-session |
| `denied` | 本地策略 | 视情况 | 租约冲突、session 已被占用、不变量被破坏 |
| `node-offline` | 远端 | 等节点回线 | 传输回执明确 offline |
| `timeout` | 本地/远端 | 可重试 | 等最终回复超时，或工具调用被宿主取消 |
| `grant-expired` / `scope-violation` / `tier-not-granted` | 策略 | 否 / 补授权 | SPEC §16 的词表；当前没有授权层，故不会出现 |
| `remote-failure` | 远端/未知 | 视情况 | 传输或对端失败；非 MeshError 异常保留原始 `cause`（name/message/stack）并写 `console.warn` |

## 8. 与 SPEC §18 的偏差

| SPEC §18 | 实现 | 差异 | 状态 |
| --- | --- | --- | --- |
| `mesh_list_nodes()` | `mesh_list_nodes` | 包装成 `{transport, peers, notes}`；peer 带 `online` 与 `status` 两个字段 | 有意偏离 |
| `mesh_list_workspaces(nodeId?)` | 折进 `peers[].workspaces` | 不设独立工具 | 有意折入 |
| `mesh_dispatch` → `{taskId}` | 阻塞返回 `{ok, taskId, state, target, result \| error}` | 异步模型待持久化任务板 | 有意偏离 |
| `mesh_task_status(taskId)` | 一致 | — | 对齐 |
| `mesh_task_wait` / `mesh_cancel` | 未实现 | 需要可推进的持久任务板 / 取消通道 | 待实现 |
| `mesh_lifecycle` / `mesh_plugin_*` / `mesh_call` / `mesh_grants` | 未实现 | 依赖 SPEC §14 / §15 / §16 的跨机面 | 待实现 |
| （§18 之外） | `mesh_status` | 补充总览工具，不替代 `mesh_task_status` | 有意新增 |

命名契约：工具前缀统一 `mesh_`；cordis 注册名与包名统一 `dsh-workspace-mesh`。改工具名要同时改：`src/tools/*.ts` → 本文 → `client/client.js`（设置页展示）→ `test/tools.test.ts`。
