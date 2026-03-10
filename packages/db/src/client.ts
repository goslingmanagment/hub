import { drizzle } from "drizzle-orm/node-postgres";
import pg, { Pool } from "pg";

import * as schema from "./schema.ts";

pg.types.setTypeParser(20, (value: string) => BigInt(value));

export function createPool(connectionString: string) {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = Omit<ReturnType<typeof createDb>, "$client">;
