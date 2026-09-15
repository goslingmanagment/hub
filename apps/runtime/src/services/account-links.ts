// Decision 347 (§4.1): one-time invite and password-reset links — the whole
// registration ceremony of the unified chatter account.
//
// Invariants this file keeps (pinned by tests/account-links.integration.test.ts):
// - the raw token exists only in the creation response; the row holds a sha256
//   digest and a 10-character display prefix; nothing here logs, audits or
//   journals the token or a password;
// - at most one ACTIVE link per user: every writer takes the user row lock
//   first (users → account_links order), the partial unique index is the belt;
// - nothing is deleted: used, expired and revoked links stay as facts;
// - every check is repeated under the lock before a password is written.

import argon2 from "argon2";

import {
  createAccountLink,
  findAccountLinkByDigest,
  findAccountLinkForUser,
  findPageSummaryByLabel,
  findUserById,
  findUserByUsername,
  hasRedeemedAccountLink,
  listAccountLinks,
  lockUserForDeviceTokenMutation,
  markAccountLinkUsed,
  revokeAccountLinkById,
  revokeActiveAccountLinks,
  updateUserMustChangePassword,
  updateUserPasswordHash,
  type AccountLinkKind,
} from "@agency_hub_core/db";
import {
  PASSWORD_POLICY_MESSAGES,
  checkNewPassword,
  randomToken,
  sha256Hex,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  assertUserNotDeactivated,
  assignPageToUserTx,
  createUserOrRefuseDuplicate,
  getAdminUserById,
  listEffectivePageAssignments,
  normalizeUsername,
  recordAudit,
  roleCanUseSession,
  terminateAccessTx,
  withAuditTransaction,
  type AuditContext,
} from "./auth.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const LINK_TOKEN_BYTES = 32;
const LINK_PREFIX_LENGTH = 10;
const DEFAULT_LINK_TTL_HOURS = 24 * 7;
const MAX_LINK_TTL_HOURS = 24 * 30;

export type AccountLinkState = "active" | "used" | "expired" | "revoked";

type AccountLinkRow = NonNullable<Awaited<ReturnType<typeof findAccountLinkByDigest>>>;

export function accountLinkState(link: AccountLinkRow, now: Date): AccountLinkState {
  if (link.usedAt) return "used";
  if (link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  return "active";
}

function accountLinkItem(link: AccountLinkRow, now: Date) {
  return {
    id: link.id,
    kind: link.kind,
    keyPrefix: link.keyPrefix,
    state: accountLinkState(link, now),
    expiresAt: link.expiresAt.toISOString(),
    usedAt: link.usedAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    revokedReason: link.revokedReason ?? null,
    createdAt: link.createdAt.toISOString(),
    createdBy: link.createdBy ?? null,
  };
}

function resolveLinkTtlHours(expiresInHours: number | undefined) {
  const hours = expiresInHours ?? DEFAULT_LINK_TTL_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LINK_TTL_HOURS) {
    throw new BadRequestError(`Link lifetime must be between 1 and ${MAX_LINK_TTL_HOURS} hours`);
  }
  return hours;
}

/** Token material: 32 random bytes; only the digest and the prefix are stored. */
function mintLinkMaterial(expiresInHours: number, now: number) {
  const token = randomToken(LINK_TOKEN_BYTES);
  return {
    token,
    tokenDigest: sha256Hex(token),
    keyPrefix: token.slice(0, LINK_PREFIX_LENGTH),
    expiresAt: new Date(now + expiresInHours * 60 * 60 * 1000),
  };
}

/** §4.1 p.4 under the lock: an invite completes only an unfinished
 * registration — no password yet, or no invite ever redeemed. */
async function assertInviteAllowed(
  dbTx: AppContext["db"],
  user: { id: number; username: string; passwordHash: string | null },
) {
  if (user.passwordHash === null) {
    return;
  }
  if (await hasRedeemedAccountLink(dbTx, user.id, "invite")) {
    throw new BadRequestError(
      `User "${user.username}" has already registered; create a password_reset link instead`,
    );
  }
}

