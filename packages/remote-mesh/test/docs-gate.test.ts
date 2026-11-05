import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The docs gate runs against the working tree, but a release is built from a
 * clean checkout. Anything that passes only because a git-ignored file happens
 * to exist locally fails in CI — which is exactly how 0.2.0's first publish run
 * died. These cases pin the difference.
 */

// The gate lives at the repository root, and this file runs from both the
// source tree and the compiled lib-test tree — walk up to the workspace marker
// instead of counting directories.
const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repository root not found')
    dir = parent
  }
})()
const script = join(repoRoot, 'scripts', 'check-docs.mjs')

function runGate(root: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, output }
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mesh-docs-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

test('a link to a private note does not fail a clean checkout', () => {
  const root = fixture({
    'AGENTS.md': '# Rules\n\n> Private notes: [AGENTS.local.md](AGENTS.local.md)\n',
  })
  try {
    const result = runGate(root)
    assert.equal(result.code, 0, result.output)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a link to a doc that should exist still fails', () => {
  const root = fixture({
    'AGENTS.md': '# Rules\n\n> See [missing](docs/missing.md)\n',
  })
  try {
    const result = runGate(root)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /断链 -> docs\/missing\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
