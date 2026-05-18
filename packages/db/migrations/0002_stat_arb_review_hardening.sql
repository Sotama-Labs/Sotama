-- Hardening from docs/stat-arb-bot-review-notes.md.

ALTER TABLE jupiter_quotes
  ADD COLUMN IF NOT EXISTS context_slot BIGINT;

ALTER TABLE basis_observations
  ADD COLUMN IF NOT EXISTS pyth_stream_timestamp_us BIGINT,
  ADD COLUMN IF NOT EXISTS pyth_feed_update_timestamp_us BIGINT,
  ADD COLUMN IF NOT EXISTS pyth_freshness_lag_ms INTEGER,
  ADD COLUMN IF NOT EXISTS quote_request_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_request_ms INTEGER,
  ADD COLUMN IF NOT EXISTS basis_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS quality TEXT NOT NULL DEFAULT 'live';

ALTER TABLE paper_signals
  ADD COLUMN IF NOT EXISTS entry_side TEXT,
  ADD COLUMN IF NOT EXISTS exit_side TEXT,
  ADD COLUMN IF NOT EXISTS entry_token_price_usd DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_base_price_usd DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_quote_id BIGINT REFERENCES jupiter_quotes(id),
  ADD COLUMN IF NOT EXISTS entry_basis_id BIGINT REFERENCES basis_observations(id),
  ADD COLUMN IF NOT EXISTS entry_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_units DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS exit_token_price_usd DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS exit_base_price_usd DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS exit_quote_id BIGINT REFERENCES jupiter_quotes(id),
  ADD COLUMN IF NOT EXISTS exit_basis_id BIGINT REFERENCES basis_observations(id),
  ADD COLUMN IF NOT EXISTS exit_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_reason TEXT;

UPDATE paper_signals
SET entry_side = side
WHERE entry_side IS NULL;

UPDATE paper_signals
SET entry_observed_at = entry_at
WHERE entry_observed_at IS NULL;

ALTER TABLE bot_heartbeats
  ADD COLUMN IF NOT EXISTS active_lazer_endpoint_count INTEGER,
  ADD COLUMN IF NOT EXISTS lazer_endpoint_health JSONB,
  ADD COLUMN IF NOT EXISTS invalid_feed_count_1m INTEGER NOT NULL DEFAULT 0;

-- Owner-approved active quote sizes for this tuning phase.
UPDATE market_pairs
SET sizes_usd = '[250,1000]'::jsonb,
    updated_at = now()
WHERE sizes_usd <> '[250,1000]'::jsonb;
