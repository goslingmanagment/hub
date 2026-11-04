/**
 * «Публикации»: wall posts Hub drafts, approves and puts on the pages. The
 * feature went live ten days before the request, so the list runs from ten
 * days back to twelve days ahead: published history, one «Исход неизвестен»
 * waiting for a person, three drafts waiting for approval, the rest of the
 * week in the platforms' schedules and approved posts after it — modest, as on
 * production. OnlyFans pages publish nothing new since the vendor was switched
 * off; nova-1 is stopped by Hub (Fansly signed its browser out).
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { hashString, iso, pick, rng, intBetween, mills } from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_PAGES, type DemoPage } from "../world.ts";
import { DAY_MS, HOUR_MS, demoDigits, demoSha, mskAt, mskDayKey, ofStop } from "./publish-of-common.ts";

type Publication = KernelOperationResponse<"adminPublicationList">["publications"][number];
type Detail = KernelOperationResponse<"adminPublicationGet">;
type Event = Detail["events"][number];
type Finding = Publication["findings"][number];
type Status = Publication["status"];
type Kind = Publication["kind"];
type Settings = KernelOperationResponse<"adminPublicationSettingsList">["pages"][number];
type Queue = KernelOperationResponse<"adminPublicationQueueList">["pages"][number];

const FIRST_DAY = -10;
const LAST_DAY = 12;

/** The agent key that drafts most posts (ContentOps, key 9 in system.ts). */
const CONTENT_AGENT_KEY_ID = 9;
const OWNER_ID = 1;
const LEAD_ID = 2;

/** Moscow hours each page posts at; ivy-1 has publishing off. */
const SLOTS: Readonly<Record<string, readonly number[]>> = {
  "mia-1": [13, 21],
  "mia-2": [12, 20.5],
  "mia-3": [22],
  "nova-1": [11, 17, 22.5],
  "ivy-2": [18],
  "mia-of": [14, 21],
  "mia-vip-of": [19],
};

const CAPTIONS = [
  "Sunday mood: coffee, sheets and absolutely no plans 🤍",
  "Caught the golden hour just right… tell me which one is your favourite",
  "New set from the beach trip is finally here 🌊",
  "I think this lace was a good decision. Thoughts?",
  "Behind the scenes from yesterday's shoot — the outtakes are my favourite part",
  "Gym day done ✔️ now I deserve a long bath",
  "Rainy day, cozy socks and a little surprise for you in the DMs",
  "Who's up late with me tonight? 🌙",
  "Red or black? I couldn't decide so you get both",
  "Mirror selfie because the light in this hotel is unreal",
  "Throwback to that weekend in the mountains ❄️",
  "Trying something a bit different today… be honest",
  "Morning stretch routine (uncut version below 👇)",
  "Just me, a glass of wine and a new playlist",
  "Little teaser of what's coming this weekend 😇",
  "Pool day! Sunscreen applied very carefully",
  "My favourite hoodie and nothing else, that's the post",
  "Thank you for 1k likes on the last one — here's a bonus",
  "Fresh nails, fresh set 💅",
  "Breakfast in bed kind of morning",
  "Do you like me better with glasses or without?",
  "Golden hour on the balcony, part two",
  "Long day, longer bath 🛁",
  "Packing for a trip… guess where?",
] as const;

const ALBUM_TITLES = ["October beach set", "Hotel mirror series", "Cozy weekend", "Red lingerie set", "Mountain cabin"] as const;
const FILE_NAMES = ["beach_03.jpg", "mirror_set_12.jpg", "bts_clip_02.mp4", "lace_07.jpg", "cabin_04.jpg", "pool_day_09.mp4", "hoodie_01.jpg", "teaser_weekend.mp4"] as const;

/**
 * Fansly walls and tiers of a page: the same numbers as the page's profile and
 * promo (page-insights.ts `ref`), so the panel finds their names.
 */
function insightsRef(page: DemoPage, kind: string, index: number): string {
  return `${7 + (hashString(`${kind}:${page.label}`) % 2)}${String(hashString(`${kind}:${page.label}:${index}`)).padStart(10, "3")}${String(index).padStart(6, "0")}`;
}
function wallRef(page: DemoPage, index = 1): string {
  return insightsRef(page, "wall", index);
}
function tierRef(page: DemoPage, index: number): string {
  return insightsRef(page, "tier", index);
}

