import type { AuthSsoSignedInResponse, SigninRefusal } from "@agency_hub_core/contracts";
import { findUserByUsername } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { redeemAccountLink } from "./account-links.ts";
import {
  type AuditContext, changeOwnPassword, createWebSessionTx, normalizeUsername, recordAudit, verifyPasswordAndLockUser,
} from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "./errors.ts";
import { userIsTest } from "./sandbox/realm.ts";
import { PERSON_CLIENT, personForContentops } from "./signin-person.ts";
import { mintServerCode, redeemServerCode, revokeOpenedSession } from "./signin-handoff.ts";

/**
 * ContentOps' own entrance (products plan, package C4; the owner, 2026-11-15: «отдельный от хаб вход выглядит
 * логичнее»): a content manager types her login and password on ContentOps' page, ContentOps' server asks Hub here.
 * The account stays one — Hub's registry, Hub's password, Hub's sign-in service with its lockout and journal — and the
 * answer is what `sso/redeem` gives (the person and a grant over a Hub session that lives on no cookie of Hub's,
 * marked `opened_by = contentops`). The owner's password never passes through another service: the owner role is
 * refused before any check (`owner`), the owner enters ContentOps through Hub in one step as before.
 */

export interface ClientOrigin {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const refused = (reason: SigninRefusal, message?: string): AuthSsoSignedInResponse =>
  ({ result: "refused", reason, ...(message ? { message } : {}) });

/** The grant over a session just opened for ContentOps: minted and spent at once, the same rows `sso/redeem` writes. */
async function grantFor(app: AppContext, session: { sessionId: number; userId: number }, audit: AuditContext): Promise<AuthSsoSignedInResponse> {
  const code = await mintServerCode(app, { sessionId: session.sessionId, userId: session.userId, client: PERSON_CLIENT, next: "/" });
  const redeemed = await redeemServerCode(app, { client: PERSON_CLIENT, code }, audit);
  const person = await personForContentops(app, redeemed.user, await userIsTest(app, redeemed.user.id));
  return { result: "signed_in", ...redeemed, person };
}

/** Whether ContentOps is the person's: the products Hub gives them (`auth/me`) carry it. */
async function opensContentops(app: AppContext, user: { id: number; role: string }): Promise<boolean> {
  const person = await personForContentops(app, user, await userIsTest(app, user.id));
  return person !== null && person.products.includes("contentops");
}

/** The login and the password typed on ContentOps' page. */
export async function contentopsPasswordSignin(
  app: AppContext,
  input: { username: string; password: string } & ClientOrigin,
  audit: AuditContext,
): Promise<AuthSsoSignedInResponse> {
  // The owner role (the agency's owner and the test team's) is refused before its password is looked at.
  const known = await findUserByUsername(app.db, normalizeUsername(input.username));
  if (known?.role === "owner") return refused("owner");
  let session: { sessionId: number; userId: number };
  try {
    session = await verifyPasswordAndLockUser(app, input, async (dbTx, locked) => {
      // After the password: «no ContentOps» tells nothing to someone who does not know it.
      if (!(await opensContentops(app, locked))) throw new NoContentops();
      const opened = await createWebSessionTx(app, dbTx, { userId: locked.id, openedBy: "contentops" });
      await recordAudit({ db: dbTx }, {
        source: "api",
        actorUserId: locked.id,
        targetUserId: locked.id,
        eventType: "auth.login",
        metadata: {
          username: locked.username,
          via: "contentops",
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        },
      });
      return { sessionId: opened.sessionId, userId: locked.id };
    });
  } catch (error) {
    if (error instanceof NoContentops) return refused("no_access");
    if (error instanceof TooManyRequestsError) return refused("locked");
    if (error instanceof UnauthorizedError) return refused("wrong");
    throw error;
  }
  return grantFor(app, session, audit);
}

class NoContentops extends Error {}

/** An invitation's or a new password's link opened on ContentOps' page: the password is set in the registry here. */
export async function contentopsLinkSignin(
  app: AppContext,
  input: { token: string; password: string } & ClientOrigin,
  audit: AuditContext,
): Promise<AuthSsoSignedInResponse> {
  let redeemed: Awaited<ReturnType<typeof redeemAccountLink>>;
  try {
    redeemed = await redeemAccountLink(app, { token: input.token, password: input.password }, {
      openedBy: "contentops", ip: input.ip, userAgent: input.userAgent, onlyRoles: ["content_manager"],
    });
  } catch (error) {
    if (error instanceof NotFoundError) return refused("link_unknown");
    if (error instanceof ConflictError) {
      const reason = error.reason === "used" ? "link_used" : error.reason === "expired" ? "link_expired"
        : error.reason === "not_here" ? "not_here" : "link_revoked";
      return refused(reason);
    }
    if (error instanceof BadRequestError) return refused("weak", error.message);
    throw error;
  }
  return grantFor(app, { sessionId: redeemed.sessionId, userId: redeemed.userId }, audit);
}

/**
 * «Сменить пароль» in ContentOps' profile: the same change as Hub's own (every sign-in of the person ends), then the
 * person is signed in again by the new password and a new grant comes back.
 */
export async function contentopsPasswordChange(
  app: AppContext,
  input: { userId: number; username: string; currentPassword: string; newPassword: string } & ClientOrigin,
  audit: AuditContext,
): Promise<AuthSsoSignedInResponse> {
  try {
    await changeOwnPassword(app, { userId: input.userId, currentPassword: input.currentPassword, newPassword: input.newPassword });
  } catch (error) {
    if (error instanceof UnauthorizedError) return refused("wrong");
    if (error instanceof BadRequestError) return refused("weak", error.message);
    throw error;
  }
  return contentopsPasswordSignin(app, { username: input.username, password: input.newPassword, ip: input.ip, userAgent: input.userAgent }, audit);
}

/** ContentOps' «Выйти»: the Hub session its page opened ends; a session the person opened in Hub stays. */
export async function contentopsLogout(app: AppContext, input: { grant: string }, audit: AuditContext): Promise<{ ended: boolean }> {
  const ended = await revokeOpenedSession(app, { client: PERSON_CLIENT, grant: input.grant, openedBy: "contentops" });
  if (ended !== null) {
    await recordAudit(app, { ...audit, eventType: "auth.logout", targetUserId: ended.userId, metadata: { via: "contentops" } });
  }
  return { ended: ended !== null };
}
