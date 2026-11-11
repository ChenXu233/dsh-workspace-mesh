# 参考：HTTP 路由

> **状态**：已实施
> **日期**：2026-11-01
> **读者**：改设置页、跨机传输或 `src/api/` 的人
> **上游材料**：[config.md](./config.md)、[tools.md](./tools.md)
> **口径**：依据 `src/api/*.ts`

两组路由，分界线是**谁在调用**：

| 组 | 调用者 | 挂在哪 | 认证 |
| --- | --- | --- | --- |
| 页面路由（§1–§11） | 浏览器 | Connection 的 fence 内（与宿主 `/api/present.host` 同一席位） | 宿主 `/api` 的签名 cookie |
| 对端路由（§12–§15） | 另一台 DSH | `ctx.webServer`，**在 fence 之下** | 自己验 mesh token |

对端路由不能放进 fence：调用方手里还没有 cookie，放进去会先被 401 挡掉，握手永远走不到自己的处理器。它们因此自带校验，且只服务握手、中继与流中继三个操作面；没配 `meshSecret` 时这三条路由仍然挂着，只是拒绝并说明原因（配对可以在运行期补上首个密钥）。

headless 组合没有 web server，两组都不挂载，设置页显示「路由缺失」而不是静默失败。

路由是精确路径匹配，只接受下表列出的方法。

## 目录

- 1. GET /api/mesh/state
- 2. POST /api/mesh/config
- 3. GET /api/mesh/workspaces
- 4. GET /api/mesh/session
- 5. POST /api/mesh/dispatch
- 6. GET /api/mesh/session/events
- 7. POST /api/mesh/session/open
- 8. POST /api/mesh/session/prompt
- 9. GET /api/mesh/session/live
- 10. GET /api/mesh/session/live/stream
- 11. GET /api/mesh/pair-link 与 POST /api/mesh/pair
- 12. POST /api/mesh/remote
- 13. POST /api/mesh/handshake
- 14. POST /api/mesh/relay
- 15. 汇点（hub）路由
- 16. 为什么不用原生 settings 管道

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

## 6. GET /api/mesh/session/events

读远端会话的**原始事件**（一页），给会话页装配用。

```text
GET /api/mesh/session/events?nodeId=<peer>&sessionId=<id>&throughSeq=&beforeSeq=&maxMessages=200

{ ok: true, events: [ { seq, type, time, data, ... } ], hasMore, endSeq, running }
```

事件原样来自对端的 `session/page`（写入时已校验无损 JSON），不裁剪、不翻译：页面用官方会话装配器按同一套规则渲染，少一个字段就可能让整类节点静默消失。`throughSeq` 省略表示对端当前日志末端，`beforeSeq` 用于向前翻页，`hasMore` 只表示「更旧还有」，`running` 来自对端的会话状态。

| 状态码 | 条件 |
| --- | --- |
| 400 | 缺 `nodeId` 或 `sessionId` |
| 200 | 其余；读不到时 `ok: false` + `code`（`unavailable` / `unknown-session` 等） |

## 7. POST /api/mesh/session/open

在对端那个工作区里开一个会话（工作区必须是对端注册表里的 id）。

```text
{ nodeId, workspaceId } → { ok: true, nodeId, workspaceId, sessionId }
```

会话在对端跑：本机不建目录、不写日志，也不持有它的运行时。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON、缺 `nodeId`/`workspaceId` |
| 200 | 其余；对端拒绝也是 200 + `ok: false` + `code` |

## 8. POST /api/mesh/session/prompt

往对端的那个会话里发一条消息。

```text
{ nodeId, sessionId, text } → { ok: true }
```

走对端的 `session/prompt`（`mode: queue`）：排队语义由对端决定，本机只负责把字送过去。回复不在这条请求里——页面轮询 §6 的事件。

| 状态码 | 条件 |
| --- | --- |
| 400 | 请求体不是 JSON、缺字段或 `text` 为空 |
| 200 | 其余；对端拒绝也是 200 + `ok: false` + `code` |

## 9. GET /api/mesh/session/live

读对端**当前正在写的回答**留下的实时帧。

```text
GET /api/mesh/session/live?nodeId=<peer>&sessionId=<id>&since=<revision>

{ ok: true, revision, frames: [ { type: "start" | "chunk" | "end", ... } ] }
```