function assertLinkKindAllowedForRole(
  user: { username: string; role: string },
  kind: AccountLinkKind,
) {
  if (user.role === "owner") {
    // §4.1 p.8: owners change their password through authChangePassword; they
    // are never invited by link either (owner accounts come from the CLI).
    throw new BadRequestError(
      kind === "password_reset"
        ? "Owner accounts change their password themselves"
        : "Owner accounts are not invited by link",
    );
  }
  if (!roleCanUseSession(user.role as Parameters<typeof roleCanUseSession>[0])) {
    throw new BadRequestError(`Role "${user.role}" cannot sign in`);
  }
}

async function accountLinksEnabled(app: AppContext) {
  const effective = await loadEffectiveConfig(app.db, app.config);
  return effective.accountLinksEnabled !== false;
}

/**
 * §5.2: the whole invite in ONE transaction — user (no password), page
 * assignments through the tx-aware core, the invite link, and every audit row.
 * A missing page or a duplicate login rolls all of it back: no half-invited
 * user is ever left behind.
 */
export async function createInvite(
  app: AppContext,
  input: {
    username: string;
    role?: "chatter" | "team_lead" | undefined;
    pageLabels: string[];
    expiresInHours?: number | undefined;
  },
  audit: AuditContext,
) {
  const username = normalizeUsername(input.username);
  if (username.length === 0) {
    throw new BadRequestError("Username is required");
  }
  const role = input.role ?? "chatter";
  const ttlHours = resolveLinkTtlHours(input.expiresInHours);
  const pageLabels = [...new Set(input.pageLabels)];

  const existing = await findUserByUsername(app.db, username);
  if (existing) {
    throw new BadRequestError(`User "${username}" already exists`);
  }

  const material = mintLinkMaterial(ttlHours, Date.now());
  const created = await withAuditTransaction(app, async (dbTx) => {
    // The INSERT is the lock on a brand-new row; the lower(username) index
    // turns a concurrent duplicate into the same 400 as the pre-check.
    const user = await createUserOrRefuseDuplicate(dbTx, {
      username,
      role,
      passwordHash: null,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.created",
      targetUserId: user.id,
      metadata: { username: user.username, role: user.role, via: "invite" },
    });

    for (const label of pageLabels) {
      const page = await findPageSummaryByLabel(dbTx, label);
      if (!page) {
        throw new NotFoundError(`Page "${label}" not found`);
      }
      await assignPageToUserTx(app, dbTx, { user, page }, audit);
    }

    const link = await createAccountLink(dbTx, {
      userId: user.id,
      kind: "invite",
      tokenDigest: material.tokenDigest,
      keyPrefix: material.keyPrefix,
      createdBy: audit.actorUserId ?? null,
      expiresAt: material.expiresAt,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "account_link.created",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        linkId: link.id,
        kind: link.kind,
        keyPrefix: link.keyPrefix,
        expiresAt: link.expiresAt.toISOString(),
      },
    });
    return { user, link };
  });

  const user = await getAdminUserById(app, created.user.id);
  if (!user) {
    throw new NotFoundError(`User "${username}" not found`);
  }
  return {
    user,
    link: {
      id: created.link.id,
      kind: created.link.kind,
      keyPrefix: created.link.keyPrefix,
      token: material.token,
      expiresAt: created.link.expiresAt.toISOString(),
    },
  };
}

/** §4.1 p.4–8: a new link of either kind for an existing user; it supersedes
 * every previously active link of that user. */
