# P1 侦察：传输接缝到底走哪条路（SPEC §13 第 1 问）

> 任务：t1（scout-transport）· attempt `7e2c3e79-bc7c-4446-aa9c-e8255cf73b16`
> 范围：只做侦察，不改 `src/`，不改 `SPEC.md`。本文所有结论都带证据；未验证项逐条标注并附复现步骤。
> 侦察日期：2026-10-24

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| **(a)** 远端配对服务在 ctx 上的真实标识与方法签名 | `ctx.get('remoteWebUiPairing')` → 实例是 `RemoteWebUiPairing`，**唯一**方法 `isPairedDevice(request: IncomingMessage): boolean`。**没有** `listPeers` / `peers` / `listWorkspaces`（源码 grep 0 命中）。它是**请求鉴权谓词**，不是资源枚举 API。 |
| **(b)** 调用路径 | 四条并存，能力不重叠：①本机 ctx 服务直调（仅本机）；②社区插件的 host HTTP 路由 `/pair-remote/*`（跨机，仅 3 个端点）；③回环嵌入代理（GUI 嵌入，非 API）；④DSH 核心 Typert 跨机面（`session/*` + `workspace/follow`，**推荐落点**，见 §3.4）。**没有**一条单独覆盖五能力。 |
| **(c)** 五能力覆盖 | `/pair-remote/*` 覆盖 `listWorkspaces`+`createSession`（2/5），**不覆盖** `listNodes`、`prompt`、`follow`。 |
| **(d)** 最终结论 | **需薄适配层。** 但适配层的落点**不是**回环代理 HTTP，而是 **DSH 核心的 Typert 方法面**（`session/create`、`session/prompt`、`session/follow`、`workspace/follow`）+ `remoteAccess` 的 `mesh-peer` 白名单 policy。 |
| **(e)** 未验证项 | 12 条，见 §6。其中最关键的一条：两个社区插件**本机根本没装**，所有运行时行为均未验证。 |

**同时给 SPEC 指出两处与现实不符的地方**（仅记录，未改 SPEC.md）：

1. **SPEC §6.2 白名单里的 `workspace/list` 在 DSH 运行时中不存在**（对 `@deepseek-ai/` 全树 grep `workspace/list` → 0 命中）。工作区控制器实际导出的是 `workspace/create|delete|follow|rename|pinSession|archiveSession|insertBefore|insertSessionBefore|unarchiveSession|unpinSession|initializeDefault`，**没有 list**。远端枚举工作区只能走 `workspace/follow`（流）或 `session/list`。
2. **SPEC §9.4.2 设想的 `PairingTransport`（“探测到 `remoteWebUiPairing` 服务即用”）没有可实现的基础**——该服务只有一个 `isPairedDevice(req)` 谓词，不含任何远端资源枚举或会话投递方法。现有 `src/transport/pairing.ts:20` 里猜的三个方法名在插件源码中一个都不存在。

---

## 1. 证据基线（版本与取证方式）

| 代号 | 组件 | 版本 | 证据位置 |
|---|---|---|---|
| `RWUI` | `@linxin666/dsh-remote-web-ui`（社区：扫码配对 / 一次性令牌 / 设备凭据） | **0.4.8**（npm 发布时间 2026-10-20T01:03:56Z） | 解包于 `%LOCALAPPDATA%\Temp\mesh-recon\rwui\package`；npm 元数据 `rwui.json` |
| `RWS` | `@njjpro/dsh-remote-workspace`（社区：远端工作区联邦 + 回环嵌入代理） | **0.3.22**（npm 发布时间 2026-10-01T08:52:18Z） | 解包于 `%LOCALAPPDATA%\Temp\mesh-recon\rws\package`；npm 元数据 `rws.json` |
| `RT` | DSH 桌面运行时（`@deepseek-ai/dsh-desktop-runtime`） | **0.2.1-rc.3**（内含 `@deepseek-ai/cordis` **4.0.5**） | `D:\programming\dshdt\resources\app.asar\dsh\` |
| `CORDIS` | `@deepseek-ai/cordis` | 4.0.5 | `E:\git\dsh-workspace-mesh\node_modules\.pnpm\@deepseek-ai+cordis@4.0.5\node_modules\@deepseek-ai\cordis` |

取证方式与注意事项：

- `app.asar` 是 Electron 归档，普通 shell 看到的是**文件**（`ls` 报 “Not a directory”）。要在本会话里读它，必须用 **Electron 进程内的 `node:fs`**（`run_code` 运行时就是 Electron 进程）。裸 shell 里的 `grep -a` 扫不到归档内文件。
- 社区插件源码**不是**本机安装的（见 §6 未验证项 U1），是从 npm tarball 解包得到，路径见上表。两者都自带 `src/`（TypeScript 原始源码，非仅编译产物），因此引用行号是源码行号。
- `RWUI` 的 npm `repository` 指向 `https://github.com/zhu1090093659/dsh-web.git`；`RWS` 的 packument **无 repository 字段**（无公开仓库可交叉验证，只能以 tarball 为准）。

