import { createDeviceToken, findUserByUsername } from "@agency_hub_core/db";
import { randomToken, sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import {
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_TTL_MS,
  KEY_PREFIX_DISPLAY_LENGTH,
  assignPageToUser,
  listEffectivePageAssignments,
  type AuditContext,
} from "../../apps/runtime/src/services/auth.ts";

/**
 * Test fixture for "this person has a working client bearer".
 *
 * Decision 369 left exactly two ways to mint a device token in production:
 * `issueDeviceTokenWithPassword` (username + password) and
 * `activatePendingDeviceToken` (the desktop's staged reservation). Neither fits
 * a fixture — a chatter has no password until an invite link is redeemed, and
 * making every suite mint a link to get a bearer would test the link flow a
 * hundred times over instead of the thing under test.
 *
 * So the fixture writes the row the way the service does — same prefix, same
 * digest, same 90-day expiry, all three imported from the service so they
 * cannot drift — and nothing else. It lives in tests/ on purpose: production has
 * no credential path that skips a password.
 *
 * **It deliberately writes no audit row and no observation.** A fixture is not a
 * business fact, and a journal full of tokens nobody issued would make the DP 7
 * pins meaningless. The real issuance path's journaling is pinned where it
 * belongs — `tests/device-token-password.integration.test.ts` › *the issuance
 * audit*, over `issueDeviceTokenWithPassword`. The `audit` argument here is
 * accepted only so call sites read like the service calls they replaced, and is
 * used solely by the page assignment below (which IS a real service call).
 */

export interface IssuedTestDeviceToken {
  token: string;
  id: number;
  label: string;
  keyPrefix: string;
  expiresAt: Date;
}

/** Decisions 355–357 address accounts by the immutable ID; this is the shape
 * the suites call when they already hold one. */
export async function issueDeviceTokenForUserId(
  app: AppContext,
  input: { userId: number; label: string; expiresAt?: Date },
  /** Ignored: see the note above — this path journals nothing. */
  _audit?: AuditContext,
): Promise<IssuedTestDeviceToken> {
  const tokenBody = randomToken(24);
  const token = `${DEVICE_TOKEN_PREFIX}${tokenBody}`;
  const keyPrefix = `${DEVICE_TOKEN_PREFIX}${tokenBody.slice(0, KEY_PREFIX_DISPLAY_LENGTH)}`;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
  const created = await createDeviceToken(app.db, {
    userId: input.userId,
    label: input.label,
    tokenDigest: sha256Hex(token),
    keyPrefix,
    expiresAt,
  });
  return { token, id: created.id, label: created.label, keyPrefix, expiresAt };
}

export async function issueDeviceTokenForUsername(
  app: AppContext,
  input: { username: string; label: string; expiresAt?: Date },
  /** Ignored: see the note above — this path journals nothing. */
  audit?: AuditContext,
): Promise<IssuedTestDeviceToken> {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new Error(`test fixture: user "${input.username}" not found`);
  }
  return issueDeviceTokenForUserId(
    app,
    { userId: user.id, label: input.label, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) },
    audit,
  );
}

/**
 * The drop-in for the retired `issueChatterApiKey`: optionally assign a page,
 * then hand back a live bearer in the same shape the suites already destructure
 * (`key`, `keyPrefix`, `assignedPages`).
 */
export async function issueChatterDeviceToken(
  app: AppContext,
  input: { username: string; pageLabel?: string; label?: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new Error(`test fixture: user "${input.username}" not found`);
  }
  if (input.pageLabel) {
    await assignPageToUser(app, { userId: user.id, pageLabel: input.pageLabel }, audit);
  }
  const issued = await issueDeviceTokenForUsername(
    app,
    { username: input.username, label: input.label ?? `${input.username} test device` },
    audit,
  );
  const assignedPages = await listEffectivePageAssignments(app, user.id);
  return {
    key: issued.token,
    id: issued.id,
    keyPrefix: issued.keyPrefix,
    assignedPages: assignedPages.map((page) => ({
      id: page.pageId,
      label: page.label,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
    })),
  };
}
