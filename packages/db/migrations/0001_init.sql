-- Stat-arb V1 schema. One file = one migration. Re-runnable: every CREATE uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_pairs (
  id                 TEXT PRIMARY KEY,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  label              TEXT NOT NULL,
  base               JSONB NOT NULL,
  tokenized          JSONB NOT NULL,
  quote              JSONB NOT NULL,
  sizes_usd          JSONB NOT NULL,
  directions         JSONB NOT NULL,
  quote_interval_ms  INTEGER NOT NULL,
  min_price_move_bps NUMERIC NOT NULL,
  slippage_bps       NUMERIC NOT NULL,
  min_net_edge_bps   NUMERIC NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pyth_ticks (
  id              BIGSERIAL PRIMARY KEY,
  pair_id         TEXT NOT NULL REFERENCES market_pairs(id) ON DELETE RESTRICT,
  pyth_lazer_id   INTEGER NOT NULL,
  price_usd       DOUBLE PRECISION NOT NULL,
  confidence_usd  DOUBLE PRECISION,
  publish_time_us BIGINT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pyth_ticks_pair_time_idx
  ON pyth_ticks (pair_id, received_at DESC);

CREATE TABLE IF NOT EXISTS jupiter_quotes (
  id               BIGSERIAL PRIMARY KEY,
  pair_id          TEXT NOT NULL REFERENCES market_pairs(id) ON DELETE RESTRICT,
  side             TEXT NOT NULL CHECK (side IN ('buy_tokenized','sell_tokenized')),
  size_usd         NUMERIC NOT NULL,
  router           TEXT,
  in_mint          TEXT NOT NULL,
  out_mint         TEXT NOT NULL,
  in_amount        NUMERIC NOT NULL,
  out_amount       NUMERIC NOT NULL,
  price_impact_pct DOUBLE PRECISION,
  quote_id         TEXT,
  expires_at       TIMESTAMPTZ,
  request_ms       INTEGER NOT NULL,
  status           TEXT NOT NULL,    -- 'ok','rate_limited','error','stale'
  raw              JSONB,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jupiter_quotes_pair_time_idx
  ON jupiter_quotes (pair_id, received_at DESC);
CREATE INDEX IF NOT EXISTS jupiter_quotes_pair_side_size_time_idx
  ON jupiter_quotes (pair_id, side, size_usd, received_at DESC);

CREATE TABLE IF NOT EXISTS basis_observations (
  id              BIGSERIAL PRIMARY KEY,
  pair_id         TEXT NOT NULL REFERENCES market_pairs(id) ON DELETE RESTRICT,
  side            TEXT NOT NULL CHECK (side IN ('buy_tokenized','sell_tokenized')),
  size_usd        NUMERIC NOT NULL,
  base_price_usd  DOUBLE PRECISION NOT NULL,
  token_price_usd DOUBLE PRECISION NOT NULL,
  gross_edge_bps  DOUBLE PRECISION NOT NULL,
  net_edge_bps    DOUBLE PRECISION NOT NULL,
  tick_id         BIGINT REFERENCES pyth_ticks(id),
  quote_id        BIGINT REFERENCES jupiter_quotes(id),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS basis_obs_pair_side_size_time_idx
  ON basis_observations (pair_id, side, size_usd, observed_at DESC);

CREATE TABLE IF NOT EXISTS paper_signals (
  id             BIGSERIAL PRIMARY KEY,
  pair_id        TEXT NOT NULL REFERENCES market_pairs(id) ON DELETE RESTRICT,
  side           TEXT NOT NULL CHECK (side IN ('buy_tokenized','sell_tokenized')),
  size_usd       NUMERIC NOT NULL,
  threshold_bps  DOUBLE PRECISION NOT NULL,
  entry_edge_bps DOUBLE PRECISION NOT NULL,
  entry_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  exit_at        TIMESTAMPTZ,
  exit_edge_bps  DOUBLE PRECISION,
  pnl_usd        DOUBLE PRECISION,
  outcome        TEXT   -- 'open','closed_win','closed_loss','closed_flat','closed_stale'
);
CREATE INDEX IF NOT EXISTS paper_signals_pair_time_idx
  ON paper_signals (pair_id, entry_at DESC);
CREATE INDEX IF NOT EXISTS paper_signals_open_idx
  ON paper_signals (pair_id, side, size_usd)
  WHERE exit_at IS NULL;

CREATE TABLE IF NOT EXISTS bot_heartbeats (
  id                BIGSERIAL PRIMARY KEY,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  stream_lag_ms     INTEGER,
  quote_lag_ms      INTEGER,
  active_pair_count INTEGER NOT NULL,
  current_rps       DOUBLE PRECISION NOT NULL,
  http_429_count_1m INTEGER NOT NULL,
  error_count_1m    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_heartbeats_time_idx
  ON bot_heartbeats (observed_at DESC);