---

## 2. (a) 服务名与方法签名

### 2.1 官方插件发布的服务：`remoteWebUiPairing`

`RWUI/src/pairing-access.ts`（全文 37 行，逐行）：

```ts
 9 | /** Named lookup key sibling plugins pass to ctx.get. */
10 | export const REMOTE_WEB_UI_PAIRING = 'remoteWebUiPairing'
16 | export class RemoteWebUiPairing extends Service {
21 |   constructor(
22 |     ctx: Context,
23 |     private readonly check: (request: IncomingMessage) => boolean,
24 |   ) {
25 |     super(ctx, REMOTE_WEB_UI_PAIRING)
26 |   }
33 |   isPairedDevice(request: IncomingMessage): boolean {
34 |     return this.check(request)
35 |   }
36 | }
```

- **ctx 标识**：`remoteWebUiPairing`（`RWUI/src/pairing-access.ts:10`）。
- **方法签名**：**唯一一个** `isPairedDevice(request: IncomingMessage): boolean`（:33）。
- **语义**（文件头注释 :1-5）：“a live paired-device cookie is an allow path on routes that sit outside /api (and therefore outside api/gate)” —— 它是**一次 HTTP 请求是否携带活体配对 cookie 的判定器**，供别的 host 插件当“准入谓词”用。
- **类级注释 :13-15**：“Structural: consumers must not import this class, only the method shape.” —— 官方明确要求消费方**只依赖方法形状**，不得 import。

**消费方实证**（`RWS` 就是这么用的）：

```ts
// RWS/src/index.ts
 78 | function serviceFace<T>(ctx: Context, name: string): T | undefined {
 80 |     return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
117 |   const face = serviceFace<unknown>(ctx, 'remoteWebUiPairing')
118 |   return isPairingFace(face) ? face : undefined

// RWS/src/peer-remote.ts
28 | export interface PeerPairingFace {
30 |   isPairedDevice(request: IncomingMessage): boolean
31 | }
```

注意 `RWS/src/index.ts:112-115` 的注释：**“The legacy pairing service registers asynchronously, so it is read per request: a one-shot read could cache `undefined`”** —— 即便要用，也必须**每次请求现读**，不能启动时探一次就缓存。

### 2.2 被否证的假设：`listPeers` / `peers` / `listWorkspaces`

对 `RWUI/src` 与 `RWS/src` 全量 `.ts` 文件 grep `listPeers|listWorkspaces|listNodes|\bpeers\b`，命中仅剩散文与文件名（`RWS/src/peer-remote.ts:252`、`RWS/src/index.ts:61`、`RWUI/src/routes.ts:197` 等），**没有任何方法声明**。

⇒ `src/transport/pairing.ts:20` 的

```ts
const hasAny = ['listPeers', 'peers', 'listWorkspaces'].some((k) => typeof probe[k] === 'function')
```

**在 0.4.8 / 0.3.22 上永远为 `false`** ⇒ `detectPairingService()` 永远返回 `undefined` ⇒ `PairingTransport` 永远不会被选中。这不是“待实现”，而是**前提不成立**。

### 2.3 真正存在的相关 ctx 服务（DSH 核心）

用 `super(ctx, '<name>')` 扫描 `RT/@deepseek-ai` 全树（2343 个 `.js/.md/.yml`），共 **104 个**已注册服务名。与 mesh 相关的子集：

