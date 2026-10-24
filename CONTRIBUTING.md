# Contributing

## Ground rules

- **SPEC.md is the authority.** Code follows the spec; if they disagree, fix the code or
  amend the spec in a separate change with a rationale in the commit message.
- **Zero runtime dependencies** (SPEC §9.4). Third-party capability is detected as a cordis
  service at runtime, never imported.
- **No shell, no process spawning** from plugin code (SPEC §8). Lifecycle means "exit and let
  a supervisor restart me", not "run a command".
- **Fail loudly.** A missing dependency is a documented degradation; a silently wrong answer is
  a bug. Stubs throw `TransportUnavailableError` instead of returning fake data.

## Layout

| Path | Role |
|---|---|
| `src/types.ts` | Framework-free vocabulary (Task, Lease, Grant, MeshError...) |
| `src/board/` | Task board + lease/fencing state machine (SPEC §6.3, §7) |
| `src/transport/` | The one integration seam: `MeshTransport` + adapters |
| `src/identity/` | Epoch key derivation, request tokens, replay guard (SPEC §17.3) |
| `src/lifecycle/` | Self-restart controller (SPEC §14) |
| `src/assignments/` | `assignment.yml` parsing (SPEC §5.4) — added with P2 |
| `src/tools/` | Agent tool surface: `mesh_list_nodes`, `mesh_status`, `mesh_dispatch`, `mesh_task_status` (SPEC §18; `mesh_status` is an addition, and `mesh_dispatch` blocking-until-reply is a documented deviation from the §18 `{taskId}` + `mesh_task_wait` model) |
| `docs/` | Spike findings and roadmap |
| `test/` | Node test runner suites, compiled to `lib-test/` |

## Verify

```sh
pnpm verify          # build + typecheck + test
```

Without pnpm on PATH (this is the CI-equivalent, verified locally):

```sh
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test "lib-test/test/*.test.js"
```

Tests live in `test/*.test.ts` and are compiled before running; the runner is Node's built-in
`node --test`, so no test framework is installed.

## Commits

Conventional-ish prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`. One concern per
commit; keep `src/` and `test/` changes for one behaviour together.
