import type { Pool } from "pg";
import { resolveMigrationFiles } from "./migrations-dir.ts";

type ColumnShapeRow = {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

const REQUIRED_TABLE_NAMES = [
  "pages",
  "page_sync_states",
  "page_sync_cursors",
  "creator_posts",
  "creator_post_tips",
] as const;
const LEGACY_TABLE_NAMES = [
  ["platform", "accounts"].join("_"),
  ["platform", "account", "proxies"].join("_"),
  ["sync", "stream", "state"].join("_"),
  ["sync", "checkpoints"].join("_"),
  ["sync", "state"].join("_"),
  ["sync", "cursors"].join("_"),
  ["sync", "requests"].join("_"),
  ["rate", "limit", "buckets"].join("_"),
  ["raw", "payloads"].join("_"),
] as const;

function normalizeDefaultExpression(value: string | null) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "");
}

function isEmptyJsonbDefault(value: string | null) {
  return normalizeDefaultExpression(value) === "'{}'::jsonb";
}

function assertUniqueMigrationPrefixes(files: string[]) {
  const seenPrefixes = new Map<string, string>();

  for (const file of files) {
    const prefix = file.split("_", 1)[0] ?? "";
    if (!prefix) {
      continue;
    }

    const existing = seenPrefixes.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate migration prefix "${prefix}" found in "${existing}" and "${file}"`,
      );
    }

    seenPrefixes.set(prefix, file);
  }
}

function driftError(detail: string) {
  return new Error(
    "Database schema for this runtime is behind or inconsistent. " +
      "Run `pnpm db:migrate` against the same DATABASE_URL used by this process. " +
      `Detail: ${detail}`,
  );
}

async function assertCreatorPostMonetizationSchema(pool: Pick<Pool, "query">) {
  // Migration 0121 is a runtime contract, not merely a migration-ledger marker.
  // Keep these expectations structural and additive: later migrations may add
  // columns or indexes, but changing/removing any 0121 object must fail startup.
  const columns = await pool.query<{ ready: boolean }>(`
    /* runtime_schema_guard_0121_columns */
    with expected(
      table_name, column_name, data_type, is_nullable, column_default,
      is_identity, identity_generation, character_maximum_length
    ) as (
      values
        ('creator_posts', 'tip_amount_mills', 'bigint', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'attachment_tip_amount_mills', 'bigint', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'post_tip_total_mills', 'bigint', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_linked', 'boolean', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_ref', 'text', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_label', 'text', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_target_mills', 'bigint', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_current_mills', 'bigint', 'YES', '', 'NO', '', -1),
        ('creator_posts', 'tip_goal_amounts_hidden', 'boolean', 'YES', '', 'NO', '', -1),
        ('creator_post_tips', 'id', 'bigint', 'NO', '', 'YES', 'ALWAYS', -1),
        ('creator_post_tips', 'account_id', 'bigint', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'platform', 'text', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'platform_post_id', 'text', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'platform_tip_id', 'text', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'tip_sender_platform_user_id', 'text', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'post_tip_amount_mills', 'bigint', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'occurred_at', 'timestamp with time zone', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'receiver_transaction_ref', 'text', 'YES', '', 'NO', '', -1),
        ('creator_post_tips', 'sender_transaction_ref', 'text', 'YES', '', 'NO', '', -1),
        ('creator_post_tips', 'tip_goal_ref', 'text', 'YES', '', 'NO', '', -1),
        ('creator_post_tips', 'tip_message_text', 'text', 'YES', '', 'NO', '', -1),
        ('creator_post_tips', 'first_observed_at', 'timestamp with time zone', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'last_observed_at', 'timestamp with time zone', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'content_hash', 'character', 'NO', '', 'NO', '', 64),
        ('creator_post_tips', 'source_event_id', 'bigint', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'source_observation_id', 'bigint', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'source_account_seq', 'bigint', 'NO', '', 'NO', '', -1),
        ('creator_post_tips', 'created_at', 'timestamp with time zone', 'NO', 'now()', 'NO', '', -1),
        ('creator_post_tips', 'updated_at', 'timestamp with time zone', 'NO', 'now()', 'NO', '', -1)
    )
    select not exists (
      select 1
      from expected e
      left join information_schema.columns c
        on c.table_schema = 'public'
       and c.table_name = e.table_name
       and c.column_name = e.column_name
      where c.column_name is null
         or c.data_type <> e.data_type
         or c.is_nullable <> e.is_nullable
         or regexp_replace(lower(coalesce(c.column_default, '')), '\\s+', '', 'g')
              <> e.column_default
         or c.is_identity <> e.is_identity
         or coalesce(c.identity_generation, '') <> e.identity_generation
         or coalesce(c.character_maximum_length, -1) <> e.character_maximum_length
    ) as ready
  `);
  if (columns.rows[0]?.ready !== true) {
    throw driftError("migration 0121 creator-post columns do not match the runtime contract");
  }

  const constraints = await pool.query<{ ready: boolean }>(`
    /* runtime_schema_guard_0121_constraints */
    with expected(table_name, constraint_name, constraint_type, definition) as (
      values
        ('creator_posts', 'creator_posts_tip_amount_check', 'c',
          'CHECK (tip_amount_mills IS NULL OR tip_amount_mills >= 0)'),
        ('creator_posts', 'creator_posts_attachment_tip_amount_check', 'c',
          'CHECK (attachment_tip_amount_mills IS NULL OR attachment_tip_amount_mills >= 0)'),
        ('creator_posts', 'creator_posts_tip_total_check', 'c',
          'CHECK (post_tip_total_mills IS NULL OR post_tip_total_mills >= 0)'),
        ('creator_posts', 'creator_posts_tip_total_consistency_check', 'c',
          'CHECK (NOT post_tip_total_mills IS DISTINCT FROM CASE WHEN tip_amount_mills IS NULL AND attachment_tip_amount_mills IS NULL THEN NULL::bigint ELSE COALESCE(tip_amount_mills, 0::bigint) + COALESCE(attachment_tip_amount_mills, 0::bigint) END)'),
        ('creator_posts', 'creator_posts_tip_goal_ref_check', 'c',
          'CHECK (tip_goal_ref IS NULL OR length(tip_goal_ref) > 0)'),
        ('creator_posts', 'creator_posts_tip_goal_amount_check', 'c',
          'CHECK ((tip_goal_target_mills IS NULL OR tip_goal_target_mills >= 0) AND (tip_goal_current_mills IS NULL OR tip_goal_current_mills >= 0))'),
        ('creator_posts', 'creator_posts_tip_goal_link_check', 'c',
          'CHECK (CASE WHEN tip_goal_linked IS TRUE THEN tip_goal_ref IS NOT NULL ELSE tip_goal_ref IS NULL AND tip_goal_label IS NULL AND tip_goal_target_mills IS NULL AND tip_goal_current_mills IS NULL AND tip_goal_amounts_hidden IS NULL END)'),
        ('creator_post_tips', 'creator_post_tips_pkey', 'p', 'PRIMARY KEY (id)'),
        ('creator_post_tips', 'creator_post_tips_account_id_fkey', 'f',
          'FOREIGN KEY (account_id) REFERENCES pages(id) ON DELETE RESTRICT'),
        ('creator_post_tips', 'creator_post_tips_platform_fkey', 'f',
          'FOREIGN KEY (platform) REFERENCES platforms(key) ON DELETE RESTRICT'),
        ('creator_post_tips', 'creator_post_tips_account_tip_post_uniq', 'u',
          'UNIQUE (account_id, platform_tip_id, platform_post_id)'),
        ('creator_post_tips', 'creator_post_tips_refs_check', 'c',
          'CHECK (length(platform_post_id) > 0 AND length(platform_tip_id) > 0 AND length(tip_sender_platform_user_id) > 0 AND (receiver_transaction_ref IS NULL OR length(receiver_transaction_ref) > 0) AND (sender_transaction_ref IS NULL OR length(sender_transaction_ref) > 0) AND (tip_goal_ref IS NULL OR length(tip_goal_ref) > 0))'),
        ('creator_post_tips', 'creator_post_tips_amount_check', 'c',
          'CHECK (post_tip_amount_mills >= 0)'),
        ('creator_post_tips', 'creator_post_tips_content_hash_check', 'c',
          'CHECK (content_hash ~ ''^[0-9a-f]{64}$''::text)'),
        ('creator_post_tips', 'creator_post_tips_source_account_seq_check', 'c',
          'CHECK (source_account_seq > 0)'),
        ('creator_post_tips', 'creator_post_tips_observed_order_check', 'c',
          'CHECK (last_observed_at >= first_observed_at)')
    ), actual as (
      select t.relname as table_name, c.conname as constraint_name,
             c.contype::text as constraint_type,
             pg_get_constraintdef(c.oid, true) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
    )
    select not exists (
      select 1
      from expected e
      left join actual a
        on a.table_name = e.table_name
       and a.constraint_name = e.constraint_name
      where a.constraint_name is null
         or a.constraint_type <> e.constraint_type
         or regexp_replace(lower(replace(a.definition, '"', '')), '\\s+', '', 'g')
              <> regexp_replace(lower(replace(e.definition, '"', '')), '\\s+', '', 'g')
    ) as ready
  `);
  if (constraints.rows[0]?.ready !== true) {
    throw driftError("migration 0121 creator-post constraints do not match the runtime contract");
  }

  const indexes = await pool.query<{ ready: boolean }>(`
    /* runtime_schema_guard_0121_indexes */
    with expected(index_name, definition) as (
      values
        ('creator_post_tips_account_occurred_idx',
          'CREATE INDEX creator_post_tips_account_occurred_idx ON public.creator_post_tips USING btree (account_id, occurred_at DESC, id DESC)'),
        ('creator_post_tips_account_post_idx',
          'CREATE INDEX creator_post_tips_account_post_idx ON public.creator_post_tips USING btree (account_id, platform_post_id, occurred_at DESC)'),
        ('creator_post_tips_account_sender_occurred_idx',
          'CREATE INDEX creator_post_tips_account_sender_occurred_idx ON public.creator_post_tips USING btree (account_id, tip_sender_platform_user_id, occurred_at DESC, id DESC)'),
        ('creator_post_tips_receiver_transaction_idx',
          'CREATE INDEX creator_post_tips_receiver_transaction_idx ON public.creator_post_tips USING btree (account_id, receiver_transaction_ref) WHERE (receiver_transaction_ref IS NOT NULL)')
    ), actual as (
      select i.relname as index_name, pg_get_indexdef(i.oid) as definition
      from pg_class i
      join pg_namespace n on n.oid = i.relnamespace
      where n.nspname = 'public' and i.relkind = 'i'
    )
    select not exists (
      select 1
      from expected e
      left join actual a on a.index_name = e.index_name
      where a.index_name is null
         or regexp_replace(lower(replace(a.definition, '"', '')), '\\s+', '', 'g')
              <> regexp_replace(lower(replace(e.definition, '"', '')), '\\s+', '', 'g')
    ) as ready
  `);
  if (indexes.rows[0]?.ready !== true) {
    throw driftError("migration 0121 creator_post_tips indexes do not match the runtime contract");
  }
}

export async function assertRuntimeSchemaReady(
  pool: Pick<Pool, "query">,
  input?: {
    migrationsDir?: string;
  },
) {
  const { files: migrationFiles, migrationsDir } = await resolveMigrationFiles({
    migrationsDir: input?.migrationsDir,
  });
  assertUniqueMigrationPrefixes(migrationFiles);
  const latestMigration = migrationFiles.at(-1);

  if (!latestMigration) {
    throw new Error(`No SQL migrations were found in ${migrationsDir}`);
  }

  const migrationTable = await pool.query<{ name: string | null }>(
    "select to_regclass('public.schema_migrations') as name",
  );

  if (migrationTable.rows[0]?.name !== "schema_migrations") {
    throw driftError("schema_migrations table is missing");
  }

  const appliedMigration = await pool.query<{ id: string }>(
    "select id from schema_migrations where id = $1 limit 1",
    [latestMigration],
  );

  if (!appliedMigration.rows[0]?.id) {
    throw driftError(`missing latest migration ${latestMigration}`);
  }

  const requiredTables = await pool.query<{ name: string }>(
    `select table_name as name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in (${REQUIRED_TABLE_NAMES.map((name) => `'${name}'`).join(", ")})`,
  );

  const requiredNames = new Set(requiredTables.rows.map((row) => row.name));
  for (const name of REQUIRED_TABLE_NAMES) {
    if (!requiredNames.has(name)) {
      throw driftError(`required table ${name} is missing`);
    }
  }

  const legacyTables = await pool.query<{ name: string }>(
    `select table_name as name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in (${LEGACY_TABLE_NAMES.map((name) => `'${name}'`).join(", ")})`,
  );

  if (legacyTables.rows.length > 0) {
    throw driftError(`legacy tables still exist: ${legacyTables.rows.map((row) => row.name).join(", ")}`);
  }

  const statsColumn = await pool.query<ColumnShapeRow>(
    `select data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sync_runs'
        and column_name = 'stats'
      limit 1`,
  );

  const column = statsColumn.rows[0];
  if (!column) {
    throw driftError("sync_runs.stats column is missing");
  }

  if (
    column.data_type !== "jsonb" ||
    column.is_nullable !== "NO" ||
    !isEmptyJsonbDefault(column.column_default)
  ) {
    throw driftError(
      "sync_runs.stats must be jsonb NOT NULL DEFAULT '{}'::jsonb " +
        `(got type=${column.data_type}, nullable=${column.is_nullable}, default=${column.column_default ?? "null"})`,
    );
  }

  await assertCreatorPostMonetizationSchema(pool);
}
