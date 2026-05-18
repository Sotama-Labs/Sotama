import { getPool } from "./index";

export type PythTickInsert = {
  pairId: string;
  pythLazerId: number;
  priceUsd: number;
  confidenceUsd: number | null;
  publishTimeUs: number;
};

export type PythTickRow = PythTickInsert & {
  id: bigint;
  receivedAt: Date;
};

export async function insertPythTick(row: PythTickInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO pyth_ticks
       (pair_id, pyth_lazer_id, price_usd, confidence_usd, publish_time_us)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [row.pairId, row.pythLazerId, row.priceUsd, row.confidenceUsd, row.publishTimeUs],
  );
  return BigInt(rows[0]!.id);
}

export async function recentTicks(pairId: string, sinceMs: number): Promise<PythTickRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, pyth_lazer_id, price_usd, confidence_usd, publish_time_us, received_at
     FROM pyth_ticks
     WHERE pair_id = $1
       AND received_at >= to_timestamp($2 / 1000.0)
     ORDER BY received_at ASC`,
    [pairId, sinceMs],
  );
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    pairId: r.pair_id,
    pythLazerId: r.pyth_lazer_id,
    priceUsd: Number(r.price_usd),
    confidenceUsd: r.confidence_usd == null ? null : Number(r.confidence_usd),
    publishTimeUs: Number(r.publish_time_us),
    receivedAt: r.received_at,
  }));
}
