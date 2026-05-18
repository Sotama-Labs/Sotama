-- Add time-regime labels so observations can be compared by session/state.

ALTER TABLE basis_observations
  ADD COLUMN IF NOT EXISTS time_regime TEXT;

CREATE INDEX IF NOT EXISTS basis_obs_pair_regime_time_idx
  ON basis_observations (pair_id, time_regime, observed_at DESC);

WITH classified AS (
  SELECT
    bo.id,
    mp.base->>'assetClass' AS asset_class,
    EXTRACT(ISODOW FROM bo.observed_at AT TIME ZONE 'America/New_York')::int AS dow,
    (
      EXTRACT(HOUR FROM bo.observed_at AT TIME ZONE 'America/New_York')::int * 60
      + EXTRACT(MINUTE FROM bo.observed_at AT TIME ZONE 'America/New_York')::int
    ) AS minutes
  FROM basis_observations bo
  JOIN market_pairs mp ON mp.id = bo.pair_id
  WHERE bo.time_regime IS NULL
)
UPDATE basis_observations bo
SET time_regime = CASE
  WHEN classified.asset_class = 'Equity' THEN CASE
    WHEN classified.dow IN (6, 7) THEN 'US_EQUITY_WEEKEND'
    WHEN classified.minutes >= 570 AND classified.minutes < 960 THEN 'US_EQUITY_REGULAR'
    WHEN classified.minutes >= 240 AND classified.minutes < 570 THEN 'US_EQUITY_PREMARKET'
    WHEN classified.minutes >= 960 AND classified.minutes < 1200 THEN 'US_EQUITY_POSTMARKET'
    ELSE 'US_EQUITY_OVERNIGHT'
  END
  WHEN classified.asset_class = 'Metal' THEN CASE
    WHEN classified.dow = 6 THEN 'METAL_WEEKEND'
    WHEN classified.dow = 7 AND classified.minutes < 1080 THEN 'METAL_WEEKEND'
    WHEN classified.dow = 5 AND classified.minutes >= 1020 THEN 'METAL_WEEKEND'
    WHEN classified.minutes >= 1020 AND classified.minutes < 1080 THEN 'METAL_MAINTENANCE'
    ELSE 'METAL_ACTIVE'
  END
  WHEN classified.asset_class = 'Crypto' THEN 'CRYPTO_NORMAL'
  ELSE NULL
END
FROM classified
WHERE bo.id = classified.id;
