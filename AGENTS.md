# AGENTS.md

> 给编码 agent 的项目说明。人类入口见 [README.md](README.md)，文档索引见 [docs/README.md](docs/README.md)。
> **最后核对**：2026-11-01，依据 `src/` 文件树、`package.json`、`docs/reference/`。
> **私人环境笔记**：同目录的 [AGENTS.local.md](AGENTS.local.md)（不入库）。存在时先读它拿机器、地址与运维口径；它的内容不进任何提交。

## 元规则：本文件自己怎么演进

| # | 规则 | 判据 |
| --- | --- | --- |
| M1 | 加规则必须先经维护者同意 | 在对话里提出、说明不加会出什么错，批准后才写 |
| M2 | 只加「不加就不知道」的规则；写稳定的抽象概念，不写易变细节 | 能从代码/工具/常识推出的不写；会随实现漂移的（版本号、行数、当前进度）不写 |
| M3 | 规则必须可判 | 要么能被 `pnpm check:docs` 机检，要么有明确判据 |
| M4 | 同一规则只写一处，其余留指针 | 复制会漂移 |
| M5 | 规则失效就删，不保留历史 | 不写「历史上曾要求…」 |

## 1. 这个仓库是什么（30 秒）

一个 cordis 插件（DSH 的 bundle）：把「哪个工作区在哪台机器」变成可调度的声明，并把任务投递到工作区所在的 DSH 实例。**agent loop 永远在那台机器上跑**，跨机只传消息。

| 层 | 技术 | 关键路径 |
| --- | --- | --- |
| host 半区 | TypeScript（ESM）+ cordis | `src/` |
| 工具面 | 裸 JSON Schema definition，零依赖 | `src/tools/` |
| 浏览器半区 | 单文件原生 JS，无构建 | `client/client.js` |
| 传输接缝 | `MeshTransport` 五方法 | `src/transport/` |
| 设计契约 | SPEC.md（设计意图，不描述当前实现） | 根目录 |

三条稳定的心智模型：

1. **mesh 传消息，不传执行。** 没有远程 bash / 文件服务，架构上也不会有（SPEC §16.6）。
2. **传输缺失是降级，不是崩溃。** 插件照常加载，工具返回 `unavailable`。
3. **每个事实只有一个家。** 实现契约在 `docs/reference/`，设计意图在 `SPEC.md`，取证在 `docs/evidence/`，数字在 `docs/reference/baselines.md`。

## 2. 代码与文档不一致时：不设优先级

**没有默认优先级。** 代码和文档都会错：代码可能是一个 bug、半成品或临时方案（本仓库就有——SPEC §5.4 描述的广播注册表在代码里并不存在，实现改用静态 `assignment.yml`，见 [decisions](docs/explanation/decisions.md) D3）；文档可能过期，也可能只是没落地的设想。任何一方都不是「标准」。

两者回答的是不同问题——这是分工，不是等级：

| 问题 | 只能由谁回答 |
| --- | --- |
| 现在实际会怎样（行为、返回值、错误码、某文件/目录是否存在） | 代码与文件树；文档说会怎样不算 |
| 本来该怎样、为什么这样定 | 文档；代码里没有意图 |

所以「代码说 A、文档说 B」不是排序问题，而是**实现与意图出现偏差**——它需要处理，不能自动判定。处理顺序：

1. 先判定偏差方向：实现写错了 / 文档写错了 / 两者说的不是同一件事（设计意图 vs 当前实现）。
2. 按判定动手：实现错 → 改代码或先记 issue；文档错 → 当次改文档；不是同一件事 → 拆开措辞，各自说清。
3. **不得静默单方面改动。** 自行判定「代码对、文档错」就把文档改掉，等于把可能的 bug 洗成既有行为。改动要在当次回复里说明「按 X 改了 Y，依据 Z」，把裁决权留给维护者。
4. 维护者要求「以代码为准」时，那是**本次的决定**，写进提交说明，不升级为通用规则。

无论哪种情况，都不写「勘误」「以前是…现在是…」——历史交给 git。

## 3. 现状（只写可验证的）

| 项 | 事实 | 依据 |
| --- | --- | --- |
| 模型工具 | 4 个 `mesh_*` 已注册，参数校验与返回形状有测试 | `src/tools/` |
| 跨机传输 | `typert`（配 `peers` 后可用，走对端 web API）；`mock` 仅测试 | `src/transport/typert.ts` |
| 任务板 | 进程内存，无持久化；进程重启即清空 | `src/board/` |
| 设置页 | 读快照 + 写配置两条路由已实现 | `src/api/` |
| hub / 广播注册表 | 不存在 | 文件树 |
| 授权层（grants、T1–T3） | 不存在 | 文件树 |

## 4. 常用命令

命令只在这里写一份，其他文档放指针。

```sh
pnpm verify            # build + typecheck + node:test，CI 同一道闸
pnpm check:docs        # 文档自检（H1/标题层级/围栏语言/相对链接/禁词）
node --check client/client.js   # 改过浏览器半区后必须跑
```

没有 pnpm 时的等价写法：

```sh
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test "lib-test/test/*.test.js"
```

## 5. 改代码后必须同步的文档

| 改了什么 | 同步到 |
| --- | --- |
| 工具名 / 参数 / 返回 / 错误码 | `docs/reference/tools.md` + `client/client.js` + `test/tools.test.ts` |
| 配置字段 | `docs/reference/config.md`（清单见其 §6） |
| HTTP 路由 | `docs/reference/http-api.md` |
| 传输实现状态（桩 → 可用） | `docs/reference/config.md` §3 + `docs/explanation/roadmap.md` §1 |
| 架构边界变更（新平面、新依赖方向） | 先登记 `docs/explanation/decisions.md`，再动代码 |
| 设计意图变化 | `SPEC.md` |
| 新的取证结论 | 先折进 `SPEC.md` / `reference/`，原文归档 `docs/evidence/` |
| 规模数字（用例数等） | `docs/reference/baselines.md`（只改这张表） |

## 6. 文档规则

1. 一份文档一个 H1；标题不跳级，不超过四级；代码围栏必须带语言。
2. 链接用相对路径，禁止盘符绝对路径。
3. 只写当前状态。不写变更日志、「勘误」、「以前是」、TODO 清单；历史交给 git。
4. 同一事实只写一处，其余放链接。
5. 不写无法从仓库验证的事实；必须保留时标【未核实】并写明缺什么依据。
6. 数字只写在 `docs/reference/baselines.md`，其他文档引用口径名称。
7. 新增文档前先问能不能折进已有文档的某一节——默认答案是折进去。
8. 改完跑 `pnpm check:docs`，退出码 0 才算完成。

## 7. 禁止事项

- **不引入运行时依赖。** 零运行时依赖是卖点，审计测试会直接失败。
- **不从插件代码 spawn 进程或跑 shell。** 「重启」= 正常退出，让外部 supervisor 拉起（SPEC §14.2）。
- **不伪造状态。** 没有传输回执就写 `unknown`，不写 `online`。
- **不 import 宿主 asar 里的包。** profile 内插件解析不到；需要的能力按 cordis 服务在运行期探测。
- **不把完整调研报告直接落盘。** 先把结论压缩成几句话折进现行文档，原文再归档。
