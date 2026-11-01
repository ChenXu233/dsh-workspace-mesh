# 参考：配置

> **状态**：已实施
> **日期**：2026-11-01
> **读者**：改配置字段的人；排查「改了配置没生效」的人
> **上游材料**：[tools.md](./tools.md)、[http-api.md](./http-api.md)、[SPEC.md](../../SPEC.md) §5.4
> **口径**：依据 `src/config.ts`、`src/config/store.ts`、`src/api/config.ts`、`src/index.ts`

## 1. 配置来源与优先级

两层，后者覆盖前者，字段级合并：

```text
cordis 条目 config（部署者的 profile patch）
  ↑ 覆盖
$DSH_HOME/mesh-config.json（设置页 POST 写入的补丁）
```

覆盖文件里的字段优先；没写的字段保留条目配置的值。

## 2. 字段

| 字段 | 类型 | 默认 | 生效时机 | 说明 |
| --- | --- | --- | --- | --- |
| `transport` | `auto` | `auto` | 重启 | 传输选择，见 §3；目前只有 `auto` |
| `peers` | 数组 `{ nodeId, baseUrl, token }` | `[]` | 重启 | 跨机传输的对端；空 = 不启用传输，见 §3 |
| `assignmentFile` | string | `''` | 立即 | assignment.yml 路径，相对宿主进程 cwd；留空 = 不加载 |
| `leaseMs` | 整数（毫秒） | `900000` | 立即 | 任务租约时长；必须大于 `dispatchTimeoutMs` |
| `dispatchTimeoutMs` | 整数（毫秒） | `120000` | 立即 | `mesh_dispatch` 等待最终回复的上限，同时是 `maxDurationMs` 的上限 |
| `leaseOwner` | string | `mesh-lead` | 立即 | 任务板租约归属者标识；空字符串会让 dispatch 返回 `denied` |

「重启」= 下一次插件 `apply()`，因为传输对象在 apply 里构造。整数必须是非负整数，非法值在写入时被 400 拒绝。

## 3. 传输

配了 `peers` 就启用 **TypertTransport**（`kind: 'typert'`），走对端自己的 web API：

```text
GET  /connect?token=<对端 token>&interactions=none    → 302 + 签名 cookie
POST /api/<namespace>/<method>  {type:'client-request', rpcId, method, payload:{args}}
```

只用到一元方法：`session/list`、`session/create`、`session/prompt`、`session/page`。
`session/follow` 是 stream-carrier 方法（"must be opened through the stream carrier"），所以 `follow()` 用**轮询**实现：`session/list` 取游标、`session/page` 取事件，延迟等于 `pollMs`（默认 1000ms）。事件形状与真流一致，reply 聚合逻辑不变。

**对端 token 每次重启轮换**：`mesh-config.json` 里的 `token` 要跟着更新，失效时工具报 `denied` 并提示刷新。真正的凭据层在 SPEC §17，尚未实现。

**失败冷却**：同一个 peer 连续失败 2 次后进入 60 秒冷却（`failureCooldownMs`），期间不再发请求。这不是性能优化——页面每几秒轮询一次，没有冷却时一个过期 token 会变成持续的 401 流，足以触发对端的入侵过滤（fail2ban 一类）把本机 IP 封掉。

**没有传输不是启动失败**（SPEC §9.4.2）：没配 `peers` 时插件照常加载，`mesh_status.transport.reason` 说明原因，`mesh_dispatch` 返回 `unavailable`，其余三个工具照常可用。

| kind | 何时 | 说明 |
| --- | --- | --- |
| `typert` | 配了 `peers` | 跨机真传输 |
| `mock` | 测试构造 | 运行期不会选中 |

对端会发布自己的原生工作区（`GET /api/mesh/workspaces`），投递时优先用那个原生 id，`cwd` 只是对端读不到注册表时的回退。要让某个 workspaceId 走回退路径，assignment 的每条路由要有 `cwd`：

```yaml
assignments:
  - { workspaceId: ws-blog, nodeId: tencent, cwd: /data/workspace }
```

没有 `cwd` 的 workspace 只能本地使用；跨机 dispatch 会报 `invalid-target`。

## 4. 三个文件的归属

| 文件 | 谁写 | 作用 |
| --- | --- | --- |
| 仓库 `cordis.patch.yml` | 维护者 | 故意是 `[]`：插件由部署者的 profile patch `insert` 挂载 |
| profile patch（部署者机器） | 部署者 | 唯一地址化的条目，带 `config` |
| `$DSH_HOME/mesh-config.json` | 设置页 | 浏览器可写的覆盖层 |

覆盖文件存在的原因只有一条：profile-patch 挂载的条目不会被原生 settings 文档投影，原生配置管道改不了它。完整理由见 [decisions.md](../explanation/decisions.md) D6。

## 5. 不变量

- `leaseMs > dispatchTimeoutMs`：否则 `mesh_dispatch` 返回 `denied`。慢投递会被自己的过期租约 fence 掉，所以这条不变量在运行时检查。
- `assignmentFile` 是配置，不是可选依赖：路径读不到或语法错时**加载期就抛错**（带文件与行号），不会静默降级。
- `leaseOwner` 不能为空。
- 凭据不进配置：`env` 类字段不允许出现密钥名（SPEC §8、§15.1）。

## 6. 加一个配置字段要改哪些地方

1. `scripts/gen-config-schema.mjs`（schema 单一来源）
2. `pnpm gen:schema` → 生成 `src/config-envelope.gen.ts`
3. `src/config.ts`（类型 + 校验 + 表单提示）
4. `src/config/store.ts`（白名单校验 / 落盘）
5. `src/api/config.ts`（热字段还是重启字段）
6. `client/client.js`（表单控件）
7. 本文 §2 与测试
