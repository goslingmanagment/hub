import {
  findPageById,
  findPageByLabel,
  listPagesByPlatform,
  updateOnlyFansPageIdentityFromOfapi,
} from "@agency_hub_core/db";
import { redactSensitiveText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { OfapiAccountRecord } from "./ofapi.ts";
import {
  normalizeOnlyFansAvatarUrl,
  resolveOnlyFansDisplayName,
} from "./onlyfans.ts";

export interface OnlyFansPageMetadataBackfillPageResult {
  pageId: number | null;
  pageLabel: string;
  status: "updated" | "failed";
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  error: string | null;
}

function uniqueNonEmpty(values: readonly string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function avatarFromMetadata(metadata: Record<string, unknown>) {
  return normalizeOnlyFansAvatarUrl(metadata.avatarUrl);
}

function metadataRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

type StoredPageLookup = NonNullable<Awaited<ReturnType<typeof findPageById>>>;
type StoredPage = StoredPageLookup["page"];

function pageResult(
  page: StoredPage,
): OnlyFansPageMetadataBackfillPageResult {
  return {
    pageId: page.id,
    pageLabel: page.label,
    status: "updated",
    username: page.username,
    displayName: page.displayName,
    avatarUrl: avatarFromMetadata(page.metadata),
    error: null,
  };
}

function resolveOfapiDisplayName(account: OfapiAccountRecord, page: StoredPage) {
  const username = account.username ?? page.username ?? "";
  return resolveOnlyFansDisplayName({
    name: account.displayName ?? account.onlyfansName ?? username,
    username,
  }, {
    displayName: account.onlyfansName ?? page.displayName,
    username: page.username ?? username,
  });
}

async function backfillOfapiPageIdentity(
  app: AppContext,
  page: StoredPage,
  accountsById: Map<string, OfapiAccountRecord>,
) {
  if (!page.ofapiAccountId) {
    throw new Error(`Page "${page.label}" has no stored platform credentials or OFAPI account mapping`);
  }

  const account = accountsById.get(page.ofapiAccountId);
  if (!account) {
    throw new Error(`OFAPI account "${page.ofapiAccountId}" was not returned by /accounts`);
  }

  const metadata = metadataRecord(page.metadata);
  const avatarUrl = normalizeOnlyFansAvatarUrl(account.avatarUrl)
    ?? normalizeOnlyFansAvatarUrl(metadata.avatarUrl)
    ?? null;

  return updateOnlyFansPageIdentityFromOfapi(app.db, page.id, {
    ofapiAccountId: page.ofapiAccountId,
    username: account.username ?? page.username,
    displayName: resolveOfapiDisplayName(account, page),
    metadata: {
      ...metadata,
      avatarUrl,
    },
  });
}

export async function backfillOnlyFansPageMetadata(
  app: AppContext,
  input?: {
    pageLabels?: string[];
  },
) {
  const requestedPageLabels = uniqueNonEmpty(input?.pageLabels ?? []);
  const pageLabels = requestedPageLabels.length > 0
    ? requestedPageLabels
    : (await listPagesByPlatform(app.db, "onlyfans")).map((page) => page.label);

  const pages: OnlyFansPageMetadataBackfillPageResult[] = [];
  let ofapiAccountsById: Map<string, OfapiAccountRecord> | null = null;

  async function getOfapiAccountsById() {
    if (ofapiAccountsById) {
      return ofapiAccountsById;
    }
    if (!app.ofapi) {
      throw new Error("OFAPI_API_KEY is not configured");
    }
    const accounts = await app.ofapi.listAccounts();
    ofapiAccountsById = new Map(accounts.map((account) => [account.id, account]));
    return ofapiAccountsById;
  }

  for (const pageLabel of pageLabels) {
    let resolvedPageId: number | null = null;
    let resolvedPageLabel = pageLabel;
    try {
      const target = await findPageByLabel(app.db, pageLabel);
      if (!target) {
        throw new Error(`Page "${pageLabel}" was not found`);
      }

      const stored = await findPageById(app.db, target.page.id);
      if (!stored) {
        throw new Error(`Page "${target.page.label}" was not found`);
      }
      resolvedPageId = stored.page.id;
      resolvedPageLabel = stored.page.label;
      if (stored.page.platform !== "onlyfans") {
        throw new Error(`Page "${stored.page.label}" is not an OnlyFans page`);
      }

      // Stage 18: the OnlyMonster credentials path is retired — identity
      // backfill is OFAPI-only (updateOnlyFansPageIdentityFromOfapi).
      if (!stored.page.ofapiAccountId) {
        throw new Error(`Page "${stored.page.label}" has no OFAPI account mapping`);
      }

      const accountsById = await getOfapiAccountsById();
      pages.push(pageResult(await backfillOfapiPageIdentity(app, stored.page, accountsById)));
    } catch (error) {
      pages.push({
        pageId: resolvedPageId,
        pageLabel: resolvedPageLabel,
        status: "failed",
        username: null,
        displayName: null,
        avatarUrl: null,
        error: errorMessage(error),
      });
    }
  }

  return {
    totalPages: pages.length,
    updatedPages: pages.filter((page) => page.status === "updated").length,
    failedPages: pages.filter((page) => page.status === "failed").length,
    pages,
  };
}
