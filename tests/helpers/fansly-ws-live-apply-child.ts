// A separate OS process for the live overlay's real-process chaos test
// (tests/fansly-ws-live-overlay.integration.test.ts): it applies one receipt on
// its own database session, so the parent can SIGKILL it after the overlay
// insert and before the commit. Prints the apply result if it survives.
import { applyFanslyWsLiveReceipt, createDb, createPool } from "@agency_hub_core/db";

const connectionString = process.env.DATABASE_URL;
const observationId = Number(process.env.OBSERVATION_ID);
if (!connectionString || !Number.isSafeInteger(observationId)) throw new Error("DATABASE_URL and OBSERVATION_ID are required");
const pool = createPool(connectionString);
try {
  const result = await applyFanslyWsLiveReceipt(createDb(pool), { observationId });
  process.stdout.write(JSON.stringify(result));
} finally {
  await pool.end();
}
