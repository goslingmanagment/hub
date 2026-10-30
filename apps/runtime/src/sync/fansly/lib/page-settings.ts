import { createHash } from "node:crypto";

import type { FanslyWireId } from "@agency_hub_core/fansly";
import { formatUsdFromMills, millsFromInteger, sanitizePostgresTextDeep } from "@agency_hub_core/shared";

// The page's settings and standing on Fansly (0338), read once a day by
// `page-settings.daily`: what the creator's settings screens show and Hub
// read nowhere before — the account switches (hidden from search, age, muted
// notifications), the geo-blocks, who sees the timeline, who may write in DMs,
// the watermark, the e-mail and push alerts, the referral codes, the pending
// balance, the account's tip goals, and the labels and tags discovery (For
// You) keeps for the page and its content.
//
// Each answer is journaled first; this module keeps what goes into the typed
// copy: the body without what is the account's secret (its e-mail), its
// sha256 (the version's identity, as the profile's: the same body seen again
// only widens first/last seen), and one line in Russian for the owner's
// screen and the agents.

/** The reads of one sweep, in the order they are made. */
export const PAGE_SETTINGS_STEPS: readonly FanslyWireId[] = [
  "settings.account",
  "settings.geo_blocks",
  "settings.timeline_permissions",
  "settings.dm_permissions",
  "settings.watermark",
  "settings.alerts",
  "referrals.stats",
  "earnings.overview",
  "tipgoals.account",
  "discovery.content",
  "discovery.tags",
];

export interface PageSettingsAnswer {
  /** The served answer without the account's secrets. */
  body: unknown;
  bodySha256: string;
  summary: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return recordOf(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Account settings without the e-mail (the `account` category's `email`). */
function withoutSecrets(spec: FanslyWireId, response: unknown): unknown {
  if (spec !== "settings.account") return response;
  const record = recordOf(response);
  if (record === null) return response;
  return {
    ...record,
    categories: list(record.categories).map((category) => ({
      ...category,
      inputs: list(category.inputs).filter((input) => input.name !== "email"),
    })),
  };
}

/** Stable JSON: keys sorted, so the same answer always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = recordOf(value);
  if (record !== null) {
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The profile switches: [the words when on, when off]. */
const PROFILE_SWITCHES: Record<string, [string, string]> = {
  hideFromSearch: ["скрыта из поиска", "видна в поиске"],
  hideAge: ["возраст скрыт", "возраст виден"],
};

function accountSummary(response: unknown): string {
  const categories = list(recordOf(response)?.categories);
  const switches: string[] = [];
  const muted: string[] = [];
  for (const category of categories) {
    for (const input of list(category.inputs)) {
      const data = parseJson(input.data);
      const name = typeof input.name === "string" ? input.name : "";
      const words = PROFILE_SWITCHES[name];
      if (words !== undefined) switches.push(data?.value === true ? words[0] : words[1]);
      if (name.startsWith("mute") && data?.value === true) muted.push(typeof input.label === "string" ? input.label : name);
    }
  }
  return [...switches, muted.length > 0 ? `заглушено: ${muted.join("; ")}` : "уведомления не заглушены"].join(" · ");
}

function geoSummary(response: unknown): string {
  const places = list(response).map((row) => {
    const data = recordOf(row.locationData) ?? {};
    const country = typeof data.countryCode === "string" && data.countryCode.length > 0 ? data.countryCode : typeof data.country === "string" ? data.country : "?";
    const state = typeof data.stateCode === "string" && data.stateCode.length > 0 ? data.stateCode : typeof data.state === "string" && data.state.length > 0 ? data.state : null;
    const city = typeof data.city === "string" && data.city.length > 0 ? data.city : null;
    return [country, state, city].filter((part): part is string => part !== null).join(" / ");
  });
  return places.length === 0 ? "гео-блока нет" : `гео-блок: ${places.join(", ")}`;
}

/** Permission flags as the site's permission editor writes them. */
const PERMISSION_FLAGS: ReadonlyArray<[number, string]> = [[1, "покупка"], [2, "фолловеры"], [4, "подписчики"], [8, "типы"]];

function flagsText(flags: unknown): string {
  if (typeof flags !== "number" || !Number.isSafeInteger(flags)) return "?";
  if (flags === 0) return "без условий";
  const named = PERMISSION_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, label]) => label);
  const rest = flags & ~PERMISSION_FLAGS.reduce((sum, [bit]) => sum | bit, 0);
  return [...named, ...(rest !== 0 ? [`флаги ${rest}`] : [])].join(" или ");
}

