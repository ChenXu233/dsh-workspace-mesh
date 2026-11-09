/**
 * The remote conversation page.
 *
 * Two seats of the shipped conversation are shadowed while a dispatch target is
 * set: the session header and the transcript area. Both draw the shipped entry
 * when no target is set, so this machine's conversation is byte-for-byte the
 * official one; with a target, the header names the peer and the transcript is
 * the peer Session's log assembled by the shipped Chat definitions.
 *
 * The composer is not touched: the shipped bar already routes its submit to the
 * peer (the adapter's tap), and its draft/machine is the one the page keeps.
 */
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearDispatchTarget } from './dispatch-target'
import type { DispatchTarget } from './dispatch-target'
import { useRemoteChatView } from './remote-chat'
import type { RemoteChatView } from './remote-chat'
import { setShellSession, useRemotePageState } from './remote-session'
import type { RemotePageState } from './remote-session'
import type { RemoteTranslate } from './locales'

/** The slot registry slice this module reads. */
interface SlotSeat {
  entriesOfSlot(key: string): readonly StoredEntryLike[]
}

/** One registration, as this module uses it. */
interface StoredEntryLike {
  readonly component: unknown
  readonly options?: { readonly id?: string; readonly key?: string; readonly priority?: number }
  readonly store?: { create?: () => { getSnapshot(): unknown, subscribe(listener: () => void): () => void, actions?: Record<string, unknown> } }
  readonly locale?: string
  readonly children?: Record<string, unknown>
  readonly inject?: unknown
}

/** Kit sources for one entry drawn outside the host renderer. */
interface KitSources {
  standard?: Record<string, unknown>
  translate?: (namespace: string) => unknown
  storeOf?: (entry: StoredEntryLike, sessionId?: string) => { useStore: unknown, actions: unknown } | undefined
  scope?: { sessionId?: string | undefined }
  owner?: Record<string, unknown>
  hookContext?: unknown
  /** Wrap the assembled kit before the entry receives it. */
  kitTap?: (kit: Record<string, unknown>) => Record<string, unknown>
}

/** One seat proton should shadow on this package's behalf. */
export interface ProtonOutlet {
  readonly slot: string
  readonly region: string
  readonly priority?: number
  readonly children?: Record<string, unknown>
  readonly render?: (entry: StoredEntryLike, owner: Record<string, unknown>) => ReactNode
  readonly alwaysShadow?: boolean
}

/** The proton service: entry drawing plus seat shadowing. */
export interface ProtonSeat {
  entryFace(entry: StoredEntryLike, sources?: KitSources): ReactNode
  connect(outlets: readonly ProtonOutlet[], options?: { split?: unknown }): () => void
}

/**
 * Read the proton service without a hard package dependency (this bundle only
 * declares the runtime name; the composition may or may not carry proton).
 * @param ctx - client root context.
 * @returns the service, when the composition has one.
 */
export function protonOf(ctx: Context): ProtonSeat | undefined {
  return (ctx as unknown as { proton?: ProtonSeat }).proton
}

/** User-facing copy the page adds on top of the shipped strings. */
export interface RemotePageCopy {
  readonly node: string
  readonly workspace: string
  readonly session: string
  readonly back: string
  readonly empty: string
  readonly emptyHint: string
  readonly running: string
  readonly failed: string
}

/** Services and copy one page render needs. */
export interface RemotePageContext {
  readonly ctx: Context
  readonly t: RemoteTranslate
}

/** Owner props the shipped seats hand their occupants. */
type SeatOwner = Record<string, unknown>

/** Standard (root-provided) props among a seat's occupant props. */
export function standardOf(owner: SeatOwner): Record<string, unknown> {
  const standard: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(owner)) {
    if (/^use[A-Z]/u.test(key) || key === 'renderFactorySlot' || key === 'sessionId') standard[key] = value
  }
  return standard
}

/**
 * The render-site owner props of a seat, without the standard kit.
 *
 * A shadowing outlet receives the host's whole kit (hooks, translator, slot
 * faces) as its props; those belong in `standard`, not in the entry's owner
 * props — the owner props are spread last and would undo a kit tap.
 * @param owner - the outlet's props.
 * @returns the seat-specific props only.
 */
export function seatPropsOf(owner: SeatOwner): Record<string, unknown> {
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(owner)) {
    if (/^use[A-Z]/u.test(key)) continue
    if (key === 'renderFactorySlot' || key === 'renderSlot' || key === 'renderSlotChain') continue
    if (key === 'useStore' || key === 'actions' || key === 't') continue
    own[key] = value
  }
  return own
}

