# dsh-workspace-mesh

[![npm version](https://img.shields.io/npm/v/dsh-workspace-mesh.svg)](https://www.npmjs.com/package/dsh-workspace-mesh)
[![CI](https://github.com/ChenXu233/dsh-workspace-mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenXu233/dsh-workspace-mesh/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Workspace **mesh** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the mesh is a grid of *workspaces*, not of agents.

> **Not resource remote-access.** The agent loop never leaves the machine that owns the workspace;
> peers only exchange messages. See [SPEC.md](./SPEC.md).

## What it does

- Declares which workspace lives on which machine (`assignment.yml`).
- Exposes four tools to the model: `mesh_list_nodes`, `mesh_status`, `mesh_dispatch`,
  `mesh_task_status` (contract: [docs/reference/tools.md](./docs/reference/tools.md)).
- Dispatches a task to the session of the owning workspace and collects the result.
- Keeps execution local: only `workspace/*` and `session/*` methods are ever used. No bash, no file access.

## Requirements

| | |
| --- | --- |
| dsh | `>=0.2.1-rc.2` — declared in `dsh.engines` and checked when the bundle loads |
| Node.js | `>=20` |
| Runtime deps | none; cordis services are detected at runtime (SPEC §9.4) |

## Install

```sh
dsh plugin --profile web add dsh-workspace-mesh
```

Or load without installing, using an overlay patch (`--patch`):

```yaml
- insert:
    - id: mesh
      name: dsh-workspace-mesh
```

## Local development

```sh
pnpm install
pnpm build
dsh plugin --profile web add file:$(pwd)
```

`pnpm verify` runs the same gate as CI: build + typecheck + tests.
The full picture — the pack cloud dev chain, the local install, the released-package install —
is in [docs/how-to/development.md](./docs/how-to/development.md).

## Settings page

The browser half registers a read-only dashboard into the native settings navigation
(`settings.section`, id `mesh`) and a live-configuration card on the plugin's own detail page
(`plugins.detail.section`). It renders transport state, the peer roster, workspace placement and
recent tasks, and writes configuration through two routes registered inside Connection's fence:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/mesh/state` | GET | Read-only snapshot |
| `/api/mesh/config` | POST | Validate + persist a config patch, apply the hot subset |

Payloads, error codes and the hot/restart split: [docs/reference/http-api.md](./docs/reference/http-api.md).
Configuration keys and their defaults: [docs/reference/config.md](./docs/reference/config.md).

## Status

The tool surface, task board, roster derivation, settings page and config layering work and are
covered by tests.

There is **no cross-machine transport yet**: the only adapter is the test-only `mock`, so in a real
host `mesh_dispatch` returns `unavailable` while `mesh_list_nodes` / `mesh_status` /
`mesh_task_status` stay usable. The next increment is the Typert transport — see
[docs/explanation/roadmap.md](./docs/explanation/roadmap.md).

## Docs

[docs/README.md](./docs/README.md) is the only index. Start there.

## License

Apache License 2.0 (`Apache-2.0`) — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
The reasoning behind that choice is in [docs/explanation/decisions.md](./docs/explanation/decisions.md) D11.
