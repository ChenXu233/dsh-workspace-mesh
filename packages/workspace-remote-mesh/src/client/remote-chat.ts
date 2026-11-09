/**
 * Assemble a peer event log into the shipped Chat snapshot.
 *
 * The Chat renderer is a pure function of (event window, registered node/view
 * definitions). Both halves already exist in this client: the definitions are
 * registered by the official Chat package, and the assembler is a plain class.
 * A conversation page therefore needs no renderer of its own — only a second
 * assembler fed from the other machine's log.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteEvent } from './remote-session'

/** One durable event in the window shape the assembler consumes. */
interface EventEntry {
  readonly type: 'event'
  readonly event: RemoteEvent
}

/** The Chat view's snapshot, structurally (the package owns the real type). */
interface ChatNodeLike {
  readonly kind?: string
  readonly key?: string
  readonly [key: string]: unknown
}

interface NodeSourceLike {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

interface ChatSnapshotLike {
  readonly order: readonly string[]
  readonly nodes: {
    get(key: string): ChatNodeLike | undefined
    source(key: string): NodeSourceLike
    bottomSource(key: string): NodeSourceLike
    processSource(key: string): NodeSourceLike
  }
  readonly navigation: { items(): readonly { anchorKey?: string }[] }
}

const EMPTY_SNAPSHOT: ChatSnapshotLike = {
  order: [],
  nodes: {
    get: () => undefined,
    source: () => absentSource(),
    bottomSource: () => absentSource(),
    processSource: () => absentSource(),
  },
  navigation: { items: () => [] },
}

const ABSENT_SOURCE: NodeSourceLike = { getSnapshot: () => undefined, subscribe: () => () => {} }
function absentSource(): NodeSourceLike {
  return ABSENT_SOURCE
}

/** The assembler registries this client already holds. */
interface ConversationRegistries {
  events: { subscribe(listener: () => void): () => void }
  views: { subscribe(listener: () => void): () => void }
  groups: { subscribe(listener: () => void): () => void }
}

/** One page's live assembly. */
export interface RemoteChatView {
  /** Props for the shipped ChatFlow entry: one selector hook per data source. */
  readonly hooks: Readonly<Record<string, unknown>>
  /**
   * Replace the assembled window.
   * @param events - the peer's events, ascending.
   * @param hasMore - whether older events exist.
   */
  replace(events: readonly RemoteEvent[], hasMore: boolean): void
  /** @returns the current Chat snapshot, or undefined before the first window. */
  snapshot(): ChatSnapshotLike | undefined
  /** @returns unsubscribe. */
  subscribe(listener: () => void): () => void
  dispose(): void
}

/**
 * Create one page-local assembler over the shipped definitions.
 *
 * The assembler is instance-private: contexts, views, groups and the published
 * snapshot all belong to this window, so a second one never touches the
 * official Session bindings.
 * @param ctx - client root context (only `uiConversation` is read).
 * @returns the page's live assembly.
 */
export function createRemoteChatView(ctx: Context): RemoteChatView {
  const conversation = (ctx as unknown as { uiConversation?: ConversationRegistries }).uiConversation
  if (conversation === undefined) throw new Error('remote-mesh: uiConversation is not available')
  const assembler = new ConversationNodeAssembler(
    conversation.events as never,
    conversation.views as never,
    conversation.groups as never,
  )
  const listeners = new Set<() => void>()
  let current: ChatSnapshotLike | undefined
  let activated = false

  const publish = (): void => {
    const next = assembler.get('chat' as never) as unknown as ChatSnapshotLike | undefined
    if (next === undefined) return
    current = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[remote-mesh] chat subscriber failed:', error)
      }
    }
  }

  // A definition registered later (a plugin loading after this page opened)
  // must reach the page too, exactly as it reaches every official Session.
  const disposers = [conversation.events, conversation.views, conversation.groups].map(registry => registry.subscribe(() => {
    assembler.rebuildRegistry()
    assembler.flush()
    publish()
  }))

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const getSnapshot = (): ChatSnapshotLike => current ?? EMPTY_SNAPSHOT

  const useSnapshot = (): ChatSnapshotLike => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  function useNodeValue<T>(
    source: (snapshot: ChatSnapshotLike) => NodeSourceLike,
    selector: ((value: unknown) => T) | undefined,
  ): T | undefined {
    const snapshot = useSnapshot()
    const observable = source(snapshot)
    const value = useObservable(observable)
    return selector === undefined ? value as T | undefined : selector(value)
  }

  const hooks: Record<string, unknown> = {
    // The renderer selects off the snapshot; identity only moves when the
    // assembler publishes, which is what its memo deps compare.
    useChat: (selector?: (snapshot: ChatSnapshotLike) => unknown) => {
      const snapshot = useSnapshot()
      return selector === undefined ? snapshot : selector(snapshot)
    },
    useChatNode: (key: string, selector?: (value: unknown) => unknown) =>
      useNodeValue(snapshot => snapshot.nodes.source(key), selector),
    useChatNodeBottom: (key: string, selector?: (value: unknown) => unknown) =>
      useNodeValue(snapshot => snapshot.nodes.bottomSource(key), selector),
    useChatNodeProcess: (key: string, selector?: (value: unknown) => unknown) =>
      useNodeValue(snapshot => snapshot.nodes.processSource(key), selector),
    // Rows render from an explicit flat order (see the page), so no group
    // source is ever read.
    useChatGroup: () => undefined,
  }

  return {
    hooks,
    replace(events, hasMore) {
      const entries: EventEntry[] = events.map(event => ({ type: 'event', event }))
      assembler.replaceWindow(entries as never, hasMore)
      if (!activated) {
        // The view target only materializes after activation; the first window
        // is also the first publish.
        assembler.activateTarget('chat' as never)
        activated = true
      }
      assembler.flush()
      publish()
    },
    snapshot: () => current,
    subscribe,
    dispose() {
      for (const dispose of disposers) dispose()
      listeners.clear()
    },
  }
}

/** Subscribe one observable source to React. */
function useObservable<T>(source: NodeSourceLike | undefined): T | undefined {
  const held = source ?? ABSENT_SOURCE
  const subscribe = useMemo(() => (listener: () => void) => held.subscribe(listener), [held])
  const getSnapshot = useMemo(() => () => held.getSnapshot() as T | undefined, [held])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Assemble one page's events into the Chat snapshot, following live updates.
 * @param ctx - client root context.
 * @param events - the peer's events, ascending by seq.
 * @param hasMore - whether older events exist.
 * @returns the live view, stable for as long as the page is mounted.
 */
export function useRemoteChatView(
  ctx: Context,
  events: readonly RemoteEvent[],
  hasMore: boolean,
): RemoteChatView {
  const view = useMemo(() => createRemoteChatView(ctx), [ctx])
  useEffect(() => () => { view.dispose() }, [view])
  useEffect(() => {
    // An empty window is a blank page, not an assembly: replaceWindow would
    // clear whatever the view already published.
    if (events.length === 0) return
    view.replace(events, hasMore)
  }, [view, events, hasMore])
  return view
}