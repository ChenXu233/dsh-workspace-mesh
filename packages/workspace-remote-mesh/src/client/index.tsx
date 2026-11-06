/**
 * Remote workspace section, browser half.
 *
 * The proton adapter holds the sidebar seat: it renders the shipped workspace
 * browser as the main pane and opens that region to sections. This package
 * contributes exactly one section and one dialog; it does not register a
 * workspace browser, does not wrap the shipped one, and does not read the local
 * workspace registry.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { en, NS, zh } from './locales'
import type { RemoteTranslate } from './locales'
import { RemoteSection } from './remote-section'

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
  ctx.inject(['locale', 'protonWorkspace'], (scoped) => {
    scoped.effect(() => scoped.locale.register(NS, { zh, en }), 'remote-mesh: dictionaries')
    const t = scoped.locale.bind(NS) as unknown as RemoteTranslate
    scoped.effect(
      () => scoped.protonWorkspace.addSection({
        id: 'remote',
        order: 10,
        render: (context) => (
          <RemoteSection
            t={t}
            rowT={(typeof context.t === 'function' ? context.t : t) as never}
          />
        ),
      }),
      'remote-mesh: remote section',
    )
  })
}
