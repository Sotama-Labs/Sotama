import { Pool, types } from "pg";

// pg returns NUMERIC as string by default to preserve precision.
// We're fine with JS numbers for these (basis points, USD); register a parser
// so call sites don't need to wrap every Number(...). OIDs: 1700 = NUMERIC.
types.setTypeParser(1700, (val) => parseFloat(val));

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  _pool = new Pool({ connectionString: url, max: 8 });
  return _pool;
}

/** Force-close the pool. Call from tests or graceful shutdown only. */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export * from "./pairs";
export * from "./ticks";
export * from "./quotes";
export * from "./basis";
export * from "./signals";
export * from "./heartbeats";
export * from "./executions";
