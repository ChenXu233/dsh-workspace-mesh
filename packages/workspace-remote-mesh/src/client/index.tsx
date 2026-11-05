import type { Context } from '@deepseek-ai/cordis'
import { RemoteWorkspaceSection } from './remote-section'
import { workspaceEntrySources } from './shipped'

// The providers below read these services while drawing a shadowed entry; cordis
// refuses an undeclared service access at runtime, so they are part of this
// plugin's contract rather than an optional nicety.
export const inject = ['slots', 'proton', 'locale', 'workspaces'] as const

const SEAT = 'sidebar.workspaces'

/**
 * Probe the slot ledger the way this plugin sees it, so a wrong-instance or
 * wrong-key diagnosis is a measurement instead of a guess.
 * @param ctx - client root context.
 */
function probe(ctx: Context): void {
  const slots = ctx.slots as unknown as {
    entries(key: string): readonly unknown[]
    spec(key: string): unknown
  }
  const sample = (): Record<string, unknown> => ({
    root: slots.entries('root').length,
    seat: slots.entries(SEAT).length,
    spec: slots.spec(SEAT) as never,
    sameObjectAsProton: (ctx.proton as unknown as { host?: unknown }).host === ctx,
  })
  const publish = (): void => {
    ;(globalThis as unknown as Record<string, unknown>).__slotsProbe = sample()
  }
  publish()
  for (const delay of [500, 2000, 5000]) setTimeout(publish, delay)
}

export function apply(ctx: Context): void {
  probe(ctx)
  ctx.effect(
    () => ctx.proton.addEntrySources(entry => workspaceEntrySources(ctx, entry)),
    'remote-mesh: workspace entry sources',
  )
  ctx.inject(['protonWorkspace'], (scoped) => {
    const proton = scoped.protonWorkspace
    if (typeof proton?.addSection !== 'function') return
    const dispose = proton.addSection({
      id: 'remote-mesh',
      order: 10,
      title: '远程工作区',
      render: () => <RemoteWorkspaceSection />,
    })
    ;(globalThis as unknown as Record<string, unknown>).__sectionDispose = typeof dispose
  })
}
