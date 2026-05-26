/** Constants shared across the HTTP read API layer. */

export const LATEST_WITHIN_MS = 5 * 60_000;
export const HISTORY_WINDOW_MS = 24 * 3600 * 1000;
export const SIGNAL_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const BASIS_SERIES_LIMIT = 720;
/** Max raw basis rows loaded per side+size for the dashboard overview.
 *  This keeps the overview responsive on high-frequency feeds while still
 *  giving the lite verdict enough recent live samples to clear its threshold. */
export const DASHBOARD_HISTORY_LIMIT_PER_BUCKET = 250;
/** Max raw basis rows loaded per side+size for expensive pair-detail replay.
 *  200ms feeds can produce >100k rows/day/pair; replaying all of them inside
 *  the bot API process can exhaust Node's heap. 5k per bucket keeps the detail
 *  page recent and bounded without running full-table aggregates on request. */
export const PAIR_DETAIL_HISTORY_LIMIT_PER_BUCKET = 5_000;
export const HEARTBEAT_STALE_MS = 30_000;

export const HOLD_HORIZONS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

/** Default opportunity threshold for stat summaries — 50 bps is the smallest
 *  edge the bot's cost model can reasonably claim across all current pairs. */
export const STAT_OPPORTUNITY_THRESHOLD_BPS = 50;

/** The dashboard's "live" round-trip spread requires both legs to be within
 *  this many seconds of each other. Larger gaps mean we'd compare a stale
 *  buy with a fresh sell (or vice versa). */
export const MAX_SYNC_AGE_GAP_MS = 30_000;

/** Stat summaries are computed over these windows per (side, size). */
export const STAT_WINDOWS_MS = [HISTORY_WINDOW_MS] as const;
