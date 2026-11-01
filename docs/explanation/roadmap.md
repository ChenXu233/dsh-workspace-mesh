# 路线图

> **状态**：现行
> **日期**：2026-11-01
> **读者**：决定下一步做什么的人
> **上游材料**：[SPEC.md](../../SPEC.md)（设计意图）、[evidence/](../evidence/README.md)（取证）、[reference/tools.md](../reference/tools.md)（当前实现）
> **口径**：只写「做什么」与「怎么判定做完」；进度看代码，不写在文档里

## 0. 一句话

零件齐了，缺一条能用的传输。下一步是把 `TypertTransport` 接上，让 `mesh_dispatch` 真的跨机跑通。

## 1. 已落地

判据是代码路径与测试，不是日期。

| 能力 | 落地位置 | 判据 |
| --- | --- | --- |
| 4 个模型工具 | `src/tools/` | `test/tools.test.ts` 断言注册形状与入参校验 |
| 任务板 + 租约 + fencing | `src/board/` | `test/board.test.ts` |
| roster 派生（assignment + 传输回执） | `src/roster/` | `test/state.test.ts` |
| `assignment.yml` 解析 | `src/assignments/` | `test/config.test.ts` |
| 设置页 + 两条 HTTP 路由 | `src/api/`、`client/client.js` | `test/config-route.test.ts`、`test/state.test.ts` |
| 配置分层与热更新 | `src/config*.ts` | `test/config.test.ts` |
| 传输接缝 + mock 适配器 | `src/transport/` | `test/transport.test.ts`；`pairing` / `loopback` 已删除（[decisions](decisions.md) D12） |
| 跨机传输 TypertTransport | `src/transport/typert.ts` | `test/typert.test.ts`；阿里云 → 腾讯云实测 `mesh_dispatch` 拿到真实回复（4.4s） |
| 模型可见的工具面（真机） | — | 云端实例里模型调用 `mesh_list_nodes`，返回 `transport.kind = "typert"` |
| 浏览器直发 + 侧栏「工作区网格」面板 | `src/api/dispatch.ts`、`client/client.js` | `test/dispatch-route.test.ts`；页面上给 ws-blog 发消息拿到「收到」 |
| 自重启控制器 | `src/lifecycle/` | `test/lifecycle.test.ts`（未接线：默认不启用） |
| 身份原语（epoch key / token / 防重放） | `src/identity/` | `test/identity.test.ts`（纯函数库，未接请求路径） |

## 2. 下一步

### 增量 1（提案，未批准）：消息总线平面

依据 [p3-bus-plane.md](../evidence/p3-bus-plane.md)：给插件用的跨节点原语，只传指针不传内容，topic 首段由 mesh 校验。

尚未决定：第四平面是否成立（a2）、传输落点用原生 publish/subscribe 还是先组合现有五方法（a9）。跨机传输已可用，前置解除。

## 3. 风险

| # | 风险 | 触发条件 | 卡住什么 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 工具注册 API 随 DSH 升级漂移（rc 通道可能 breaking） | DSH 升级后插件挂载失败或工具消失 | 全部工具面 | 零依赖手写 definition，依赖面只有 `ctx.tools.register` 与 `output` 形状；`dsh.engines` 钉版本；升级后先用「故意非法注册」反证链路 |
| R2 | 跨机调用的信任头不匹配 | 对端 `DSH_TRUSTED_HOST` / `DSH_PUBLIC_URL` 与实际访问地址不一致 | 跨机 dispatch | 部署时把两者对齐；`/connect` token 每次重启轮换，配置里的 `peers[].token` 要同步更新（[decisions](decisions.md) D13） |
| R3 | 两端 DSH 版本组合未验证 | 节点版本不一致 | 跨机 dispatch | 先用同版本验证（已用 0.2.1-rc.4 ↔ rc.4 跑通），再逐台升 |
| R4 | 断线重连的 offset 语义未定（SPEC §7.2） | 想要 `stream` 或异步模型 | 推进语义 | 先按「替换 baseline + seq 单调」实现（typert 已按此做），真机观察后再定 |

## 4. 不做（近期不碰）

| SPEC 章节 | 不做 | 理由 |
| --- | --- | --- |
| §14 生命周期远控 | `mesh_lifecycle`、`lifecycle/*` 端点 | 控制器已就位但没接线；远端重启需要跨机面先成立 |
| §15 插件供给 | `mesh_plugin_ensure` / `mesh_plugin_drift` | 依赖 plugin-manager 跨机面 + 生命周期重启，两级前置都不存在 |
| §16 授权矩阵 | `grants.yml`、T1–T3 分级、TTL/吊销广播 | 矩阵是 remoteAccess 的声明式前端；近期只做最小 `mesh-peer` policy |
| §17 密钥三层 | X25519 / mTLS / 动态密码接线 | 通道先于密码学；`identity` 目前只是纯函数库 |
| §9.3 调度子插件 | 全部 | 没有 hub、没有未分组工作区的自动发现，调度器无输入 |
| §18 的 `mesh_call` / `mesh_grant*` / `mesh_plugin_*` / `mesh_lifecycle` | 这些工具 | 随 §14/§15/§16 一起推迟 |
| SPEC §7.2 真实 offset 语义 | 断线重连增量去重 | 见 R4；v1 用 session 级互斥 + final 聚合规避 |
