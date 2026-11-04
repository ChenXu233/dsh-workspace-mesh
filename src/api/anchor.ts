import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { deriveRoster } from '../roster/index.js'
import type { MeshToolRuntime } from '../tools/types.js'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import { readWorkspaceRegistry } from './workspaces.js'
import type { RegistryWorkspace, WorkspaceRegistryLike } from './workspaces.js'

/** Create a local native-workspace record for a workspace owned by another node. */
export const MESH_ANCHOR_PATH = '/api/mesh/anchor'

export interface AnchorWorkspaceRegistry extends WorkspaceRegistryLike {
  create(path: string, title?: string): RegistryWorkspace | Promise<RegistryWorkspace>
}

export interface MeshAnchorControl {
  runtime: MeshToolRuntime
  registry: WorkspaceRegistryLike | undefined | (() => WorkspaceRegistryLike | undefined)
  /** Test override; production anchors live below Windows LOCALAPPDATA. */
  root?: string
}

export interface PreparedMeshAnchor {
  ok: true
  path: string
  remoteCwd: string
  workspace: {
    workspaceId: string
    title: string
    path: string
  }
}

class AnchorTargetError extends Error {}

function defaultAnchorRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
  const base = localAppData === undefined || localAppData === '' ? join(homedir(), 'AppData', 'Local') : localAppData
  return join(base, 'dsh-mesh', 'anchors')
}

function safeNodeId(nodeId: string): string {
  // Hash the raw id: Windows folds case and strips trailing dots, and rejects reserved names.
  return createHash('sha256').update(nodeId, 'utf8').digest('hex')
}

function repositoryName(remoteCwd: string, workspaceId: string): string {
  const withoutTrailingSeparators = remoteCwd.replace(/[\\/]+$/u, '')
  return withoutTrailingSeparators.split(/[\\/]/u).pop() || workspaceId
}

async function resolveRemoteTarget(
  runtime: MeshToolRuntime,
  nodeId: string,
  workspaceId: string,
): Promise<{ remoteCwd: string; nodeLabel: string }> {
  const route = runtime.assignment?.assignments.find(
    (candidate) => candidate.workspaceId === workspaceId && candidate.nodeId === nodeId,
  )
  if (route?.cwd !== undefined && route.cwd.trim() !== '') {
    const node = runtime.assignment?.nodes.find((candidate) => candidate.nodeId === nodeId)
    return { remoteCwd: route.cwd, nodeLabel: node?.label || nodeId }
  }

  // A transport receipt can prove a target that is not in the static table.
  // deriveRoster also retains assignment-only nodes, so an absent peer is a
  // genuinely unknown node rather than a transport success invented here.
  const roster = await deriveRoster(runtime)
  const peer = roster.peers.find((candidate) => candidate.nodeId === nodeId)
  const workspace = peer?.workspaces.find((candidate) => candidate.workspaceId === workspaceId)
  if (workspace !== undefined && workspace.path.trim() !== '') {
    return { remoteCwd: workspace.path, nodeLabel: peer?.label || nodeId }
  }
  if (peer === undefined) throw new AnchorTargetError(`unknown node "${nodeId}"`)
  throw new AnchorTargetError(`unknown workspace "${workspaceId}" on node "${nodeId}"`)
}

/** Prepare the directory and metadata, then create its native registry record. */
export async function prepareMeshAnchor(
  runtime: MeshToolRuntime,
  registry: AnchorWorkspaceRegistry,
  nodeId: string,
  workspaceId: string,
  root = defaultAnchorRoot(),
): Promise<PreparedMeshAnchor> {
  const target = await resolveRemoteTarget(runtime, nodeId, workspaceId)
  const hash = createHash('sha256').update(JSON.stringify([nodeId, workspaceId, target.remoteCwd])).digest('hex')
  const anchorPath = join(root, safeNodeId(nodeId), hash)
  const metadataPath = join(anchorPath, '.dsh-remote.json')
  const metadata = { version: 1, nodeId, workspaceId, remoteCwd: target.remoteCwd }
  let existingMetadata: unknown
  try {
    existingMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`anchor metadata mismatch: ${metadataPath}`)
    }
  }
  if (existingMetadata !== undefined) {
    const existing = existingMetadata as Partial<typeof metadata>
    if (
      existingMetadata === null || typeof existingMetadata !== 'object'
      || existing.version !== metadata.version || existing.nodeId !== metadata.nodeId
      || existing.workspaceId !== metadata.workspaceId || existing.remoteCwd !== metadata.remoteCwd
    ) {
      throw new Error(`anchor metadata mismatch: ${metadataPath}`)
    }
  }

  await fs.mkdir(anchorPath, { recursive: true })
  await Promise.all([
    fs.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2) + '\n',
      'utf8',
    ),
    fs.writeFile(
      join(anchorPath, 'README.md'),
      [
        '# Remote workspace anchor',
        '',
        `Node: ${nodeId}`,
        `Workspace: ${workspaceId}`,
        `Remote cwd: ${target.remoteCwd}`,
        '',
        'This directory is only a local anchor for native workspace bookkeeping.',
        'The agent loop remains on the owning machine; this directory is not a remote mount.',
        '',
      ].join('\n'),
      'utf8',
    ),
  ])

  const title = `${repositoryName(target.remoteCwd, workspaceId)} @${target.nodeLabel}`
  const created = await registry.create(anchorPath, title)
  const id = created?.id
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') {
    throw new Error('workspaceRegistry.create did not return a workspace id')
  }
  if (typeof created.title !== 'string' || typeof created.path !== 'string') {
    throw new Error('workspaceRegistry.create did not return a workspace title and path')
  }
  return {
    ok: true,
    path: created.path,
    remoteCwd: target.remoteCwd,
    workspace: { workspaceId: String(id), title: created.title, path: created.path },
  }
}