| ctx key | 定义位置 | 用途 |
|---|---|---|
| `typertGateway` | `RT/dsh-api-gateway/lib/index.js:767` | 跨机 RPC 入口：`invoke(request)` (:915)、`stream(request)` (:934) |
| `remoteAccess` | `RT/dsh-api-remote-access` | 方法级鉴权：`registerPolicy(kind, policy)`（README:31） |
| `sessionController` | `RT/dsh-api-session-controller` | 会话面：`list(request, signal)`、可选 `create({workspaceId, cwd})`（形状见 `RWS/src/peer-remote.ts:34-51`） |
| `workspaceRegistry` | `RT/dsh-workspace` | 工作区面：`list(): {id, path, title, sessionIds}[]`（形状见 `RWS/src/peer-remote.ts:54-64`） |
| `workspaceController` | `RT/dsh-api-workspace-controller` | workspace Typert 命名空间 |
| `webServer` | `RT/dsh-host-webserver` | `ctx.webServer.register(route)` 注册 host HTTP 路由 |
| `connection` | `RT/dsh-client-connection` | Peer 准入（`/connect?token=...`） |
| `tools` | `RT/dsh-tools` | 工具注册（模型可见工具面） |

**cordis 服务注册/查找 API**（团队关心的第二个未知量，一并回答）：

```ts
// CORDIS/lib/types/service.d.ts
 9 | export declare abstract class Service<out T = never> {
38 |   constructor(ctx: Context, name: string);   // 立即注册，随 fiber 卸载自动注销

// CORDIS/lib/types/reflect.d.ts
14 | get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K];
16 | get(name: string, strict?: boolean): any;   // 非类型化的服务查找
26 | set<K extends string & keyof this>(name: K, value: undefined | this[K]): void;
```

⇒ **服务发现是「按名字取实例」的 duck-typing 契约**：提供方 `super(ctx, 'name')`，消费方 `ctx.get('name')`。这正是 SPEC §9.4「运行期探测别人的服务」的机制底座，**已验证可行**——但前提是对方真的发布了有用的方法。

### 2.4 (a) 小结

| 项 | 真实值 |
|---|---|
| ctx 标识 | `remoteWebUiPairing` |
| 方法 | 仅 `isPairedDevice(req): boolean` |
| 是否含远端资源枚举 | **否** |
| 是否含会话投递 | **否** |

---

## 3. (b) 调用路径

### 3.1 路径 A —— 本机 ctx 服务直调（**仅本机**）

`RWS` 自己就是这么读本机数据的（`RWS/src/index.ts:200-205`）：

```ts
200 |     ...makePeerRemoteRoutes({
201 |       pairing,
203 |       getFeed: () => serviceFace<PeerFeedFace>(ctx, 'sessionController'),
204 |       getRegistry: () => serviceFace<PeerRegistryFace>(ctx, 'workspaceRegistry'),
205 |     }),
```

⇒ 在**同一进程内**，一个 cordis 插件可以直接 `ctx.get('sessionController')` / `ctx.get('workspaceRegistry')` 拿到工作区与会话元数据。**这是“直接调用”，但只对本机成立。**

### 3.2 路径 B —— 社区插件的 host HTTP 路由（跨机）

**归属划分**（`RWS/src/index.ts:20-23`）：

> “Routes registered here never collide with that plugin's: this package owns `/pair-remote/*`, `/api/pair/peer/*`, and the embedded-shell pair.”

**B1. `/pair-remote/*`（设备面向：配对后的对端实例来读本机）** —— `RWS/src/peer-remote.ts:278-358`

| 路由 | 方法 | 请求体 | 成功响应 | 失败码 |
|---|---|---|---|---|
| `/pair-remote/ping` | GET | — | `200 {ok:true, known:true}` (:289) | `401 {ok:false, code:'unpaired'}` |
| `/pair-remote/inventory` | GET | — | `200 {ok:true, generatedAt, sessions:[…], workspaces:[…]}` (:272) | `503 code:'feed-unavailable'` (:268)、`500 code:'inventory-failed'` (:275) |
| `/pair-remote/session` | POST | `{"workspaceId":"<id>"}`（可选，缺省则由对端用默认） | `200 {ok:true, sessionId}` (:349) | `400 'bad-payload'/'bad-workspace'`、`404 'unknown-workspace'` (:331)、`501 'create-unavailable'` (:337)、`502 'create-empty'/'create-failed'` |

**鉴权栅栏**（`RWS/src/peer-remote.ts:239-248`）：

```ts
244 | function peerFence(deps: PeerRemoteDeps, req: IncomingMessage, res: ServerResponse): boolean {
245 |   if (deps.pairing()?.isPairedDevice(req) === true) return true
246 |   writeJson(res, 401, { ok: false, code: 'unpaired' })
247 |   return false
248 | }
```