const storeInstances = new WeakMap<object, Map<string, { useStore: unknown, actions: unknown }>>()

/**
 * Bind an entry's declared store exactly once per (entry, session).
 *
 * The host keeps one instance per scope; rebuilding it per render would reset
 * the transcript's fold state on every frame.
 * @param entry - the entry declaring the store.
 * @param sessionId - session scope the instance belongs to.
 * @returns `useStore` and `actions`, or undefined when the seat has no store.
 */
export function storeSeat(entry: StoredEntryLike, sessionId?: string): { useStore: unknown, actions: unknown } | undefined {
  const decl = entry.store
  if (decl === undefined || typeof decl.create !== 'function') return undefined
  const scopeKey = sessionId ?? ''
  let perEntry = storeInstances.get(entry as object)
  if (perEntry === undefined) {
    perEntry = new Map()
    storeInstances.set(entry as object, perEntry)
  }
  const cached = perEntry.get(scopeKey)
  if (cached !== undefined) return cached
  const instance = decl.create()
  if (instance === undefined || typeof instance.getSnapshot !== 'function' || typeof instance.subscribe !== 'function') {
    return undefined
  }
  function useStore<T>(selector: (snapshot: unknown) => T): T {
    const holder = useRef<{ raw: unknown, selected: T } | undefined>(undefined)
    const selectorRef = useRef(selector)
    selectorRef.current = selector
    const subscribe = useMemo(() => (listener: () => void) => instance.subscribe(listener), [])
    const getSnapshot = useMemo(() => (): T => {
      const raw = instance.getSnapshot()
      const held = holder.current
      if (held !== undefined && held.raw === raw) return held.selected
      const selected = selectorRef.current(raw)
      holder.current = { raw, selected }
      return selected
    }, [])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
  const bound = { useStore, actions: instance.actions }
  perEntry.set(scopeKey, bound)
  return bound
}

/** Find one registered entry by slot and (for keyed/list seats) identity. */
export function findEntry(ctx: Context, slot: string, id?: string): StoredEntryLike | undefined {
  const slots = (ctx as unknown as { slots?: SlotSeat }).slots
  const entries = slots?.entriesOfSlot(slot) ?? []
  if (id === undefined) return entries[0]
  return entries.find(entry => entry.options?.id === id)
}

/** Kit sources with this package's locale and store seats. */
function sourcesFor(ctx: Context): Pick<KitSources, 'translate' | 'storeOf'> {
  const locale = (ctx as unknown as { locale?: { bind(namespace: string): unknown } }).locale
  return {
    translate: namespace => (locale === undefined ? (key: string) => key : locale.bind(namespace)),
    storeOf: (entry, sessionId) => storeSeat(entry, sessionId),
  }
}

/** Contain one page failure so the official conversation can take the seat back. */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('[remote-mesh] remote page failed:', error)
  }

  override render(): ReactNode {
    if (this.state.failed) return null
    return this.props.children
  }
}

/**
 * Fold visibility for one row: the shipped flow hides folded rows with the
 * `hidden` attribute, and this page has no fold clock of its own.
 * @param hidden - desired visibility.
 * @param reveal - browser-find callback (unused here).
 * @returns the row ref.
 */
function useGroupAction(hidden: boolean, reveal: () => void): { current: HTMLDivElement | null } {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden) element.setAttribute('hidden', '')
    else element.removeAttribute('hidden')
  }, [hidden])
  return ref
}

/**
 * Hide or show one group header row.
 * @param ref - the header element.
 * @param hidden - desired visibility.
 */
function useGroupHeaderAction(ref: { current: HTMLElement | null }, hidden: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden) element.setAttribute('hidden', '')
    else element.removeAttribute('hidden')
  }, [ref, hidden])
}

/**
 * Draw the shipped entry this seat would have rendered.
 *
 * A component of its own on purpose: `entryFace` runs React hooks inline, so a
 * caller that sometimes draws an entry and sometimes does not would change its
 * own hook count between renders.
 * @param props.ctx - client root context.
 * @param props.entry - the shadowed registration.
 * @param props.owner - the seat's occupant props.
 * @returns the shipped content.
 */
