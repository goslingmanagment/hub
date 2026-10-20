// The Parquet lake's file shape. The tiering run that wrote such files is gone
// (2026-10-21); the erasure still rewrites any lake it finds under LAKE_DIR,
// and its tests seed a lake with these helpers.

export interface TieredTableSpec {
  table: "observations" | "domain_events";
  plane: string;
  /** DuckDB column schema — MUST cover every Postgres column (pinned by test). */
  columns: Record<string, string>;
  /** The column restricted-kind filtering applies to (observations only). */
  kindColumn?: string;
}

export const TIERED_TABLES: TieredTableSpec[] = [
  {
    table: "observations",
    plane: "capture",
    kindColumn: "kind",
    columns: {
      id: "BIGINT",
      source: "VARCHAR",
      producer: "VARCHAR",
      platform: "VARCHAR",
      account_id: "BIGINT",
      native_account_ref: "VARCHAR",
      kind: "VARCHAR",
      payload: "JSON",
      payload_hash: "VARCHAR",
      idempotency_key: "VARCHAR",
      observed_at: "TIMESTAMPTZ",
      received_at: "TIMESTAMPTZ",
      actor_principal_id: "BIGINT",
      parse_version: "INTEGER",
      // G5 slice 1 (0124): the content-addressed catalog reference. Exported
      // as plain values — the ref is part of the envelope's history even
      // though the catalog itself is not a tiered table.
      payload_bucket_month: "DATE",
      payload_object_id: "BIGINT",
      // G5 slice 3a (0125): the queryable projections of the harvest payload.
      // VARCHAR because the columns are `text` in Postgres for the reason they
      // are text there — they reproduce what `payload->>'…'` returned, and a
      // cold copy that re-typed them would stop being that reproduction.
      harvest_machine_id: "VARCHAR",
      harvest_tx_id: "VARCHAR",
      harvest_tx_amount: "VARCHAR",
      harvest_tx_created_at: "VARCHAR",
    },
  },
  {
    table: "domain_events",
    plane: "ledger",
    columns: {
      id: "BIGINT",
      account_id: "BIGINT",
      account_seq: "BIGINT",
      type: "VARCHAR",
      occurred_at: "TIMESTAMPTZ",
      fan_identity_ref: "VARCHAR",
      conversation_ref: "VARCHAR",
      message_ref: "VARCHAR",
      transaction_ref: "VARCHAR",
      post_ref: "VARCHAR",
      data: "JSON",
      schema_version: "INTEGER",
      observation_id: "BIGINT",
      dedup_key: "VARCHAR",
      created_at: "TIMESTAMPTZ",
    },
  },
];

function duckdbColumnsLiteral(columns: Record<string, string>): string {
  return `{${Object.entries(columns).map(([name, type]) => `${name}: '${type}'`).join(", ")}}`;
}

export async function ndjsonToParquet(
  ndjsonPath: string,
  parquetPath: string,
  columns: Record<string, string>,
): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM read_json('${ndjsonPath.replaceAll("'", "''")}', format='newline_delimited', columns=${duckdbColumnsLiteral(columns)})) `
      + `TO '${parquetPath.replaceAll("'", "''")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

export async function readParquetIds(parquetPath: string): Promise<number[]> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.run(
      `SELECT id::bigint AS id FROM read_parquet('${parquetPath.replaceAll("'", "''")}') ORDER BY id`,
    );
    const rows = await reader.getRowObjects();
    return rows.map((row) => Number(row.id));
  } finally {
    connection.closeSync();
  }
}

/** A lake partition's manifest, as the retired tiering run wrote it. */
export interface TieringManifest {
  table: string;
  partition: string;
  rowCount: number;
  restrictedRowCount: number;
  minId: number | null;
  maxId: number | null;
  sha256: string;
  restrictedSha256: string | null;
  exportedAt: string;
  /** Erasure rewrites append themselves here (filter-out + re-checksum). */
  erasures?: Array<{ scopeRef: string; removedRows: number; at: string }>;
}