注释明确：**“loopback is NOT a bypass”** —— 回环请求也必须有活体配对凭据。

**鉴权头**（`RWS/src/peer.ts:190-196`，token 模型）：

```ts
190 |   private headers(): Record<string, string> {
194 |     ...(credential.authorization === undefined ? {} : { authorization: credential.authorization }),
195 |     ...(credential.cookieName === '' ? {} : { cookie: cookieName + '=' + credential.deviceId }),
196 |     'x-dsh-remote-device': credential.deviceId,
```

- **token 模型**：`Authorization: Bearer <peerToken>`（`RWS/src/peer.ts:154`：`authorization: 'Bearer ' + this.token`），外加 `x-dsh-remote-device: <deviceId>`。
- **legacy 模型**：`cookie: <cookieName>=<deviceId>`（cookie 名由对端 `Set-Cookie` 决定，见 `RWS/src/peer.ts:239-248`）。
- `content-type: application/json` 仅在有 body 时加（`RWS/src/peer.ts:204`）。

**B2. `/api/pair/peer/*`（回环控制面：只给本机浏览器半区用）** —— `RWS/src/peer-remote.ts:398-561`

| 路由 | 方法 | body | 作用 |
|---|---|---|---|
| `/api/pair/peer` | GET | — | 本机 peer 快照（`{configured, online, baseUrl, lastError, lastSyncAt, inventory}`） |
| `/api/pair/peer/embed-ticket` | POST | `{"sessionId":"<id>"}` | 铸造一次性 embed ticket |
| `/api/pair/peer/new-session` | POST | `{"workspaceId":"<id>"}` | 让对端建会话 + 铸 ticket |
| `/api/pair/peer/embed-log` | GET | — | 嵌入代理请求环（诊断） |
| `/api/pair/peer/open-external` | POST | `{"url":"…"}` | 交给系统浏览器打开（仅允许本代理端口） |

栅栏（`RWS/src/peer-remote.ts:399-406`）：**socket 地址与 Host 头都必须是回环**，LAN 来源即使伪造 Host 也够不到。

**B3. 官方插件 `RWUI` 自己的路由**（`RWUI/src/routes.ts:444-469`，注册于 :1170-1190）：

```
/api/pair/issue  /api/pair/accept  /api/pair/stop  /api/pair/revoke
/api/pair/heartbeat  /api/pair/status  /api/pair/events  /api/pair/lan-bind
/pair-accept（QR 链接落地页）  /pair-app（配对设备的无 cookie 应用外壳）
/pair-ping（落地页可达性信标）  /pair-app.sw.js（重开用的 service worker）
```

⇒ **`/pair-remote/*` 属于 `RWS`，不属于 `RWUI`**。SPEC §13 把两者混称为“host 控制路由”，实际是两套不同插件各自拥有的路径。

### 3.3 路径 C —— 回环嵌入代理（GUI 嵌入，不是 API）

- `RWS/src/index.ts:166-189`：`createPeerProxy({ port: value.peerEmbedPort, target: …, tickets: embedTickets })`。
- 默认端口 **43121**，仅绑 127.0.0.1（`RWS/src/index.ts:66`、:70 `DEFAULT_PEER_EMBED_PORT = 43121`）。
- 嵌入 URL 形态（`RWS/src/peer-remote.ts:449`、:499）：
  `http://127.0.0.1:43121/?dsh-remote-embed=1&dsh-remote-session=<sessionId>&embedToken=<ticket>`
- 代理把**对端的整个 Web GUI** 转发到本机回环地址。

⇒ `prompt` / `follow` 在现有社区插件里的唯一实现方式，是**在这个被代理的浏览器 GUI 里驱动对端会话**。对 agent 工具而言这是“驱动浏览器”，不是“调用 API”。

### 3.4 路径 D —— DSH 核心 Typert 跨机面（**推荐落点**）

- `ctx.typertGateway.invoke(request)`（`RT/dsh-api-gateway/lib/index.js:915`）、`ctx.typertGateway.stream(request)`（:934）。
- `request.peer` **必填**，网关不提供默认 Peer（README `dsh-api-gateway/README.md:33`；代码 `index.js:1171` `assertPeerLive(request.peer, endpoint)`）。
- 非 owner Peer 的调用会被 `ctx.remoteAccess.decide({principal, action, resources, args})` 拦截（:1175-1181；README:33）；owner 调用跳过资源解析。
- 流式方法 `@Remote({ mode: 'stream' })`，走 `ctx.typertGateway.stream()`（README:39）。
- 跨机 Peer 的准入：`GET /connect?token=…&interactions=answer|none` → 立即建一个 owner principal 的 Peer 并返回 302 + 签名的 API Cookie（`RT/dsh-client-connection/README.md:51`）。