export async function createAccountLinkForUsername(
  app: AppContext,
  input: {
    username: string;
    kind: AccountLinkKind;
    expiresInHours?: number | undefined;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  assertLinkKindAllowedForRole(user, input.kind);
  assertUserNotDeactivated(user);
  const ttlHours = resolveLinkTtlHours(input.expiresInHours);

  const material = mintLinkMaterial(ttlHours, Date.now());
  const link = await withAuditTransaction(app, async (dbTx) => {
    const locked = await lockUserForDeviceTokenMutation(dbTx, user.id);
    if (!locked) {
      throw new NotFoundError(`User "${input.username}" not found`);
    }
    // Everything is re-checked under the lock: the right to this kind of link
    // may have changed while the request waited.
    assertLinkKindAllowedForRole(locked, input.kind);
    assertUserNotDeactivated(locked);
    if (input.kind === "invite") {
      await assertInviteAllowed(dbTx, locked);
    }

    const superseded = await revokeActiveAccountLinks(dbTx, locked.id, "superseded");
    const createdLink = await createAccountLink(dbTx, {
      userId: locked.id,
      kind: input.kind,
      tokenDigest: material.tokenDigest,
      keyPrefix: material.keyPrefix,
      createdBy: audit.actorUserId ?? null,
      expiresAt: material.expiresAt,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "account_link.created",
      targetUserId: locked.id,
      metadata: {
        username: locked.username,
        linkId: createdLink.id,
        kind: createdLink.kind,
        keyPrefix: createdLink.keyPrefix,
        expiresAt: createdLink.expiresAt.toISOString(),
        supersededLinks: superseded.length,
      },
    });
    return createdLink;
  });

  return {
    id: link.id,
    kind: link.kind,
    keyPrefix: link.keyPrefix,
    token: material.token,
    expiresAt: link.expiresAt.toISOString(),
  };
}

export async function listAccountLinksForUsername(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    throw new NotFoundError(`User "${username}" not found`);
  }
  const now = new Date();
  const links = await listAccountLinks(app.db, user.id);
  return links.map((link) => accountLinkItem(link, now));
}

/** Owner revocation of one link. Idempotent: an already used / revoked /
 * expired link is returned as it is. */
export async function revokeAccountLinkForUsername(
  app: AppContext,
  input: { username: string; linkId: number },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  return withAuditTransaction(app, async (dbTx) => {
    await lockUserForDeviceTokenMutation(dbTx, user.id);
    const link = await findAccountLinkForUser(dbTx, { linkId: input.linkId, userId: user.id });
    if (!link) {
      throw new NotFoundError(`Link ${input.linkId} not found for "${input.username}"`);
    }
    const now = new Date();
    if (accountLinkState(link, now) !== "active") {
      return accountLinkItem(link, now);
    }
    const revoked = await revokeAccountLinkById(dbTx, {
      linkId: link.id,
      userId: user.id,
      reason: "revoked_by_owner",
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "account_link.revoked",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        linkId: link.id,
        kind: link.kind,
        keyPrefix: link.keyPrefix,
      },
    });
    return accountLinkItem(revoked ?? link, now);
  });
}

export type InspectedAccountLink =
  | {
    state: "active";
    kind: AccountLinkKind;
    username: string;
    expiresAt: string;
    platforms: Array<"fansly" | "onlyfans">;
  }
  | { state: "used" | "expired" | "revoked" };

/** §4.1 p.11: what the /join page may learn before asking for a password. */
export async function inspectAccountLink(
  app: AppContext,
  token: string,
): Promise<InspectedAccountLink> {
  if (!(await accountLinksEnabled(app))) {
    throw new NotFoundError();
  }
  const link = await findAccountLinkByDigest(app.db, sha256Hex(token));
  if (!link) {
    throw new NotFoundError();
  }
  const now = new Date();
  const state = accountLinkState(link, now);
  if (state !== "active") {
    return { state };
  }
  const user = await findUserById(app.db, link.userId);
  if (!user || user.disabledAt) {
    // Deactivation revokes links; if a row ever survives, say no more than that.
    return { state: "revoked" };
  }
  const pages = await listEffectivePageAssignments(app, user.id);
  const platforms = [...new Set(pages.map((page) => page.platform))].sort();
  return {
    state: "active",
    kind: link.kind,
    username: user.username,
    expiresAt: link.expiresAt.toISOString(),
    platforms,
  };
}

const CONFLICT_MESSAGES: Record<Exclude<AccountLinkState, "active">, string> = {
  used: "This link has already been used",
  expired: "This link has expired; ask the owner for a new one",
  revoked: "This link is no longer valid; ask the owner for a new one",
};