export function ShippedSlot({ ctx, entry, owner }: {
  ctx: Context
  entry: StoredEntryLike
  owner: SeatOwner
}): ReactNode {
  const proton = protonOf(ctx)
  if (proton === undefined) return null
  return proton.entryFace(entry, {
    ...sourcesFor(ctx),
    standard: standardOf(owner),
    scope: { sessionId: typeof owner.sessionId === 'string' ? owner.sessionId : undefined },
    owner: seatPropsOf(owner),
  })
}

/**
 * Draw the shipped conversation frame for one seat.
 *
 * While a dispatch target is set the frame must NOT stay in its blank-session
 * hero posture: the local Session has no turns (every message goes to the peer),
 * so the shipped hero would keep the welcome block and a centered composer
 * under the remote transcript forever. Presenting the Session as no longer
 * blank is the one input that decides it — the frame then docks the composer
 * exactly as on a conversation that has started.
 * @param props.ctx - client root context.
 * @param props.entry - the shadowed main-conversation registration.
 * @param props.owner - the seat's occupant props.
 * @returns the shipped conversation frame.
 */
export function ShippedConversation({ ctx, entry, owner }: {
  ctx: Context
  entry: StoredEntryLike
  owner: SeatOwner
}): ReactNode {
  const proton = protonOf(ctx)
  const state = useRemotePageState()
  const active = state.target !== undefined
  // The kit (and the tap inside it) is memoized per registration identity, so a
  // mode switch has to hand it a new identity: otherwise the posture flip never
  // reaches the frame.
  const seat = useMemo(() => (active ? { ...entry } : entry), [active, entry])
  if (proton === undefined) return null
  return proton.entryFace(seat, {
    ...sourcesFor(ctx),
    standard: standardOf(owner),
    scope: { sessionId: typeof owner.sessionId === 'string' ? owner.sessionId : undefined },
    owner: seatPropsOf(owner),
    kitTap: (kit: Record<string, unknown>) => {
      // No target: this machine's page, untouched.
      if (!active) return kit
      const actual = kit['useSession'] as ((selector: (snapshot: unknown) => unknown) => unknown) | undefined
      const useSession = actual === undefined
        ? (selector: (snapshot: unknown) => unknown) => selector({ blank: false, awaitingFirstTurn: false })
        : (selector: (snapshot: unknown) => unknown) => selector({
          ...(actual(snapshot => snapshot) as Record<string, unknown> | undefined),
          blank: false,
          awaitingFirstTurn: false,
        })
      return { ...kit, useSession }
    },
  })
}

/** One small header line naming the machine, workspace and Session. */
export function RemoteSessionHeader({ ctx, owner, t, shipped }: RemotePageContext & { owner: SeatOwner, shipped: StoredEntryLike }): ReactNode {
  const state = useRemotePageState()
  const target = state.target
  if (target === undefined) return <ShippedSlot ctx={ctx} entry={shipped} owner={owner} />
  return (
    <div data-remote-session-header="" style={HEADER}>
      <span style={HEADER_ICON}><IconGlobeOutlineRegular size={14} /></span>
      <span style={HEADER_MAIN} title={`${target.nodeLabel} · ${target.title}`}>
        <span style={HEADER_TITLE}>{target.nodeLabel} · {target.title}</span>
        <span style={HEADER_PATH}>{target.remotePath}</span>
        {state.sessionId === undefined ? null : (
          <span style={HEADER_PATH}>session {state.sessionId.slice(0, 12)}</span>
        )}
      </span>
      {state.phase === 'error' ? <span style={HEADER_ERROR}>{t('page.failed')}</span> : null}
      {state.running ? <span style={HEADER_RUNNING}>{t('page.running')}</span> : null}
      <button type="button" style={HEADER_BACK} onClick={() => { clearDispatchTarget() }}>
        {t('page.back')}
      </button>
    </div>
  )
}

