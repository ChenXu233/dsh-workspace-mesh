# 参考：HTTP 路由

> **状态**：已实施
> **日期**：2026-11-01
> **读者**：改设置页、跨机传输或 `src/api/` 的人
> **上游材料**：[config.md](./config.md)、[tools.md](./tools.md)
> **口径**：依据 `src/api/*.ts`

两组路由，分界线是**谁在调用**：

| 组 | 调用者 | 挂在哪 | 认证 |
| --- | --- | --- | --- |
| 设置页路由（§1–§5） | 浏览器 | Connection 的 fence 内（与宿主 `/api/present.host` 同一席位） | 宿主 `/api` 的签名 cookie |
| 对端路由（§6–§7） | 另一台 DSH | `ctx.webServer`，**在 fence 之下** | 自己验 mesh token |

对端路由不能放进 fence：调用方手里还没有 cookie，放进去会先被 401 挡掉，握手永远走不到自己的处理器。它们因此自带校验，且只服务这两个操作面。

headless 组合没有 web server，两组都不挂载，设置页显示「路由缺失」而不是静默失败。

路由是精确路径匹配，只接受下表列出的方法。

## 1. GET /api/mesh/state

只读快照。设置页在打开、切回本页或点「立即刷新」时读它，不按定时器轮询：这一条要扇出到每个对端（读注册表 + 读它的整份会话列表），空转的轮询等于替所有人反复买单。

```text
{ ok: true, version: 1, plugin, generatedAt,
  transport: { configured, mode, kind, reason },
  assignment: { configured, file, nodes, assignments },
  config: { transportMode, assignmentFile, leaseMs, dispatchTimeoutMs, leaseOwner },
  lifecycle: { state, supervisor, pid, startedAt },
  counts: { total, queued, dispatched, running, done, failed, expired },
  peers: [ ... ], tasks: [ ... ], notes: [ ... ], configFile }
```

- `tasks` 只带最近 25 条（任务板本身无界），`objective` 截断到 160 字符。
- `peers` 与 `mesh_list_nodes` 的 peer 形状同源。
- 构建失败返回 500 + `{ ok: false, error }`。

## 2. POST /api/mesh/config

写配置补丁并应用热字段。

请求体：配置补丁对象，五个键取自 [config.md](./config.md) §2（`transport` / `assignmentFile` / `leaseMs` / `dispatchTimeoutMs` / `leaseOwner`）。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON |
| 400 | 含未知键，或值不合法（如 `transport` 不在枚举内、整数为负） |
| 400 | 补丁为空 |
| 400 | `assignmentFile` 指向的文件读不到或语法错 |
| 200 | 已落盘并应用，返回刷新后的完整 state（与 GET 同形） |

热字段（`leaseMs` / `dispatchTimeoutMs` / `leaseOwner` / `assignmentFile`）当场生效；`transport` 先落盘，下次 `apply()` 才生效。

## 3. GET /api/mesh/workspaces

本机**原生工作区**清单，给对端调用。mesh 不自造工作区 id：远端要投递时，必须用归属机注册表里的那个 id，所以由归属机自己发布。

```text
{ ok: true,
  workspaces: [ { workspaceId, title, path, sessions, sessionIds } ],
  note?: string }
```

注册表只登记**显式建进工作区**的会话：按目录创建的旧会话不在 `sessionIds` 里。所以调用方必须再拉一次 `session/list`，把剩下的会话按 `cwd` 归组（匹配已有工作区路径就并进去，否则单独成组），否则旧会话会凭空消失。

`sessions` 是数量，`sessionIds` 是**该工作区里的会话 id 列表**——工作区是一组会话，不是投递口；调用方拿这些 id 去 `session/list` 取标题与运行状态，再决定新建还是续用（`sessionMode: "resume"`）。

数据源是 host 的 `ctx.workspaceRegistry.list()`（`dsh-workspace` 提供的 cordis 服务）。组合里没有这个服务时返回空数组 + `note`，不报错。

只读：创建、改名、删除工作区仍然是人在这台机器上的本地动作。

## 4. GET /api/mesh/session

读远端会话的尾部（页面里的「会话历史」）。

```text
GET /api/mesh/session?nodeId=<peer>&sessionId=<id>&limit=50

{ ok: true, messages: [ { seq, role: "user" | "assistant", text, time? } ] }
```

