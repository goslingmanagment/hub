import {
  DuplicatePageLabelError,
  OfapiAccountCustodyConflictError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  createOnlyFansPage,
  findModelBySlug,
  setPageOfapiAccountId,
  updateOnlyFansPageIdentityFromOfapi,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { normalizeOnlyFansAvatarUrl } from "./onlyfans.ts";

// A new Fansly page is onboarded through its own browser
// (`page-browser-onboarding.ts`); this file onboards an OnlyFans page.

type OnlyFansOnboardingContext = Pick<AppContext, "db" | "config" | "ofapi">;

function rethrowPageIdentityConflict(error: unknown): never {
  if (
    error instanceof DuplicatePageLabelError ||
    error instanceof PlatformAccountIdentityConflictError ||
    error instanceof PlatformAccountIdentityImmutableError ||
    error instanceof OfapiAccountCustodyConflictError
  ) {
    throw new ConflictError(error.message);
  }

  throw error;
}

export async function onboardOnlyFansPage(
  app: OnlyFansOnboardingContext,
  input: {
    modelSlug: string;
    label: string;
    username: string;
  },
) {
  // OnlyMonster retired — OnlyFans pages onboard against the OFAPI
  // vendor: the account must already be connected at onlyfansapi.com, and the
  // page is created pre-mapped (no pasted credentials, no per-page proxy —
  // egress is vendor-side).
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  }
  if (!app.ofapi) {
    throw new BadRequestError("OFAPI is not configured (OFAPI_API_KEY) — OnlyFans onboarding requires it");
  }

  await app.ofapi.assertCredentialReady?.();
  const needle = input.username.trim().toLowerCase().replace(/^@/, "");
  const accounts = await app.ofapi.listAccounts();
  const matches = accounts.filter((account) =>
    (account.username ?? "").toLowerCase().replace(/^@/, "") === needle
    || (account.onlyfansName ?? "").toLowerCase() === needle,
  );
  if (matches.length === 0) {
    throw new NotFoundError(
      `No connected OFAPI account matches "${input.username}" — connect the account at the vendor first`,
    );
  }
  if (matches.length > 1) {
    throw new ConflictError(`Multiple OFAPI accounts match "${input.username}" — resolve manually`);
  }
  const account = matches[0]!;
  if (!account.onlyfansUserId || account.identityStatus === "conflict") {
    throw new ConflictError("OFAPI creator identity is unverified; username alone cannot establish a page binding");
  }

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createOnlyFansPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });
      await setPageOfapiAccountId(dbTx, { pageId: created.id, ofapiAccountId: account.id, creatorId: account.onlyfansUserId,
        evidence: { source: "onboarding", username: account.username } });
      await updateOnlyFansPageIdentityFromOfapi(dbTx, created.id, {
        ofapiAccountId: account.id,
        username: account.username,
        displayName: account.displayName ?? account.onlyfansName,
        metadata: {
          ...(normalizeOnlyFansAvatarUrl(account.avatarUrl)
            ? { avatarUrl: normalizeOnlyFansAvatarUrl(account.avatarUrl) }
            : {}),
          ...(account.onlyfansUserId ? { onlyfansUserId: account.onlyfansUserId } : {}),
        },
      });
      return created;
    });
  } catch (error) {
    rethrowPageIdentityConflict(error);
  }

  return {
    page,
    verified: account,
  };
}
