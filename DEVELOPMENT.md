# 开发指南（dsh-workspace-mesh）

这份文档说清三件事：**我们自己的开发怎么走**、别人想用同一套方式要准备什么、以及还有哪些别的开发方式。

## 0. 三种方式

| 方式 | 谁用 | 需要什么 | 每轮迭代 |
|---|---|---|---|
| **A. pack 云端 dev 链路（我们自己的做法）** | 维护者，以及有自己服务器的贡献者 | 你自己的开发服务器 + oh-my-dsh-pack 的开发覆盖层 | `pnpm verify` + 一条同步脚本 + 容器重启 |
| B. 本地安装（`link:` / `file:`） | 只改浏览器半侧、或本机调试 | 本地 dsh ≥ 0.2.1-rc.2 | `pnpm build` + 重启本地 dsh |
| C. 发布物安装 | 使用者 / 别的项目 | `dsh plugin add dsh-workspace-mesh` | 发版本 |

## 1. 我们的开发方式：pack 云端 dev 链路

**声明**：这条链路跑在**维护者自己的**开发服务器上（本机 `~/.ssh/config` 里的 `dsh-server` 别名，
地址只存在那台机器上，不进仓库）。它不是共享实例 —— 别人的服务器、环境、数据卷与它是分开的；
别人要用同一种方式，按 §2 配自己的服务器，或者直接走 §3 的本地开发。

**这套方法需要先配置**；配置过一次之后，日常迭代就是一条命令（§1.2）。

### 1.1 一次性配置（在自己的机器上）

1. 服务器按 oh-my-dsh-pack 标准部署一次（tag 镜像 + `docker compose up -d`）。
2. 启用开发覆盖层：`.env` 里 `DSH_DEV_PLUGINS=/srv/dev-plugins`，启动命令带
   `-f docker-compose.yml -f docker-compose.dev.yml`。
3. 容器把宿主 `/srv/dev-plugins` 挂成 `/opt/dev-plugins`（只读），每次启动跑
   `bootstrap-dev/20-link-plugins.sh`：对每个子目录执行
   `dsh plugin --profile web add link:/opt/dev-plugins/<插件>`。
   目录约定是**一个插件一个子目录**（`/srv/dev-plugins/dsh-workspace-mesh/`）。
4. 本机 ssh config 配一个别名；仓库里不要写地址。

### 1.2 每轮迭代

```pwsh
pnpm verify
pwsh <pack>/scripts/sync-plugin.ps1 -Plugin dsh-workspace-mesh
```

脚本做三件事：build → scp（`lib/`、`package.json`、`cordis.patch.yml`、`client/client.js`，
按相对路径落盘）→ `docker compose up -d` + `restart dsh`。
`-SshHost <别名>` 换机器，`-SkipBuild` 跳过构建。

### 1.3 怎么确认这次真的生效了

- 容器日志 `[dev] linked: dsh-workspace-mesh`
- `[mesh] registered mesh_list_nodes / mesh_status / mesh_dispatch / mesh_task_status`
- `[mesh] settings page route mounted at /api/mesh/state`（带设置页的版本才有）
- 浏览器打开日志末尾的 `?token=` 地址 → 设置 → 「工作区网格」

### 1.4 这条链路特有的坑

- **只改 `client/client.js` 也要重启容器**：client bundle 的 `rev` 在 `dsh plugin add` 时才重算，
  不重启页面还是旧代码。
- `client.js` 语法错 = 整个插件不注册（插件页显示"1 异常"）：提交前 `node --check client/client.js`。
- 日志里 `[mesh] disposed` 是旧进程退出，别把它当成本次启动失败。
- 本插件由 profile patch `insert` 挂载（仓库里的 `cordis.patch.yml` 故意是 `[]`），
  所以原生 settings 文档里没有它的命名空间（见 §4）。

## 2. 别人要用同一种方式

一句话：**自备一台开发服务器（或走 §3 本地），按 §1.1 配一次，之后同样用 `sync-plugin.ps1`。**

- 仓库不提供共享环境，也不记录任何机器地址；
- `DSH_DEV_PLUGINS` 目录、`dsh-home` / `dsh-workspace` 卷、反代与 token 都各自独立；
- 同步目标由 `-SshHost` 或你自己的 ssh 别名决定，默认值只是维护者本机的别名。

## 3. 本地开发（不需要服务器）

```sh
pnpm install && pnpm build
dsh plugin --profile web add file:$(pwd)     # 或 link:
dsh --profile web --no-open
```

浏览器半侧和 `/api/mesh/*` 在本机实例上同样可用，适合先验证页面。

## 4. 设置页与配置写入（实现约束，改之前先看）

- 页面注册在 `settings.section`（导航项 id `mesh`）；插件详情页另有 `plugins.detail.section` 的配置卡。
- 数据与写入走 `ctx.connection.fetch`：`GET /api/mesh/state`、`POST /api/mesh/config`。
  两条路被排除的原因：
  - 原生 `settings.describe/mutate` 只投影 profile `include` 根下的条目，profile-patch 插入的条目没有 namespace；
  - `link:` 安装的插件目录没有 `node_modules`，`TypertRemoteService` 需要的
    `@deepseek-ai/dsh-typert-protocol` 解析不到。
- 配置写 `$DSH_HOME/mesh-config.json`，`apply()` 时盖在 cordis 条目配置之上。
  `leaseMs` / `dispatchTimeoutMs` / `leaseOwner` / `assignmentFile` 立即生效；
  `transport` / `peerBaseUrl` 重启后生效。
- 加一个配置字段要同时改：`src/config.ts`（schema）→ `pnpm gen:schema`（生成
  `src/config-envelope.gen.ts`）→ `src/config/store.ts`（校验/落盘）→ `client/client.js`（表单）→ 测试。

## 5. 测试与审计

- `pnpm verify` = build + typecheck + `node:test`（当前 83 个）。
- 新增 `node:xxx` 导入要同步更新 `test/tools.test.ts` 里的零依赖审计允许列表；
  新增 `package.json` 依赖会直接让审计失败（本插件坚持零运行时依赖）。
- 路由 / 存储这类宿主逻辑必须有单测；客户端 bundle 提交前 `node --check client/client.js`。