**已验证存在的远程方法名**（从 `typert.host.js` 提取）：

- session 控制器：`session/create`、`session/prompt`、`session/follow`、`session/list`、`session/page`、`session/cancel`、`session/control`、`session/fork`、`session/rename`、`session/search` …
- workspace 控制器：`workspace/create`、`workspace/delete`、`workspace/follow`、`workspace/rename`、`workspace/pinSession`、`workspace/archiveSession`、`workspace/insertBefore`、`workspace/unarchiveSession`、`workspace/initializeDefault` …
- **`workspace/list` 不存在**（全树 grep 0 命中）。

### 3.5 (b) 小结

| 路径 | 跨机 | 覆盖能力 | 需要的鉴权 |
|---|---|---|---|
| A 本机 ctx 直调 | ❌ | 本机的 session/workspace 全量 | 无（进程内） |
| B `/pair-remote/*` | ✅ | listWorkspaces、createSession（+ ping） | `Authorization: Bearer` 或配对 cookie |
| B' `/api/pair/peer/*` | ❌（回环独占） | 控制面 / 铸票 | socket+Host 双回环 |
| C 回环嵌入代理 | ✅ | 间接：驱动对端 GUI | embedTicket |
| D Typert 跨机 | ✅ | createSession、prompt、follow、workspace/follow | Peer 准入 + `remoteAccess` policy |

**⇒ 二选一的答案是「二者皆非纯粹的直调」：本机可以直调，跨机必须走一层适配；社区插件提供的跨机端点不够用，跨机 agent 调用要落到 DSH 核心 Typert 面。**

---

## 4. (c) MeshTransport 五能力覆盖矩阵

`MeshTransport` 定义见 `src/transport/types.ts:4-12`。

| 能力 | `/pair-remote/*`（社区 HTTP） | `remoteWebUiPairing` 服务 | 本机 ctx 服务 | DSH 核心 Typert（跨机，mesh-peer policy） |
|---|---|---|---|---|
| `listNodes()` | ❌ 无。插件是**1:1 单 peer**（配置只有单个 `peerBaseUrl`，`RWS/src/index.ts:51`），`/api/pair/peer` 也只回这一个 peer 的快照 | ❌ | ❌ 无 roster 类服务 | ❌ roster 不是 DSH 概念，**必须自建** |
| `listWorkspaces(nodeId)` | ✅ `GET /pair-remote/inventory` → `workspaces[]`（`{id,title,path,sessionIds}`） | ❌ | ✅ `ctx.workspaceRegistry.list()` | ⚠️ **无 `workspace/list`**；只能 `workspace/follow`（流）或 `session/list` |
| `createSession(nodeId, workspaceId)` | ✅ `POST /pair-remote/session` → `{ok:true,sessionId}` | ❌ | ✅ `ctx.sessionController.create()`（可选方法，`RWS/src/peer-remote.ts:50`） | ✅ `session/create` |
| `prompt(nodeId, sessionId, text)` | ❌ **无此端点** | ❌ | ✅（业务方法） | ✅ `session/prompt` |
| `follow(nodeId, sessionId, onEvent)` | ❌ **无流端点**。`inventory` 是 **3 秒轮询缓存快照**（`RWS/src/peer-remote.ts:259-262`：`Date.now() - cache.at < 3_000`），不是事件流 | ❌ | ✅ | ✅ `session/follow`（流） |

**覆盖度小结**：

- 社区 HTTP 接缝：**2/5**（`listWorkspaces`、`createSession`）。
- `remoteWebUiPairing` 服务：**0/5**。
- DSH 核心 Typert 接缝：**4/5**（缺 `listNodes`，且 `listWorkspaces` 需用 `workspace/follow` 或 `session/list` 替代 `workspace/list`）。

---

## 5. (d) 结论

### 结论：**需薄适配层**

理由（逐条可追溯）：

