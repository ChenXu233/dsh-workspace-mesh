import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The package ships its own mount row. `dsh plugin add` only registers a bundle
 * layer: a bundle whose patch is an empty list installs silently and mounts
 * nothing, which looks like a working install and behaves like a missing
 * plugin. These cases pin the row that makes install == enabled.
 */

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}
const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

test('the published bundle patch mounts the plugin', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.files?.includes('cordis.patch.yml'), true, 'cordis.patch.yml must ship in the package')
  assert.match(patch, /^-\s*insert:\s*$/mu)
  assert.match(patch, /^\s*-\s*id:\s*mesh\s*$/mu)
  const name = pkg.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  assert.match(patch, new RegExp('^\\s*name:\\s*' + name + '\\s*$', 'mu'))
})

test('the mount row carries no per-machine config', () => {
  // peers / assignmentFile / meshSecret / hub are per-deployment facts: they
  // belong in $DSH_HOME/mesh-config.json or the deployer's override row, not in
  // the package every install mounts.
  for (const key of ['peers', 'assignmentFile', 'meshSecret', 'hub']) {
    assert.doesNotMatch(patch, new RegExp('^\\s*' + key + ':', 'mu'))
  }
})
