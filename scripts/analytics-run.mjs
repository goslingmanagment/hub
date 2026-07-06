#!/usr/bin/env node
// Kernel Stage 28: the metrics-model runner — dbt-style discipline without
// the framework. Each analytics/models/<name>.sql owns one machine-generated
// analytics_<name> table; the runner rebuilds it atomically (drop + create
// inside a transaction). Usage: pnpm analytics:run <model>|all
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(root, "analytics", "models");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const requested = process.argv[2];
if (!requested) {
  console.error("Usage: analytics-run.mjs <model>|all");
  process.exit(1);
}

const available = (await readdir(modelsDir))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => file.replace(/\.sql$/, ""));
const models = requested === "all" ? available : [requested];

for (const model of models) {
  if (!available.includes(model)) {
    console.error(`Unknown model "${model}". Available: ${available.join(", ")}`);
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  for (const model of models) {
    const sql = await readFile(join(modelsDir, `${model}.sql`), "utf8");
    const startedAt = Date.now();
    await client.query("begin");
    try {
      await client.query(`drop table if exists analytics_${model}`);
      await client.query(sql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    const { rows } = await client.query(`select count(*)::int as n from analytics_${model}`);
    console.log(`${model}: rebuilt analytics_${model} (${rows[0].n} rows, ${Date.now() - startedAt} ms)`);
  }
} finally {
  await client.end();
}
