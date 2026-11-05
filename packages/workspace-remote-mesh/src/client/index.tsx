/**
 * Remote workspace section.
 *
 * The shipped workspace list is owned by the official ui-workspace bundle; this
 * package does not take that seat. It contributes one section beside it through
 * the proton workspace domain: the shipped list keeps rendering untouched, and
 * the remote workspaces (local anchor directories standing in for directories
 * that live on another machine) get a group of their own that says which machine
 * they belong to.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-proton-workspace/client'
import { RemoteWorkspaceSection } from './remote-section'

export const inject = ['slots'] as const

/**
 * Contribute the remote group once the workspace domain is on the ledger.
 * @param ctx - client root context.
 */
const mark = (state: string): void => {
  ;(globalThis as unknown as Record<string, unknown>).__remoteMesh = state
}

/**
 * Off by default: taking the seat is only safe once the shipped list can be
 * rendered back through the outlet, and \`OriginalSlotEntry\` cannot render an
 * entry that declares children/locale/hooks — the shipped workspace browser
 * does. With this on, the region loses the local list entirely.
 */
const ENABLED = false

export function apply(ctx: Context): void {
  if (!ENABLED) return
  mark('applied')
  ctx.inject(['protonWorkspace'], (scoped) => {
    mark('inject-cb')
    const proton = scoped.protonWorkspace
    if (proton === undefined) { mark('no-service'); return }
    if (typeof proton.addSection !== 'function') { mark('no-addSection'); return }
    scoped.effect(
      () => proton.addSection({
        id: 'remote-mesh',
        order: 10,
        title: '远程工作区',
        render: () => <RemoteWorkspaceSection />,
      }),
      'remote-mesh: workspace section',
    )
    mark('added')
  })
}
