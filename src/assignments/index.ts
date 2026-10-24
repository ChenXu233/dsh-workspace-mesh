import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Zero-dependency reader for the assignment subset the mesh needs (SPEC §5.4).
 *
 * The supported YAML is deliberately small: a top-level `nodes:` mapping and a
 * top-level `assignments:` sequence. Both flow (`{ label: x, endpoint: y }`)
 * and block mappings are accepted, plus comments and quoted scalars. Anchors,
 * aliases, tags, multi-document streams, block scalars and nested flow
 * collections are rejected with the file path and line number instead of being
 * silently misread (SPEC §8: fail loudly).
 */

export type AssignmentErrorCode = 'missing-file' | 'unreadable' | 'syntax' | 'schema'

export class AssignmentFileError extends Error {
  readonly file: string
  readonly line: number | undefined
  readonly code: AssignmentErrorCode

  constructor(file: string, line: number | undefined, code: AssignmentErrorCode, detail: string) {
    super(
      line === undefined
        ? `assignment file "${file}": ${detail}`
        : `assignment file "${file}" line ${line}: ${detail}`,
    )
    this.name = 'AssignmentFileError'
    this.file = file
    this.line = line
    this.code = code
  }
}

export interface AssignmentNode {
  nodeId: string
  label?: string
  endpoint?: string
  /** 1-based source line, kept for diagnostics. */
  line: number
}

export interface AssignmentRoute {
  workspaceId: string
  nodeId: string
  /** 1-based source line, kept for diagnostics. */
  line: number
}

export interface AssignmentTable {
  /** Absolute path (or the caller-supplied inline label) the table came from. */
  file: string
  nodes: AssignmentNode[]
  assignments: AssignmentRoute[]
}

const KNOWN_SECTIONS = new Set(['nodes', 'assignments'])
const NODE_KEYS = new Set(['label', 'endpoint'])
const ASSIGNMENT_KEYS = new Set(['workspaceId', 'nodeId'])

interface SourceLine {
  number: number
  indent: number
  text: string
}

interface NodeBuilder {
  nodeId: string
  line: number
  indent: number
  attrIndent?: number
  attrs: Record<string, string>
}

/** Read and parse an assignment file. Path errors keep the absolute path in the message. */
export function loadAssignmentTable(file: string): AssignmentTable {
  const absolute = resolve(file)
  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const detail = code === 'ENOENT' ? 'file not found' : `cannot read file (${(err as Error).message})`
    throw new AssignmentFileError(absolute, undefined, code === 'ENOENT' ? 'missing-file' : 'unreadable', detail)
  }
  return parseAssignment(text, absolute)
}

/** Parse assignment text. `file` is only used to build error messages. */
export function parseAssignment(text: string, file = '<inline>'): AssignmentTable {
  const lines = tokenize(text, file)
  if (lines.length === 0) {
    throw new AssignmentFileError(file, 1, 'schema', 'the file is empty; expected a "nodes:" and/or "assignments:" section')
  }

  const nodes: AssignmentNode[] = []
  const assignments: AssignmentRoute[] = []
  const nodeLines = new Map<string, number>()
  const workspaceLines = new Map<string, number>()
  const sections = new Set<string>()
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent !== 0) {
      throw new AssignmentFileError(file, line.number, 'syntax', 'unexpected indentation at the top level')
    }
    const { key, value } = splitKeyValue(line, file)
    if (value !== '') {
      throw new AssignmentFileError(file, line.number, 'schema', `top-level section "${key}" must not have an inline value`)
    }
    if (!KNOWN_SECTIONS.has(key)) {
      throw new AssignmentFileError(
        file,
        line.number,
        'schema',
        `unknown top-level section "${key}" (supported: nodes, assignments)`,
      )
    }
    if (sections.has(key)) {
      throw new AssignmentFileError(file, line.number, 'schema', `duplicate section "${key}"`)
    }
    sections.add(key)
    index += 1
    index =
      key === 'nodes'
        ? parseNodes(lines, index, file, nodes, nodeLines)
        : parseAssignments(lines, index, file, assignments, workspaceLines)
  }

  if (sections.size === 0) {
    throw new AssignmentFileError(file, 1, 'schema', 'no "nodes:" or "assignments:" section found')
  }

  return { file, nodes, assignments }
}

export function findAssignmentNode(table: AssignmentTable | undefined, nodeId: string): AssignmentNode | undefined {
  return table?.nodes.find((node) => node.nodeId === nodeId)
}

