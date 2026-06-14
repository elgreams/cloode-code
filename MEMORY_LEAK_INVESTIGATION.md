# Memory leak investigation handoff

Date: 2026-06-14
Repo: `/home/three/git/free-code`
Session investigated: `adc5153c-3d45-4d70-9c18-15ca94bad06b`

## User-observed symptom

- Long Claude Code/free-code sessions grow to very high memory in `htop`.
- Example observed memory pressure: >70% of 32GB after a 5-6 hour session.
- Current live session showed high RSS and continued to grow while the chat stayed active.

## Heapdump files inspected

The user ran `/heapdump` twice in the same live process. The command writes fixed filenames, so the second run overwrote the first files. The first dump numbers below were recorded in chat before overwrite.

Current/second files:

- `/home/three/Desktop/adc5153c-3d45-4d70-9c18-15ca94bad06b.heapsnapshot`
- `/home/three/Desktop/adc5153c-3d45-4d70-9c18-15ca94bad06b-diagnostics.json`

## First heapdump summary

Timestamp: `2026-06-14T02:47:21.371Z`
Uptime: `7526.27s`

Diagnostics:

- `heapUsed`: `225,751,628` bytes (~215.3 MB)
- `heapTotal`: `180,564,992` bytes (~172.2 MB)
- `external`: `74,429,932` bytes (~71.0 MB)
- `arrayBuffers`: `10,141,244` bytes (~9.7 MB)
- `rss`: `11,212,218,368` bytes (~10.44 GiB / 11.21 GB)
- `mallocedMemory`: `226,013,884` bytes
- `peakMallocedMemory`: `11,254,771,712` bytes
- `activeHandles`: `0`
- `activeRequests`: `0`
- `openFileDescriptors`: `54`
- `memoryGrowthRate`: `5114.6 MB/hour`

`smaps_rollup` highlights:

- `Rss`: `10,951,960 kB`
- `Private_Dirty`: `10,899,752 kB`
- `Anonymous`: `10,900,140 kB`
- `Swap`: `182,684 kB`

Heap snapshot summary:

- Node count: `1,546,360`
- Edge count: `5,070,605`
- Huge top node: `4152.9 MB object "url " id=2116901`
- That node was retained from `GlobalObject -> property performance -> object "url "`.
- Top node outgoing edges only included `property now -> closure "now"` and an internal structure.
- Long strings >100KB: `13` strings, total `~7.3 MB`
- Base64-like strings >10KB: `4`, total `~3.6 MB`
- Strings containing `data:image` or `base64`: `281`, total `~3.8 MB`

Initial conclusion: high RSS was real private/native memory, not JS heap or base64 image retention.

## Second heapdump summary

Timestamp: `2026-06-14T02:56:32.303Z`
Uptime: `8077.20s`
Time since first dump: ~551 seconds / ~9.2 minutes

Diagnostics:

- `heapUsed`: `206,860,931` bytes (~197.3 MB)
- `heapTotal`: `187,492,352` bytes (~178.8 MB)
- `external`: `67,905,011` bytes (~64.8 MB)
- `arrayBuffers`: `10,129,996` bytes (~9.7 MB)
- `rss`: `12,258,365,440` bytes (~11.42 GiB / 12.26 GB)
- `mallocedMemory`: `207,123,187` bytes
- `peakMallocedMemory`: `12,340,781,056` bytes
- `activeHandles`: `0`
- `activeRequests`: `0`
- `openFileDescriptors`: `54`
- `memoryGrowthRate`: `5210.4 MB/hour`

`smaps_rollup` highlights:

- `Rss`: `11,972,512 kB`
- `Private_Dirty`: `11,915,204 kB`
- `Anonymous`: `11,920,244 kB`
- `Swap`: `177,368 kB`

Heap snapshot summary:

- Node count: `1,646,499`
- Edge count: `5,390,725`
- Huge top node: `4557.2 MB object "url " id=2116901`
- Same object id as first dump: `2116901`
- Long strings >100KB: `13`, total `~6.9 MB`
- Base64-like strings >10KB: `4`, total `~3.4 MB`
- Strings containing `data:image` or `base64`: `596`, total `~3.7 MB`

## Growth between the two dumps

Over ~9.2 minutes:

- RSS grew: `11.21 GB -> 12.26 GB` = `+~1.05 GB`
- `Private_Dirty` grew: `10,899,752 kB -> 11,915,204 kB` = `+1,015,452 kB` (~992 MB)
- JS `heapUsed` went down: `225.8 MB -> 206.9 MB` = `-18.9 MB`
- `external` went down: `74.4 MB -> 67.9 MB` = `-6.5 MB`
- The giant `performance -> url` node grew: `4152.9 MB -> 4557.2 MB` = `+404.3 MB`
- Total object self size grew: `4219.6 MB -> 4631.5 MB` = `+411.9 MB`

Conclusion from comparison: memory growth is native/private dirty anonymous memory. It is not driven by JS heap, external buffers, ArrayBuffers, or retained base64 images.

## Ruled out or deprioritized

