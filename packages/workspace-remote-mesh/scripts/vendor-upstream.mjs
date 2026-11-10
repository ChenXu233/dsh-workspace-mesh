#!/usr/bin/env node
/**
 * Re-vendor the upstream workspace surfaces we draw ourselves, then re-apply our patches.
 *
 *   node scripts/vendor-upstream.mjs --check     # only verify the patches still apply
 *   node scripts/vendor-upstream.mjs             # pin every package from its PROVENANCE.json
 *   node scripts/vendor-upstream.mjs ui-workspace  # one package only
 *
 * Each vendored package keeps its own `vendor/<id>/PROVENANCE.json` (tag, commit,
 * what was copied); patches in `patches/` are shared and applied to whichever
 * tree they touch.
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
const PATCHES = join(PACKAGE_ROOT, 'patches')
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness'

/** One vendored upstream package: where it comes from and what to copy. */
const PACKAGES = [
  { id: 'ui-workspace', upstream: 'packages/client/ui-workspace', copy: ['src', 'locale', 'package.json'] },
  {
    id: 'ui-directory-picker-browse',
    upstream: 'packages/client/ui-directory-picker-browse',
    copy: ['src/client/DirectoryBrowser.tsx', 'src/client/DirectoryBrowser.module.css'],
  },
]

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const checkOnly = has('--check')
const only = argv.find(arg => !arg.startsWith('--'))
const selected = only === undefined ? PACKAGES : PACKAGES.filter(pkg => pkg.id === only)
if (selected.length === 0) {
  console.error('未知的 vendor 包: ' + only)
  process.exit(2)
}

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

const provenanceOf = (id) => {
  const file = join(VENDOR, id, 'PROVENANCE.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

let conflicts = 0
for (const pkg of selected) {
  const provenance = provenanceOf(pkg.id)
  const tag = value('--tag') ?? provenance.tag ?? 'dsh-v0.2.1-rc.5'
  const target = join(VENDOR, pkg.id)

  const tmp = join(REPO_ROOT, '.vendor-tmp-' + pkg.id)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  console.log('> sparse clone ' + UPSTREAM + ' @ ' + tag + ' -> ' + pkg.id)
  run('git', ['clone', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', UPSTREAM, tmp])
  run('git', ['-C', tmp, 'sparse-checkout', 'set', pkg.upstream])
  const commit = run('git', ['-C', tmp, 'rev-parse', 'HEAD'], true).trim()

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of pkg.copy) {
    const from = join(tmp, pkg.upstream, entry)
    if (existsSync(from)) cpSync(from, join(target, entry), { recursive: true })
  }
  rmSync(tmp, { recursive: true, force: true })

  writeFileSync(join(target, 'PROVENANCE.json'), JSON.stringify({
    source: UPSTREAM, tag, commit, path: pkg.upstream, license: 'MIT',
    copied: pkg.copy, patches: patchFiles,
    note: '原样存放，不手工编辑。改动放 packages/workspace-remote-mesh/patches/。',
  }, null, 2) + '\n')
}

for (const file of patchFiles) {
  try {
    applyPatch(join(PATCHES, file), false)
    console.log('  applied ' + file)
  } catch {
    conflicts += 1
    console.error('  CONFLICT ' + file + ' — 上游改了同一处，需要人工裁决')
  }
}

if (conflicts > 0) {
  console.error('\n' + conflicts + ' 个补丁无法自动套用。vendor 已更新，补丁保持原样，人工裁决后重新生成。')
  process.exit(1)
}
console.log('\nOK: vendored ' + selected.map(pkg => pkg.id).join(', ') + '，' + patchFiles.length + ' 个补丁全部套用')