/** The three drafts that wait for approval, each a different case. */
const DRAFT_KEYS: ReadonlySet<string> = new Set(["mia-1:2:1", "nova-1:4:1", "mia-2:5:0"]);
/** A scheduled post whose withdrawal Fansly refused. */
const WITHDRAW_REFUSED_KEY = "mia-1:1:0";
/** A published post whose deletion did not leave in time. */
const DELETE_STUCK_KEY = "mia-2:-1:0";
/** A paid post with a second attachment for subscribers. */
const EXTRA_ATTACHMENT_KEY = "nova-1:2:1";

interface Built {
  publication: Publication;
  events: Event[];
  revision: Detail["revision"];
}

function kindFor(page: DemoPage, random: () => number, dayIndex: number, slot: number): Kind {
  if (page.platform === "onlyfans") return random() < 0.8 ? "subscriber_post" : "story";
  if (page.label === "mia-1" && slot === 1 && dayIndex % 3 === 0) return "story";
  if (page.label === "mia-2" && slot === 0 && dayIndex % 5 === 2) return "vault_album";
  const roll = random();
  if (roll < 0.32) return "fyp_post";
  if (roll < 0.7) return "subscriber_post";
  return "paid_post";
}

function mediaFor(page: DemoPage, kind: Kind, random: () => number, seed: string): Publication["media"] {
  const count = kind === "story" ? 1 : kind === "vault_album" ? intBetween(random, 6, 12) : intBetween(random, 1, 4);
  const items: Publication["media"] = [];
  for (let position = 0; position < count; position += 1) {
    const uploaded = page.platform === "fansly" && random() < 0.25;
    items.push(uploaded
      ? { role: "media", position, source: "file", mediaRef: null, fileId: 300 + (Math.abs(seed.length * 37 + position * 11 + Math.floor(random() * 400)) % 900), attachment: 0, name: kind === "vault_album" ? null : pick(random, FILE_NAMES) }
      : { role: "media", position, source: "vault", mediaRef: page.platform === "fansly" ? demoDigits(`${seed}:m${position}`, 18) : demoDigits(`${seed}:m${position}`, 10), fileId: null, attachment: 0, name: null });
  }
  if (kind === "paid_post") {
    items.push({ role: "preview", position: 0, source: "vault", mediaRef: page.platform === "fansly" ? demoDigits(`${seed}:p0`, 18) : demoDigits(`${seed}:p0`, 10), fileId: null, attachment: 0, name: null });
  }
  return items;
}

function finding(code: Finding["code"], severity: Finding["severity"], extra: Partial<Finding> = {}): Finding {
  return { code, severity, mediaKey: null, at: null, postRef: null, publicationId: null, detail: {}, ...extra };
}

/** The first uploaded file of a post, as a finding names it. */
function uploadedKey(media: Publication["media"]): string | null {
  const file = media.find((item) => item.source === "file");
  return file ? `file:${file.fileId ?? ""}` : null;
}

function vaultKey(media: Publication["media"]): string | null {
  const first = media.find((item) => item.role === "media");
  if (!first) return null;
  return first.source === "vault" ? `vault:${first.mediaRef ?? ""}` : `file:${first.fileId ?? ""}`;
}

/** Special fates in the past and odd drafts in the future: the natural exceptions. */
const PAST_OVERRIDES: Readonly<Record<string, { status: Status; reason: string | null }>> = {
  "nova-1:-1:1": { status: "unknown", reason: "absent_unproven:timeline_read_failed" },
  "mia-1:-4:0": { status: "withdrawn", reason: "deleted_after_publish" },
  "mia-3:-6:0": { status: "not_published", reason: "absent_by_id_schedule_and_timeline" },
  "ivy-2:-2:0": { status: "missed", reason: "window_passed" },
  "nova-1:-5:2": { status: "rejected", reason: "fansly_http_400" },
  "mia-of:-2:0": { status: "missed", reason: "window_passed after held: OnlyFans API выключен" },
};

