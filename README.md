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

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full picture: the pack cloud dev
chain we use (own dev server + `sync-plugin.ps1`), the local install, and the
released-package install — plus what has to be configured once before the cloud
chain works.

Or load without installing, using an overlay patch (`--patch`):

```yaml
- insert:
    - id: swarm
      name: dsh-workspace-mesh
```

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
(see SPEC §13). Dependency policy: zero runtime dependencies; third-party
capabilities are detected as cordis services at runtime (SPEC §9.4).

## License

MIT