- Large retained chat message arrays: not supported by heap numbers.
- Base64 screenshot/image retention as the dominant issue: only ~3-4 MB in snapshots.
- ArrayBuffer accumulation: largest ArrayBuffers were only a few MB.
- Detached React/native contexts: `detachedContexts: 0`, `nativeContexts: 1`.
- Open handles/requests: diagnostics reported `activeHandles: 0`, `activeRequests: 0`.

## Current leading hypothesis (REVISED 2026-06-13)

**Native allocator arena bloat driven by continuous Ink re-render churn, with the
buddy CompanionSprite animation as the prime suspect for steady idle growth.**

### Why "allocator arena bloat", not "retention"

The single most actionable signal was previously buried: `mallocedMemory` vs
`peakMallocedMemory`.

| dump | mallocedMemory (live) | peakMallocedMemory | rss |
| --- | --- | --- | --- |
| 1 | ~226 MB | ~11.25 GB | ~11.21 GB |
| 2 | ~207 MB | ~12.34 GB | ~12.26 GB |

Peak malloc'd tracks RSS almost exactly, but *live* malloc'd is only ~200 MB.
JSC/Bun allocated ~12 GB at some point, considers nearly all of it freed, but
never returned the pages to the OS. Combined with flat/declining `heapUsed`,
this is the signature of **high-volume transient allocations** (built then
dropped) permanently raising the allocator high-water mark — NOT a live object
graph retaining gigabytes. So the question is "what repeatedly allocates large
transient buffers", not "what is holding memory".

### The `performance -> url` node is almost certainly a snapshot artifact

A single ~4.5 GB JS object whose only outgoing edges are `now -> closure` and an
internal structure is not a real data structure. It is JSC attributing
unaccounted native/allocator memory to a synthetic node near `performance`. Use
it ONLY as a "the leak grew between dumps" marker. Do NOT hunt for a JS object
literally holding URLs — that is a dead end.

### Why the buddy sprite is the prime suspect for steady idle growth

The growth rate was remarkably *steady* (5114 → 5210 MB/hr) and the user reported
growth "while the chat stayed active" / idle. A per-user-query leak would be
bursty. Steady growth points at something firing on a wall-clock timer
regardless of user input.

Two earlier guesses were CHECKED AND RULED OUT against the code:

- **Companion observer fetch/timer is NOT a background loop.** `fireCompanionObserver`
  is called once per assistant turn from `REPL.tsx` (after the `query()` loop),
  throttled to `MIN_INTERVAL_MS` (30s) + a 0.7 dice roll. It cannot fire while
  idle, so it cannot drive steady idle growth.
- **The buddy API path is non-streaming.** `queryHaiku` goes through
  `queryModelWithoutStreaming`, so there is no SSE response body to leave
  undrained. The "undrained SSE" hypothesis does not apply here.

What IS always-on and buddy-specific is `src/buddy/CompanionSprite.tsx`:

- An **unconditional `setInterval(..., TICK_MS=500ms)`** (line ~214) that calls
  `setTick` for the entire lifetime of the mounted sprite → ~2 Ink re-renders/sec
  forever, INCLUDING idle.
- `useAnimationFrame(50)` (line ~195) → 20fps shimmer. For **shiny** companions
  the shimmer ref is attached to a visible box (line ~290), so shiny pets drive a
  continuous 20fps render loop.

Before buddy, idle time was idle. Buddy converts idle time into a perpetual Ink
render loop. Each Ink render allocates transient ANSI/string buffers that are
freed (heapUsed stays flat) but bloat the native allocator arena (peakMalloced
≈ RSS). This mechanism matches every number above.

### Secondary native-heavy areas (only if buddy is exonerated)

- Bun/JSC timers / `AbortSignal.timeout()` / AbortController paths
  (NOTE: `activeHandles: 0` does NOT exonerate timers — Bun does not populate
  `activeHandles`/`activeRequests` the way Node does)
- Ink renderer / terminal output path itself (independent of buddy)
- MCP channel/browser/screenshot activity
- LSP/plugin layer (notably `rust-analyzer-lsp` was present in debug logs)
- shell/pty/task handling

## Code changes already made before this handoff

### Buddy observer timer cleanup

File: `src/buddy/observer.ts`

Changed the companion observer timeout from native `AbortSignal.timeout()` to the project helper:

- imports `createCombinedAbortSignal`
- creates `{ signal, cleanup } = createCombinedAbortSignal(undefined, { timeoutMs: REQUEST_TIMEOUT_MS })`
- calls `cleanup()` in `finally`

Reason: repo helper documents a Bun native-memory issue where `AbortSignal.timeout()` timers are finalized lazily and hold memory until they fire. This was a cheap real fix, but likely too small to explain 11GB alone.

### Slash-command misroute instrumentation

Added dormant debug logs tagged `[slash-route]` to investigate intermittent cases where fork-added commands like `/buddy` or `/provider` appeared to be sent to the model.

Files touched:

- `src/utils/processUserInput/processUserInput.ts`
- `src/utils/processUserInput/processSlashCommand.tsx`
- `src/screens/REPL.tsx`
- `src/components/PromptInput/PromptInput.tsx`

Run with:

```bash
./dist/cli --debug=slash-route
```

