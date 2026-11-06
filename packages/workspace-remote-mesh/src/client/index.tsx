/**
 * Workspace plugin, browser half.
 *
 * This package IS the shipped workspace browser: `vendor/ui-workspace` holds
 * the official `@deepseek-ai/dsh-client-ui-workspace` source at the vendored
 * tag, and this entry mounts it. The composition therefore disables the
 * shipped bundle and this one occupies its seats — same slots, same contract,
 * same row behaviour — with one addition: the list also draws Workspaces that
 * live on other machines (see `remote-workspaces.ts` and the vendored patch
 * that appends them to the derived groups).
 *
 * Proton is not involved: it does not own this seat, does not re-render the
 * official renderer, and knows nothing about workspaces.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyVendor, inject as vendorInject } from '../../vendor/ui-workspace/src/client/index.ts'

export { remoteWorkspaceKey, useRemoteWorkspaces } from './remote-workspaces'
export type { RemoteWorkspaceRow } from './remote-workspaces'

/** Services the shipped browser requires; the vendored source declares them. */
export const inject = vendorInject

/**
 * Mount the browser, picker, and row actions.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  applyVendor(ctx)
}
