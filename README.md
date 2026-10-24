# dsh-workspace-mesh

Workspace **mesh** for DeepSeek Harness — the mesh is a grid of *workspaces*, not of agents.

> **Not resource remote-access.** The agent loop never leaves the machine that owns the workspace;
> peers only exchange messages. See [SPEC.md](./SPEC.md).

## What it does

- Declares which workspace lives on which machine (`assignment.yml`).
- Dispatches a task to the session of the owning workspace and collects the result.
- Keeps execution local: only `workspace/list`, `workspace/follow`, `session/create`,
  `session/prompt`, `session/follow` are ever used. No bash, no file access.

## Install

```sh
dsh plugin --profile web add dsh-workspace-mesh
```

## Local development

```sh
pnpm install
pnpm build
dsh plugin --profile web add file:$(pwd)
```

Or load without installing, using an overlay patch (`--patch`):

```yaml
- insert:
    - id: swarm
      name: dsh-workspace-mesh
```

## Status

Skeleton. Transport adapters are stubs that fail loudly rather than silently
(see SPEC §13). Dependency policy: zero runtime dependencies; third-party
capabilities are detected as cordis services at runtime (SPEC §9.4).

## License

MIT