1. **`remoteWebUiPairing` 不能作为传输接缝。** 它只有 `isPairedDevice(req)`（`RWUI/src/pairing-access.ts:33`），是一个请求准入谓词。它既不知道有哪些 peer，也不知道对端有哪些工作区，更不能投递消息。SPEC §9.4.2 的 `PairingTransport` 与 `src/transport/pairing.ts:14-22` 的探测逻辑**前提不成立**。
2. **但也不必“另起炉灶重建一套远端协议”。** DSH 核心已经把 mesh 需要的语义准备好了：`session/create`、`session/prompt`、`session/follow`、`workspace/follow` 都是现成 Typert 端点（§3.4），而且 `ctx.remoteAccess.registerPolicy(kind, policy)` 正是 SPEC §6.2 设想的“方法白名单 + 资源过滤”机制（README `dsh-api-remote-access/README.md:31`）。
3. **适配层的职责因此被压缩得很薄**，只有三件事：
   - 把 `MeshTransport` 的 5 个方法映射到 Typert 端点（`session/*`、`workspace/follow`）；
   - 为跨机 principal kind（拟 `mesh-peer`）注册白名单 policy，只放行 §6.2 那几条 action；
   - 解决 **`listNodes` 无源**的问题——DSH 没有 roster 概念，节点名册必须由本插件的广播/心跳自建（这本来就是 SPEC §6.1 的设计，不属于接缝问题）。
4. **社区插件的 `/pair-remote/*` 可以作为 P2 的“快速验证通道”**：它零依赖、鉴权头清晰（`Authorization: Bearer`）、能拿到 `workspaces` 与 `sessionId`。但它**不能**作为最终接缝，因为 `prompt`/`follow` 缺失——而这两个恰好是 P2 “Lead 能 mesh_dispatch 并拿到最终回复”（SPEC §12 P2 验收）所必需的。
5. **回环嵌入代理（路径 C）不适合做 agent 接缝**：它是把对端 GUI 整体代理到 127.0.0.1，让浏览器去驱动（`RWS/src/peer-remote.ts:449`）。agent 工具要走这条路，就得引入浏览器自动化——既重又脆，且拿不到结构化事件流。

### 落地建议（供 P2 采纳，不改 SPEC.md）

| MeshTransport 方法 | P2 实现建议 |
|---|---|
| `listNodes` | 本插件自建（DSH 无此能力）；roster 由 §6.1 的 hello/heartbeat 广播派生 |
| `listWorkspaces` | **本机**：`ctx.get('workspaceRegistry').list()`；**远端**：先试 `/pair-remote/inventory`（P2 快速通道），最终切 Typert `workspace/follow` |
| `createSession` | **远端**：`/pair-remote/session`（快速通道）→ 最终 `session/create` |
| `prompt` | **只能**走 Typert `session/prompt`（社区接缝无此能力） |
| `follow` | **只能**走 Typert `session/follow`（社区接缝无流） |

⇒ **实践含义：P2 的 mock 闭环可以先做（零风险），但真机闭环必须先解掉“跨机 Typert 调用”这一层，不能靠社区插件的 HTTP 端点糊过去。**

---

## 6. (e) 未验证项与复现步骤

> 下列条目**未经运行验证**。不得在 SPEC 或实现中当作已证事实使用。