耐久事件只在回合结束时落一条消息，直接读日志看到的是「整段出现」。写的过程中，对端的 agent 发的是稠密的过程帧（`agent/assistant-stream`）：`start` 带 attempt/turn/step，`chunk` 带一个 LLM 原始 chunk 与自增序号，`end` 带结算去向。对端插件把这些帧按会话滚动保留，页面用 `since`（已折叠到的 revision）拿增量，再按对端浏览器的同一条规则折成 `assistant/live-chunk` 行。

`nodeId` 在内网关上出现时表示「这个会话在别处」，路由转给传输层；不带 `nodeId` 时用本机保留的帧回答（对端就是这样被读到的）。

| 状态码 | 条件 |
| --- | --- |
| 400 | 缺 `sessionId` |
| 200 | 其余；对端没有保留帧（旧版本、无 agent 的组合）时 `ok: false` + `code: unavailable` |

帧**不是**耐久日志的一部分：丢掉它们只是退化成整段显示，不会让页面缺内容。

## 10. GET /api/mesh/session/live/stream

同一个实时帧，改成一**条常开的响应**（`text/event-stream`）。

```text
GET /api/mesh/session/live/stream?nodeId=<peer>&sessionId=<id>&since=<revision>

data: { "type": "frames", "revision": 12, "frames": [ ... ] }
data: { "type": "ping" }
```

先补发 `since` 之后已有的帧，之后每批新帧到一条事件；15s 一条 `ping` 保活。浏览器断开时 `request.signal` 触发，订阅随之释放。页面优先用它：轮询的步长就是回答的颗粒度，常开响应把每个 chunk 直接送到。

| 状态码 | 条件 |
| --- | --- |
| 400 | 缺 `sessionId` |
| 200 | 其余；对端不支持时 `ok: false` + `code: unavailable`（页面退回 §9 轮询） |

## 11. GET /api/mesh/pair-link 与 POST /api/mesh/pair

一键配对：这台机器发一张「名片」，另一台机器打开它就多出一个对端。

```text
GET  /api/mesh/pair-address
  → { ok, url, source, candidates }
GET  /api/mesh/pair-link?nodeId=<对方怎么称呼这台机器>&url=<可选，覆盖地址>
  → { ok, nodeId, url, source, secret, token, link }
POST /api/mesh/pair   { token } 或 { link }
  → { ok, peers, peer }
```

链接形如 `<本机地址>/#mesh-pair=<base64url JSON>`，负载是 `{ v: 1, nodeId, url, secret }`。负载放在 `#` 后面而不是查询串：Web UI 对 `/?token=` 会 302 到 `/`，查询串被丢掉，片段会跟着走。在对方机器上打开链接，前端把负载 POST 回来，对端就写进自己的 `peers`（`secret` 是这一对端专用的），随后重建传输、立即生效。

生成这一侧如果还没有 `meshSecret`，会当场生成并落盘——否则发出去的名片在对方那儿验不过。

地址按「谁最先说清」的顺序取：配置里的 `publicUrl` → 环境变量 `DSH_PUBLIC_URL` → 浏览器访问这个页面的 origin（仅当它不是回环地址）→ 本机网卡 IPv4。`pair-address` 提前把这套判断的结果和候选都交给面板，操作者可以改；`pair-link?url=` 就是用改过的地址生成，非法地址直接 400 而不是悄悄退回猜测值。

| 状态码 | 条件 |
| --- | --- |
| 400 | 生成时推断不出本机地址；导入时负载不是 JSON、版本不认识、`url` 不是 http(s)、缺 `nodeId` 或 `secret` |
| 200 | 其余；导入成功返回落盘后的完整 `peers` 与新增的那条 |

配对是**单向**的：要让两台机器互相调用，两边各生成一张、各导入一次。

## 12. POST /api/mesh/remote

浏览器替用户管理**对端**的工作区：列那台机器的目录，或在那台机器上登记一条 Workspace。设置页路由里只有它作用在别的机器上，所以它用 `meshSecret` 换来的 mesh token，而不是本页的登录 cookie。请求体：

```text
{ op: 'browse' | 'mkdir' | 'workspace-create', nodeId, path, title?, name? }
```

`browse` 只回答目录名与绝对路径，不返回文件内容；`path` 为空表示从那台机器的主目录开始。答案的形状就是官方目录对话框要的：`path`、`home`、`crumbs`（根到当前目录每一跳）、`entries`（只列目录，带 `hidden`）、`truncated`。`mkdir` 在 `path` 下建一个名为 `name` 的文件夹（`name` 只能是单段路径，不能含分隔符），返回 `{ path }`。`workspace-create` 直接调对端的 `workspaceRegistry.create(path, title)`，所以工作区真的出现在那台机器上，本机不建目录、不登记记录。

