import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * Kill-switch check for voice mode. Returns true unless the
 * `tengu_amber_quartz_disabled` GrowthBook flag is flipped on (emergency
 * off). Default `false` means a missing/stale disk cache reads as "not
 * killed" — so fresh installs get voice working immediately without
 * waiting for GrowthBook init. Use this for deciding whether voice mode
 * should be *visible* (e.g., command registration, config UI).
 */
export function isVoiceGrowthBookEnabled(): boolean {
  return !getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_amber_quartz_disabled',
    false,
  )
}

/**
 * Full runtime check for voice mode. Voice now runs against a local STT
 * engine, so it no longer depends on Anthropic auth — availability is just
 * the GrowthBook kill-switch.
 */
export function isVoiceModeEnabled(): boolean {
  return isVoiceGrowthBookEnabled()
}
