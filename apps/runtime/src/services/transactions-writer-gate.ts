import { getPageTransactionsWriterInfo } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { notifyWrongTransactionsWriterIncident } from "./notification-incidents.ts";

export type TransactionsWriter = "onlymonster" | "ofapi" | "fansly";

export class WrongTransactionsWriterError extends Error {
  readonly platformAccountId: number;
  readonly attemptedWriter: TransactionsWriter;
  readonly assignedWriter: string | null;

  constructor(input: {
    platformAccountId: number;
    attemptedWriter: TransactionsWriter;
    assignedWriter: string | null;
  }) {
    super(
      `Transactions writer '${input.attemptedWriter}' refused for page ${input.platformAccountId}: ` +
        `assigned writer is ${input.assignedWriter ? `'${input.assignedWriter}'` : "unassigned"}`,
    );
    this.name = "WrongTransactionsWriterError";
    this.platformAccountId = input.platformAccountId;
    this.attemptedWriter = input.attemptedWriter;
    this.assignedWriter = input.assignedWriter;
  }
}

/**
 * Stage 13 single-writer gate. Every transactions write path calls this before
 * writing a chunk/batch for a page; a mismatch opens an incident and THROWS —
 * the caller's chunk fails loudly and retries, never a silent skip. NULL
 * writer refuses everyone (Stage 14 assigns writers page-by-page).
 */
export async function assertPageTransactionsWriter(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    attemptedWriter: TransactionsWriter;
  },
) {
  const page = await getPageTransactionsWriterInfo(app.db, input.platformAccountId);
  const assignedWriter = page?.transactionsWriter ?? null;
  if (page && assignedWriter === input.attemptedWriter) {
    return;
  }

  await notifyWrongTransactionsWriterIncident(app, {
    platformAccountId: input.platformAccountId,
    pageLabel: page?.label ?? null,
    platform: page?.platform ?? null,
    attemptedWriter: input.attemptedWriter,
    assignedWriter,
  });
  throw new WrongTransactionsWriterError({
    platformAccountId: input.platformAccountId,
    attemptedWriter: input.attemptedWriter,
    assignedWriter,
  });
}