export function findAssignmentRoute(table: AssignmentTable | undefined, workspaceId: string): AssignmentRoute | undefined {
  return table?.assignments.find((route) => route.workspaceId === workspaceId)
}

/** Container mapping key -> nodeId, for mesh_list_nodes/mesh_status summaries. */
export function assignmentNodeIds(table: AssignmentTable | undefined): string[] {
  return table ? table.nodes.map((node) => node.nodeId) : []
}

function tokenize(text: string, file: string): SourceLine[] {
  const lines: SourceLine[] = []
  const rawLines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  for (let index = 0; index < rawLines.length; index += 1) {
    const number = index + 1
    const withoutComment = stripComment(rawLines[index] ?? '')
    const rightTrimmed = withoutComment.replace(/\s+$/u, '')
    if (rightTrimmed.trim() === '') continue
    const trimmed = rightTrimmed.trim()
    if (trimmed === '---' || trimmed === '...') continue
    const leading = /^[ \t]*/u.exec(rightTrimmed)?.[0] ?? ''
    if (leading.includes('\t')) {
      throw new AssignmentFileError(file, number, 'syntax', 'tabs are not allowed in indentation; use spaces')
    }
    lines.push({ number, indent: leading.length, text: rightTrimmed.slice(leading.length) })
  }
  return lines
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote !== undefined) {
      if (quote === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}

function parseNodes(
  lines: readonly SourceLine[],
  start: number,
  file: string,
  nodes: AssignmentNode[],
  nodeLines: Map<string, number>,
): number {
  let index = start
  let baseIndent: number | undefined
  let current: NodeBuilder | undefined

  const finish = (): void => {
    if (current === undefined) return
    nodes.push({ nodeId: current.nodeId, label: current.attrs.label, endpoint: current.attrs.endpoint, line: current.line })
    current = undefined
  }

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent === 0) break
    if (baseIndent === undefined) baseIndent = line.indent

    if (current !== undefined) {
      if (line.indent <= current.indent) {
        finish()
        continue
      }
      if (current.attrIndent === undefined) current.attrIndent = line.indent
      else if (current.attrIndent !== line.indent) {
        throw new AssignmentFileError(file, line.number, 'syntax', 'inconsistent indentation inside a node entry')
      }
      const { key, value } = splitKeyValue(line, file)
      if (!NODE_KEYS.has(key)) {
        throw new AssignmentFileError(file, line.number, 'schema', `unknown node key "${key}" (supported: label, endpoint)`)
      }
      if (Object.hasOwn(current.attrs, key)) {
        throw new AssignmentFileError(file, line.number, 'schema', `duplicate node key "${key}"`)
      }
      if (value === '') {
        throw new AssignmentFileError(file, line.number, 'schema', `node key "${key}" needs a value`)
      }
      current.attrs[key] = unquote(value, file, line.number)
      index += 1
      continue
    }

    if (line.indent !== baseIndent) {
      throw new AssignmentFileError(file, line.number, 'syntax', `expected a node entry indented ${baseIndent} spaces`)
    }
    if (line.text.startsWith('-')) {
      throw new AssignmentFileError(
        file,
        line.number,
        'syntax',
        'nodes must be a mapping ("nodeId: { label, endpoint }"), not a sequence',
      )
    }

    const { key: nodeId, value } = splitKeyValue(line, file)
    if (nodeId === '') throw new AssignmentFileError(file, line.number, 'schema', 'node id must not be empty')
    const firstLine = nodeLines.get(nodeId)
    if (firstLine !== undefined) {
      throw new AssignmentFileError(file, line.number, 'schema', `duplicate node "${nodeId}" (first declared at line ${firstLine})`)
    }
    nodeLines.set(nodeId, line.number)

    if (value === '') {
      current = { nodeId, line: line.number, indent: line.indent, attrs: {} }
      index += 1
      continue
    }
    const attrs = parseFlowMapping(value, line.number, file, NODE_KEYS, 'node')
    nodes.push({ nodeId, label: attrs.label, endpoint: attrs.endpoint, line: line.number })
    index += 1
  }

  finish()
  return index
}

