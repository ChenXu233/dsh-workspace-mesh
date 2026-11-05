#!/usr/bin/env node
/**
 * Re-vendor the upstream workspace browser at a pinned tag, then re-apply our patches.
 *
 *   node scripts/vendor-upstream.mjs                 # pin from vendor/PROVENANCE.json
 *   node scripts/vendor-upstream.mjs --tag dsh-v0.2.2-alpha.3
 *   node scripts/vendor-upstream.mjs --check         # only verify the patches still apply
 *
 * Exit codes: 0 ok · 1 conflict · 2 usage/network problem.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PACKAGE_ROOT, encoding: 'utf8' }).trim()
const VENDOR = join(PACKAGE_ROOT, 'vendor')
const TARGET = join(VENDOR, 'ui-workspace')
const PATCHES = join(PACKAGE_ROOT, 'patches')
const PROVENANCE = join(VENDOR, 'PROVENANCE.json')
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness'
const UPSTREAM_PATH = 'packages/client/ui-workspace'
const COPY = ['src', 'locale', 'package.json']

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

const provenance = existsSync(PROVENANCE) ? JSON.parse(readFileSync(PROVENANCE, 'utf8')) : {}
const tag = value('--tag') ?? provenance.tag ?? 'dsh-v0.2.1-rc.5'
const checkOnly = has('--check')

const run = (cmd, args, quiet) =>
  execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })

const patchFiles = existsSync(PATCHES) ? readdirSync(PATCHES).filter((f) => f.endsWith('.patch')).sort() : []

function applyPatch(file, check) {
  const rel = relative(REPO_ROOT, file).split('\\').join('/')
  const args = ['apply', check ? '--check' : '--verbose', '-p1', rel]
  run('git', args, check)
}

if (checkOnly) {
  let failed = 0
  for (const file of patchFiles) {
    try {
      applyPatch(join(PATCHES, file), true)
      console.log('  OK ' + file)
    } catch {
      failed += 1
      console.error('  CONFLICT ' + file)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

const tmp = join(REPO_ROOT, '.vendor-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

console.log('> sparse clone ' + UPSTREAM + ' @ ' + tag)
run('git', ['clone', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', UPSTREAM, tmp])
run('git', ['-C', tmp, 'sparse-checkout', 'set', UPSTREAM_PATH])
const commit = run('git', ['-C', tmp, 'rev-parse', 'HEAD'], true).trim()
console.log('> vendoring ' + tag + ' (' + commit.slice(0, 8) + ')')

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
for (const entry of COPY) {
  const from = join(tmp, UPSTREAM_PATH, entry)
  if (existsSync(from)) cpSync(from, join(TARGET, entry), { recursive: true })
}
rmSync(tmp, { recursive: true, force: true })

let conflicts = 0
for (const file of patchFiles) {
  try {
    applyPatch(join(PATCHES, file), false)
    console.log('  applied ' + file)
  } catch {
    conflicts += 1
    console.error('  CONFLICT ' + file + ' — 上游改了同一处，需要人工裁决')
  }
}

writeFileSync(PROVENANCE, JSON.stringify({
  source: UPSTREAM, tag, commit, path: UPSTREAM_PATH, license: 'MIT',
  copied: COPY, patches: patchFiles,
  note: '原样存放，不手工编辑。改动放 packages/workspace-remote-mesh/patches/。',
}, null, 2) + '\n')

if (conflicts > 0) {
  console.error('\n' + conflicts + ' 个补丁无法自动套用。vendor 已是 ' + tag + '，补丁保持原样，人工裁决后重新生成。')
  process.exit(1)
}
console.log('\nOK: vendored ' + tag + ', ' + patchFiles.length + ' 个补丁全部套用')