function buildOne(now: Date, page: DemoPage, day: number, slot: number, hour: number): Built | null {
  const key = `${page.label}:${day}:${slot}`;
  const random = rng(`pub:${key}`);
  const publishAtDate = mskAt(now, day, hour);
  const publishAt = publishAtDate.getTime();
  const nowMs = now.getTime();
  const stop = ofStop(now).getTime();
  const override = PAST_OVERRIDES[key];

  // OnlyFans: posts went out until collection stopped; two were already in
  // OnlyFans' own schedule for the next days; nothing else after.
  if (page.platform === "onlyfans" && publishAt >= stop && override === undefined) {
    const queued = page.label === "mia-of" && slot === 0 && (day === 1 || day === 2);
    if (!queued) return null;
  }
  // Further ahead the pages are planned more thinly.
  if (day > 6 && slot > 0) return null;
  if (page.label === "ivy-2" && day % 2 !== 0) return null;

  const pageIndex = Object.keys(SLOTS).indexOf(page.label);
  const id = 4000 + (day - FIRST_DAY) * 24 + (pageIndex === -1 ? 7 : pageIndex) * 3 + slot;
  const kind = key === EXTRA_ATTACHMENT_KEY ? "paid_post" : key === "mia-2:5:0" ? "subscriber_post" : kindFor(page, random, day - FIRST_DAY, slot);
  const media = mediaFor(page, kind, random, key);
  if (key === "mia-2:5:0" && !media.some((item) => item.source === "file")) {
    // The draft whose uploaded file the server already deleted.
    media.unshift({ role: "media", position: 0, source: "file", mediaRef: null, fileId: 455, attachment: 0, name: "beach_03.jpg" });
    media.forEach((item, index) => { if (item.role === "media") item.position = index; });
  }
  // Captions rotate by day and slot, so one day never repeats a caption.
  const caption = CAPTIONS[((day - FIRST_DAY) * 11 + (pageIndex === -1 ? 7 : pageIndex) * 3 + slot) % CAPTIONS.length] ?? CAPTIONS[0];
  const text = kind === "story" ? "" : kind === "vault_album" ? pick(random, ALBUM_TITLES) : caption;
  const author: Publication["author"] = random() < 0.72
    ? { kind: "agent", userId: null, agentKeyId: CONTENT_AGENT_KEY_ID }
    : { kind: "human", userId: random() < 0.5 ? OWNER_ID : LEAD_ID, agentKeyId: null };
  const paidPrice = page.label === "nova-1" ? pick(random, [12.99, 14.99, 19.99, 24.99, 34.99]) : pick(random, [7.99, 9.99, 12.99, 14.99, 19.99]);
  let priceMills: number | null = kind === "paid_post" ? mills(paidPrice) : null;
  // A Fansly subscriber post others may buy, now and then.
  if (kind === "subscriber_post" && page.platform === "fansly" && random() < 0.2) priceMills = mills(pick(random, [4.99, 6.99, 9.99]));

  // --- status ---
  const hoursAhead = (publishAt - nowMs) / HOUR_MS;
  let status: Status;
  let statusReason: string | null = null;
  if (override) {
    status = override.status;
    statusReason = override.reason;
  } else if (hoursAhead <= 0) {
    status = "published";
    statusReason = kind === "story" ? "story_listed" : "read_by_id";
  } else if (page.platform === "onlyfans") {
    status = "scheduled";
    statusReason = "found_in_schedule";
  } else if (DRAFT_KEYS.has(key)) {
    status = "draft";
    // Approved once, then the page's account changed: back to the drafts.
    if (key === "mia-1:2:1") statusReason = "account_changed";
  } else if (day <= 6) {
    // Hub puts approved posts in the platform's schedule a week ahead.
    status = random() < 0.9 ? "scheduled" : "approved";
    if (status === "scheduled") statusReason = "found_in_schedule";
  } else {
    status = "approved";
  }
  if (key === "mia-3:5:0" || key === "ivy-1:-7:0") status = "cancelled";

  // --- findings ---
  const findings: Finding[] = [];
  let repost = false;
  const mediaKey = vaultKey(media);
  const earlier = (days: number) => iso(new Date(nowMs - days * DAY_MS));
  if (status === "draft" || status === "approved" || status === "scheduled") {
    if (key === "mia-2:5:0") {
      findings.push(finding("file_deleted", "blocking", { mediaKey: uploadedKey(media), at: earlier(8) }));
      const vault = media.find((item) => item.source === "vault" && item.role === "media");
      if (vault) findings.push(finding("repost_within_threshold", "blocking", { mediaKey: `vault:${vault.mediaRef ?? ""}`, at: earlier(12), postRef: demoDigits(`post:${key}`, 18), detail: { thresholdDays: 30 } }));
    } else if (key === "mia-2:2:1" && status !== "draft") {
      repost = true;
      findings.push(finding("repost_within_threshold", "warning", { mediaKey, at: earlier(19), postRef: demoDigits(`post:${key}`, 18), detail: { thresholdDays: 30 } }));
    } else if (key === "nova-1:4:1") {
      findings.push(finding("volume_high", "warning", { at: mskDayKey(publishAt), detail: { dayCount: 7, usualPerDay: 3.4 } }));
    } else if (random() < 0.22) {
      findings.push(finding("posted_before", "info", { mediaKey, at: earlier(intBetween(random, 34, 80)), postRef: demoDigits(`old:${key}`, page.platform === "fansly" ? 18 : 10) }));
    }
  }
  if (status === "draft" && kind === "paid_post" && page.label === "ivy-2") findings.push(finding("price_range_not_set", "blocking"));
  const blocked = findings.some((item) => item.severity === "blocking");

  // --- times ---
  // OnlyFans posts still in its schedule were handed over before collection stopped.
  const handedBeforeStop = page.platform === "onlyfans" && publishAt >= stop && status === "scheduled";
  const createdAt = handedBeforeStop ? stop - 31 * HOUR_MS
    : Math.min(publishAt - intBetween(random, 30, 110) * HOUR_MS, nowMs - intBetween(random, 1, 26) * HOUR_MS);
  const approvedAt = handedBeforeStop ? stop - 27 * HOUR_MS : Math.min(createdAt + intBetween(random, 1, 9) * HOUR_MS, nowMs - 20 * 60_000);
  const submittedAt = handedBeforeStop ? stop - 20 * HOUR_MS
    : Math.min(Math.max(approvedAt + 12 * 60_000, publishAt - 7 * DAY_MS), nowMs - 5 * 60_000);
  const scheduledAt = submittedAt + 70_000;
  const settledAt = publishAt + intBetween(random, 2, 9) * 60_000;

  const author0: Pick<Event, "actorKind" | "actorUserId" | "actorAgentKeyId"> = author.kind === "agent"
    ? { actorKind: "agent", actorUserId: null, actorAgentKeyId: author.agentKeyId }
    : { actorKind: "human", actorUserId: author.userId, actorAgentKeyId: null };
  const approver = author.kind === "human" && author.userId === LEAD_ID ? LEAD_ID : (random() < 0.7 ? OWNER_ID : LEAD_ID);
  const hub = { actorKind: "hub" as const, actorUserId: null, actorAgentKeyId: null };
  const events: Event[] = [{ fromStatus: null, toStatus: "draft", ...author0, reason: null, at: iso(new Date(createdAt)) }];
  if (statusReason === "account_changed") {
    events.push({ fromStatus: "draft", toStatus: "approved", actorKind: "human", actorUserId: OWNER_ID, actorAgentKeyId: null, reason: null, at: iso(new Date(approvedAt)) });
    events.push({ fromStatus: "approved", toStatus: "draft", ...hub, reason: "account_changed", at: iso(new Date(Math.min(approvedAt + 3 * HOUR_MS, nowMs - 30 * 60_000))) });
  }
  const approvedOnce = status !== "draft" && !(status === "cancelled" && random() < 0.5);
  if (approvedOnce) {
    events.push({ fromStatus: "draft", toStatus: "approved", actorKind: "human", actorUserId: approver, actorAgentKeyId: null, reason: null, at: iso(new Date(approvedAt)) });
  }
  const sent = !["draft", "approved", "cancelled"].includes(status);
  if (sent && status === "missed") {
    events.push({ fromStatus: "approved", toStatus: "missed", ...hub, reason: statusReason, at: iso(new Date(publishAt + 30 * 60_000)) });
  } else if (sent) {
    events.push({ fromStatus: "approved", toStatus: "submitting", ...hub, reason: null, at: iso(new Date(submittedAt)) });
    if (status === "rejected") {
      events.push({ fromStatus: "submitting", toStatus: "rejected", ...hub, reason: statusReason, at: iso(new Date(scheduledAt)) });
    } else if (status === "unknown" && key === "nova-1:-1:1") {
      events.push({ fromStatus: "submitting", toStatus: "unknown", ...hub, reason: statusReason, at: iso(new Date(scheduledAt + 40_000)) });
    } else {
      events.push({ fromStatus: "submitting", toStatus: "scheduled", ...hub, reason: "found_in_schedule", at: iso(new Date(scheduledAt)) });
      if (status === "published" || status === "withdrawn") {
        events.push({ fromStatus: "scheduled", toStatus: "published", ...hub, reason: kind === "story" ? "story_listed" : "read_by_id", at: iso(new Date(settledAt)) });
      }
      if (status === "withdrawn") {
        events.push({ fromStatus: "published", toStatus: "withdrawn", ...hub, reason: "deleted_after_publish", at: iso(new Date(settledAt + 26 * HOUR_MS)) });
      }
      if (status === "not_published") {
        events.push({ fromStatus: "scheduled", toStatus: "not_published", ...hub, reason: statusReason, at: iso(new Date(settledAt + 3 * HOUR_MS)) });
      }
      if (status === "unknown") {
        events.push({ fromStatus: "scheduled", toStatus: "unknown", ...hub, reason: statusReason, at: iso(new Date(settledAt + 6 * HOUR_MS)) });
      }
    }
  }
  if (status === "cancelled") {
    const from = events.at(-1)?.toStatus ?? "draft";
    events.push({ fromStatus: from, toStatus: "cancelled", actorKind: "human", actorUserId: OWNER_ID, actorAgentKeyId: null, reason: "cancelled", at: iso(new Date(Math.min(approvedAt + 2 * HOUR_MS, nowMs - 10 * 60_000))) });
  }
  const last = events.at(-1);
  const statusChangedAt = last?.at ?? iso(new Date(createdAt));

  const hasPost = ["scheduled", "published", "withdrawn"].includes(status);
  const platformPostRef = hasPost ? (page.platform === "fansly" ? demoDigits(`post:${key}`, 18) : demoDigits(`post:${key}`, 10)) : null;
  const revisionId = approvedOnce && status !== "draft" ? id * 3 + 1 : null;
  const fansly = page.platform === "fansly";

  const publication: Publication = {
    id,
    pageLabel: page.label,
    platform: page.platform,
    kind,
    status,
    version: approvedOnce ? 2 : 1,
    text,
    publishAt: iso(publishAtDate),
    expiresAt: kind === "story" ? iso(new Date(publishAt + DAY_MS)) : null,
    wallRefs: fansly && kind !== "story" && kind !== "vault_album" ? [wallRef(page)] : [],
    tierRefs: fansly && kind === "subscriber_post" && random() < 0.3 ? [tierRef(page, 1)] : [],
    priceMills,
    repost,
    pinWallRefs: fansly && kind === "fyp_post" && random() < 0.08 ? [wallRef(page)] : [],
    replyLock: fansly && kind === "paid_post" && random() < 0.3 ? ["subscribers"] : [],
    subscribersOnly: false,
    extraAttachments: key === EXTRA_ATTACHMENT_KEY
      ? [{ attachment: 1, access: "subscribers", tierRefs: [], priceMills: mills(9.99), subscribersOnly: false }]
      : [],
    media: key === EXTRA_ATTACHMENT_KEY
      ? [...media, { role: "media", position: 0, source: "vault", mediaRef: demoDigits(`${key}:x0`, 18), fileId: null, attachment: 1, name: null }, { role: "media", position: 1, source: "file", mediaRef: null, fileId: 812, attachment: 1, name: "bonus_clip.mp4" }]
      : media,
    findings,
    blocked,
    author,
    approvedRevisionId: revisionId,
    platformPostRef,
    vaultAlbumRef: kind === "vault_album" && sent ? demoDigits(`album:${key}`, 18) : null,
    statusReason,
    previousPublicationId: null,
    withdrawal: key === WITHDRAW_REFUSED_KEY && status === "scheduled"
      ? { state: "rejected", errorCode: "fansly_http_400", at: iso(new Date(nowMs - 40 * 60_000)) }
      : null,
    deletion: status === "withdrawn" ? { state: "confirmed", errorCode: null, at: iso(new Date(settledAt + 26 * HOUR_MS - 4 * 60_000)) }
      : key === DELETE_STUCK_KEY && status === "published" ? { state: "prepared", errorCode: "window_passed", at: iso(new Date(nowMs - 3 * HOUR_MS)) }
        : null,
    createdAt: iso(new Date(createdAt)),
    updatedAt: statusChangedAt,
    statusChangedAt,
  };
  const revision: Detail["revision"] = revisionId === null ? null : {
    id: revisionId,
    fingerprint: demoSha(`rev:${key}`).slice(0, 40),
    approvedByUserId: approver,
    approvedAt: iso(new Date(approvedAt)),
  };
  return { publication, events, revision };
}

