import { createHash } from "node:crypto";
import { link, open, unlink, writeFile } from "node:fs/promises";
import pg from "pg";

const [operation, from, to, outputPath] = process.argv.slice(2);
// The `corpus` export fed the DM shadow analyzer, which went with the legacy
// DM sweep at step 4 (S4-14).
if (operation !== "report" || !from || !to || !outputPath) {
  throw new Error("Usage: read.ts report FROM_ISO TO_ISO OUTPUT");
}
const connectionString = process.env.HUB_READ_ONLY_DATABASE_URL;
if (!connectionString) throw new Error("Set HUB_READ_ONLY_DATABASE_URL for the read_only role");
const client = new pg.Client({ connectionString, application_name: "fansly-events-read" });
const file = await open(`${outputPath}.partial`, "wx", 0o600);
const hash = createHash("sha256");
const startedAt = new Date().toISOString();

async function read(sql: string, parameters: unknown[]) {
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = '20s'");
    const identity = await client.query("select current_user as role, current_setting('transaction_read_only') as mode");
    if (identity.rows[0].role !== "read_only" || identity.rows[0].mode !== "on") {
      throw new Error("This exporter requires read_only inside a read-only transaction");
    }
    const result = await client.query(sql, parameters);
    await client.query("commit");
    return result.rows[0].result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function append(text: string) {
  hash.update(text);
  await file.write(text);
}

try {
  await client.connect();
  const report = await read("select fansly_events_measurement_report($1, $2) as result", [from, to]);
  await append(JSON.stringify(report, null, 2) + "\n");
  const records = report.sweeps.length;
  await file.close();
  await link(`${outputPath}.partial`, outputPath);
  await unlink(`${outputPath}.partial`);
  await writeFile(`${outputPath}.manifest.json`, JSON.stringify({
    operation, from, to, startedAt, completedAt: new Date().toISOString(), records,
    sha256: hash.digest("hex"), atomicSnapshot: false,
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`Saved ${operation}: ${records} records to ${outputPath}\n`);
} finally {
  await file.close();
  await client.end();
}
