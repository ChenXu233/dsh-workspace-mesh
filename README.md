# dsh-workspace-mesh

[![npm version](https://img.shields.io/npm/v/dsh-workspace-mesh.svg)](https://www.npmjs.com/package/dsh-workspace-mesh)
[![CI](https://github.com/ChenXu233/dsh-workspace-mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenXu233/dsh-workspace-mesh/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Workspace **mesh** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the mesh is a grid of *workspaces*, not of agents.

> **Not resource remote-access.** The agent loop never leaves the machine that owns the workspace;
> peers only exchange messages. See [SPEC.md](./SPEC.md).

## What it does

- Declares which workspace lives on which machine (`assignment.yml`).
- Dispatches a task to the session of the owning workspace and collects the result.
- Keeps execution local: only `workspace/list`, `workspace/follow`, `session/create`,
  `session/prompt`, `session/follow` are ever used. No bash, no file access.

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
    - id: swarm
      name: dsh-workspace-mesh
```

## Local development

```sh
pnpm install
pnpm build
dsh plugin --profile web add file:$(pwd)
```

`pnpm verify` runs the same gate as CI: build + typecheck + tests.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full picture: the pack cloud dev
chain we use (own dev server + `sync-plugin.ps1`), the local install, and the
released-package install — plus what has to be configured once before the cloud
chain works.

## Settings page

The browser half registers a read-only dashboard into the native settings
navigation (`settings.section`, id `mesh`) and a live-configuration card on the
plugin's own detail page (`plugins.detail.section`). The dashboard renders the
transport state, the peer roster, workspace placement and recent tasks.

Data comes from two authenticated Fetch routes registered inside Connection's
fence (the same seat the shipped `/api/present.host` route uses):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/mesh/state` | GET | Read-only snapshot: transport, config, peers, counts, recent tasks |
| `/api/mesh/config` | POST | Validate + persist a config patch, apply the hot subset |

Configuration writes land in `$DSH_HOME/mesh-config.json` and are layered over
the cordis entry config at apply time. `leaseMs`, `dispatchTimeoutMs`,
`leaseOwner` and `assignmentFile` apply immediately; `transport` and
`peerBaseUrl` are persisted now and take effect on the next container restart.
The file lives under `$DSH_HOME` because a profile-patch mounted entry is not
projected into this DSH version's settings document, so the native settings
pipe cannot edit it.

## Status

Skeleton. Transport adapters are stubs that fail loudly rather than silently
(see SPEC §13). The Typert transport is the next increment — see
[docs/roadmap.md](./docs/roadmap.md) and the spikes under `docs/`.

## Docs

- [SPEC.md](./SPEC.md) — the contract: what "mesh" means, tool surface, failure modes
- [DEVELOPMENT.md](./DEVELOPMENT.md) — build, install, cloud dev chain
- [docs/roadmap.md](./docs/roadmap.md) — increments and current state

## Why Apache-2.0?

The mesh is only useful when many DSH instances speak the same thing, so
adoption beats code ownership. Apache-2.0 maximises both without giving up the
parts that matter:

- **Enterprises can actually use it.** Apache-2.0 is on nearly every corporate
  allow-list, so the plugin can be installed into a profile or baked into a
  pre-built image without a licence review. Copyleft would end that
  conversation before it starts, while buying almost nothing in return: the
  typical deployment is internal, and internal use never triggers copyleft.
- **Patents are explicit, not implied.** Section 3 grants a patent licence from
  every contributor and terminates it for anyone who sues over patents. MIT
  only implies this; GPLv3 has the same grant but brings distribution
  obligations that do not match how a plugin is actually shipped.
- **It fits the ecosystem.** dsh and cordis are MIT; Apache-2.0 combines with
  them cleanly.
- **It is honest about what it cannot do.** No open-source licence stops a fork
  that is never distributed. What protects the mesh is the [SPEC](./SPEC.md),
  the package name and the reference implementation staying ahead — not a
  licence clause.

If your organisation needs different terms, open an issue.

## License

Apache License 2.0 (`Apache-2.0`) — see [LICENSE](./LICENSE) and
[NOTICE](./NOTICE).

You may use, modify and redistribute this plugin, including inside closed
products, provided you keep the copyright and licence notices. The plugin
contains no code from dsh itself; it talks to dsh only through its public
cordis interfaces.
