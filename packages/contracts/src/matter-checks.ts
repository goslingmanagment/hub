/**
 * Проверки (ecosystem plan §6, package K): the checks Hub's server keeps as
 * matters besides the mirrors of package D — people and access, and the
 * ledger's own checks. Each kind has one writer, the server: an agent key
 * opens or closes none of them. Each closes itself when its cause goes away;
 * a source that does not answer leaves its kind «не проверено».
 */

/** The kinds of package K, each with how often its source is asked. */
export const MATTER_CHECK_KIND_PERIODS = {
  /** A person who left, with a living login, a device token or an agent key. */
  "people.left_with_access": 10,
  /** A living login no person holds (service and test logins are people of kind `service`). */
  "people.login_unlinked": 10,
  /** A working chatter or team lead with no pay terms in force (never the terms themselves). */
  "people.no_pay_terms": 10,
  /** A working chatter or team lead with no working page. */
  "people.no_working_page": 10,
  /** A person works a page none of their living logins may open. */
  "people.page_without_access": 10,
  /** Access to pages a person neither works nor touched for 30 days: information, one line, read once a week. */
  "people.access_idle": 7 * 24 * 60,
  /** An agent key that expires within 7 days (or expired and nobody revoked it). */
  "people.agent_key_expiring": 10,
  /** A check of the ledger red longer than its threshold (one per check key), in the ledger's own sentence. */
  "ledger.check": 15,
  /** The payout tabs someone works with no column for tomorrow: one matter listing them (the ledger's notice). */
  "ledger.sheet_column": 15,
  /** An off-platform sale («мимо площадки») still not in a report N days after it was said. */
  "ledger.off_platform": 15,
} as const;

export type MatterCheckKind = keyof typeof MATTER_CHECK_KIND_PERIODS;
export const MATTER_CHECK_KINDS = Object.keys(MATTER_CHECK_KIND_PERIODS) as MatterCheckKind[];

const CHECK_KIND_SET: ReadonlySet<string> = new Set(MATTER_CHECK_KINDS);
export function isMatterCheckKind(kind: string): kind is MatterCheckKind {
  return CHECK_KIND_SET.has(kind);
}

/** The people checks: a person or a login, read from the people registry and the logins. */
export const PEOPLE_CHECK_KINDS = MATTER_CHECK_KINDS.filter((kind) => kind.startsWith("people."));
/** The ledger's: its checks, its notice about the payout tabs, its off-platform sales. */
export const LEDGER_CHECK_KINDS = ["ledger.check", "ledger.sheet_column", "ledger.off_platform"] as const satisfies readonly MatterCheckKind[];

/**
 * Kinds that only inform: they wait for nobody, are not counted in «Ждут вас»
 * or on the extension's icon, and the list shows them apart («Для сведения»).
 */
export const MATTER_INFO_KINDS: readonly string[] = ["people.access_idle"];
const INFO_KIND_SET: ReadonlySet<string> = new Set(MATTER_INFO_KINDS);
export function isMatterInfoKind(kind: string): boolean {
  return INFO_KIND_SET.has(kind);
}

/** How long a ledger check stays red (its `failingSince`) before it becomes a matter: an urgent one two of its hourly runs, any other a day. */
export const LEDGER_CHECK_RED_HOURS = { urgent: 2, other: 24 } as const;
/** How many days an off-platform sale may wait for its report before it is the owner's matter. */
export const LEDGER_OFF_PLATFORM_DAYS = 7;
/** How many days without a touch make access to a page that is not worked idle. */
export const PEOPLE_ACCESS_IDLE_DAYS = 30;
/** How many days before its end an agent key is said to expire. */
export const AGENT_KEY_EXPIRING_DAYS = 7;