Findings so far: one suspected reproduction had no `[slash-route]` lines, implying dispatch never saw a leading `/`; remaining hypothesis is PromptInput/keyboard-layer slash loss if it reproduces.

### Buddy model override

Added `/buddy model` support to manually set the model used for companion quips independently of main chat model.

Files touched:

- `src/utils/config.ts`: added `companionModel?: string`
- `src/services/api/claude.ts`: `queryHaiku` accepts optional `model?: string`
- `src/buddy/observer.ts`: uses `config.companionModel ?? getSmallFastModel()`
- `src/buddy/observer.ts`: tolerant quip parsing for non-strict JSON models
- `src/commands/buddy/buddy.ts`: `/buddy model` command and picker
- `src/commands/buddy/index.ts`: updated argument hint

Behavior:

- `/buddy model` opens a picker-like menu.
- `/buddy model <model>` sets buddy-only model override.
- `/buddy model default` or `/buddy model reset` clears override.
- Main `/model` is unchanged.
- Buddy parser accepts JSON `{ "quip": "..." }`, fenced JSON, or first-line plain text.

### Memory-watch instrumentation

Added debug-only memory sampler/markers.

New file:

- `src/utils/memWatch.ts`

Files instrumented:

- `src/screens/REPL.tsx`
  - starts sampler on REPL mount
  - logs `repl-mount`, `repl-unmount`
  - logs `query-start`, `query-finish`
- `src/buddy/observer.ts`
  - logs `companion-observer-start`, `companion-observer-finish`
- `src/services/mcp/useManageMCPConnections.ts`
  - logs `mcp-channel-message`

Run with:

```bash
./dist/cli --debug=mem-watch --debug-file=/home/three/leak-debug.log
```

Expected log lines:

```text
[mem-watch] sampler-start ... rss=... heapUsed=... privateDirty=...
[mem-watch] sample ...
[mem-watch] query-start ...
[mem-watch] query-finish ...
[mem-watch] companion-observer-start ...
[mem-watch] companion-observer-finish ...
[mem-watch] mcp-channel-message ...
```

The sampler records:

- RSS
- RSS delta since previous sample/event
- heapUsed
- heapTotal
- external
- arrayBuffers
- `/proc/self/smaps_rollup` Private_Dirty, Anonymous, Swap
- open file descriptors
- active handles/requests if available

## Recommended next investigation steps

### Phase 0 — cheap discriminating A/B tests (DO THESE FIRST)

These isolate the buddy sprite render loop in minutes and are worth more than the
slow mem-watch correlation. Watch RSS in `htop`; leave the session idle (no
typing) for ~30 min in each arm so any background driver dominates.

1. **Buddy muted / BUDDY off, idle 30 min.**
   - RSS goes flat → the leak IS the always-on sprite render loop. Done isolating;
     go to Phase 1.
   - RSS still climbs → buddy is exonerated; the leak is in the runtime/render
     layer independent of buddy. Skip to Phase 2.

2. **Shiny vs non-shiny companion, idle 30 min each** (only if step 1 showed buddy
   matters).
   - Shiny leaks much faster → the 20fps `useAnimationFrame(50)` / `ShinyText` /
     Ink-output shimmer path is the hot spot.
   - Both leak similarly → the unconditional 500ms `setInterval` re-render
     (CompanionSprite.tsx ~line 214) is enough on its own.

### Phase 1 — confirm the mechanism is allocator churn, not retention

3. With buddy active and RSS elevated, run `/heapdump` and re-check
   `mallocedMemory` vs `peakMallocedMemory`. Expect live malloc'd to stay small
   (~200 MB) while peak ≈ RSS. That confirms transient-churn arena bloat and means
   the fix is "stop the churn" (gate/slow the idle render loop), not "free a
   retained object".

### Phase 2 — mem-watch correlation (if the A/B is inconclusive)

4. Recompile and run with mem-watch:

```bash
cd /home/three/git/free-code
bun run compile
./dist/cli --debug=mem-watch --debug-file=/home/three/leak-debug.log
```

5. Use until `htop` shows meaningful RSS growth, then inspect slope:

```bash
grep mem-watch /home/three/leak-debug.log
```

6. When high, run `/heapdump` and save both files/paths.

7. Compare mem-watch events around big RSS jumps:

- Steady rise during idle samples (no query/observer events nearby) → render-loop
  / runtime background churn (the leading hypothesis).
- Jumps near `query-start`/`query-finish` → model request/query loop/native API path.
- Jumps near `companion-observer-*` → buddy API path (less likely; once-per-turn).
- Jumps near `mcp-channel-message` → MCP channel/pushed message path.

### Phase 3 — native allocation profiling (if mem-watch cannot localize)

8. Use `heaptrack ./dist/cli` (preferred — it surfaces the *temporary* allocation
   call stacks that bloat the arena, which is exactly this signature) or
   `valgrind massif`. JS heap snapshots are insufficient for native RSS leaks.

## Important caveat

The heapdumps above are from the old live process, before the observer cleanup and mem-watch changes were compiled into `dist/cli`. They are still valuable because they prove the leak shape, but they do not verify whether newer builds reduce the growth rate.
