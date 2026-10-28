import { and, eq } from "drizzle-orm";

import {
  createPlatformPage,
  findAiPersonaByKey,
  findModelBySlug,
  findPageByLabel,
  pages,
  storeProxyConfig,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { recordAudit, withAuditTransaction, type AuditContext } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

// A persona's own Telegram account as a hub page (chat-extension Telegram spec
// §5.5), for the operator's audited `page add telegram`. The page has no
// transactions and no sync (shared platform-sync.ts `none`): it exists so the
// extension can bind the account to it and its AI runs on it. Its pieces:
// - `external_page_id`: the account's Telegram user id, what the extension
//   binds the open Telegram Web account by. Set here once and never changed
//   (no writer of a Telegram page touches it); checked free before.
// - the AI gateway's proxy, copied from a page the owner names (the gateway
//   refuses a page without one): the same address, the same rate scope.
// - its default persona (`default_persona_key`), served in the bootstrap.

const PAGE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** A Telegram user id: a positive integer. */
const TELEGRAM_USER_ID = /^[1-9]\d{0,19}$/;

export interface TelegramPageInput {
  modelSlug: string;
  label: string;
  displayName: string;
  /** The account's Telegram user id. */
  accountId: string;
  /** The page whose AI gateway proxy the new page uses. */
  proxyFromLabel: string;
  /** The page's default persona (an active `ai_personas` key). */
  personaKey: string;
}

export interface TelegramPageCreated {
  id: number;
  label: string;
  accountId: string;
  proxyFromLabel: string;
  personaKey: string;
}

export async function addTelegramPage(
  app: Pick<AppContext, "db">,
  audit: AuditContext,
  input: TelegramPageInput,
): Promise<TelegramPageCreated> {
  const label = input.label.trim();
  const displayName = input.displayName.trim();
  const accountId = input.accountId.trim();
  if (!PAGE_LABEL.test(label)) {
    throw new BadRequestError("--label: letters, digits, underscore or hyphen, starting with a letter or digit");
  }
  if (displayName.length === 0 || displayName.length > 200) {
    throw new BadRequestError("--display-name: 1 to 200 characters");
  }
  if (!TELEGRAM_USER_ID.test(accountId)) {
    throw new BadRequestError("--account-id: the account's Telegram user id, a positive integer");
  }

  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  }
  const persona = await findAiPersonaByKey(app.db, input.personaKey);
  if (!persona || persona.archivedAt !== null) {
    throw new NotFoundError(`No active persona "${input.personaKey}": add it first (persona put)`);
  }
  const source = await findPageByLabel(app.db, input.proxyFromLabel);
  if (!source) {
    throw new NotFoundError(`Page "${input.proxyFromLabel}" does not exist`);
  }
  if (!source.proxy) {
    throw new BadRequestError(`Page "${input.proxyFromLabel}" has no proxy to copy`);
  }
  const bound = await app.db.query.pages.findFirst({
    where: and(eq(pages.platform, "telegram"), eq(pages.platformAccountId, accountId)),
  });
  if (bound) {
    throw new ConflictError(`Telegram account ${accountId} is already page "${bound.label}"`);
  }
  const proxy = source.proxy;

  return withAuditTransaction(app, async (db) => {
    const created = await createPlatformPage(db, { modelId: model.id, platform: "telegram", label });
    await db.update(pages).set({
      platformAccountId: accountId,
      displayName,
      defaultPersonaKey: persona.key,
      updatedAt: new Date(),
    }).where(eq(pages.id, created.id));
    await storeProxyConfig(db, created.id, {
      url: proxy.url,
      encryptedAuth: proxy.encryptedAuth,
      keyVersion: proxy.keyVersion,
      rateLimitScopeKey: proxy.rateLimitScopeKey,
    });
    await recordAudit({ db }, {
      ...audit,
      eventType: "admin.page_create",
      platformAccountId: created.id,
      metadata: {
        pageLabel: label,
        platform: "telegram",
        modelSlug: model.slug,
        platformAccountId: accountId,
        proxyFromPageLabel: source.page.label,
        defaultPersonaKey: persona.key,
      },
    });
    return { id: created.id, label, accountId, proxyFromLabel: source.page.label, personaKey: persona.key };
  });
}