| # | 未验证项 | 复现步骤（供人手执行） |
|---|---|---|
| **U1** | **两个社区插件本机根本没装**，因此本文所有关于它们的运行时行为都只是**源码静态分析**。本机 `%USERPROFILE%\.dsh\plugins\` 只有 `dsh-gemini-tool-schema`、`dsh-ppt`、`tool-schema-compat`；profile 的 `node_modules/@linxin666/` 只有 `dsh-client-ui-git-graph`、`dsh-client-ui-skill-explorer`、`dsh-client-ui-task-board`；无 `@njjpro` 作用域目录。 | ① 装 `@linxin666/dsh-remote-web-ui@0.4.8` + `@njjpro/dsh-remote-workspace@0.3.22` 到一个 DSH profile；② 三机配对；③ 复查 ``/.dsh/plugins/`。 |
| **U2** | 运行中的 DSH 实例 ctx 上**是否真的注册了** `remoteWebUiPairing`（本文只验证了“装了该插件就会注册”，未在本机验证“确实注册了”）。 | 在目标实例的插件里加一行 `console.log(Object.keys(ctx.get('remoteWebUiPairing') ?? {}))`，看是否只有 `isPairedDevice`。 |
| **U3** | `/pair-remote/*` 在真实对端上的实际响应（状态码、字段名）**未运行验证**。 | `curl -i -H "Authorization: Bearer <peerToken>" -H "x-dsh-remote-device: <deviceId>" http://<peer>:PORT/pair-remote/ping`；再 `GET /pair-remote/inventory`；再 `POST /pair-remote/session` 带 `{"workspaceId":"<id>"}`。 |
| **U4** | `x-dsh-remote-device` 头是否被栅栏实际校验。源码里该头由 `PeerLink` 发出（`RWS/src/peer.ts:196`），但 `peerFence` 只调 `isPairedDevice(req)`（:245）——该头更像是给**嵌入代理**命名目标设备用的（`RWS/src/index.ts:224-227`）。**谁校验、校验什么，未验证。** | 去掉该头再打 `/pair-remote/inventory`，看是否仍 200。 |
| **U5** | `/api/pair/peer/*` 的回环栅栏在**非回环来源**下确实 403。 | 从 LAN 上打 `GET /api/pair/peer`，看是否 403 `{ok:false,code:'forbidden'}`。 |
| **U6** | `ctx.typertGateway.invoke()` 能否被 **host 侧插件**以自造 `peer` 调用（正常 `peer` 由 Connection 准入产生，代码里没有公开的“造 peer”工厂）。 | 在插件里试 `ctx.typertGateway.invoke({ peer: …, endpoint: 'session/list', args: {} })`，看 `assertPeerLive` / `lookup-unavailable` 怎么报。 |
| **U7** | 非 owner principal（拟 `mesh-peer`）调用 `session/prompt` 是否真的被放行、是否真的落到对端会话。SPEC §6.2 自己标了 ⚠「非 owner Peer 的创建入口是否对外开放」这个唯一真实风险点——**本次未解**。 | 在对端 `ctx.remoteAccess.registerPolicy('mesh-peer', …)` 只放行 `session/prompt` + 资源 `session:<id>`，再从本端调。 |
| **U8** | `principal.kind` 的**取值来源**未验证：README 只说“one non-owner principal kind”，没说 kind 由谁赋予（Connection 准入时按 token 映射？）。`'mesh-peer'` 只是拟议名。 | 读 `RT/dsh-client-connection` 里 Peer 准入与 principal 构造代码，或在 `remoteAccess.decide` 处打日志打印 `principal.kind`。 |
| **U9** | 远端枚举工作区在 Typert 面上到底用 `workspace/follow`（流）还是 `session/list`（一次性）更合适——`workspace/list` 不存在是已验证事实，**替代路径未验证**。 | 在对端开 `workspace/follow` 流，看首帧是不是全量基线。 |
| **U10** | `session/follow` 的 **seq / offset 语义**（SPEC §13 第 2 条）**完全未验证**，本轮不涉及。 | 读 `RT/dsh-api-session-controller` 的 `session/follow` 实现与 `RT/dsh-session-projection`。 |
| **U11** | 同一 session 并发 prompt 的真实行为（SPEC §13 第 3 条）**未验证**。 | 同 U1 的三机环境，连发两条 prompt。 |
| **U12** | 跨版本兼容：本文的 `RWUI 0.4.8` / `RWS 0.3.22` / 运行时 `0.2.1-rc.3` 是一个**特定组合**。社区包迭代快，接口可能已变（npm 上 RWUI 已有 60 个版本，RWS 5 个）。 | 每次升级后重跑本文 §2.2 的否证 grep 与 §3.2 的路由清单核对。 |

---

## 7. 附录

### 7.1 关键证据索引（文件:行号）

**社区插件（npm 解包源码）**

- `RWUI/src/pairing-access.ts:10` — `REMOTE_WEB_UI_PAIRING = 'remoteWebUiPairing'`
- `RWUI/src/pairing-access.ts:16,25,33` — 类、注册、方法 `isPairedDevice`
- `RWUI/src/routes.ts:444-469` — `PAIR_PATHS` 官方路由表
- `RWUI/src/routes.ts:1170-1190` — 路由注册
- `RWS/src/index.ts:20-23` — 路由归属声明
- `RWS/src/index.ts:78-84,117` — `ctx.get()` 读可选服务
- `RWS/src/index.ts:200-205` — 读 `sessionController` / `workspaceRegistry`
- `RWS/src/index.ts:66,70,166` — `peerEmbedPort` / 默认 43121 / `createPeerProxy`
- `RWS/src/peer-remote.ts:28-31` — `PeerPairingFace`
- `RWS/src/peer-remote.ts:34-64` — `PeerFeedFace` / `PeerRegistryFace` 形状
- `RWS/src/peer-remote.ts:239-248` — `peerFence`（401 unpaired）
- `RWS/src/peer-remote.ts:259-262` — inventory 3 秒缓存
- `RWS/src/peer-remote.ts:281,289,294,306-307,349` — 三个远端路由
- `RWS/src/peer-remote.ts:399-406,410,423,449,458,508,520` — 回环控制面
- `RWS/src/peer.ts:9-13,144-154,190-196,204,262-275,280,315-318` — 凭据模型与请求头