/** The transcript: the peer Session's events drawn by the shipped Chat flow. */
export function RemoteTranscript({ ctx, owner, t, shipped }: RemotePageContext & { owner: SeatOwner, shipped: StoredEntryLike }): ReactNode {
  const state = useRemotePageState()
  const flow = useMemo(() => findEntry(ctx, 'conversation.chat.flow'), [ctx])
  // The page runs inside a local (blank) Session. While it does, that Session
  // is a shell, not a conversation on this machine: publish it so the workspace
  // list can leave it out.
  const useSession = owner.useSession as ((selector: (snapshot: unknown) => unknown) => unknown) | undefined
  const blank = useSession === undefined
    ? undefined
    : useSession((snapshot) => (snapshot as { blank?: boolean } | undefined)?.blank)
  const shellId = typeof owner.sessionId === 'string' ? owner.sessionId : undefined
  useEffect(() => {
    setShellSession(state.target !== undefined && blank === true ? shellId : undefined)
  }, [state.target !== undefined, blank, shellId])
  useEffect(() => () => { setShellSession(undefined) }, [])
  const view = useRemoteChatView(ctx, state.events, state.hasMore)
  const snapshot = view.snapshot()
  const columnRef = useRef<HTMLDivElement | null>(null)

  // Follow the tail: the enclosing scrollport belongs to the shipped layout,
  // so the page only asks it to stay at the bottom when the reader already is.
  const revision = state.revision
  useEffect(() => {
    const node = columnRef.current
    if (node === null) return
    const scroller = node.closest('[data-conversation-scroll]') as HTMLElement | null
    if (scroller === null) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (distance < 160 || revision === 0) {
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [revision])

  if (state.target === undefined) return <ShippedSlot ctx={ctx} entry={shipped} owner={owner} />

  const order = snapshot?.order ?? []
  const content = flow === undefined || order.length === 0
    ? (
      <div style={EMPTY}>
        <div style={EMPTY_TITLE}>{t('page.empty')}</div>
        <div style={EMPTY_HINT}>{t('page.emptyHint')}</div>
      </div>
    )
    : <FlowSlot ctx={ctx} flow={flow} view={view} owner={owner} state={state} />

  return (
    <PageBoundary>
      <div data-remote-transcript="" style={TRANSCRIPT}>
        <div ref={columnRef} style={COLUMN}>
          {content}
        </div>
      </div>
    </PageBoundary>
  )
}

/** Draw the shipped Chat flow over the page's assembled snapshot. */
function FlowSlot({ ctx, flow, view, owner, state }: {
  ctx: Context
  flow: StoredEntryLike
  view: RemoteChatView
  owner: SeatOwner
  state: RemotePageState
}): ReactNode {
  const proton = protonOf(ctx)
  if (proton === undefined) return null
  const snapshot = view.snapshot()
  const order = snapshot?.order ?? []
  const entries = order.map(key => ({ kind: 'node' as const, key }))
  const noop = (): void => {}
  const target = state.target
  const localUseSession = owner.useSession as ((selector: (snapshot: unknown) => unknown) => unknown) | undefined
  const running = state.running
  const useSession = localUseSession === undefined
    ? (selector: (snapshot: unknown) => unknown) => selector({ running })
    : (selector: (snapshot: unknown) => unknown) => selector({
      ...(localUseSession(value => value) as Record<string, unknown> | undefined),
      running,
    })
  return proton.entryFace(flow, {
    ...sourcesFor(ctx),
    standard: { ...standardOf(owner), useSession },
    scope: { sessionId: typeof owner.sessionId === 'string' ? owner.sessionId : undefined },
    hookContext: { motion: false },
    owner: {
      ...view.hooks,
      useSession,
      entries,
      pendingInputs: [],
      lastInputTurn: undefined,
      deferCollapse: false,
      cwd: target?.remotePath,
      openFile: async () => undefined,
      inspectCall: undefined,
      forkAt: noop,
      loadImage: () => Promise.resolve(''),
      // Slot-level hooks the host would bind when *it* renders this child: the
      // seat declaration carries them, and drawing the entry directly skips
      // that binding, so the page supplies equivalent ones.
      useGroupAction,
      useGroupHeaderAction,
    },
  })
}

const TRANSCRIPT: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  flexDirection: 'column',
  paddingTop: 16,
}

const COLUMN: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  maxWidth: 'var(--dsh-chat-content-width, 760px)',
  margin: '0 auto',
  paddingBottom: 24,
}

const EMPTY: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  alignItems: 'center',
  justifyContent: 'center',
  padding: '72px 24px',
  textAlign: 'center',
}

const EMPTY_TITLE: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--dsw-alias-label-secondary)',
}

const EMPTY_HINT: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  padding: '6px 0',
}

const HEADER_ICON: React.CSSProperties = {
  display: 'inline-flex',
  color: 'var(--dsw-alias-label-tertiary)',
}

const HEADER_MAIN: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  minWidth: 0,
  overflow: 'hidden',
}

const HEADER_TITLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const HEADER_PATH: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const HEADER_RUNNING: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const HEADER_ERROR: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-status-error, #d14343)',
}

const HEADER_BACK: React.CSSProperties = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 6,
}