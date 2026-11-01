# 文档索引

> **状态**：现行
> **日期**：2026-11-01
> **读者**：第一次读这个仓库的人；要改这个仓库的 agent
> **口径**：只描述 HEAD 的文档布局；冲突处理规则见 [AGENTS.md](../AGENTS.md) §2

这是 `docs/` 的唯一索引。其他文档不再自建索引，新增文档先登记到这里。

## 1. 按需要读

| 你想 | 读 |
| --- | --- |
| 装上并用起来 | [README.md](../README.md) |
| 改代码、跑起来、看日志 | [how-to/development.md](how-to/development.md) |
| 查工具名 / 参数 / 返回 / 错误码 | [reference/tools.md](reference/tools.md) |
| 查配置字段、热更新边界 | [reference/config.md](reference/config.md) |
| 查 HTTP 路由（设置页 + 对端握手/中继） | [reference/http-api.md](reference/http-api.md) |
| 引用规模数字（用例数等） | [reference/baselines.md](reference/baselines.md) |
| 知道「mesh 到底是什么意思」 | [SPEC.md](../SPEC.md) |
| 知道下一步做什么、什么不做 | [explanation/roadmap.md](explanation/roadmap.md) |
| 知道某个决定为什么这么定 | [explanation/decisions.md](explanation/decisions.md) |
| 查当初怎么查出来的 | [evidence/](evidence/README.md) |
| 贡献代码的规矩 | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## 2. 目录即象限

按**读者读完产出什么**分，不按编号分优先级：

```text
docs/
  how-to/        任务导向：读完能完成一件具体事
  reference/     信息导向：查字段、参数、路由、错误码
  explanation/   理解导向：为什么这样设计、下一步做什么
  evidence/      取证快照：当初怎么查出来的（只读，不随代码更新）
```

不建空目录。某个象限暂时没有内容时，在本文写清「出现什么内容才建」，而不是先立空壳——空壳会诱使 agent 往里凑内容。

## 3. 新增文档前

1. 先问能不能折进已有文档的某一节。**默认答案是折进去**。
2. 只有当出现**新的读者需要**（新的问题类型）时才建新文件；只是新话题，不构成新文件。
3. 一份文档一个 H1，标题不跳级，代码围栏带语言。
4. 开头写元信息块：状态、日期、读者、上游材料、口径。
5. 改完跑 `pnpm check:docs`，退出码 0 才算完成。

## 4. 谁更新什么

「改了什么 → 同步到哪」的矩阵只有一份，在 [AGENTS.md](../AGENTS.md) §5。这里不复制。
