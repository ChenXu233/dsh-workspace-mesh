# 参考：设置页 HTTP 路由

> **状态**：已实施
> **日期**：2026-11-01
> **读者**：改设置页或 `src/api/` 的人
> **上游材料**：[config.md](./config.md)、[tools.md](./tools.md)
> **口径**：依据 `src/api/*.ts`

两条路由注册在 Connection 的 fence 内（与宿主自带的 `/api/present.host` 同一席位），鉴权面与宿主 `/api` 一致。headless 组合没有 web server，路由不挂载，设置页会显示「路由缺失」而不是静默失败。

路由是精确路径匹配，只接受下表列出的方法。

## 1. GET /api/mesh/state

只读快照，设置页轮询它。

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

## 3. 为什么不用原生 settings 管道

原生 `settings.describe/mutate` 只投影 profile `include` 根下的条目；本插件由 profile patch `insert` 挂载，没有 namespace。另一条路 `TypertRemoteService` 也走不通：`link:` 安装的插件目录没有 `node_modules`，解析不到 `@deepseek-ai/dsh-typert-protocol`。

因此设置页自带读写面，落在插件自己的覆盖文件上。取舍见 [decisions.md](../explanation/decisions.md) D6。
