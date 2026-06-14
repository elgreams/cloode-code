import { readFileSync, readdirSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'

const MB = 1024 * 1024
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000

let sampler: ReturnType<typeof setInterval> | undefined
let lastSample: MemorySnapshot | undefined

export type MemorySnapshot = {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
  privateDirtyKb?: number
  anonymousKb?: number
  swapKb?: number
  openFileDescriptors?: number
  activeHandles?: number
  activeRequests?: number
}

export const isMemWatchEnabled = memoize((): boolean => {
  if (process.env.CLAUDE_CODE_MEM_WATCH) return true
  return process.argv.some(arg => arg === '--debug=mem-watch' || arg.includes('mem-watch'))
})

function readSmapsRollup(): Pick<MemorySnapshot, 'privateDirtyKb' | 'anonymousKb' | 'swapKb'> {
  try {
    const text = readFileSync('/proc/self/smaps_rollup', 'utf8')
    const getKb = (name: string): number | undefined => {
      const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))
      return match ? Number(match[1]) : undefined
    }
    return {
      privateDirtyKb: getKb('Private_Dirty'),
      anonymousKb: getKb('Anonymous'),
      swapKb: getKb('Swap'),
    }
  } catch {
    return {}
  }
}

function openFileDescriptorCount(): number | undefined {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return undefined
  }
}

export function captureMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage()
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles
  const getActiveRequests = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    openFileDescriptors: openFileDescriptorCount(),
    activeHandles: getActiveHandles?.().length,
    activeRequests: getActiveRequests?.().length,
    ...readSmapsRollup(),
  }
}

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)}MB`
}

function kbToMb(kb: number | undefined): string {
  return kb === undefined ? 'n/a' : `${(kb / 1024).toFixed(1)}MB`
}

export function logMemWatch(event: string, details?: Record<string, unknown>): MemorySnapshot | undefined {
  if (!isMemWatchEnabled()) return undefined

  const current = captureMemorySnapshot()
  const delta = lastSample ? current.rss - lastSample.rss : 0
  const detailText = details
    ? ` ${Object.entries(details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')}`
    : ''

  logForDebugging(
    `[mem-watch] ${event}${detailText} rss=${mb(current.rss)} rssDelta=${mb(delta)} ` +
      `heapUsed=${mb(current.heapUsed)} heapTotal=${mb(current.heapTotal)} ` +
      `external=${mb(current.external)} arrayBuffers=${mb(current.arrayBuffers)} ` +
      `privateDirty=${kbToMb(current.privateDirtyKb)} anonymous=${kbToMb(current.anonymousKb)} ` +
      `swap=${kbToMb(current.swapKb)} fds=${current.openFileDescriptors ?? 'n/a'} ` +
      `handles=${current.activeHandles ?? 'n/a'} requests=${current.activeRequests ?? 'n/a'}`,
    { level: 'info' },
  )

  lastSample = current
  return current
}

export function startMemWatchSampler(intervalMs = DEFAULT_SAMPLE_INTERVAL_MS): void {
  if (!isMemWatchEnabled() || sampler) return
  logMemWatch('sampler-start', { intervalMs })
  sampler = setInterval(() => {
    logMemWatch('sample')
  }, intervalMs)
  sampler.unref?.()
}

export function stopMemWatchSampler(): void {
  if (!sampler) return
  clearInterval(sampler)
  sampler = undefined
  logMemWatch('sampler-stop')
}
