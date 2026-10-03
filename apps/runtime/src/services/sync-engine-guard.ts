import { findPageByLabel, isFanslyPageEngineOwned, type Database } from "@agency_hub_core/db";

import { AppError } from "./errors.ts";

// Step-3 design §3.1 items 10–11 (S3-01): the legacy senders outside the
// schedulers — the owner's `/account/me` routes and CLIs, the probes, the
// alias backfill, the binding preflight and the probe-socket scripts — refuse
// a page the Fansly Sync Engine owns (`handover`/`live`) before they resolve
// an egress or touch the page's send guard. The step-1 guard row stays the
// catch-all at the wire; this is the refusal with a reason and a hint.
// `off` and `shadow` pages pass (J8).

export const FANSLY_PAGE_ON_SYNC_ENGINE_CODE = "fansly_page_on_sync_engine";

/** Where to go instead, per legacy entry point. */
export const SYNC_ENGINE_HINTS = {
  verify: (label: string) =>
    `the engine verifies the page's session itself; read it with \`pnpm cli sync page status --page ${label}\``
    + ` or ask for one read with \`pnpm cli sync probe --page ${label} --operation account.me\``,
  credentials: (label: string) =>
    "credentials and proxy changes of an engine page go through the engine's identity check;"
    + ` see \`pnpm cli sync page status --page ${label}\``,
  probe: (label: string) =>
    `ask the engine for one paced read: \`pnpm cli sync probe --page ${label} --operation <wire id>\``,
  aliasBackfill: (label: string) =>
    `fan profiles of an engine page are the engine's: \`pnpm cli sync work enqueue --page ${label}`
    + " --resource fan-profiles.alias-backfill`",
  socket: (label: string) =>
    `the page's socket belongs to the engine; see \`pnpm cli sync page status --page ${label}\``,
} as const;

export class FanslyPageOnSyncEngineError extends AppError {
  readonly pageId: number;
  readonly pageLabel: string;
  readonly mode: string;

  constructor(input: { pageId: number; pageLabel: string; mode: string; hint?: string }) {
    super(
      `Page ${input.pageLabel} is on the Fansly Sync Engine (mode ${input.mode}): `
        + `the legacy engine sends nothing for it${input.hint ? `; ${input.hint}` : ""}`,
      409,
      FANSLY_PAGE_ON_SYNC_ENGINE_CODE,
    );
    this.name = "FanslyPageOnSyncEngineError";
    this.pageId = input.pageId;
    this.pageLabel = input.pageLabel;
    this.mode = input.mode;
  }
}

/** A request that would make a page read, asked while the Fansly Sync Engine
 *  takes it over or gives it back (`handover`): neither engine reads it until
 *  the switch (or rollback) completes. */
export class FanslyPageSwitchingError extends AppError {
  constructor(label: string) {
    super(
      `${label} is being switched to the Fansly Sync Engine (handover): neither engine reads it until the switch completes`,
      409,
      "fansly_page_switching",
    );
    this.name = "FanslyPageSwitchingError";
  }
}

/** Refuse a page the Fansly Sync Engine owns (409 `fansly_page_on_sync_engine`). */
export async function assertLegacyOwnsFanslyPage(
  app: { db: Database },
  page: { id: number; label: string },
  options: { hint?: string } = {},
): Promise<void> {
  const ownership = await isFanslyPageEngineOwned(app.db, page.id);
  if (ownership.owned) {
    throw new FanslyPageOnSyncEngineError({
      pageId: page.id,
      pageLabel: page.label,
      mode: ownership.mode ?? "?",
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    });
  }
}

/** The same refusal for a list of page labels, all checked before any of them
 *  sends. A label that names no page passes: the caller's own lookup reports
 *  it as it always did. */
export async function assertLegacyOwnsFanslyPageLabels(
  app: { db: Database },
  labels: readonly string[],
  hint: (label: string) => string,
): Promise<void> {
  for (const label of labels) {
    const stored = await findPageByLabel(app.db, label);
    if (stored) await assertLegacyOwnsFanslyPage(app, stored.page, { hint: hint(stored.page.label) });
  }
}