function parseAssignments(
  lines: readonly SourceLine[],
  start: number,
  file: string,
  assignments: AssignmentRoute[],
  workspaceLines: Map<string, number>,
): number {
  let index = start
  let baseIndent: number | undefined

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent === 0) break
    if (baseIndent === undefined) baseIndent = line.indent
    if (line.indent !== baseIndent) {
      throw new AssignmentFileError(file, line.number, 'syntax', `expected an assignment entry indented ${baseIndent} spaces`)
    }
    if (!line.text.startsWith('-')) {
      throw new AssignmentFileError(file, line.number, 'syntax', 'assignment entries must start with "-"')
    }

    const itemLine = line.number
    const after = line.text.slice(1).trim()
    const attrs: Record<string, string> = {}
    let attrIndent: number | undefined
    let inlineOnly = false
    index += 1

    if (after.startsWith('{')) {
      inlineOnly = true
      Object.assign(attrs, parseFlowMapping(after, itemLine, file, ASSIGNMENT_KEYS, 'assignment'))
    } else if (after !== '') {
      if (indexOutsideQuotes(after, ',', file, itemLine) >= 0) {
        throw new AssignmentFileError(
          file,
          itemLine,
          'syntax',
          'inline assignment fields must be wrapped in { ... } when they share a line',
        )
      }
      const entry = splitKeyValue({ number: itemLine, indent: line.indent, text: after }, file)
      if (!ASSIGNMENT_KEYS.has(entry.key)) {
        throw new AssignmentFileError(
          file,
          itemLine,
          'schema',
          `unknown assignment key "${entry.key}" (supported: workspaceId, nodeId)`,
        )
      }
      if (entry.value === '') {
        throw new AssignmentFileError(file, itemLine, 'schema', `assignment key "${entry.key}" needs a value`)
      }
      attrs[entry.key] = unquote(entry.value, file, itemLine)
    }

    while (index < lines.length && lines[index]!.indent > baseIndent) {
      const attribute = lines[index]!
      if (inlineOnly) {
        throw new AssignmentFileError(
          file,
          attribute.number,
          'syntax',
          'an inline assignment mapping cannot be followed by indented fields',
        )
      }
      if (attrIndent === undefined) attrIndent = attribute.indent
      else if (attrIndent !== attribute.indent) {
        throw new AssignmentFileError(file, attribute.number, 'syntax', 'inconsistent indentation inside an assignment entry')
      }
      const { key, value } = splitKeyValue(attribute, file)
      if (!ASSIGNMENT_KEYS.has(key)) {
        throw new AssignmentFileError(
          file,
          attribute.number,
          'schema',
          `unknown assignment key "${key}" (supported: workspaceId, nodeId)`,
        )
      }
      if (Object.hasOwn(attrs, key)) {
        throw new AssignmentFileError(file, attribute.number, 'schema', `duplicate assignment key "${key}"`)
      }
      if (value === '') {
        throw new AssignmentFileError(file, attribute.number, 'schema', `assignment key "${key}" needs a value`)
      }
      attrs[key] = unquote(value, file, attribute.number)
      index += 1
    }

    const workspaceId = attrs.workspaceId
    const nodeId = attrs.nodeId
    if (workspaceId === undefined || workspaceId === '') {
      throw new AssignmentFileError(file, itemLine, 'schema', 'assignment needs a non-empty workspaceId')
    }
    if (nodeId === undefined || nodeId === '') {
      throw new AssignmentFileError(file, itemLine, 'schema', 'assignment needs a non-empty nodeId')
    }
    const firstLine = workspaceLines.get(workspaceId)
    if (firstLine !== undefined) {
      throw new AssignmentFileError(
        file,
        itemLine,
        'schema',
        `workspace "${workspaceId}" is assigned more than once (first at line ${firstLine}); remove the duplicate or pass nodeId explicitly at dispatch time`,
      )
    }
    workspaceLines.set(workspaceId, itemLine)
    assignments.push({ workspaceId, nodeId, line: itemLine })
  }

  return index
}

