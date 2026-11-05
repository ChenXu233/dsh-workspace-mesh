import type { MeshGraph, NodeKind } from './model.js'

/**
 * Force-directed layout for the topology canvas.
 *
 * Pure maths, no DOM and no timers: the canvas drives it with requestAnimationFrame
 * and the tests drive it with a plain loop. Determinism is deliberate — the start
 * ring is derived from node order, so the same payload always settles the same
 * way and a screenshot is reproducible.
 */

export interface LayoutNode {
  id: string
  kind: NodeKind
  x: number
  y: number
  vx: number
  vy: number
  /** Pinned position while the user drags; null when free. */
  fixedX: number | null
  fixedY: number | null
  radius: number
}

export interface LayoutPoint {
  x: number
  y: number
}

export interface LayoutOptions {
  width?: number
  height?: number
  /** Nodes the user already placed, kept where they are. */
  pinned?: Record<string, LayoutPoint>
}

export interface ForceLayout {
  nodes: LayoutNode[]
  alpha: number
  /** One integration step; call ~60×/s until settled(). */
  step(): void
  /** True once the simulation has cooled down; the canvas can stop the loop. */
  settled(): boolean
  positions(): Record<string, LayoutPoint>
  pin(id: string, x: number, y: number): void
  release(id: string): void
  releaseAll(): void
  pinned(): Record<string, LayoutPoint>
}

export const DEFAULT_WIDTH = 720
export const DEFAULT_HEIGHT = 420

/** Node radius in canvas pixels, by layer. */
export function radiusOf(kind: NodeKind): number {
  if (kind === 'self') return 11
  if (kind === 'peer') return 7.5
  if (kind === 'workspace') return 5
  return 4
}

/** Desired link length by layer: the hub fans out, leaves stay close to their owner. */
const LINK_LENGTH: Record<NodeKind, number> = {
  self: 150,
  peer: 168,
  workspace: 80,
  task: 64,
}

/** Where a layer sits, as a fraction of the canvas radius (x and y differ). */
const RING: Record<NodeKind, number> = {
  self: 0,
  peer: 0.56,
  workspace: 0.82,
  task: 1.04,
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}

/**
 * Deterministic start: the hub sits in the middle, each layer starts on its own
 * ring, and nodes are spread by their index inside the layer.
 */
function seedPositions(graph: MeshGraph, width: number, height: number): LayoutNode[] {
  const cx = width / 2
  const cy = height / 2
  const radiusX = width * 0.36
  const radiusY = height * 0.4

  const byKind: Record<NodeKind, string[]> = { self: [], peer: [], workspace: [], task: [] }
  for (const node of graph.nodes) byKind[node.kind].push(node.id)

  // A workspace belongs to one peer and a task to one workspace; seeding each
  // layer around its parent's angle is what keeps the drawing a tree instead of
  // a ball of crossing lines.
  const parentOf = new Map<string, string>()
  for (const edge of graph.edges) {
    if (edge.kind === 'workspace' || edge.kind === 'task') parentOf.set(edge.to, edge.from)
  }
  const angleOf = new Map<string, number>()

  const spread = (ids: string[], parentId: string, width: number, lean = 0): void => {
    const base = (angleOf.get(parentId) ?? -Math.PI / 2) + lean
    const step = width / Math.max(ids.length, 1)
    const first = base - (width * (ids.length - 1)) / (2 * Math.max(ids.length, 1))
    for (let index = 0; index < ids.length; index += 1) angleOf.set(ids[index]!, first + step * index)
  }

  const groupByParent = (kind: 'workspace' | 'task'): Map<string, string[]> => {
    const groups = new Map<string, string[]>()
    for (const id of [...byKind[kind]].sort()) {
      const parent = parentOf.get(id) ?? ''
      const list = groups.get(parent)
      if (list === undefined) groups.set(parent, [id])
      else list.push(id)
    }
    return groups
  }

  const workspaceGroups = groupByParent('workspace')
  const taskGroups = groupByParent('task')

  // Peers share the circle evenly; each peer's children fan out around its own
  // angle with a capped spread, so a heavy subtree cannot squeeze the others.
  const peers = [...byKind.peer].sort()
  for (let index = 0; index < peers.length; index += 1) {
    angleOf.set(peers[index]!, (index / Math.max(peers.length, 1)) * Math.PI * 2)
  }

  for (const [parent, ids] of workspaceGroups) {
    spread(ids, parent, Math.min(1.25, 0.36 * ids.length))
  }

  for (const [parent, ids] of taskGroups) {
    spread(ids, parent, Math.min(0.62, 0.2 * ids.length), 0.09)
  }

  const ringOf: Record<NodeKind, number> = { self: 0, peer: 0.56, workspace: 0.82, task: 1.04 }
  return graph.nodes.map((node) => {
    const ring = ringOf[node.kind]
    const angle = angleOf.get(node.id) ?? -Math.PI / 2
    const x = ring === 0 ? cx : cx + Math.cos(angle) * radiusX * ring
    const y = ring === 0 ? cy : cy + Math.sin(angle) * radiusY * ring
    return {
      id: node.id,
      kind: node.kind,
      x,
      y,
      vx: 0,
      vy: 0,
      fixedX: null,
      fixedY: null,
      radius: radiusOf(node.kind),
    }
  })
}

/**
 * Build one simulation for one graph. The caller owns the clock: \`step()\` is
 * cheap enough for 60 fps with the node counts a mesh roster produces.
 */
