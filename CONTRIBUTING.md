# Contributing

Project invariants (zero runtime dependencies, no shell, fail loudly) live in
[AGENTS.md](./AGENTS.md) §7. This page only covers what a change has to look like.

## Ground rules

- **Code is the factual authority; SPEC.md is the design authority.** When they disagree, fix the
  code or amend the spec in a separate change with a rationale in the commit message — and update
  the affected doc in the same change. Never leave a "corrigendum" behind.
- **Fail loudly.** A missing dependency is a documented degradation; a silently wrong answer is a
  bug. An adapter that cannot do its job throws `TransportUnavailableError` instead of returning
  fake data.

## Layout

| Path | Role |
| --- | --- |
| `src/types.ts` | Framework-free vocabulary (Task, Lease, Grant, MeshError...) |
| `src/board/` | Task board + lease/fencing state machine (SPEC §6.3, §7) |
| `src/transport/` | The one integration seam: `MeshTransport` + adapters |
| `src/identity/` | Epoch key derivation, request tokens, replay guard (SPEC §17.3) |
| `src/lifecycle/` | Self-restart controller (SPEC §14) |
| `src/assignments/` | `assignment.yml` parsing (SPEC §5.4) |
| `src/roster/` | Peer roster derived from the assignment table plus transport receipts |
| `src/api/` | Settings-page routes: `/api/mesh/state`, `/api/mesh/config` |
| `src/tools/` | Agent tool surface (contract: [docs/reference/tools.md](./docs/reference/tools.md)) |
| `client/` | Browser half: single-file settings page, no build step |
| `test/` | Node test runner suites, compiled to `lib-test/` |

Documentation layout is described in [docs/README.md](./docs/README.md).

## Verify

```sh
pnpm verify
pnpm check:docs
```

Command reference: [AGENTS.md](./AGENTS.md) §4.

## Commits

Conventional-ish prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`. One concern per
commit; keep `src/` and `test/` changes for one behaviour together.
