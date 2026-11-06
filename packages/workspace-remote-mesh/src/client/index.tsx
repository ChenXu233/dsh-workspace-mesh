/**
 * Remote workspace section, browser half.
 *
 * The proton adapter holds the sidebar seat: it renders the shipped workspace
 * browser as the main pane and opens that region to sections. This package
 * contributes exactly one section and one dialog; it does not register a
 * workspace browser, does not wrap the shipped one, and does not read the local
 * workspace registry.
 *
 * It also feeds the hero workspace picker: the workspace domain merges extra
 * rows into that shipped menu, and a pick of one of our rows becomes a dispatch
 * target (§ D20) rather than a local Session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { en, NS, zh } from './locales'
import type { RemoteTranslate } from './locales'
import { createRemotePickerExtras } from './picker-source'
import { RemoteSection } from './remote-section'
import { DispatchTargetChip } from './target-chip'

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    protonWorkspace: SectionSeat
  }
}

// The client root only has to exist before we inject; the section itself needs
// the locale service (own namespace) and the workspace domain's section seat.
export const inject = ['slots'] as const

/**
 * Register the section once the domain and locale services are up.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['locale', 'protonWorkspace', 'slots'], (scoped) => {
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
  })
}
