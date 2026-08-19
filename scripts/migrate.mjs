#!/usr/bin/env node
// Runs every .sql file in db/migrations against DATABASE_URL, in filename order.
// No migration-tracking table on purpose (few, idempotent, hand-written migrations) —
// swap for a real migrator (e.g. node-pg-migrate) if this grows past a handful of files.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

// Meant to be run inside the gateway container (`mise run migrate`, which runs this via
// `docker compose run --rm gateway ...`) — DATABASE_URL comes from that service's
// environment in docker-compose.yml. The fallback below only matters if you run this
// bare on the host against a manually-exposed Postgres port.
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://strudel:strudel@postgres:5432/strudel_point";

const migrationsDir = path.resolve(import.meta.dirname, "..", "db", "migrations");

async function main() {
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      console.log(`applying ${file}...`);
      await client.query(sql);
    }
    console.log(`done (${files.length} migration file(s) applied)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
