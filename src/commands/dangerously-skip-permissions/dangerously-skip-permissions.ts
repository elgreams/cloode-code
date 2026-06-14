import {
  shouldDisableBypassPermissions,
  transitionPermissionMode,
} from '../../utils/permissions/permissionSetup.js'
import type { LocalCommandCall } from '../../types/command.js'

/**
 * Toggle bypassPermissions mode at runtime — the slash-command equivalent of
 * launching with --dangerously-skip-permissions. Useful when you start a
 * session normally and later decide you want to stop being prompted (or vice
 * versa) without restarting.
 *
 * On enable we set isBypassPermissionsModeAvailable so the footer reflects the
 * mode and Shift+Tab keeps cycling through it. The org/settings killswitch
 * (tengu_disable_bypass_permissions_mode / permissions.disableBypassPermissionsMode)
 * is honored: if bypass is disabled we refuse to enable it.
 */
export const call: LocalCommandCall = async (_args, context) => {
  const current = context.getAppState().toolPermissionContext
  const enabling = current.mode !== 'bypassPermissions'

  if (enabling) {
    if (await shouldDisableBypassPermissions()) {
      return {
        type: 'text',
        value:
          'Bypass-permissions mode is disabled by your organization or settings.',
      }
    }
    context.setAppState(prev => {
      const ctx = transitionPermissionMode(
        prev.toolPermissionContext.mode,
        'bypassPermissions',
        prev.toolPermissionContext,
      )
      return {
        ...prev,
        toolPermissionContext: {
          ...ctx,
          mode: 'bypassPermissions',
          isBypassPermissionsModeAvailable: true,
        },
      }
    })
    return {
      type: 'text',
      value:
        'Bypass-permissions mode ON — tools run without asking. Run /dangerously-skip-permissions again to turn it off.',
    }
  }

  context.setAppState(prev => {
    const ctx = transitionPermissionMode(
      prev.toolPermissionContext.mode,
      'default',
      prev.toolPermissionContext,
    )
    return {
      ...prev,
      toolPermissionContext: { ...ctx, mode: 'default' },
    }
  })
  return {
    type: 'text',
    value: 'Bypass-permissions mode OFF — back to normal permission prompts.',
  }
}
