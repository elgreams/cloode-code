import { useEffect } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import {
  checkOllamaToolCapability,
  subscribeToolWarnings,
  toolWarningMessage,
} from '../../services/api/openai-compat/tool-capability.js'
import { isOpenAICompatModel } from '../../services/api/openai-compat/registry.js'
import { logError } from '../../utils/log.js'

/**
 * Surfaces tool-capability warnings for OpenAI-compatible models.
 *
 *  - Subscribes to the tool-warning channel that the fetch adapter (tool
 *    rejected) and query loop (tools ignored) emit on. Any warning — including
 *    ones buffered before this mounted — becomes a notification.
 *  - Preemptively probes the active model at startup: if it's an Ollama-style
 *    provider whose /api/show says it lacks the "tools" capability, warn before
 *    the user wastes a turn discovering it the hard way.
 *
 * The once-per-model discipline lives in tool-capability.ts (session set +
 * persisted TTL), so this hook can fire freely without double-warning.
 */
export function useToolCapabilityNotification(mainLoopModel: string): void {
  const { addNotification } = useNotifications()

  // Bridge the non-React warning channel into the notification queue.
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    return subscribeToolWarnings(w => {
      addNotification({
        key: `openai-compat-tool-warning-${w.id}`,
        text: toolWarningMessage(w),
        color: 'warning',
        priority: 'high',
        timeoutMs: 15000,
      })
    })
  }, [addNotification])

  // Preemptive Ollama probe whenever the active openai-compat model changes.
  // checkOllamaToolCapability self-gates (non-Ollama, already-flagged, or
  // tool-capable → no-op) and emits through the same channel above on a hit.
  useEffect(() => {
    if (getIsRemoteMode() || !isOpenAICompatModel(mainLoopModel)) {
      return
    }
    void checkOllamaToolCapability(mainLoopModel).catch(logError)
  }, [mainLoopModel])
}
