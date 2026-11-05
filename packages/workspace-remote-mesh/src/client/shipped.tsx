import { useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryKitSources } from 'dsh-proton/client'

/** The seat whose shipped occupant this package feeds proton. */
const SEAT = 'sidebar.workspaces'

/** Observable source the host would expose as a selector hook. */
interface ObservableLike<T = unknown> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
/** Observable face of the workspace controller's list. */
interface WorkspaceListSource extends ObservableLike<unknown> {}
/** Locale service face: it binds a namespace to the stable translate seat. */
interface LocaleLike {
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}
/** The slice of the client context this package reads. */
interface RawEntry {
  component: unknown
  locale?: string
  registrant?: string | undefined
  store?: { create?: () => { getSnapshot?: () => unknown, subscribe?: (fn: () => void) => () => void, actions?: unknown } }
}

/**
 * One-level structural comparison, so a rebuilt snapshot is not mistaken for a
 * state change.
 * @param left - previous value.
 * @param right - candidate value.
 * @returns true when both have the same leaves.
 */
function shallowSame(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => key in b && a[key] === b[key])
}

const hookCache = new WeakMap<ObservableLike, (selector: (snapshot: never) => unknown) => unknown>()

/**
 * Selector hook for a source, bound once.
 *
 * The subscribe/getSnapshot pair must not be rebuilt per render: a source that
 * notifies on subscribe turns a fresh pair into an unbounded render loop.
 * @param source - observable with snapshot + subscribe.
 * @returns a stable selector hook.
 */
function selectorHook(source: WorkspaceListSource) {
  const cached = hookCache.get(source)
  if (cached !== undefined) return cached
  const built = function useSelector<T>(selector: (snapshot: never) => T): T {
    const subscribe = useRef((listener: () => void) => source.subscribe(listener)).current
    const holder = useRef<{ raw: unknown, selected: T } | undefined>(undefined)
    const selectorRef = useRef(selector)
    selectorRef.current = selector
    const getSnapshot = useRef((): T => {
      const raw = source.getSnapshot()
      const held = holder.current
      if (held !== undefined && held.raw === raw) return held.selected
      const selected = selectorRef.current(raw as never)
      if (held !== undefined && shallowSame(held.selected, selected)) {
        holder.current = { raw, selected: held.selected }
        return held.selected
      }
      holder.current = { raw, selected }
      return selected
    }).current
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
  hookCache.set(source, built)
  return built
}

const storeInstances = new WeakMap<RawEntry, { useStore: unknown, actions: unknown }>()

/**
 * Bind an entry's declared store into the two props the host would hand over.
 * @param entry - the entry declaring the store.
 * @returns `useStore` and `actions`, or undefined when the seat has no store.
 */
function storeSeat(entry: RawEntry): { useStore: unknown, actions: unknown } | undefined {
  // One instance per entry: creating a store per render resubscribes every frame.
  const cached = storeInstances.get(entry)
  if (cached !== undefined) return cached
  const decl = entry.store
  if (decl === undefined || typeof decl.create !== 'function') return undefined
  const instance = decl.create()
  if (typeof instance.getSnapshot !== 'function' || typeof instance.subscribe !== 'function') return undefined

  function useStore<T>(selector: (snapshot: never) => T): T {
    const holder = useRef<{ raw: unknown, selected: T } | undefined>(undefined)
    const selectorRef = useRef(selector)
    selectorRef.current = selector
    const subscribe = useRef((listener: () => void) => instance.subscribe!(listener)).current
    const getSnapshot = useRef((): T => {
      const raw = instance.getSnapshot!()
      const held = holder.current
      if (held !== undefined && held.raw === raw) return held.selected
      const selected = selectorRef.current(raw as never)
      if (held !== undefined && shallowSame(held.selected, selected)) {
        holder.current = { raw, selected: held.selected }
        return held.selected
      }
      holder.current = { raw, selected }
      return selected
    }).current
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  const bound = { useStore, actions: instance.actions }
  storeInstances.set(entry, bound)
  return bound
}

/**
 * Claim one entry and describe the kit the host renderer would have synthesized.
 *
 * Proton asks its providers in order; the first that answers draws the entry
 * through the entry face. This package claims the workspace namespace — the
 * shipped browser declares it.
 * @param ctx - client root context.
 * @param entry - the entry the outlet shadowed.
 * @returns kit sources, or undefined when this entry is not ours to draw.
 */
export function workspaceEntrySources(ctx: Context, entry: unknown): EntryKitSources | undefined {
  const declared = entry as RawEntry
  if (declared.locale !== 'workspace') return undefined
  const locale = (ctx as unknown as { locale?: LocaleLike }).locale
  const workspaces = (ctx as unknown as { workspaces?: { list: WorkspaceListSource } }).workspaces

  return {
    standard: workspaces === undefined ? {} : { useWorkspaces: selectorHook(workspaces.list) },
    // The host synthesizes this seat from the declared namespace; the locale
    // service binds the same stable function, so keys and fallbacks agree.
    translate: namespace => (locale === undefined ? (key: string) => key : locale.bind(namespace)),
    storeOf: candidate => storeSeat(candidate as RawEntry),
  }
}