function permissionsSummary(response: unknown, what: string, none: string): string {
  const rows = list(response);
  if (rows.length === 0) return none;
  return `${what}: ${rows.map((row) => flagsText(row.flags)).join("; ")}`;
}

function watermarkSummary(response: unknown): string {
  const record = recordOf(response);
  if (record === null) return "вотермарка выключена";
  const text = [record.text, record.content, record.label].find((value): value is string => typeof value === "string" && value.length > 0);
  return text === undefined ? "вотермарка включена" : `вотермарка: «${text}»`;
}

function alertsSummary(response: unknown): string {
  const rows = list(response);
  if (rows.length === 0) return "алертов нет";
  return `каналов алертов: ${rows.length} (${rows.map((row) => `тип ${String(row.type ?? "?")}${typeof row.metadata === "string" && row.metadata.length > 0 ? ", свои настройки" : ", по умолчанию"}`).join("; ")})`;
}

function referralsSummary(response: unknown): string {
  const codes = list(recordOf(response)?.codes);
  return codes.length === 0 ? "реферальных кодов нет" : `реферальных кодов: ${codes.length}`;
}

function pendingSummary(response: unknown): string {
  const pending = recordOf(response)?.pendingBalance;
  return typeof pending === "number" && Number.isSafeInteger(pending)
    ? `в холде ${formatUsdFromMills(millsFromInteger(pending))}`
    : "баланс в холде не прислан";
}

function tipGoalsSummary(response: unknown): string {
  const goals = list(response);
  return goals.length === 0 ? "целей типов нет" : `целей типов: ${goals.length}`;
}

function discoveryContentSummary(response: unknown): string {
  const rows = list(response);
  return rows.length === 0 ? "меток For You нет" : `меток For You: ${rows.length}`;
}

function discoveryTagsSummary(response: unknown): string {
  const tags = [...new Set(list(response).map((row) => row.tag).filter((tag): tag is string => typeof tag === "string" && tag.length > 0))];
  if (tags.length === 0) return "тегов нет";
  const shown = tags.slice(0, 30);
  return `тегов: ${tags.length} — ${shown.join(", ")}${tags.length > shown.length ? "…" : ""}`;
}

function summaryOf(spec: FanslyWireId, response: unknown): string {
  switch (spec) {
    case "settings.account":
      return accountSummary(response);
    case "settings.geo_blocks":
      return geoSummary(response);
    case "settings.timeline_permissions":
      return permissionsSummary(response, "ленту видят", "лента без ограничений");
    case "settings.dm_permissions":
      return permissionsSummary(response, "в ЛС пишут", "ЛС без ограничений");
    case "settings.watermark":
      return watermarkSummary(response);
    case "settings.alerts":
      return alertsSummary(response);
    case "referrals.stats":
      return referralsSummary(response);
    case "earnings.overview":
      return pendingSummary(response);
    case "tipgoals.account":
      return tipGoalsSummary(response);
    case "discovery.content":
      return discoveryContentSummary(response);
    case "discovery.tags":
      return discoveryTagsSummary(response);
    default:
      return "";
  }
}

/** The typed copy of one answer of the sweep. */
export function parsePageSettingsAnswer(spec: FanslyWireId, response: unknown): PageSettingsAnswer {
  const body = sanitizePostgresTextDeep(withoutSecrets(spec, response) ?? null);
  return {
    body,
    bodySha256: createHash("sha256").update(stable(body)).digest("hex"),
    summary: summaryOf(spec, body),
  };
}
