import { getPool } from "./index";
import { PairConfigSchema, normalizeActiveQuoteSizes, type PairConfig } from "@sotama/market-core";

type Row = {
  id: string;
  enabled: boolean;
  label: string;
  base: any;
  tokenized: any;
  quote: any;
  sizes_usd: any;
  directions: any;
  quote_interval_ms: number;
  min_price_move_bps: number;
  slippage_bps: number;
  min_net_edge_bps: number;
  quality_gate: any;
};

const SELECT_COLS = `
  id, enabled, label, base, tokenized, quote, sizes_usd, directions,
  quote_interval_ms, min_price_move_bps, slippage_bps, min_net_edge_bps,
  quality_gate
`;

export async function listEnabledPairs(): Promise<PairConfig[]> {
  const { rows } = await getPool().query<Row>(`
    SELECT ${SELECT_COLS}
    FROM market_pairs
    WHERE enabled = TRUE
    ORDER BY id ASC
  `);
  return rows.map(rowToConfig);
}

export async function listAllPairs(): Promise<PairConfig[]> {
  const { rows } = await getPool().query<Row>(`
    SELECT ${SELECT_COLS}
    FROM market_pairs
    ORDER BY id ASC
  `);
  return rows.map(rowToConfig);
}

export async function getPair(id: string): Promise<PairConfig | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLS} FROM market_pairs WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToConfig(row) : null;
}

export async function upsertPair(cfg: PairConfig): Promise<void> {
  await getPool().query(
    `INSERT INTO market_pairs
       (id, enabled, label, base, tokenized, quote, sizes_usd, directions,
        quote_interval_ms, min_price_move_bps, slippage_bps, min_net_edge_bps,
        quality_gate, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (id) DO UPDATE SET
       enabled            = EXCLUDED.enabled,
       label              = EXCLUDED.label,
       base               = EXCLUDED.base,
       tokenized          = EXCLUDED.tokenized,
       quote              = EXCLUDED.quote,
       sizes_usd          = EXCLUDED.sizes_usd,
       directions         = EXCLUDED.directions,
       quote_interval_ms  = EXCLUDED.quote_interval_ms,
       min_price_move_bps = EXCLUDED.min_price_move_bps,
       slippage_bps       = EXCLUDED.slippage_bps,
       min_net_edge_bps   = EXCLUDED.min_net_edge_bps,
       quality_gate       = EXCLUDED.quality_gate,
       updated_at         = now()`,
    [
      cfg.id,
      cfg.enabled,
      cfg.label,
      cfg.base,
      cfg.tokenized,
      cfg.quote,
      JSON.stringify(cfg.sizesUsd),
      JSON.stringify(cfg.directions),
      cfg.quoteIntervalMs,
      cfg.minPriceMoveBps,
      cfg.slippageBps,
      cfg.minNetEdgeBps,
      cfg.qualityGate == null ? null : JSON.stringify(cfg.qualityGate),
    ],
  );
}

export async function disablePair(id: string): Promise<void> {
  await getPool().query(
    `UPDATE market_pairs
     SET enabled = FALSE, disabled_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

function rowToConfig(row: Row): PairConfig {
  const sizesUsd = normalizeActiveQuoteSizes(
    typeof row.sizes_usd === "string" ? JSON.parse(row.sizes_usd) : row.sizes_usd,
  );
  return PairConfigSchema.parse({
    id: row.id,
    enabled: row.enabled,
    label: row.label,
    base: row.base,
    tokenized: row.tokenized,
    quote: row.quote,
    sizesUsd,
    directions: typeof row.directions === "string" ? JSON.parse(row.directions) : row.directions,
    quoteIntervalMs: row.quote_interval_ms,
    minPriceMoveBps: Number(row.min_price_move_bps),
    slippageBps: Number(row.slippage_bps),
    minNetEdgeBps: Number(row.min_net_edge_bps),
    qualityGate: row.quality_gate ?? undefined,
  });
}
