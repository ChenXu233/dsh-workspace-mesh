/**
 * Remote workspace rendering.
 *
 * This package does not compete for the workspace seat: proton's outlet holds it.
 * It contributes two things:
 *
 * - the kit the host renderer would synthesize for the entry that seat shadows,
 *   so the shipped browser is drawn by the entry face instead of vanishing;
 * - a section of its own, rendered beside the shipped list, that names the
 *   machine each remote workspace actually lives on.
 */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteWorkspaceSection } from './remote-section'

// The providers below read these services while drawing a shadowed entry; cordis
// refuses an undeclared service access at runtime, so they are part of this
// plugin's contract rather than an optional nicety.
export const inject = ['slots', 'proton'] as const

/**
 * Register the kit sources proton consults when it draws a shadowed entry, and
 * contribute the remote group beside the shipped list.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['protonWorkspace'], (scoped) => {
    const proton = scoped.protonWorkspace
    if (typeof proton?.addSection !== 'function') return
    scoped.effect(
      () => proton.addSection({
        id: 'remote-mesh',
        order: 10,
        title: '远程工作区',
        render: () => <RemoteWorkspaceSection />,
      }),
      'remote-mesh: workspace section',
    )
  })
}
