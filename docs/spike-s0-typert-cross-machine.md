# S0 spike：跨机 Typert 可达性实测（U6/U7/U8）

> 任务 t-S0 · 日期 2026-10-28 · 环境：本机（Windows 桌面实例）+ 云主机 A（`oh-my-dsh-pack` dev 部署，地址略）+ 云主机 B（`oh-my-dsh-pack` Docker 部署，地址略，机上零编译）
> 探针：s0-probe/（临时插件，未入 src/；两端以 dev-plugins link + profile patch insert 挂载，含 mesh_s0_probe 工具与 owner-gated GET /api/s0/run 触发器）
> 结论先行：**U6 ✅ / U7 ✅ / U8 ✅ / 跨机 ✅ —— 增量 3（TypertTransport）解锁。**

## 1. 实测结果

| 问题 | 判定 | 证据（两端一致，跨机腿复验） |
|---|---|---|
| **U6** host 侧插件能否自造 Peer 调 typertGateway.invoke | **能** | connection.createPeer({principal}) 是公开工厂（dsh-client-connection lib/index.js:753 「Create one in-process Peer owned by the Context that read this service」）；assertPeerLive 只检查 peer.signal.aborted，自造 Peer 天然存活。探针以 owner Peer 调 session/list 返回真实会话列表 |
| **U7** 非 owner principal（mesh-peer）是否被放行 | **默认拒绝，注册 policy 后放行** | 无 policy：remote access: session/list: access denied (no-allow)（decide() 对未注册 kind 返回 NO_ALLOW）。注册 remoteAccess.registerPolicy('mesh-peer', …) 后：bindings 返回 [{resource:{kind:'global'}, role:{actions:['session/list',…]}}] 即放行 |
| **U8** principal.kind 取值来源 | **创建者自定，原样到达 decide()** | createPeer({principal:{kind:'mesh-peer',label:'s0-probe'}}) 后，policy explain() 拒绝载荷里看到 {"principal":{"kind":"mesh-peer","label":"s0-probe"},"action":"session/list","resources":[{"kind":"global"}]} |
| **跨机** /connect 准入 + /api RPC 线 | **公网实测通过** | 本机→阿里云、腾讯→阿里云：GET /connect?token=…&interactions=none → 302 + 签名 cookie；携 cookie POST /api/<ns>/<method> 与 GET /api/s0/run 全部工作 |

## 2. 增量 3 的实施要点（由本次实测修正路线图假设）

1. **跨机调用线定型**：GET /connect?token=…&interactions=none 换 owner cookie → POST /api/<namespace>/<method>，信封 {"type":"client-request","rpcId","method","payload":{"args":{…}}}。session/list 的 args 需要 _request 字段（缺省报 gateway/arguments-invalid: missing "_request"）。
2. **mesh-peer policy 每节点注册一次即永久生效**（绑定在 effect 生命周期，进程重启后需重注册）。首次注册可用「先拒后学」：explain() 的拒绝文本内嵌完整 request JSON，探针即以此自举 resource 形状（{kind:"global"}）。注意：policy 是节点级状态，注册后同进程内「无 policy」对照实验不再可复现。
3. **invoke() 请求形状**：{peer, namespace:'session', method:'list', args}——不是 {endpoint}（endpoint 由 endpointOf(namespace, method) 派生）。
4. **token 每次重启轮换**；isTrusted 校验 Host 头，跨机调用要求对端 DSH_TRUSTED_HOST/DSH_PUBLIC_URL 与实际访问地址一致。
5. **宿主版本注意**：CNB :latest 镜像的 entrypoint 落后于 pack 仓库（写死 127.0.0.1、无 plan-boot）。部署侧用 bind-mount 覆盖 entrypoint.sh/bootstrap/scripts/plans 四目录解决；长期应推 tag 重建镜像。

## 3. 探针清理

s0-probe/ 仅存在于仓库工作区与两台服务器的 /srv/dev-plugins/，未编译进任何发布物。增量 3 落地后：删除两台服务器 dev-plugins 下的 dsh-s0-probe/ 目录、从两端 profile patch 的 insert 列表移除 - id: s0 条目、删除仓库 s0-probe/ 目录。