/**
 * §4.1 p.3/6/9, §4.2, §4.4: set the password through a link. One-time — the
 * link is marked used in the same transaction as the password. Every check is
 * repeated under the user + link locks.
 *
 * Whether the old sign-ins survive depends on whether there WAS an account
 * behind them, not on the label of the link: a reset always terminates every
 * sign-in, and so does an invite redeemed on an account that already had a
 * password. Only a first registration — no password yet — has nothing to
 * terminate. (Review clarification to §4.1 p.4: `assertInviteAllowed` lets an
 * invite through for a user who has a password but never redeemed one, which is
 * every person onboarded before this decision shipped.)
 */
export async function redeemAccountLink(
  app: AppContext,
  input: { token: string; password: string },
) {
  if (!(await accountLinksEnabled(app))) {
    throw new NotFoundError();
  }
  const verdict = checkNewPassword(input.password);
  if (verdict !== "ok") {
    // The verdict travels as a machine `reason` beside the message. Over HTTP
    // only `common` can reach a client: the route schema's own min(12)/max(256)
    // rejects the length cases first, with a plain validation 400 that carries
    // no reason. The length verdicts stay because this function is also called
    // directly (CLI, tests) and because the rule must not live in two places.
    throw new BadRequestError(PASSWORD_POLICY_MESSAGES[verdict], { reason: verdict });
  }
  const tokenDigest = sha256Hex(input.token);
  const peek = await findAccountLinkByDigest(app.db, tokenDigest);
  if (!peek) {
    throw new NotFoundError();
  }
  // Hashing is slow; do it before taking any lock.
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  return withAuditTransaction(app, async (dbTx) => {
    // Lock order: user first, then the link (the same order every link writer
    // and every credential mutation uses).
    const user = await lockUserForDeviceTokenMutation(dbTx, peek.userId);
    const link = await findAccountLinkByDigest(dbTx, tokenDigest, { forUpdate: true });
    if (!user || !link || link.userId !== user.id) {
      throw new NotFoundError();
    }
    // Time is sampled after the lock wait: a link that expired while a reset
    // held the lock does not cross its deadline on a stale timestamp.
    const now = new Date();
    const state = accountLinkState(link, now);
    if (state !== "active") {
      throw new ConflictError(CONFLICT_MESSAGES[state], { reason: state });
    }
    if (user.disabledAt || !roleCanUseSession(user.role)) {
      throw new ConflictError(CONFLICT_MESSAGES.revoked, { reason: "revoked" });
    }

    await updateUserPasswordHash(dbTx, user.id, passwordHash);
    // A password the person chose themselves satisfies the frozen flag.
    await updateUserMustChangePassword(dbTx, user.id, false);
    await markAccountLinkUsed(dbTx, link.id, now);
    const otherLinks = await revokeActiveAccountLinks(dbTx, user.id, "password_set");
    // `user` is the row as it stands under the lock, read BEFORE the update
    // above, so this is the pre-redemption password.
    const hadPassword = user.passwordHash !== null;
    const terminated = link.kind === "password_reset" || hadPassword
      ? await terminateAccessTx(
        dbTx,
        user,
        link.kind === "password_reset" ? "password_reset" : "password_set",
      )
      : null;

    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      targetUserId: user.id,
      eventType: "user.password_set_via_link",
      metadata: {
        username: user.username,
        linkId: link.id,
        kind: link.kind,
        keyPrefix: link.keyPrefix,
        revokedAccountLinks: otherLinks.length,
        // False only for a first registration; a re-set of an existing
        // password always terminates the old sign-ins.
        terminatedExistingAccess: terminated !== null,
        revokedDeviceTokens: terminated?.deviceTokens ?? 0,
        deletedPendingDeviceTokens: terminated?.pendingDeviceTokens ?? 0,
        revokedSessions: terminated?.sessions ?? 0,
        revokedApiKeys: terminated?.apiKeys ?? 0,
      },
    });
    return { username: user.username };
  });
}
