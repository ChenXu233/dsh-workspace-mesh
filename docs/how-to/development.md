# 开发指南

> **状态**：现行
> **日期**：2026-11-01
> **读者**：维护者与贡献者
> **上游材料**：[reference/config.md](../reference/config.md)（字段与不变量）、[AGENTS.md](../../AGENTS.md)（命令与禁令）
> **口径**：描述 HEAD 的开发链路；数字见 [reference/baselines.md](../reference/baselines.md)

这份文档说清三件事：**我们自己的开发怎么走**、别人想用同一套方式要准备什么、以及还有哪些别的开发方式。

## 0. 三种方式

| 方式 | 谁用 | 需要什么 | 每轮迭代 |
| --- | --- | --- | --- |
| **A. pack 云端 dev 链路（我们自己的做法）** | 维护者，以及有自己服务器的贡献者 | 自己的开发服务器 + oh-my-dsh-pack 的开发覆盖层 | `pnpm verify` + 一条同步脚本 + 容器重启 |
| B. 本地安装（`link:` / `file:`） | 只改浏览器半侧、或本机调试 | 本地 dsh ≥ 0.2.1-rc.2 | `pnpm build` + 重启本地 dsh |
| C. 发布物安装 | 使用者 / 别的项目 | `dsh plugin add dsh-workspace-mesh` | 发版本 |

## 1. 我们的开发方式：pack 云端 dev 链路

**声明**：这条链路跑在**维护者自己的**开发服务器上（本机 ssh config 里的别名，地址只存在那台机器上，不进仓库）。它不是共享实例——别人的服务器、环境、数据卷与它是分开的；别人要用同一种方式，按 §2 配自己的服务器，或者直接走 §3 的本地开发。

这套方法需要先配置；配置过一次之后，日常迭代就是一条命令（§1.2）。

### 1.1 一次性配置（在自己的机器上）

1. 服务器按 oh-my-dsh-pack 标准部署一次（tag 镜像 + `docker compose up -d`）。
2. 启用开发覆盖层：`.env` 里 `DSH_DEV_PLUGINS=/srv/dev-plugins`，启动命令带 `-f docker-compose.yml -f docker-compose.dev.yml`。
3. 容器把宿主 `/srv/dev-plugins` 挂成 `/opt/dev-plugins`（只读），每次启动跑 `bootstrap-dev/20-link-plugins.sh`：对每个子目录执行 `dsh plugin --profile web add link:/opt/dev-plugins/<插件>`。目录约定是**一个插件一个子目录**。
4. 本机 ssh config 配一个别名；仓库里不要写地址。

### 1.2 每轮迭代

```pwsh
pnpm verify
pwsh <pack>/scripts/sync-plugin.ps1 -Plugin dsh-workspace-mesh
```

脚本做三件事：build → scp（`lib/`、`package.json`、`cordis.patch.yml`、`client/client.js`，按相对路径落盘）→ `docker compose up -d` + `restart dsh`。`-SshHost <别名>` 换机器，`-SkipBuild` 跳过构建。

### 1.3 怎么确认这次真的生效了

- 容器日志出现 `[dev] linked: dsh-workspace-mesh`
- 容器日志出现 `[mesh] registered mesh_list_nodes / mesh_status / mesh_dispatch / mesh_task_status`
- 容器日志出现 `[mesh] settings page route mounted at /api/mesh/state`
- 浏览器打开日志末尾的 `?token=` 地址 → 设置 → 「工作区网格」
- 新会话里让模型调 `mesh_list_nodes`：出现工具调用卡片，返回的 roster 与 `assignment.yml` 一致

前三条对应「插件加载了」，后两条对应「模型看得见工具」——这是两件事，别只看前三条就宣布成功。

### 1.4 这条链路特有的坑

- **只改 `client/client.js` 也要重启容器**：client bundle 的 `rev` 在 `dsh plugin add` 时才重算，不重启页面还是旧代码。
- `client.js` 语法错 = 整个插件不注册（插件页显示「1 异常」）：提交前 `node --check client/client.js`。
- 日志里 `[mesh] disposed` 是旧进程退出，别当成本次启动失败。
- 本插件由 profile patch `insert` 挂载（仓库里的 `cordis.patch.yml` 故意是 `[]`），所以原生 settings 文档里没有它的命名空间。原因见 [decisions.md](../explanation/decisions.md) D7。

### 1.5 侧栏工作区：三个质子包 + 一个区段包

侧栏工作区座位由质子托管，组合里要挂四个 dev-plugin 目录：

| 目录 | 包 | 作用 |
| --- | --- | --- |
| `dsh-proton` | `dsh-proton` | 通用 region / 条目 / 影子 / entry face / 分栏 |
| `dsh-proton-adapter-dsh` | `dsh-proton-adapter-dsh` | 唯一的 DSH slot 键与子槽契约、分栏比例 store |
| `dsh-proton-workspace` | `dsh-proton-workspace` | 官方工作区 entry 的 kit、区段入口 |
| `dsh-proton-workspace-remote-mesh` | 本仓库的区段包 | 「远程工作区」一节 |

**官方 `ui-workspace` 不要停用**：它仍是被渲染的组件，质子只是在它外面占座。profile patch 里保留官方的 `- id: ui-workspace`，另外 `insert` 上面四个包。

改 vendor 的姿势固定三步：改 `vendor/ui-workspace/**` → `git diff` 落到 `packages/workspace-remote-mesh/patches/<主题>.patch` → `git checkout -- packages/workspace-remote-mesh/vendor`。构建与 typecheck 走 `scripts/with-vendor-patches.mjs`，补丁套不上会直接失败。vendor 只用于**远程段的行组件**（`ProjectRowItem`）与其 CSS，官方段不经过它。

远程段只读 `assignment.yml` 与 `/api/mesh/state` 的 `peers[].workspaces`，不创建本地记录、不写目录。

## 2. 别人要用同一种方式

一句话：**自备一台开发服务器（或走 §3 本地），按 §1.1 配一次，之后同样用 `sync-plugin.ps1`。**

- 仓库不提供共享环境，也不记录任何机器地址；
- `DSH_DEV_PLUGINS` 目录、`dsh-home` / `dsh-workspace` 卷、反代与 token 都各自独立；
- 同步目标由 `-SshHost` 或你自己的 ssh 别名决定。

## 3. 本地开发（不需要服务器）

```sh
pnpm install && pnpm build
dsh plugin --profile web add file:$(pwd)
dsh --profile web --no-open
```

浏览器半侧和 `/api/mesh/*` 在本机实例上同样可用，适合先验证页面。

profile 里必须挂 `id: tools` 行，否则 `ctx.tools` 不存在，四个工具不会注册（日志会打 `[mesh] tool runtime unavailable`）。

## 4. 改配置字段之前

配置字段、优先级、热更新边界、加字段要改的 7 处，全部在 [reference/config.md](../reference/config.md)。这里不复制。

只强调一条最容易踩的：**`transport` 与 `peerBaseUrl` 是重启字段**，保存后看起来「没生效」是正常的；`leaseMs` / `dispatchTimeoutMs` / `leaseOwner` / `assignmentFile` 才是热字段。

## 5. 测试与审计

- `pnpm verify` = build + typecheck + `node:test`。当前用例数见 [reference/baselines.md](../reference/baselines.md)。
- 新增 `node:xxx` 导入要同步更新 `test/tools.test.ts` 里的零依赖审计允许列表；新增 `package.json` 依赖会直接让审计失败（本插件坚持零运行时依赖）。
- 路由 / 存储这类宿主逻辑必须有单测；客户端 bundle 提交前 `node --check client/client.js`。