/** Every publication of the demo agency, in publish order. */
export function demoPublications(now: Date): Built[] {
  const built: Built[] = [];
  for (let day = FIRST_DAY; day <= LAST_DAY; day += 1) {
    for (const page of DEMO_DATA_PAGES) {
      const slots = SLOTS[page.label] ?? (page.label === "ivy-1" && day === -7 ? [16] : []);
      slots.forEach((hour, slot) => {
        const item = buildOne(now, page, day, slot, hour);
        if (item) built.push(item);
      });
    }
  }
  // A replacement drafted after «not published», linked to its original.
  const lost = built.find((item) => item.publication.status === "not_published");
  if (lost) {
    const replacement = buildOne(now, DEMO_PAGES.find((page) => page.label === "mia-3")!, 2, 0, 15.5);
    if (replacement) {
      replacement.publication = { ...replacement.publication, id: lost.publication.id + 1, previousPublicationId: lost.publication.id, text: lost.publication.text, media: lost.publication.media };
      built.push(replacement);
    }
  }
  built.sort((left, right) => Date.parse(left.publication.publishAt) - Date.parse(right.publication.publishAt) || left.publication.id - right.publication.id);
  return built;
}

export function publicationSettings(now: Date): KernelOperationResponse<"adminPublicationSettingsList"> {
  const stop = ofStop(now);
  const pages: Settings[] = DEMO_PAGES.map((page) => {
    const updated = iso(new Date(now.getTime() - (3 + (page.id % 5)) * DAY_MS));
    if (page.platform === "onlyfans") {
      // As on production: switched on, never stopped; the switched-off API is what keeps them quiet.
      return {
        pageLabel: page.label, platform: page.platform, enabled: true,
        autostopReason: null,
        autostoppedAt: null,
        paidPriceMinMills: null, paidPriceMaxMills: null, repostThresholdDays: 30, dailyLimit: 4, updatedAt: iso(new Date(stop.getTime() - 3 * DAY_MS)),
      };
    }
    if (page.label === "nova-1") {
      // The one live stop: Fansly signed the page's browser out five hours ago (a stop always turns the page off).
      return {
        pageLabel: page.label, platform: page.platform, enabled: false,
        autostopReason: "browser_login_lost",
        autostoppedAt: iso(new Date(now.getTime() - 5 * HOUR_MS)),
        paidPriceMinMills: mills(8), paidPriceMaxMills: mills(50), repostThresholdDays: 45, dailyLimit: 8, updatedAt: updated,
      };
    }
    const ranges: Record<string, [number, number] | null> = {
      "mia-1": [5, 40], "mia-2": [5, 40], "mia-3": [5, 30], "nova-1": [8, 50], "ivy-1": null, "ivy-2": null,
    };
    const range = ranges[page.label] ?? null;
    return {
      pageLabel: page.label,
      platform: page.platform,
      enabled: page.label !== "ivy-1",
      autostopReason: null,
      autostoppedAt: null,
      paidPriceMinMills: range ? mills(range[0]) : null,
      paidPriceMaxMills: range ? mills(range[1]) : null,
      repostThresholdDays: page.label === "nova-1" ? 45 : 30,
      dailyLimit: page.label === "mia-1" ? 6 : page.label === "nova-1" ? 8 : null,
      updatedAt: page.label === "ivy-1" ? null : updated,
    };
  });
  return { globalEnabled: true, pages };
}

