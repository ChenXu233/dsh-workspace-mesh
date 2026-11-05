#!/usr/bin/env node
/**
 * Run one command against the patched vendor tree, then put the tree back.
 *
 * The vendor tree is committed pristine, so "the bundle contains our changes"
 * and "anybody can re-read the vendor tree" cannot both be true at rest. This
 * script makes the patched state transient: apply every patch, run the command
 * from the package, restore no matter how it ends. Build and typecheck both go
 * through here — a patched file that no longer compiles is exactly the failure
 * a pristine-tree typecheck would never see.
 *
 * Exit codes: 0 ok · 1 dirty vendor tree or a patch that no longer applies · otherwise the command's own status.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PACKAGE_ROOT, encoding: 'utf8' }).trim()
const VENDOR = join(PACKAGE_ROOT, 'vendor')
const PATCHES = join(PACKAGE_ROOT, 'patches')
const VENDOR_REL = relative(REPO_ROOT, VENDOR).split('\\').join('/')
const PATCHES_REL = relative(REPO_ROOT, PATCHES).split('\\').join('/')

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('用法: node scripts/with-vendor-patches.mjs <node 入口> [参数...]')
  process.exit(2)
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' }).trim()

/** Uncommitted vendor edits would be destroyed by the restore; refuse to start. Untracked files are fine — a fresh package has not been added yet. */
const dirty = run('git', ['status', '--porcelain', '--', VENDOR_REL])
  .split('\n')
  // A newly added file is not an edit the restore would destroy; a staged or
  // unstaged modification is.
  .filter((line) => line !== '' && !line.startsWith('A'))
  .join('\n')
if (dirty !== '') {
  console.error('vendor 目录有未提交改动，拒绝在有脏树的目录上打补丁：\n' + dirty)
  process.exit(1)
}

const patches = readdirSync(PATCHES).filter((f) => f.endsWith('.patch')).sort()

const restore = () => {
  try {
    run('git', ['checkout', '--', VENDOR_REL])
  } catch (error) {
    console.error('恢复 vendor 目录失败，请手动执行 git checkout -- ' + VENDOR_REL)
    throw error
  }
}

let status = 0
try {
  for (const patch of patches) {
    try {
      run('git', ['apply', '-p1', PATCHES_REL + '/' + patch])
    } catch (error) {
      console.error('补丁套不上：' + patch + '\n' + (error.stderr ?? ''))
      status = 1
      break
    }
  }
  if (status === 0) {
    try {
      execFileSync(process.execPath, argv, { cwd: PACKAGE_ROOT, stdio: 'inherit' })
    } catch (error) {
      status = typeof error.status === 'number' && error.status !== 0 ? error.status : 1
    }
  }
} finally {
  restore()
}
process.exit(status)
