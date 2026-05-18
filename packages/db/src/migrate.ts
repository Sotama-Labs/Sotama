import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

const migrationsDir = resolve(__dirname, "../migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await pool.query<{ version: number }>(
      `SELECT version FROM schema_migrations`,
    );
    const applied = new Set(rows.map((r) => r.version));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const versionStr = f.split("_")[0];
      if (!versionStr) continue;
      const version = Number(versionStr);
      if (applied.has(version)) {
        console.log(`skip ${f} (already applied)`);
        continue;
      }
      console.log(`apply ${f}`);
      const sql = readFileSync(resolve(migrationsDir, f), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await pool.query("COMMIT");
      } catch (e) {
        await pool.query("ROLLBACK");
        throw e;
      }
    }
    console.log("migrations complete");
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
