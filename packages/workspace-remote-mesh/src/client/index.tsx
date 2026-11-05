/**
 * Remote workspace rendering.
 *
 * Two pieces, both independent of any DSH change:
 *
 * - the kit the host renderer would synthesize for the shipped workspace entry
 *   (standard props, locale seat, store binding), handed to proton so its entry
 *   face can draw that entry rather than only the renderer that owned it;
 * - a section of its own, meant to render beside the shipped list and name the
 *   machine each remote workspace lives on.
 */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteWorkspaceSection } from './remote-section'
import { workspaceEntrySources } from './shipped'

export const inject = ['slots', 'proton'] as const

/**
 * Register the entry kit sources, and contribute the remote group.
 *
 * The section does not appear yet: it renders inside the workspace region's host,
 * and that host is only reachable through proton's outlet — which stays parked
 * until the shipped seat is visible to it (see the adapter's note). Registering
 * anyway keeps the contribution honest: the moment the outlet holds the seat, the
 * section is already there.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.proton.addEntrySources(entry => workspaceEntrySources(ctx, entry)),
    'remote-mesh: workspace entry sources',
  )
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
