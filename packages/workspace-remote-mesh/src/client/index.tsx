/**
 * Remote workspace section and remote conversation page, browser half.
 *
 * Two contributions, both proton seats:
 *
 * 1. The sidebar section that lists the peer's Workspaces and lets one be added
 *    there. Choosing one from the hero picker becomes a dispatch target rather
 *    than a local Session, because there is no local directory and no local log.
 * 2. The conversation page for that target. While one is set, the shipped
 *    session header and transcript area are shadowed by this package; the
 *    header names the peer and the transcript is the peer Session's own event
 *    log assembled by the shipped Chat definitions. With no target both seats
 *    draw the shipped entries again, so this machine's conversation is exactly
 *    the official one.
 *
 * The composer is never replaced: the shipped bar keeps its machine and draft,
 * and the adapter's submit tap hands the message to this package while a target
 * is set — one input, one composer, exactly as on this machine.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { en, NS, zh } from './locales'
import type { RemoteTranslate } from './locales'
import { currentDispatchTarget, subscribeDispatchTarget } from './dispatch-target'
import type { DispatchTarget } from './dispatch-target'
import { createRemotePickerExtras } from './picker-source'
import { protonOf, RemoteSessionHeader, RemoteTranscript, ShippedConversation } from './remote-page'
import { sendRemoteMessage, syncRemoteSession } from './remote-session'
import { RemoteSection } from './remote-section'
import { DispatchTargetChip } from './target-chip'

/** The conversation frame; the page keeps it and only changes its posture. */
export const MAIN_CONVERSATION_SLOT = 'main.conversation' as const
/** Seats the remote page shadows (both draw the shipped entry when idle). */
export const SESSION_HEADER_SLOT = 'conversation.session.header' as const
/** Transcript area of the conversation; the composer below it is untouched. */
export const TRANSCRIPT_SLOT = 'conversation.session' as const
/** Region name this package uses for the two shadowed seats. */
export const REMOTE_PAGE_REGION = 'remote.page' as const

/**
 * The section seat the workspace domain provides. Declared here instead of
 * imported so this package builds without the domain package: the runtime
 * service is the contract, and the shape is all this package uses.
 */
export interface SectionSeat {
  addSection(section: {
    id: string
    order?: number
    render: (context: Record<string, unknown>) => ReactNode
  }): () => void
  addPickerExtras(extras: {
    rows: {
      getSnapshot(): readonly { workspaceId: string; title: string }[]
      subscribe(listener: () => void): () => void
    }
    pick(workspaceId: string): boolean
    selectedId?(): string | undefined
  }): () => void
}

/** The slice of the slot registry this package registers into. */
interface SlotSeat {
  inject(name: string, callback: () => () => void): () => void
  register(options: { name: string; id: string; order?: number }, component: unknown): () => void
}

/** One submit the shipped composer is about to perform (the adapter's tap). */
export interface ComposerSubmitRequest {
  readonly text: string
  readonly mode: string
  readonly source?: string | undefined
  readonly sessionId?: string | undefined
  readonly clear?: (() => void) | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    protonWorkspace: SectionSeat
  }
  interface Events {
    /**
     * A submit happened in the shipped composer. Returning true takes it over:
     * the adapter skips the shipped send and the draft is cleared by the caller.
     * @mode bail
     */
    'proton/composer-submit'(request: ComposerSubmitRequest): boolean | undefined
  }
}

// The section needs the locale service (own namespace), the workspace domain's
// section seat, and proton itself. Declared at plugin level on purpose: the
// loader starts this plugin once they exist, whereas a runtime `ctx.inject`
// created while one is still missing is never woken by a sibling providing it.
export const inject = ['slots', 'locale', 'proton', 'protonWorkspace', 'uiConversation'] as const

/** Whether two targets point at the same peer Workspace. */
function sameTarget(left: DispatchTarget | undefined, right: DispatchTarget | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.nodeId === right.nodeId && left.workspaceId === right.workspaceId
}