**DSH 运行时（`RT`）**

- `dsh-api-gateway/lib/index.js:767` — `super(ctx, "typertGateway")`
- `dsh-api-gateway/lib/index.js:915,934` — `invoke()` / `stream()`
- `dsh-api-gateway/lib/index.js:1171,1175-1181` — peer 必填 + `remoteAccess.decide`
- `dsh-api-gateway/README.md:25,27,33,39` — Host 服务契约
- `dsh-api-remote-access/README.md:16,25,31,33` — `remoteAccess` / `registerPolicy` / `decide`
- `dsh-api-session-controller/lib/typert.host.js` — `session/*` 端点集
- `dsh-api-workspace-controller/lib/typert.host.js` — `workspace/*` 端点集（无 list）
- `dsh-client-connection/README.md:41,51` — Peer 认证与 `/connect?token=`

**cordis**

- `@deepseek-ai/cordis@4.0.5 lib/types/service.d.ts:9,38` — `Service` 基类与 `super(ctx, name)`
- `@deepseek-ai/cordis@4.0.5 lib/types/reflect.d.ts:14,16,26` — `ctx.get` / `ctx.set`

**本项目**

- `src/transport/types.ts:4-12` — `MeshTransport` 五方法
- `src/transport/pairing.ts:14-22` — 被否证的探测逻辑
- `src/transport/loopback.ts:11-25` — 尚未实现的回环传输

### 7.2 复现本文关键结论的命令

```bash
# 取社区插件源码
cd "$TEMP/mesh-recon"
curl -sS -o rwui.tgz 'https://registry.npmjs.org/@linxin666/dsh-remote-web-ui/-/dsh-remote-web-ui-0.4.8.tgz'
curl -sS -o rws.tgz  'https://registry.npmjs.org/@njjpro/dsh-remote-workspace/-/dsh-remote-workspace-0.3.22.tgz'
mkdir -p rwui rws && tar -xzf rwui.tgz -C rwui && tar -xzf rws.tgz -C rws

# 证伪 listPeers/listWorkspaces/listNodes
grep -rnE 'listPeers|listWorkspaces|listNodes' rwui/package/src rws/package/src   # → 0 命中

# 取唯一方法
grep -n 'isPairedDevice' rwui/package/src/pairing-access.ts

# 取三个远端路由
grep -n "path: '/pair-remote" rws/package/src/peer-remote.ts

# 证伪 workspace/list（须在 Electron 进程内读 app.asar）
#   遍历 app.asar/dsh/node_modules/@deepseek-ai 下所有 lib/*.js，grep "workspace/list" → 0 命中
```

### 7.3 与 SPEC 的出入清单（仅记录，未改 SPEC.md）

| SPEC 位置 | 原文要点 | 本次侦察结果 |
|---|---|---|
| §6.2 方法白名单 | `workspace/list` 列出归属机工作区 | **该方法在 DSH 运行时中不存在**（grep 0 命中）；工作区控制器无 list 端点 |
| §9.4.2 传输接缝 | `PairingTransport`：探测到 `remoteWebUiPairing` 即用 | 该服务仅 `isPairedDevice(req)`，**无**可用的远端能力；现有探测代码永远返回 undefined |
| §13 第 1 问 | host 路由能否被 agent 工具直接调用 | 路由**能**被 HTTP 直接调用，但只有 3 个端点、覆盖 2/5 能力；`prompt`/`follow` 必须走 DSH 核心 Typert 面 |
| §10 映射表 | 传输层复用 `@linxin666/dsh-remote-web-ui` 0.4.8 | 版本号与本次 npm 最新一致；补充：`/pair-remote/*` 属 `@njjpro/dsh-remote-workspace` 0.3.22，不属官方插件 |
