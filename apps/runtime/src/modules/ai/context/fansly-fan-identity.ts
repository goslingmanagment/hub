import { sql } from "drizzle-orm";

import type { AppContext } from "../../../bootstrap.ts";
import type { OperationFeature } from "../prompts/index.ts";

// chat-extension R20 HF-7б: who the fan is, in a Fansly generation whose
// context the hub loads itself (no `clientContext`).
//
// The released Fansly extension (fansly-chat 2.10.1) asks Fansly for the fan's
// account at every generation and sends what it read in `clientContext`. Its
// successor sends no context, and the hub forms the same values from its own
// stores, by the released client's rules:
//
//  - the name: the username, else the display name, else "fan"
//    (`kernelFanDisplayName`). Hi turns the pair round, display name first,
//    and names the username beside it in a field of its own;
//  - the saved name: the page's own name for the fan, Fansly's "Custom
//    Username" note. The hub keeps the current one in `page_fans.page_alias`
//    (packages/db fan-page-identity.ts) and reads it with the page's inbox.
//    One difference from the released client: of several such notes on one
//    fan the hub keeps the newest, the client reads the first Fansly serves,
//    which is the oldest;
//  - the bio: the fan's profile text, which the account lookup stores in
//    `fans.metadata.about` (sync/fansly/lib/fan-hydration.ts), for the
//    features whose policy includes it;
//  - the avatar is not the hub's: the client takes it from the page.
//
// OnlyFans keeps its own loaders (context/index.ts), and a request with
// `clientContext` keeps the client's values: neither comes here.

/** The released client's name for a fan whose account gives none. */
export const FANSLY_FAN_NAME_FALLBACK = "fan";

/** The contract's bounds on the same values in `clientContext`
 * (`fanDisplayName`, `fanUsername`, `fanCustomName`; `fanBio`): the prompt
 * holds no more of a value than the released client could send. */
export const FANSLY_FAN_NAME_MAX_CHARS = 200;
export const FANSLY_FAN_BIO_MAX_CHARS = 5_000;

/** What the hub holds about a Fansly fan for one page. */
export interface FanslyFanRecord {
  username: string | null;
  displayName: string | null;
  /** The page's saved name for the fan (`page_fans.page_alias`). */
  savedName: string | null;
  /** The fan's profile text (`fans.metadata.about`). */
  about: string | null;
}

/** Which of the account's names the prompt's name is. */
export type FanslyFanNameSource = "username" | "display_name" | "fallback";

/** The prompt's values, as the released client sends them in `clientContext`. */
export interface FanslyFanIdentity {
  fanDisplayName: string;
  nameSource: FanslyFanNameSource;
  /** Hi only. */
  fanUsername: string | undefined;
  fanCustomName: string | undefined;
  fanBio: string | undefined;
}

/** What a generation's record keeps about the identity it read: where the
 * name came from and how old the hub's copies are. Never the values. */
export interface FanslyFanIdentityManifest {
  /** The hub holds an account for the fan the request names. */
  known: boolean;
  name: FanslyFanNameSource;
  savedName: boolean;
  bio: boolean;
  /** When the page's notes on the fan were last read; null when Fansly never
   * served a note of the page on this fan. */
  savedNameReadAt: string | null;
  /** When the fan's account was last looked up through the page: the read
   * that brings the bio. */
  accountReadAt: string | null;
}

/** Cut at the bound in UTF-16 units, the unit the contract counts in, without
 * leaving half of a surrogate pair at the cut. */
function capped(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A value the released client would send: trimmed, bounded, absent when empty. */
function present(value: string | null | undefined, max: number): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? capped(trimmed, max) : undefined;
}

/**
 * The released client's rules, over the hub's record of the fan. Pure.
 * `record` is null when the hub holds no account for the fan: the name is the
 * fallback and nothing else is known, as when the client's own account read
 * failed.
 */
export function fanslyFanIdentity(input: {
  feature: OperationFeature;
  includesFanBio: boolean;
  record: FanslyFanRecord | null;
}): FanslyFanIdentity {
  const username = present(input.record?.username, FANSLY_FAN_NAME_MAX_CHARS);
  const displayName = present(input.record?.displayName, FANSLY_FAN_NAME_MAX_CHARS);
  const greeting = input.feature === "hi-greeting";
  const names: Array<[FanslyFanNameSource, string | undefined]> = greeting
    ? [["display_name", displayName], ["username", username]]
    : [["username", username], ["display_name", displayName]];
  const [nameSource, name] = names.find(([, value]) => value !== undefined) ?? ["fallback", undefined];
  return {
    fanDisplayName: name ?? FANSLY_FAN_NAME_FALLBACK,
    nameSource,
    fanUsername: greeting ? username : undefined,
    fanCustomName: present(input.record?.savedName, FANSLY_FAN_NAME_MAX_CHARS),
    fanBio: input.includesFanBio ? present(input.record?.about, FANSLY_FAN_BIO_MAX_CHARS) : undefined,
  };
}

/**
 * The fan's identity for one Fansly generation, and what its record keeps
 * about it. One indexed read: the fan by `(platform, platform_user_id)`, and
 * the page's own link to them. The saved name is the page's: another page's
 * name for the same fan is never read.
 */
export async function loadFanslyFanIdentity(
  app: Pick<AppContext, "db">,
  input: { pageId: number; fanRef: string; feature: OperationFeature; includesFanBio: boolean },
): Promise<{ identity: FanslyFanIdentity; manifest: FanslyFanIdentityManifest }> {
  const result = await app.db.execute<{
    username: string | null;
    display_name: string | null;
    page_alias: string | null;
    about: string | null;
    page_alias_synced_at: Date | null;
    account_lookup_at: Date | null;
  }>(sql`
    select f.username, f.display_name, pf.page_alias,
           case when jsonb_typeof(f.metadata -> 'about') = 'string' then f.metadata ->> 'about' end as about,
           pf.page_alias_synced_at, pf.account_lookup_at
    from fans f
    left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
    where f.platform = 'fansly' and f.platform_user_id = ${input.fanRef}
    limit 1
  `);
  const row = result.rows[0];
  const record: FanslyFanRecord | null = row
    ? { username: row.username, displayName: row.display_name, savedName: row.page_alias, about: row.about }
    : null;
  const identity = fanslyFanIdentity({ feature: input.feature, includesFanBio: input.includesFanBio, record });
  const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
  return {
    identity,
    manifest: {
      known: record !== null,
      name: identity.nameSource,
      savedName: identity.fanCustomName !== undefined,
      bio: identity.fanBio !== undefined,
      savedNameReadAt: iso(row?.page_alias_synced_at),
      accountReadAt: iso(row?.account_lookup_at),
    },
  };
}