/**
 * Register the remote section, the page seats and the composer tap.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The page exists exactly while a target is set: no target means no peer
  // Session to open and no polling to run.
  ctx.effect(() => {
    let previous = currentDispatchTarget()
    syncRemoteSession(previous)
    const stop = subscribeDispatchTarget(() => {
      const next = currentDispatchTarget()
      if (sameTarget(previous, next)) return
      previous = next
      syncRemoteSession(next)
    })
    return () => {
      stop()
      syncRemoteSession(undefined)
    }
  }, 'remote-mesh: page follows target')

  const scoped = ctx
    scoped.effect(() => scoped.locale.register(NS, { zh, en }), 'remote-mesh: dictionaries')
    const t = scoped.locale.bind(NS) as unknown as RemoteTranslate
    // Rows are drawn by the shipped browser's own component (vendor copy), so
    // their copy belongs to the shipped `workspace` namespace: read that seat
    // rather than duplicating the strings, and never trust the region owner to
    // hand one over (its `t` is not the browser's).
    const rowT = scoped.locale.bind('workspace') as never
    scoped.effect(
      () => scoped.protonWorkspace.addSection({
        id: 'remote',
        order: 10,
        render: () => <RemoteSection t={t} rowT={rowT} />,
      }),
      'remote-mesh: remote section',
    )
    // The hero picker offers the peer's Workspaces beside the local ones; the
    // pick itself is remembered as a dispatch target, never as a Session here.
    const extras = createRemotePickerExtras()
    scoped.effect(() => scoped.protonWorkspace.addPickerExtras(extras), 'remote-mesh: picker rows')
    // The shipped composer asks plugins before it sends (the adapter taps its
    // submit verb). While a target is set this claims the submit: the text goes
    // to that machine's Session and the reply arrives in the page above it.
    scoped.effect(() => scoped.on('proton/composer-submit', (request) => {
      const target = currentDispatchTarget()
      if (target === undefined) return undefined
      const objective = typeof request?.text === 'string' ? request.text.trim() : ''
      if (objective === '') return undefined
      request.clear?.()
      void sendRemoteMessage(objective)
      return true
    }), 'remote-mesh: composer submit')

    const slots = (scoped as unknown as { slots?: SlotSeat }).slots
    if (slots !== undefined) {
      scoped.effect(
        () => slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: 'remote-mesh.dispatch-target' },
          () => <DispatchTargetChip t={t} />,
        )),
        'remote-mesh: dispatch target chip',
      )
    }

    // The page itself: the shipped session header and the transcript area are
    // shadowed while a target is set. Both outlets always take their seat so
    // they can draw the shipped entry again the moment the target is cleared.
    const proton = protonOf(scoped as unknown as Context)
    if (proton === undefined) {
      console.warn('[remote-mesh] proton service is absent; the remote page stays closed')
      return
    }
    scoped.effect(() => proton.connect([
      {
        slot: MAIN_CONVERSATION_SLOT,
        region: REMOTE_PAGE_REGION,
        alwaysShadow: true,
        render: (entry, owner) => (
          <ShippedConversation ctx={scoped as unknown as Context} entry={entry} owner={owner} />
        ),
      },
      {
        slot: SESSION_HEADER_SLOT,
        region: REMOTE_PAGE_REGION,
        alwaysShadow: true,
        render: (entry, owner) => (
          <RemoteSessionHeader ctx={scoped as unknown as Context} owner={owner} t={t} shipped={entry} />
        ),
      },
      {
        slot: TRANSCRIPT_SLOT,
        region: REMOTE_PAGE_REGION,
        alwaysShadow: true,
        render: (entry, owner) => (
          <RemoteTranscript ctx={scoped as unknown as Context} owner={owner} t={t} shipped={entry} />
        ),
      },
    ]), 'remote-mesh: remote page seats')
}