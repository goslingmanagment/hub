import { createDeviceToken, findUserByUsername } from "@agency_hub_core/db";
import { randomToken, sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import {
  DEVICE_TOKEN_PREFIX,
  assignPageToUser,
  listEffectivePageAssignments,
  type AuditContext,
} from "../../apps/runtime/src/services/auth.ts";

/**
 * Test fixture for "this person has a working client bearer".
 *
 * Decision 353 left exactly two ways to mint a device token in production:
 * `issueDeviceTokenWithPassword` (username + password) and
 * `activatePendingDeviceToken` (the desktop's staged reservation). Neither fits
 * a fixture — a chatter has no password until an invite link is redeemed, and
 * making every suite mint a link to get a bearer would test the link flow a
 * hundred times over instead of the thing under test.
 *
 * So the fixture writes the row the way the service does — same prefix, same
 * digest, same 90-day expiry — and nothing else. It lives in tests/ on purpose:
 * production has no credential path that skips a password.
 */

const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const KEY_PREFIX_DISPLAY_LENGTH = 10;

export interface IssuedTestDeviceToken {
  token: string;
  id: number;
  label: string;
  keyPrefix: string;
  expiresAt: Date;
}

export async function issueDeviceTokenForUsername(
  app: AppContext,
  input: { username: string; label: string; expiresAt?: Date },
  _audit?: AuditContext,
): Promise<IssuedTestDeviceToken> {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new Error(`test fixture: user "${input.username}" not found`);
  }
  const tokenBody = randomToken(24);
  const token = `${DEVICE_TOKEN_PREFIX}${tokenBody}`;
  const keyPrefix = `${DEVICE_TOKEN_PREFIX}${tokenBody.slice(0, KEY_PREFIX_DISPLAY_LENGTH)}`;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
  const created = await createDeviceToken(app.db, {
    userId: user.id,
    label: input.label,
    tokenDigest: sha256Hex(token),
    keyPrefix,
    expiresAt,
  });
  return { token, id: created.id, label: created.label, keyPrefix, expiresAt };
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
  if (input.pageLabel) {
    await assignPageToUser(app, { username: input.username, pageLabel: input.pageLabel }, audit);
  }
  const issued = await issueDeviceTokenForUsername(
    app,
    { username: input.username, label: input.label ?? `${input.username} test device` },
    audit,
  );
  const user = await findUserByUsername(app.db, input.username);
  const assignedPages = user ? await listEffectivePageAssignments(app, user.id) : [];
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