const MANUAL_CAPTIONS = ["Happy Friday!! 💋", "Live tonight at 10pm — set a reminder", "Quick hello from the airport ✈️", "Sunday reset: face mask and a movie", "Weekend giveaway: comment your favourite emoji"] as const;

export function publicationQueues(now: Date, publications: readonly Publication[]): KernelOperationResponse<"adminPublicationQueueList"> {
  const nowMs = now.getTime();
  const stop = ofStop(now).getTime();
  const pages: Queue[] = [];
  for (const page of DEMO_DATA_PAGES) {
    if (page.label === "ivy-1") continue;
    const off = page.platform === "onlyfans";
    const readAt = off ? stop - 35 * 60_000 : nowMs - (12 + (page.id % 7) * 4) * 60_000;
    const scheduled = publications.filter((item) => item.pageLabel === page.label && item.status === "scheduled");
    const random = rng(`queue:${page.label}`);
    const manualCount = off ? (page.label === "mia-of" ? 3 : 1) : page.label === "nova-1" ? 2 : page.label === "mia-1" ? 1 : 0;
    const entries: Queue["entries"] = scheduled.map((item) => ({
      queueId: demoDigits(`q:${item.id}`, 9),
      postRef: item.platformPostRef,
      publishAt: item.publishAt,
      text: item.text,
      mediaCount: item.media.filter((media) => media.role === "media").length,
      publicationId: item.id,
    }));
    for (let index = 0; index < manualCount; index += 1) {
      entries.push({
        queueId: demoDigits(`qm:${page.label}:${index}`, 9),
        postRef: null,
        publishAt: iso(new Date(readAt + (index + 1) * intBetween(random, 20, 40) * HOUR_MS)),
        text: MANUAL_CAPTIONS[(page.id + index) % MANUAL_CAPTIONS.length] ?? "",
        mediaCount: intBetween(random, 1, 3),
        publicationId: null,
      });
    }
    entries.sort((left, right) => Date.parse(left.publishAt ?? "") - Date.parse(right.publishAt ?? ""));
    const postsPerDay: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.publishAt === null) continue;
      const day = entry.publishAt.slice(0, 10);
      postsPerDay[day] = (postsPerDay[day] ?? 0) + 1;
    }
    if (page.label === "mia-1") {
      // An entry Fansly answered without a time.
      entries.push({ queueId: demoDigits("qm:mia-1:undated", 9), postRef: null, publishAt: null, text: "Polaroid dump from the weekend", mediaCount: 4, publicationId: null });
    }
    // As on production: Fansly's whole-list read is never confirmed (a permanent reason the
    // screen hides) and Fansly has no read window; mia-3 also ran out of reads.
    const fansly = page.platform === "fansly";
    pages.push({
      pageLabel: page.label,
      platform: page.platform,
      readAt: iso(new Date(readAt)),
      windowFrom: fansly ? null : new Date(readAt).toISOString().slice(0, 10),
      windowTo: fansly ? null : new Date(readAt + 7 * DAY_MS).toISOString().slice(0, 10),
      complete: !fansly,
      incompleteReasons: fansly ? (page.label === "mia-3" ? ["list_whole_unverified", "read_budget"] : ["list_whole_unverified"]) : [],
      stale: off,
      postsPerDay,
      refreshRequestedAt: null,
      lastFailure: off ? "OnlyFans API выключен: чтение расписания не отправлялось" : null,
      lastFailedAt: off ? iso(new Date(nowMs - 50 * 60_000)) : null,
      entries,
    });
  }
  return { pages };
}
