import pg from "pg";
import { envString } from "./env.js";
import { log } from "./logger.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: envString("DATABASE_URL"),
      max: 10,
    });
    pool.on("error", (error) => {
      log("error", "pg idle client error", { error: error.message });
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