function parseFlowMapping(
  raw: string,
  lineNumber: number,
  file: string,
  allowedKeys: ReadonlySet<string>,
  kind: string,
): Record<string, string> {
  const value = raw.trim()
  if (!value.startsWith('{')) {
    throw new AssignmentFileError(file, lineNumber, 'syntax', `${kind} value must be an inline mapping "{ ... }"`)
  }
  if (!value.endsWith('}')) {
    throw new AssignmentFileError(file, lineNumber, 'syntax', 'unterminated inline mapping')
  }
  const inner = value.slice(1, -1).trim()
  const attrs: Record<string, string> = {}
  if (inner === '') return attrs

  const parts = splitOutsideQuotes(inner, ',', file, lineNumber)
  for (let index = 0; index < parts.length; index += 1) {
    const text = parts[index]!.trim()
    if (text === '') {
      if (index === parts.length - 1) continue
      throw new AssignmentFileError(file, lineNumber, 'syntax', 'empty entry in an inline mapping')
    }
    const { key, value: rawValue } = splitKeyValue({ number: lineNumber, indent: 0, text }, file)
    if (!allowedKeys.has(key)) {
      throw new AssignmentFileError(
        file,
        lineNumber,
        'schema',
        `unknown ${kind} key "${key}" (supported: ${[...allowedKeys].join(', ')})`,
      )
    }
    if (Object.hasOwn(attrs, key)) {
      throw new AssignmentFileError(file, lineNumber, 'schema', `duplicate ${kind} key "${key}"`)
    }
    if (rawValue === '') {
      throw new AssignmentFileError(file, lineNumber, 'schema', `${kind} key "${key}" needs a value`)
    }
    if (rawValue.startsWith('{') || rawValue.startsWith('[')) {
      throw new AssignmentFileError(file, lineNumber, 'schema', 'nested flow collections are not supported')
    }
    attrs[key] = unquote(rawValue, file, lineNumber)
  }
  return attrs
}

function splitKeyValue(line: SourceLine, file: string): { key: string; value: string } {
  const colon = indexOutsideQuotes(line.text, ':', file, line.number)
  if (colon < 0) {
    throw new AssignmentFileError(file, line.number, 'syntax', 'expected "key: value"')
  }
  const rawKey = line.text.slice(0, colon).trim()
  if (rawKey === '') throw new AssignmentFileError(file, line.number, 'syntax', 'empty key')
  return { key: unquote(rawKey, file, line.number), value: line.text.slice(colon + 1).trim() }
}

function indexOutsideQuotes(input: string, target: string, file: string, lineNumber: number): number {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quote !== undefined) {
      if (quote === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === quote) {
        if (quote === "'" && input[index + 1] === "'") {
          index += 1
          continue
        }
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === target) return index
  }
  if (quote !== undefined) {
    throw new AssignmentFileError(file, lineNumber, 'syntax', 'unterminated quoted string')
  }
  return -1
}

function splitOutsideQuotes(input: string, separator: string, file: string, lineNumber: number): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quote !== undefined) {
      current += char
      if (quote === '"' && char === '\\') {
        index += 1
        current += input[index] ?? ''
        continue
      }
      if (char === quote) {
        if (quote === "'" && input[index + 1] === "'") {
          index += 1
          current += input[index] ?? ''
          continue
        }
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === separator) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (quote !== undefined) {
    throw new AssignmentFileError(file, lineNumber, 'syntax', 'unterminated quoted string')
  }
  parts.push(current)
  return parts
}

function unquote(raw: string, file: string, lineNumber: number): string {
  const value = raw.trim()
  if (value === '') throw new AssignmentFileError(file, lineNumber, 'schema', 'empty value')
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new AssignmentFileError(file, lineNumber, 'syntax', 'unterminated double-quoted string')
    }
    const inner = value.slice(1, -1)
    let out = ''
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index]!
      if (char === '"') {
        throw new AssignmentFileError(file, lineNumber, 'syntax', 'unescaped double quote inside a double-quoted string')
      }
      if (char !== '\\') {
        out += char
        continue
      }
      index += 1
      const escape = inner[index]
      if (escape === undefined) {
        throw new AssignmentFileError(file, lineNumber, 'syntax', 'trailing backslash in a double-quoted string')
      }
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '0': '\0',
      }
      const mapped = escapes[escape]
      if (mapped === undefined) {
        throw new AssignmentFileError(file, lineNumber, 'syntax', `unsupported escape "\\${escape}"`)
      }
      out += mapped
    }
    return out
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new AssignmentFileError(file, lineNumber, 'syntax', 'unterminated single-quoted string')
    }
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  if (value.startsWith('{') || value.startsWith('[')) {
    throw new AssignmentFileError(file, lineNumber, 'schema', 'nested flow collections are not supported in scalar values')
  }
  if (/^[&*!|>]/u.test(value)) {
    throw new AssignmentFileError(
      file,
      lineNumber,
      'schema',
      'YAML anchors, aliases, tags and block scalars are not supported; use a plain scalar',
    )
  }
  return value
}