export async function handleAnchor(request: Request, control: MeshAnchorControl): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method must be POST' }, 405)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ ok: false, error: 'body must be JSON' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
  }
  const record = body as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || record.nodeId.trim() === '') {
    return jsonResponse({ ok: false, error: 'nodeId is required' }, 400)
  }
  if (typeof record.workspaceId !== 'string' || record.workspaceId.trim() === '') {
    return jsonResponse({ ok: false, error: 'workspaceId is required' }, 400)
  }
  const registry = typeof control.registry === 'function' ? control.registry() : control.registry
  if (registry === undefined || typeof (registry as Partial<AnchorWorkspaceRegistry>).create !== 'function') {
    return jsonResponse({ ok: false, error: 'workspaceRegistry.create is not available in this composition' }, 503)
  }

  try {
    const result = await prepareMeshAnchor(
      control.runtime,
      registry as AnchorWorkspaceRegistry,
      record.nodeId,
      record.workspaceId,
      control.root,
    )
    return jsonResponse(result, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ ok: false, error: message }, err instanceof AnchorTargetError ? 404 : 500)
  }
}

/** Serve POST /api/mesh/anchor inside Connection's authenticated fence. */
export function mountMeshAnchorRoute(ctx: MeshRouteContext, control: MeshAnchorControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_ANCHOR_PATH,
    methods: ['POST'],
    fetch: async (request) => handleAnchor(request, control),
  }
  return mountExactRoute(ctx, route)
}

export function registerMeshAnchorRoute(ctx: Context, runtime: MeshToolRuntime, source: unknown = ctx): void {
  withConnection(ctx, (inner) => mountMeshAnchorRoute(inner, { runtime, registry: () => readWorkspaceRegistry(source) }))
}

/** Where the browser reads the anchors it created, so it can mark the matching rows. */
export const MESH_ANCHORS_PATH = '/api/mesh/anchors'

/** One anchor directory, as the workspace list needs to see it. */
export interface AnchorRecord {
  /** Path string the rows use: the registry's spelling, never ours. */
  path: string
  nodeId: string
  nodeLabel: string
  workspaceId: string
  remoteCwd: string
}

/**
 * Path identity. On Windows a registry path and a directory we built ourselves
 * can name the same anchor while differing in case, and both separators survive
 * in realpaths.
 */
function pathKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Operator-facing node name, falling back to the id the metadata recorded. */
function nodeLabel(runtime: MeshToolRuntime, nodeId: string): string {
  const node = runtime.assignment?.nodes.find((candidate) => candidate.nodeId === nodeId)
  return node?.label || nodeId
}

/**
 * Read every anchor below `root`.
 *
 * The directory scan finds what exists; the registry then decides which path
 * string a row will actually show, because `create()` records a realpath and
 * that is the only spelling the browser can match.
 */
export async function readMeshAnchors(
  runtime: MeshToolRuntime,
  registry: WorkspaceRegistryLike | undefined,
  root = defaultAnchorRoot(),
): Promise<AnchorRecord[]> {
  const known = new Map<string, string>()
  for (const item of registry?.list() ?? []) {
    if (typeof item.path === 'string' && item.path !== '') known.set(pathKey(item.path), item.path)
  }

  let nodeDirs: string[]
  try {
    nodeDirs = await fs.readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const records: AnchorRecord[] = []
  for (const nodeDir of nodeDirs) {
    const nodePath = join(root, nodeDir)
    let anchorDirs: string[]
    try {
      anchorDirs = await fs.readdir(nodePath)
    } catch {
      continue
    }
    for (const anchorDir of anchorDirs) {
      const anchorPath = join(nodePath, anchorDir)
      let raw: string
      try {
        raw = await fs.readFile(join(anchorPath, '.dsh-remote.json'), 'utf8')
      } catch {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      const metadata = parsed as Partial<Record<'nodeId' | 'workspaceId' | 'remoteCwd', unknown>>
      if (
        typeof metadata.nodeId !== 'string' || metadata.nodeId === ''
        || typeof metadata.workspaceId !== 'string' || metadata.workspaceId === ''
        || typeof metadata.remoteCwd !== 'string'
      ) continue
      records.push({
        path: known.get(pathKey(anchorPath)) ?? anchorPath,
        nodeId: metadata.nodeId,
        nodeLabel: nodeLabel(runtime, metadata.nodeId),
        workspaceId: metadata.workspaceId,
        remoteCwd: metadata.remoteCwd,
      })
    }
  }
  return records
}

export async function handleAnchors(request: Request, control: MeshAnchorControl): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ ok: false, error: 'method must be GET' }, 405)
  const registry = typeof control.registry === 'function' ? control.registry() : control.registry
  try {
    return jsonResponse({ ok: true, anchors: await readMeshAnchors(control.runtime, registry, control.root) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ ok: false, error: message }, 500)
  }
}

/** Serve GET /api/mesh/anchors inside Connection's authenticated fence. */
export function mountMeshAnchorsRoute(ctx: MeshRouteContext, control: MeshAnchorControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_ANCHORS_PATH,
    methods: ['GET'],
    fetch: async (request) => handleAnchors(request, control),
  }
  return mountExactRoute(ctx, route)
}

export function registerMeshAnchorsRoute(ctx: Context, runtime: MeshToolRuntime, source: unknown = ctx): void {
  withConnection(ctx, (inner) => mountMeshAnchorsRoute(inner, { runtime, registry: () => readWorkspaceRegistry(source) }))
}
