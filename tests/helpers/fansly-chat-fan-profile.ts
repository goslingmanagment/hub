// What the released Fansly extension (fansly-chat 2.10.1, commit ff30d00)
// sends about a fan in `clientContext`, restated from its source for the
// hub's reference tests (chat-extension R20 HF-7б). The extension reads the
// fan's account from Fansly (`GET /account?ids=`) at every generation and
// derives these values; the hub, asked without `clientContext`, must form the
// same ones from its own stores.
//
// Sources, by file of fansly-chat at ff30d00:
//  - src/shared/fansly-custom-name.ts: `customNameFromAccount`,
//    `kernelFanCustomName`;
//  - src/background/operations.ts: `kernelFanDisplayName` (:406-410), the
//    account read of a generation (:2530-2562), the `clientContext` it builds
//    (:2943-2957);
//  - src/shared/greeting-context.ts: `greetingProfileFields`, its bounds;
//  - src/shared/features.ts: `includesFanBio` of each feature.

/** A Fansly account as `/account?ids=` serves it (the fields the client reads). */
export interface ReleasedFanslyAccount {
  id: string;
  username?: string | null;
  displayName?: string | null;
  about?: string | null;
  notes?: Array<{ contentType?: number; note?: string | null }>;
}

/** The fan fields of the released client's `clientContext`. */
export interface ReleasedFanContext {
  fanDisplayName: string;
  fanUsername?: string;
  fanCustomName?: string;
  fanBio?: string;
}

/** Fansly's "Custom Username" note: the page's own name for a fan. */
const CUSTOM_NAME_NOTE_TYPE = 12002;
const NAME_MAX_CHARS = 200;
const BIO_MAX_CHARS = 5000;

/** The features whose request carries the fan's bio (src/shared/features.ts). */
const FEATURES_WITH_BIO = new Set(["help-me", "ping", "hi-greeting", "coach-chat", "fan-notes-fill"]);

/** `customNameFromAccount`: the text of the first custom-name note, or null. */
export function releasedCustomName(account: ReleasedFanslyAccount): string | null {
  if (!Array.isArray(account.notes)) return null;
  const note = account.notes.find((entry) => entry?.contentType === CUSTOM_NAME_NOTE_TYPE);
  const text = note?.note?.trim();
  return text ? text : null;
}

/** `kernelFanCustomName`: the saved name, at most 200 code points. */
function kernelFanCustomName(account: ReleasedFanslyAccount | undefined): string | undefined {
  const name = account ? releasedCustomName(account) : null;
  if (!name) return undefined;
  const points = Array.from(name);
  return points.length > NAME_MAX_CHARS ? points.slice(0, NAME_MAX_CHARS).join("") : name;
}

/** `cap` of greeting-context.ts: UTF-16 units, never half a surrogate pair. */
function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The fan fields the released client puts in `clientContext` for one feature.
 * `account` is undefined when its account read failed: the neutral name alone.
 */
export function releasedFanContext(feature: string, account: ReleasedFanslyAccount | undefined): ReleasedFanContext {
  const fanBio = FEATURES_WITH_BIO.has(feature) && account?.about?.trim() ? account.about.trim() : undefined;
  if (feature === "hi-greeting" && account) {
    // The chat Hi button: display name first, the username beside it.
    const profile = {
      displayName: account.displayName?.trim() || account.username?.trim() || "fan",
      username: account.username?.trim() || null,
      customName: releasedCustomName(account),
      bio: fanBio ?? null,
    };
    return {
      fanDisplayName: cap(profile.displayName, NAME_MAX_CHARS),
      ...(typeof profile.username === "string" ? { fanUsername: cap(profile.username, NAME_MAX_CHARS) } : {}),
      ...(typeof profile.customName === "string" ? { fanCustomName: cap(profile.customName, NAME_MAX_CHARS) } : {}),
      ...(typeof profile.bio === "string" ? { fanBio: cap(profile.bio, BIO_MAX_CHARS) } : {}),
    };
  }
  const fanCustomName = kernelFanCustomName(account);
  return {
    // `kernelFanDisplayName`: the username, else the display name, else "fan".
    fanDisplayName: account?.username?.trim() || account?.displayName?.trim() || "fan",
    ...(fanBio !== undefined ? { fanBio } : {}),
    ...(fanCustomName !== undefined ? { fanCustomName } : {}),
  };
}
