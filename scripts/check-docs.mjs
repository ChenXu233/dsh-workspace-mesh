#!/usr/bin/env node
/**
 * Documentation self-check. Run with `pnpm check:docs`.
 *
 * Checks: exactly one H1 per file, no skipped heading levels, max heading depth,
 * fenced code blocks declare a language, no drive-letter absolute paths, no
 * doubled horizontal rules, files over 300 lines need a table of contents,
 * every relative .md link resolves, and banned "history" words never appear in
 * headings (see AGENTS.md §6).
 *
 * Exit code 0 = clean; 1 = findings printed one per line.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const MAX_HEADING = 4
const TOC_LINE_LIMIT = 300
const BANNED = ['勘误', '变更记录', '变更日志', 'TODO', '以前是', '已废弃']
// The rule file itself talks about these words; frozen evidence keeps its own wording.
const EXEMPT_BANNED = new Set(['AGENTS.md'])
const FROZEN_PREFIX = 'docs/evidence/'
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'lib-test', 'dist'])

function listMarkdown(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(root, full).split(sep).join('/')
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(full)
      } else if (entry.endsWith('.md')) {
        out.push(rel)
      }
    }
  }
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) continue
    if (entry.endsWith('.md')) out.push(entry)
  }
  const docs = join(root, 'docs')
  if (existsSync(docs)) walk(docs)
  return [...new Set(out)].sort()
}

function scan(root, path, findings) {
  const lines = readFileSync(join(root, path), 'utf8').split('\n')
  const frozen = path.startsWith(FROZEN_PREFIX)
  const levels = []
  let inFence = false
  let noLang = 0
  let absPath = 0
  let doubleRule = 0
  let banned = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (!inFence && line.trim() === '```') noLang += 1
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6}) /.exec(line)
    if (heading) {
      levels.push(heading[1].length)
      if (!frozen && !EXEMPT_BANNED.has(path)) {
        if (BANNED.some((word) => line.includes(word))) banned += 1
      }
    }
    if (/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(line)) absPath += 1
    if (i > 0 && line.trim() === '---' && lines[i - 1].trim() === '---') doubleRule += 1
  }

  const h1 = levels.filter((l) => l === 1).length
  const jumps = levels.filter((l, k) => k > 0 && l - levels[k - 1] > 1).length
  if (h1 !== 1) findings.push(`${path}: H1 数量 = ${h1}（应为 1）`)
  if (jumps > 0) findings.push(`${path}: 标题跳级 ${jumps} 处`)
  if (levels.length > 0 && Math.max(...levels) > MAX_HEADING) {
    findings.push(`${path}: 标题超过 ${MAX_HEADING} 级`)
  }
  if (noLang > 0) findings.push(`${path}: 无语言代码围栏 ${noLang} 处`)
  // Frozen evidence keeps the machine paths it was measured on; only living docs must be clean.
  if (absPath > 0 && !frozen) findings.push(`${path}: 盘符绝对路径 ${absPath} 处`)
  if (doubleRule > 0) findings.push(`${path}: 连续 --- ${doubleRule} 处`)
  if (banned > 0) findings.push(`${path}: 标题含禁词（勘误/变更记录/TODO/以前是 等）${banned} 处`)

  const hasToc = lines.slice(0, 80).some((line) => /^#{2,3} .*目\s*录/.test(line) || /^#{2,3} .*(Contents|Table of contents)/i.test(line))
  if (!frozen && lines.length > TOC_LINE_LIMIT && !hasToc) {
    findings.push(`${path}: 超过 ${TOC_LINE_LIMIT} 行但没有目录`)
  }
}

function checkLinks(root, path, findings) {
  const text = readFileSync(join(root, path), 'utf8')
  const base = dirname(join(root, path))
  const linkPattern = /\]\(([^)\s]+\.md)(#[^)]*)?\)/g
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1]
    if (target.startsWith('http')) continue
    if (!existsSync(resolve(base, target))) findings.push(`${path}: 断链 -> ${target}`)
  }
}

const root = process.argv[2] ? resolve(process.argv[2]) : ROOT
const files = listMarkdown(root)
if (files.length === 0) {
  console.error(`没找到 markdown 文件，检查仓库根是否正确：${root}`)
  process.exit(1)
}
const findings = []
for (const path of files) scan(root, path, findings)
for (const path of files) checkLinks(root, path, findings)

if (findings.length > 0) {
  console.error(findings.join('\n'))
  console.error(`\nFAIL：${findings.length} 处问题（检查了 ${files.length} 份文档）`)
  process.exit(1)
}
console.log(`OK：文档自检全部通过（${files.length} 份）`)