透传层是 `MeshTransport.control`（可缺省）：没有这条能力的传输回答 503，而不是伪造一个空列表。对端把它落到 relay 的 `browse` / `workspace-create` 两个 op。

返回 `{ ok: true, value }`（`value` 是对端的原样答案）或 `{ ok: false, code, error }`，HTTP 200。

| 状态码 | 条件 |
| --- | --- |
| 405 | 方法不是 POST |
| 400 | 请求体不是 JSON、缺 `nodeId`/`op`、`op` 不在枚举内、`workspace-create` 的 `path` 不是绝对路径 |
| 503 | 传输没有 `control` 能力，或对端组合里没有 `workspaceRegistry` |
| 200 | 其余情况；对端拒绝也是 200 + `ok: false` |
## 13. POST /api/mesh/handshake

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

## 14. POST /api/mesh/relay

对端**在本机**执行一次会话操作。凭 §7 换到的 mesh token。

```text
{ token, op, args }        op ∈ list | create | prompt | page | workspaces | browse | workspace-create | assistant-live
```

同一套凭据还有 `POST /api/mesh/relay/stream`：请求体 `{ token, op: 'assistant-live', args: { sessionId, since } }`，返回与 §10 同形的常开事件流（不走浏览器 fence，token 在体内自证）。

`args` 就是 Typert 的 `payload.args`：`list` 传 `{_request:{}}`，其余传 `{request:{...}}`；`assistant-live` 传 `{ sessionId, since }`，返回 `{ revision, frames }`（与 §9 同形，供页面在 relay 模式下读实时帧）。返回 `{ ok: true, value }`；业务失败是 200 + `{ ok: false, code?, error }`。

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

## 15. 汇点（hub）路由

一台有公网的机器当汇点：它保存节点目录，并替没有入站端口的节点缓冲请求。鉴权与 relay 相同——用汇点 `meshSecret` 签发的 mesh token。

```text
POST /api/mesh/hub/join          { token, nodeId, url? }
  → { ok, node, peers, revision }
GET  /api/mesh/hub/nodes?token=
  → { ok, nodes, revision }
GET  /api/mesh/hub/inbox?token=&nodeId=&wait=
  → { ok, job|null, nodes, revision }
POST /api/mesh/hub/result        { token, id, status, headers?, body? }
  → { ok, delivered }
POST /api/mesh/hub/forward?nodeId=  { token, method, path, headers?, body?, timeoutMs? }
  → { ok, result: { status, headers, body } }
```

`inbox` 是长轮询：没有请求时挂住最多 25 秒（`wait` 更小则以它为准），回答里同时带上当前目录，因此新节点是被「已经在跑的那次轮询」告知的，汇点不需要反向拨号。`forward` 把整个请求缓冲进目标节点的队列，等它执行完回填；超时以 504 回答。

汇点不执行任何东西，也不读对端的会话数据：它只搬一进一出两个 HTTP 包。

传输层对 `via: 'hub'` 的对端就是这样走的：把原本要发给对端的请求包成 `{ method, path, headers, body }` 交给 `forward`，再把 `result` 解回一个普通 `Response`。因此这类对端只能用 relay 模式（凭 `secret` 签 mesh token，不需要登录 token），SSE 流式接口会明确报错而不是挂住。

浏览器侧另有一对（在 fence 内）：

```text
GET  /api/mesh/hub-link   → { ok, url, nodeId, link }
POST /api/mesh/hub-adopt  { token } 或 { link }
  → { ok, hub, secret }
```

`hub-link` 生成 `#mesh-hub=<base64url {v,url,secret,nodeId}>`：加入方打开它，页面把负载 POST 回 `hub-adopt`，本机写入 `hub` 与共享密钥并起 agent，不需要重启。

## 16. 为什么不用原生 settings 管道

原生 `settings.describe/mutate` 只投影 profile `include` 根下的条目；本插件由 profile patch `insert` 挂载，没有 namespace。另一条路 `TypertRemoteService` 也走不通：`link:` 安装的插件目录没有 `node_modules`，解析不到 `@deepseek-ai/dsh-typert-protocol`。

因此设置页自带读写面，落在插件自己的覆盖文件上。取舍见 [decisions.md](../explanation/decisions.md) D6。