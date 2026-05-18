-- Persist deterministic tradability classification for every successful basis row.

ALTER TABLE market_pairs
  ADD COLUMN IF NOT EXISTS quality_gate JSONB;

ALTER TABLE basis_observations
  ADD COLUMN IF NOT EXISTS pyth_confidence_bps DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pyth_market_session TEXT,
  ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'LIVE_ELIGIBLE',
  ADD COLUMN IF NOT EXISTS quality_reason TEXT NOT NULL DEFAULT 'legacy row before quality gate';

CREATE INDEX IF NOT EXISTS basis_obs_pair_quality_time_idx
  ON basis_observations (pair_id, quality_status, observed_at DESC);

ALTER TABLE paper_signals
  ADD COLUMN IF NOT EXISTS entry_quality_status TEXT NOT NULL DEFAULT 'LIVE_ELIGIBLE',
  ADD COLUMN IF NOT EXISTS entry_quality_reason TEXT NOT NULL DEFAULT 'legacy signal before quality gate',
  ADD COLUMN IF NOT EXISTS exit_quality_status TEXT,
  ADD COLUMN IF NOT EXISTS exit_quality_reason TEXT;

UPDATE paper_signals
SET exit_quality_status = 'LIVE_ELIGIBLE',
    exit_quality_reason = 'legacy closed signal before quality gate'
WHERE exit_at IS NOT NULL
  AND exit_quality_status IS NULL;

UPDATE basis_observations
SET quality_status = CASE
    WHEN quality = 'live' THEN 'LIVE_ELIGIBLE'
    WHEN quality = 'stale' THEN 'STALE_BASIS'
    WHEN quality = 'warm' THEN 'QUOTE_LATENCY_TOO_HIGH'
    ELSE 'MARKET_SESSION_INVALID'
  END,
  quality_reason = CASE
    WHEN quality = 'live' THEN 'legacy live row before quality gate'
    WHEN quality = 'stale' THEN 'legacy stale row before quality gate'
    WHEN quality = 'warm' THEN 'legacy warm row before quality gate'
    ELSE 'legacy invalid row before quality gate'
  END
WHERE quality_reason = 'legacy row before quality gate';
