// Shared realtime cadence for the Consent + VSS deployment channels.
//
// Both pages coalesce peer-centre postgres_changes bursts the same way:
// skip events that echo OUR OWN saves for a short window, queue while a save
// is in flight, and fire one silent refresh per burst after a trailing
// debounce. The numbers live here (single source of truth) so the two
// channels can never drift apart — same tables/filters/cadence on both.

export const REALTIME_RELOAD_DEBOUNCE_MS = 600
export const REALTIME_SELF_SKIP_MS = 1500

// True when an event arrived inside our own-save echo window and must be
// skipped. `nowMs` is injectable so tests pin the boundary deterministically.
export function shouldSkipSelfWrite(lastWriteAtMs, nowMs = Date.now()) {
  return nowMs - lastWriteAtMs < REALTIME_SELF_SKIP_MS
}