export function createForceLayout(graph: MeshGraph, options: LayoutOptions = {}): ForceLayout {
  const width = options.width ?? DEFAULT_WIDTH
  const height = options.height ?? DEFAULT_HEIGHT
  const nodes = seedPositions(graph, width, height)
  const byId = new Map(nodes.map((node) => [node.id, node]))

  for (const [id, point] of Object.entries(options.pinned ?? {})) {
    const node = byId.get(id)
    if (node === undefined) continue
    node.fixedX = point.x
    node.fixedY = point.y
    node.x = point.x
    node.y = point.y
  }

  const springs: Array<{ a: LayoutNode; b: LayoutNode; length: number }> = []
  for (const edge of graph.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (a === undefined || b === undefined) continue
    springs.push({ a, b, length: LINK_LENGTH[b.kind] })
  }

  const cx = width / 2
  const cy = height / 2
  const radiusX = width * 0.36
  const radiusY = height * 0.4
  const charge = Math.sqrt((width * height) / Math.max(nodes.length, 2)) * 0.9
  const padding = 26

  const state = {
    nodes,
    alpha: 1,
    step(): void {
      const alpha = state.alpha
      for (const node of nodes) {
        node.vx *= 0.82
        node.vy *= 0.82
      }

      // Repulsion plus collision: every pair, cheap at roster sizes.
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i]!
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j]!
          let dx = b.x - a.x
          let dy = b.y - a.y
          let distance = Math.sqrt(dx * dx + dy * dy)
          if (distance < 0.001) {
            // Coincident points must not divide by zero or stay glued.
            dx = (j - i) * 0.5
            dy = 0.5
            distance = Math.sqrt(dx * dx + dy * dy)
          }
          const ux = dx / distance
          const uy = dy / distance
          const repulsion = (charge * charge) / distance * 0.007 * (0.3 + alpha)
          a.vx -= ux * repulsion
          a.vy -= uy * repulsion
          b.vx += ux * repulsion
          b.vy += uy * repulsion

          const minimum = a.radius + b.radius + 22
          if (distance < minimum) {
            const overlap = (minimum - distance) * 0.35
            a.vx -= ux * overlap
            a.vy -= uy * overlap
            b.vx += ux * overlap
            b.vy += uy * overlap
          }
        }
      }

      for (const spring of springs) {
        const dx = spring.b.x - spring.a.x
        const dy = spring.b.y - spring.a.y
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.001
        const force = (distance - spring.length) * 0.022
        const ux = dx / distance
        const uy = dy / distance
        spring.a.vx += ux * force
        spring.a.vy += uy * force
        spring.b.vx -= ux * force
        spring.b.vy -= uy * force
      }

      // Radial target per layer, expressed in ellipse-normalised space so the
      // force has no tangential component: pulling toward an ellipse point would
      // slowly drag every node onto the horizontal axis.
      for (const node of nodes) {
        const ring = RING[node.kind]
        if (ring === 0) {
          node.vx += (cx - node.x) * 0.05
          node.vy += (cy - node.y) * 0.05
          continue
        }
        const nx = (node.x - cx) / radiusX
        const ny = (node.y - cy) / radiusY
        const norm = Math.sqrt(nx * nx + ny * ny) || 0.0001
        const delta = ring - norm
        node.vx += (nx / norm) * radiusX * delta * 0.08
        node.vy += (ny / norm) * radiusY * delta * 0.08
      }

      for (const node of nodes) {
        if (node.fixedX !== null && node.fixedY !== null) {
          node.x = node.fixedX
          node.y = node.fixedY
          node.vx = 0
          node.vy = 0
          continue
        }
        // Soft walls: without them the clamp alone glues nodes to the border.
        const inset = 34;
        if (node.x < inset) node.vx += (inset - node.x) * 0.16;
        if (node.x > width - inset) node.vx -= (node.x - (width - inset)) * 0.16;
        if (node.y < inset) node.vy += (inset - node.y) * 0.16;
        if (node.y > height - inset) node.vy -= (node.y - (height - inset)) * 0.16;

        const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy)
        const cap = 12
        if (speed > cap) {
          node.vx = (node.vx / speed) * cap
          node.vy = (node.vy / speed) * cap
        }
        node.x = clamp(node.x + node.vx, padding, width - padding)
        node.y = clamp(node.y + node.vy, padding, height - padding)
      }

      state.alpha = Math.max(state.alpha * 0.94, 0.002)
    },
    settled(): boolean {
      return state.alpha <= 0.03
    },
    positions(): Record<string, LayoutPoint> {
      const out: Record<string, LayoutPoint> = {}
      for (const node of nodes) out[node.id] = { x: node.x, y: node.y }
      return out
    },
    pin(id: string, x: number, y: number): void {
      const node = byId.get(id)
      if (node === undefined) return
      node.fixedX = x
      node.fixedY = y
      node.x = x
      node.y = y
      node.vx = 0
      node.vy = 0
      // A pin is a user statement, so give the rest of the graph a chance to move.
      state.alpha = Math.max(state.alpha, 0.35)
    },
    release(id: string): void {
      const node = byId.get(id)
      if (node === undefined) return
      node.fixedX = null
      node.fixedY = null
      state.alpha = Math.max(state.alpha, 0.35)
    },
    releaseAll(): void {
      for (const node of nodes) {
        node.fixedX = null
        node.fixedY = null
      }
      state.alpha = Math.max(state.alpha, 0.6)
    },
    pinned(): Record<string, LayoutPoint> {
      const out: Record<string, LayoutPoint> = {}
      for (const node of nodes) {
        if (node.fixedX !== null && node.fixedY !== null) out[node.id] = { x: node.fixedX, y: node.fixedY }
      }
      return out
    },
  }

  return state
}