数据来自对端的 `session/page`（一元方法）：先读 `session/list` 拿游标 `asOfSeq`，再用它做 `throughSeq` 读一页。**不缓存**——对端是唯一权威，页面按需重读。

| 状态码 | 条件 |
| --- | --- |
| 400 | 缺 `nodeId` 或 `sessionId` |
| 200 | 其余；读不到时 `ok: false` + `code`（`unavailable` / `unknown-session` 等） |

## 5. POST /api/mesh/dispatch

浏览器直接投递：模型走 `mesh_dispatch` 工具，人走这条。两者是**同一份代码**——路由调 `createMeshDispatchTool(runtime).execute(...)`，所以校验、租约不变量、回复聚合与错误码不会分叉。

请求体只接受下表这些键，其余字段丢弃：

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `workspaceId` | 是 | 目标工作区：对端注册表里的原生 id |
| `nodeId` | 否 | 目标节点；工作区不在本机 assignment.yml 里时**必须**给 |
| `objective` | 是 | 要在这台机器的这个工作区里做的事 |
| `nodeId` / `context` / `acceptance` / `sessionMode` / `sessionId` / `maxDurationMs` / `replyMode` | 否 | 与工具同名同义 |

返回 `mesh_dispatch` 的输出原样：`{ ok, taskId, state, target, result | error }`，HTTP 200。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON、缺 `workspaceId`/`objective`、或工具抛参数错误 |
| 200 | 其余情况；业务失败也是 200 + `ok: false` + `error.code` |

和工具一样**阻塞到最终回复**（或 `dispatchTimeoutMs`），所以一次页面请求最长约两分钟。

## 6. POST /api/mesh/handshake

对端用共享密钥换一个短期 mesh token。这是 relay 模式的入口：调用方不需要对端那个每次重启都轮换的登录 token。

请求体：

```text
{ nodeId, ts, nonce, hmac }
hmac = base64url(HMAC-SHA256(meshSecret, "mesh-handshake:<nodeId>:<ts>:<nonce>"))
```

返回 `{ ok: true, token, expiresAt }`，token 有效期 10 分钟。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON，或缺字段（`nonce` 少于 8 字符） |
| 401 | hmac 不对 / `ts` 偏离本机时钟超过 60 秒 / nonce 在窗口内重放 |
| 503 | 本机没配 `meshSecret`——没配就是不开放，不是默认放行 |

nonce 只在 60 秒窗口内记一次，同一个 nonce 第二次提交会被拒（防重放）。

## 7. POST /api/mesh/relay

对端**在本机**执行一次会话操作。凭 §6 换到的 mesh token。

```text
{ token, op, args }        op ∈ list | create | prompt | page | workspaces
```

`args` 就是 Typert 的 `payload.args`：`list` 传 `{_request:{}}`，其余传 `{request:{...}}`。返回 `{ ok: true, value }`；业务失败是 200 + `{ ok: false, code?, error }`。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON，或 `op` 不在枚举内 |
| 401 | token 缺失 / 过期 / 签名不符 |
| 503 | 本机没配 `meshSecret`，或组合里没有 `sessionController` |

这五个操作直接调 `ctx.sessionController` 的同名方法。**它拿到的是生成的 `session` 命名空间，不是内部命令控制器**，两者签名不同：

| 方法 | 签名 | 坑 |
| --- | --- | --- |
| `list` | `list(request, signal)` | 第一个参数是保留的空请求，**signal 在第二位** |
| `create` | `create(request)` | 没有 signal 参数 |
| `prompt` | `prompt(request, signal)` | 第二个参数是 signal，**不是** source；source 由它自己从 `request.requestId` 造 |
| `page` | `page(request, signal)` | — |

把 source 传进 `prompt` 的第二位，报错是 `signal.throwIfAborted is not a function`——错误发生在对端，调用方只看到一句与参数无关的话。`test/relay-route.test.ts` 用「假控制器先调 `signal.throwIfAborted()`」把这条契约钉住。

## 8. 为什么不用原生 settings 管道

原生 `settings.describe/mutate` 只投影 profile `include` 根下的条目；本插件由 profile patch `insert` 挂载，没有 namespace。另一条路 `TypertRemoteService` 也走不通：`link:` 安装的插件目录没有 `node_modules`，解析不到 `@deepseek-ai/dsh-typert-protocol`。

因此设置页自带读写面，落在插件自己的覆盖文件上。取舍见 [decisions.md](../explanation/decisions.md) D6。
