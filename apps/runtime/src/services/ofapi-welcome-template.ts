import { readOfapiStoredSnapshots, type Database } from "@agency_hub_core/db";
import { millsFromDollars, normalizeDmMessageText } from "@agency_hub_core/shared";

/**
 * The page's automatic welcome template, as the `account_settings` collection
 * category snapshots it (catalog read `welcome_message`, off until the owner
 * applies a policy). The chat extension's "New" panel shows the newest one.
 */
export const OFAPI_WELCOME_TEMPLATE_OPERATION = "ofapi_read_welcome_message";

/** Facts of one template, fixed when its captured response is canonicalized. */
export interface OfapiWelcomeTemplateFacts {
  /** `isActive`: whether OnlyFans sends the template; null when absent. */
  enabled: boolean | null;
  hasText: boolean;
  hasMedia: boolean;
  /** Platform money in mills; null when the provider price is absent or invalid. */
  priceMills: number | null;
}

export interface OfapiWelcomeTemplateSnapshot extends OfapiWelcomeTemplateFacts {
  /** The provider's template id: changes when the owner saves a new template. */
  ref: string;
  observedAt: string;
}

const MAX_TEMPLATE_PRICE_DOLLARS = 1_000_000;

/**
 * OnlyFans prices the template in US DOLLARS (`price: 0`, or 3–200 on write —
 * the same unit `welcome_message_update` sends), never cents or mills. The
 * conversion to mills is explicit here so no reader handles a dollar number.
 */
export function ofapiWelcomeTemplatePriceMills(value: unknown): number | null {
  const dollars = typeof value === "number"
    ? Number.isFinite(value) && value >= 0 && value <= MAX_TEMPLATE_PRICE_DOLLARS ? value : null
    : typeof value === "string" && /^(0|[1-9]\d{0,6})(\.\d{1,3})?$/.test(value) ? value : null;
  if (dollars === null) return null;
  return Number(millsFromDollars(dollars));
}

export function ofapiWelcomeTemplateFacts(row: Record<string, unknown>): OfapiWelcomeTemplateFacts {
  const mediaCount = row.mediaCount;
  return {
    enabled: typeof row.isActive === "boolean" ? row.isActive : null,
    // Template text is OnlyFans HTML: an empty `<p></p>` is no text.
    hasText: typeof row.text === "string" && normalizeDmMessageText(row.text).length > 0,
    hasMedia: (Array.isArray(row.media) && row.media.length > 0)
      || (typeof mediaCount === "number" && Number.isFinite(mediaCount) && mediaCount > 0),
    priceMills: ofapiWelcomeTemplatePriceMills(row.price),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Reads one stored snapshot back; null unless it carries the canonical facts. */
export function ofapiWelcomeTemplateFromSnapshot(
  snapshot: { observedAt: string; items: readonly unknown[] },
): OfapiWelcomeTemplateSnapshot | null {
  const item = record(snapshot.items[0]);
  const facts = record(item?.welcomeTemplate);
  const ref = item?.nativeId;
  if (!facts || typeof ref !== "string" || ref.length === 0) return null;
  const { enabled, hasText, hasMedia, priceMills } = facts;
  if (
    (enabled !== null && typeof enabled !== "boolean")
    || typeof hasText !== "boolean"
    || typeof hasMedia !== "boolean"
    || (priceMills !== null && !Number.isSafeInteger(priceMills))
  ) return null;
  return {
    ref,
    observedAt: snapshot.observedAt,
    enabled: enabled as boolean | null,
    hasText,
    hasMedia,
    priceMills: priceMills as number | null,
  };
}

/** The newest collected template of one page, or null. Local rows only, no vendor call. */
export async function readLatestOfapiWelcomeTemplate(
  db: Database,
  pageId: number,
): Promise<OfapiWelcomeTemplateSnapshot | null> {
  const [latest] = await readOfapiStoredSnapshots(db, {
    pageId,
    operation: OFAPI_WELCOME_TEMPLATE_OPERATION,
    limit: 1,
  });
  return latest ? ofapiWelcomeTemplateFromSnapshot(latest) : null;
}
