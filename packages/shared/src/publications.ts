// Publications (wall posts through Hub, docs/plans/2026-10-23-wall-posts):
// the vocabulary every layer shares — kinds, statuses, who may move a
// publication from one status to another, and the codes of the draft checks.
// The transition table below is the ONE place that says which status change
// is allowed and for whom; the service refuses anything it does not list.

export const PUBLICATION_KINDS = ["fyp_post", "subscriber_post", "paid_post", "story"] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];

/** What each platform can publish: OnlyFans has no FYP (spec §6). */
export const PUBLICATION_PLATFORM_KINDS = {
  fansly: ["fyp_post", "subscriber_post", "paid_post", "story"],
  onlyfans: ["subscriber_post", "paid_post", "story"],
} as const satisfies Record<string, readonly PublicationKind[]>;

/** spec §4, in the order a publication lives through them. */
export const PUBLICATION_STATUSES = [
  "draft",
  "approved",
  "submitting",
  "scheduled",
  "processing",
  "published",
  "not_published",
  "rejected",
  "unknown",
  "missed",
  "withdrawn",
  "cancelled",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Who wrote a publication. */
export const PUBLICATION_AUTHOR_KINDS = ["human", "agent"] as const;
export type PublicationAuthorKind = (typeof PUBLICATION_AUTHOR_KINDS)[number];

/** Who moved its status: a person, an agent key, or Hub itself. */
export const PUBLICATION_ACTOR_KINDS = ["human", "agent", "hub"] as const;
export type PublicationActorKind = (typeof PUBLICATION_ACTOR_KINDS)[number];

/**
 * Every allowed status change and who may make it (spec §4, §8.2). A status
 * that is not a key here, or a target it does not list, is refused.
 *
 * - draft → approved and every cancel are a person's: an agent drafts, a
 *   person approves (spec §2.5, §9).
 * - approved → draft: an edit (person or agent), or Hub's check before
 *   dispatch finding the account, binding or model changed (spec §3.3).
 * - approved → submitting / missed and everything after submitting are Hub's:
 *   the sender and the read that confirms the outcome.
 * - unknown is answered by a read (Hub) or by a person (spec §8.2): "it went
 *   out" (scheduled / published) or "it did not" (not_published, and a new
 *   publication linked to this one is drafted). Hub never concludes "it did
 *   not" by itself: absence from a read proves nothing.
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, Readonly<Partial<Record<PublicationStatus, readonly PublicationActorKind[]>>>>
> = {
  draft: { approved: ["human"], cancelled: ["human"] },
  approved: { draft: ["human", "agent", "hub"], cancelled: ["human"], submitting: ["hub"], missed: ["hub"] },
  // submitting → missed only when the command provably never left (its
  // window passed while it waited for the platform's slot).
  submitting: { scheduled: ["hub"], processing: ["hub"], published: ["hub"], rejected: ["hub"], unknown: ["hub"], missed: ["hub"] },
  // scheduled → processing: a story OnlyFans took as ready turned out still
  // preparing at the check (plan PR 5).
  scheduled: { published: ["hub"], processing: ["hub"], not_published: ["hub"], withdrawn: ["hub"], unknown: ["hub"] },
  processing: { published: ["hub"], not_published: ["hub"], unknown: ["hub"] },
  unknown: {
    scheduled: ["human", "hub"],
    processing: ["hub"],
    published: ["human", "hub"],
    not_published: ["human"],
    withdrawn: ["hub"],
  },
  published: {},
  not_published: {},
  rejected: {},
  missed: {},
  withdrawn: {},
  cancelled: {},
};

export function canTransitionPublication(
  from: PublicationStatus,
  to: PublicationStatus,
  actor: PublicationActorKind,
): boolean {
  return PUBLICATION_TRANSITIONS[from][to]?.includes(actor) === true;
}

/** Statuses whose content may still change (an edit of an approved one returns it to draft). */
export const PUBLICATION_EDITABLE_STATUSES: readonly PublicationStatus[] = ["draft", "approved"];

/**
 * Statuses in which a publication occupies its media and its day on the page:
 * approved and on the way, on the platform, or possibly on it (unknown).
 * Drafts, and the statuses where it surely did not go out, do not.
 */
export const PUBLICATION_ACTIVE_STATUSES: readonly PublicationStatus[] = [
  "approved",
  "submitting",
  "scheduled",
  "processing",
  "published",
  "unknown",
];

/** The codes of the draft checks (spec §8.1). Severity is decided per finding. */
export const PUBLICATION_FINDING_CODES = [
  /** The publish time is not in the future. Blocking. */
  "publish_time_past",
  /** An uploaded file belongs to another model than the page's. Blocking. */
  "file_of_another_model",
  /** An uploaded file's bytes were deleted after their 7 days (spec §7): upload it again. Blocking. */
  "file_deleted",
  /** A vault media ref is not among the media Hub collected for this page. Blocking. */
  "media_not_on_page",
  /** The file went out on the page, or is approved for it, closer than the
   *  page's repeat threshold. Blocking without the repost flag, a warning with it. */
  "repost_within_threshold",
  /** The file went out on the page before, outside the threshold. Information. */
  "posted_before",
  /** A paid post on a page with no price range: not approvable. Blocking. */
  "price_range_not_set",
  /** The price is outside the page's range. Blocking. */
  "price_out_of_range",
  /** Paid posts on OnlyFans stay off until a price at creation is verified (spec §6, §12). Blocking. */
  "paid_post_off_on_onlyfans",
  /** The day holds twice the page's usual posts or more. Warning. */
  "volume_high",
  /** The day would pass the page's hard daily limit. Blocking. */
  "daily_limit_exceeded",
  /** A Fansly wall the page does not have. Blocking. */
  "wall_not_on_page",
  /** A Fansly post with no wall named, and Hub knows no default wall of the page. Blocking. */
  "wall_default_unknown",
  /** A subscription tier the page does not have. Blocking. */
  "tier_not_on_page",
  /** No longer produced (plan PR 4c uploads new files); kept so findings saved before still read. */
  "onlyfans_file_upload_unsupported",
  /** A new file over 100 MB on an OnlyFans page: OnlyFansAPI's direct upload stops there. Blocking. */
  "onlyfans_file_too_large",
  /** A new file on a Fansly page: the page's browser cannot upload it yet (plan PR 8). Blocking. */
  "fansly_file_upload_unsupported",
  /** A Fansly subscriber post for more than one tier: the site's request for it
   *  is not captured (the contract §3 shows one tier). Blocking. */
  "fansly_several_tiers_unsupported",
] as const;
export type PublicationFindingCode = (typeof PUBLICATION_FINDING_CODES)[number];

export const PUBLICATION_FINDING_SEVERITIES = ["blocking", "warning", "info"] as const;
export type PublicationFindingSeverity = (typeof PUBLICATION_FINDING_SEVERITIES)[number];

/** Defaults of a page's publishing settings (a page without a settings row has these). */
export const PUBLICATION_DEFAULT_REPOST_THRESHOLD_DAYS = 30;
/** The volume warning's floor: a page's "usual" day is never fewer posts than this. */
export const PUBLICATION_VOLUME_USUAL_FLOOR_PER_DAY = 3;
/** The volume warning fires at this multiple of the usual day. */
export const PUBLICATION_VOLUME_WARNING_FACTOR = 2;
/** The window the usual day is averaged over. */
export const PUBLICATION_VOLUME_BASELINE_DAYS = 30;

/**
 * Paid posts on OnlyFans: OnlyFansAPI's post create has no documented price
 * field, and setting the price by an edit after creation would make the post
 * free for a moment. Off until the "save for later" check of plan stage 2
 * shows a price at creation is accepted (spec §6, §12).
 */
export const ONLYFANS_PAID_POSTS_ENABLED = false;

/**
 * New files on Fansly: the page's browser uploads them (plan PR 8), which has
 * not landed. Until it does, a Fansly publication goes out with vault media
 * only, and a new file is a blocking finding (`fansly_file_upload_unsupported`).
 */
export const FANSLY_FILE_UPLOAD_ENABLED = false;

/** Limits of a draft's shape; the platforms' own limits are tighter or unknown. */
export const PUBLICATION_TEXT_MAX_LENGTH = 5000;
export const PUBLICATION_MEDIA_MAX = 20;
export const PUBLICATION_PREVIEWS_MAX = 5;

/** The largest new file Hub uploads to OnlyFans (OnlyFansAPI's direct upload, plan PR 4c). */
export const ONLYFANS_UPLOAD_MAX_BYTES = 100_000_000;
/** A story with a new file starts its upload this long before its time; a post when it goes into the schedule. */
export const ONLYFANS_STORY_UPLOAD_LEAD_MINUTES = 60;

/** Posts go into the platform's own schedule this far ahead; later ones wait in Hub (spec §3.4). */
export const PUBLICATION_SCHEDULE_HORIZON_DAYS = 7;
/** At most this many posts of one page go to the platform in a row... */
export const PUBLICATION_BATCH_SIZE = 5;
/** ...and the next batch of the page waits this long (spec §8.3). */
export const PUBLICATION_BATCH_GAP_MINUTES = 10;
/**
 * A story is sent at its time; if Hub has not started sending it this many
 * minutes after, it is missed and never goes late (spec §3.5). A post whose
 * time passed this long ago while Hub was down is missed the same way.
 */
export const PUBLICATION_START_WINDOW_MINUTES = 30;
/** A post due within this many minutes goes out now instead of into the schedule. */
export const PUBLICATION_POST_NOW_LEAD_MINUTES = 2;

/**
 * Did it go out (spec §3.6, plan PR 5): a fresh read of the platform this
 * long after the publish time. A story OnlyFans still prepares is read again
 * these many hours after its time; still not ready at the last one, it waits
 * for a person.
 */
export const PUBLICATION_CHECK_DELAY_MINUTES = 10;
export const PUBLICATION_PROCESSING_RECHECK_HOURS = [1, 6] as const;
/**
 * An "unknown" publication is looked for by reading only (spec §8.2): fresh
 * platform reads this long after it became unknown, then the posts Hub
 * collected once a day for a week. Never "it did not go out" by Hub alone.
 */
export const PUBLICATION_SEARCH_READ_ROUNDS_MINUTES = [10, 60, 6 * 60, 24 * 60] as const;
export const PUBLICATION_SEARCH_DAYS = 7;

/**
 * Withdrawal of a post from the platform's schedule (spec §6, §8.2): only this
 * long before its time or earlier, and only after a fresh complete read of the
 * schedule shows it still there. OnlyFansAPI's post delete removes live posts
 * too: the margin and the fresh read are the guard against deleting one that
 * already went out.
 */
export const PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES = 15;
/** The platform's schedule is read this many days ahead (Hub schedules 7 days ahead, spec §3.4). */
export const PUBLICATION_QUEUE_READ_DAYS = 7;
/** ...hourly while the page has Hub posts in it, otherwise daily (and on the owner's button). */
export const PUBLICATION_QUEUE_READ_IN_FLIGHT_MINUTES = 60;
export const PUBLICATION_QUEUE_READ_IDLE_MINUTES = 24 * 60;
