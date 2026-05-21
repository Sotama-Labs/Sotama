CREATE TABLE IF NOT EXISTS trade_executions (
  id                       BIGSERIAL PRIMARY KEY,
  pair_id                  TEXT NOT NULL REFERENCES market_pairs(id) ON DELETE RESTRICT,
  signal_id                BIGINT REFERENCES paper_signals(id) ON DELETE SET NULL,
  action                   TEXT NOT NULL CHECK (action IN ('open','close')),
  side                     TEXT NOT NULL CHECK (side IN ('buy_tokenized','sell_tokenized')),
  size_usd                 NUMERIC NOT NULL,
  mode                     TEXT NOT NULL,
  status                   TEXT NOT NULL,
  edge_bps                 DOUBLE PRECISION NOT NULL,
  base_price_usd           DOUBLE PRECISION NOT NULL,
  token_price_usd          DOUBLE PRECISION NOT NULL,
  in_mint                  TEXT NOT NULL,
  out_mint                 TEXT NOT NULL,
  in_amount                NUMERIC NOT NULL,
  expected_out_amount      NUMERIC,
  actual_out_amount        NUMERIC,
  router                   TEXT,
  order_request_id         TEXT,
  order_quote_id           TEXT,
  signature                TEXT,
  slot                     TEXT,
  error_code               INTEGER,
  error_message            TEXT,
  order_request_ms         INTEGER,
  sign_ms                  INTEGER,
  sender_prepare_ms        INTEGER,
  execute_request_ms       INTEGER,
  request_started_at       TIMESTAMPTZ NOT NULL,
  order_response_at        TIMESTAMPTZ,
  execute_response_at      TIMESTAMPTZ,
  raw_order                JSONB,
  raw_execute              JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_executions_pair_time_idx
  ON trade_executions (pair_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trade_executions_signal_idx
  ON trade_executions (signal_id)
  WHERE signal_id IS NOT NULL;

ALTER TABLE paper_signals
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'paper',
  ADD COLUMN IF NOT EXISTS entry_execution_id BIGINT REFERENCES trade_executions(id),
  ADD COLUMN IF NOT EXISTS exit_execution_id BIGINT REFERENCES trade_executions(id);
