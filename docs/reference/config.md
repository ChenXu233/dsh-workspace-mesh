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
| `transport` | `auto` / `pairing` / `loopback` | `auto` | 重启 | 传输选择，见 §3 |
| `peerBaseUrl` | string | `''` | 重启 | loopback 传输的对端基础 URL；留空 = 不启用 |
| `assignmentFile` | string | `''` | 立即 | assignment.yml 路径，相对宿主进程 cwd；留空 = 不加载 |
| `leaseMs` | 整数（毫秒） | `900000` | 立即 | 任务租约时长；必须大于 `dispatchTimeoutMs` |
| `dispatchTimeoutMs` | 整数（毫秒） | `120000` | 立即 | `mesh_dispatch` 等待最终回复的上限，同时是 `maxDurationMs` 的上限 |
| `leaseOwner` | string | `mesh-lead` | 立即 | 任务板租约归属者标识；空字符串会让 dispatch 返回 `denied` |

「重启」= 下一次插件 `apply()`，因为传输对象在 apply 里构造。整数必须是非负整数，非法值在写入时被 400 拒绝。

## 3. 传输选择

```text
transport = auto（默认）
  ├─ 探测到 remoteWebUiPairing 服务 → pairing
  ├─ 否则 peerBaseUrl 非空        → loopback
  └─ 都没有                        → 无传输
transport = pairing  → 探测不到就抛 TransportUnavailableError
transport = loopback → 只按 peerBaseUrl 判断，空则无传输
```

**没有传输不是启动失败**：`apply()` 捕获异常，记 `transportError`，插件照常加载，`mesh_*` 工具返回 `unavailable`。这是 SPEC §9.4.2 的浅依赖原则。

当前三个实现的实际状态：

| kind | 状态 | 说明 |
| --- | --- | --- |
| `mock` | 可用，仅测试 | 测试直接构造，运行期不会选中 |
| `loopback` | 桩 | 每个方法抛 `TransportUnavailableError`，真实请求形状未取证 |
| `pairing` | 桩 + 探测失效 | 探测 `listPeers` / `peers` / `listWorkspaces` 三个方法名，而该社区插件没有这些方法（[p1-transport.md](../evidence/p1-transport.md) §2.2），因此实际不会命中 |

结论：**当前没有可用的跨机传输**，`mesh_dispatch` 在真实宿主里返回 `unavailable`；下一步见 [roadmap](../explanation/roadmap.md)。

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
