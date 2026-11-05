import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryKitSources } from 'dsh-proton/client'
import zh from '../../vendor/ui-workspace/locale/zh.json'
import en from '../../vendor/ui-workspace/locale/en.json'

/** The seat whose shipped occupant this package wants to render. */
const SEAT = 'sidebar.workspaces'

/** Minimal shape of the pieces we read from the client context. */
interface RawSlots {
  entries(key: string): readonly RawEntry[]
}
interface RawEntry {
  component: unknown
  options?: { id?: string }
  registrant?: string | undefined
}
interface WorkspaceListSource {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}
interface LocaleLike {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

/**
 * Wrap one observable as the selector hook the shipped component expects
 * (`useWorkspaces((state) => state)`).
 * @param source - observable with snapshot + subscribe.
 * @returns a selector hook.
 */
function selectorHook(source: WorkspaceListSource) {
  return function useSelected<T>(selector: (snapshot: never) => T): T {
    return useSyncExternalStore(
      listener => source.subscribe(listener),
      () => selector(source.getSnapshot() as never),
      () => selector(source.getSnapshot() as never),
    )
  }
}

/**
 * Build a `t` for the namespace the shipped entry declares.
 *
 * The host synthesizes this from its locale face. We cannot reach that face, but
 * the dictionaries ship with the vendored package, so translate from them and
 * read only the active locale id from the public locale service.
 * @param locale - client locale service.
 * @param namespace - the namespace the entry declared.
 * @returns a translate function.
 */
function translator(locale: LocaleLike | undefined, namespace: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const active = locale?.getSnapshot().active ?? 'zh'
    const dict = dictFor(namespace, active)
    const template = dict[key] ?? dictFor(namespace, 'en')[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}

/**
 * Pick the dictionary for one namespace and language.
 * @param namespace - declared namespace.
 * @param language - active locale id.
 * @returns flat key to template.
 */
function dictFor(namespace: string, language: string): Record<string, string> {
  if (namespace !== 'workspace') return {}
  return (language.startsWith('zh') ? zh : en) as unknown as Record<string, string>
}

/**
 * Find the entry the host itself would have rendered into the seat: everything
 * in it except our own wrapper.
 * @param ctx - client root context.
 * @param self - our wrapper component identity.
 * @returns the shipped entry, or undefined before it registers.
 */
function shippedEntry(ctx: Context, self: unknown): RawEntry | undefined {
  const slots = ctx.slots as unknown as RawSlots
  return slots.entries(SEAT).find(entry => entry.component !== self)
}

/**
 * Render the shipped workspace browser through the proton entry face.
 *
 * Nothing here is vendored UI: this is the host's own component, drawn with the
 * props the host would have given it.
 * @param props.ctx - client root context.
 * @param props.self - our wrapper component identity, excluded from the lookup.
 * @param props.onError - surfaces a render failure instead of a blank region.
 * @returns the shipped browser, or a message while it is missing.
 */
export function ShippedWorkspaceList({ ctx, self, onError }: {
  ctx: Context
  self: unknown
  onError: (message: string) => ReactNode
}): ReactNode {
  const shipped = shippedEntry(ctx, self)
  const locale = (ctx as unknown as { locale?: LocaleLike }).locale
  const workspaces = (ctx as unknown as { workspaces?: { list: WorkspaceListSource } }).workspaces

  const sources: EntryKitSources = {
    standard: workspaces === undefined ? {} : { useWorkspaces: selectorHook(workspaces.list) },
    translate: namespace => translator(locale, namespace),
    storeOf: entry => storeSeat(entry),
  }

  if (shipped === undefined) return onError('还没有可渲染的官方工作区列表')
  try {
    return (ctx as unknown as { proton: { entryFace(entry: unknown, sources: EntryKitSources): ReactNode } })
      .proton.entryFace(shipped, sources)
  } catch (error) {
    return onError('entry face: ' + String(error instanceof Error ? error.message : error))
  }
}

/**
 * Resolve an entry's declared store into the two props the host binds.
 * @param entry - the entry declaring the store.
 * @returns the bound pair, or undefined when the seat has no `create`.
 */
function storeSeat(entry: RawEntry): { useStore: unknown, actions: unknown } | undefined {
  const decl = (entry as unknown as { store?: { create?: () => unknown } }).store
  if (decl === undefined || typeof decl.create !== 'function') return undefined
  const instance = decl.create() as { getSnapshot?: () => unknown, subscribe?: (fn: () => void) => () => void, actions?: unknown }
  if (typeof instance.getSnapshot !== 'function' || typeof instance.subscribe !== 'function') return undefined
  const useStore = (selector: (snapshot: never) => unknown) => useSyncExternalStore(
    listener => instance.subscribe!(listener),
    () => selector(instance.getSnapshot!() as never),
    () => selector(instance.getSnapshot!() as never),
  )
  return { useStore, actions: instance.actions }
}
