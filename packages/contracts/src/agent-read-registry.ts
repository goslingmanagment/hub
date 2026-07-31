/**
 * Agent Read Plane — the single source of truth for the claim/plane vocabulary.
 *
 * WHY THIS FILE EXISTS (do not "simplify" it back into prose):
 * the design spec restated the same vocabulary in a dozen places — an enum here,
 * a count there, a matrix in the appendix, a pinned number in a test. Three
 * adversarial review rounds each found real defects caused purely by those
 * restatements drifting apart (plane enum said 19 while four other sites still
 * pinned 13; six claim classes in the architecture against four in the contract
 * appendix). The vocabulary is therefore declared ONCE, here, and everything
 * else — Zod enums, counts, required-plane sets, per-operation matrices, the CI
 * pins — is DERIVED. A drift becomes a compile error instead of a silent lie in
 * a response body.
 *
 * Design reference: `investigations/agent-read-api-design-2026-07-31.md` §5.
 */

/**
 * A physical store the read plane can consult.
 *
 * `required` planes decide `conclusion.absenceProvable`: if one of them is not
 * `read`, no negative conclusion is possible. `evidentiary` planes are reported
 * in `capture.planes[]` for provenance but never block a conclusion.
 *
 * The split exists because an earlier revision required EVERY plane of a class
 * to be `read`, which included the capture journal — and the journal only
 * begins 2026-07-05 in production, so `absenceProvable` was structurally `false`
 * on every historical window, on both platforms, even with a valid OnlyFans
 * continuity proof. `message_archive` is authoritative for reads; the journal is
 * provenance evidence, already expressed through `fieldStates`/`provenance`.
 */
export type AgentPlaneRole = "required" | "evidentiary";

export type AgentClaimClassDefinition = {
  /** Stores that must be `read` for a negative conclusion to be permitted. */
  readonly required: readonly string[];
  /** Stores reported for provenance; never gate a conclusion. */
  readonly evidentiary: readonly string[];
  /** Wire fields whose absence this class can speak about. */
  readonly fields: readonly string[];
};

/**
 * The six claim classes. A request may declare `claim.fields`; each field maps
 * to exactly one class (pinned by test), and the conclusion is evaluated
 * against that class's `required` planes only.
 */
export const AGENT_CLAIM_CLASSES = {
  messages: {
    required: ["message_archive", "dm_message_archive"],
    evidentiary: ["page_dm_messages", "page_dm_threads", "observations", "sync_raw_payloads"],
    fields: [
      "textPlain", "textHtml", "priceMills", "isOpened", "isNew", "isTip",
      "tipAmountMills", "tipTextPlain", "inReplyToRef", "replyMetadata",
      "mediaMetadata", "deletedAt", "conversationRef", "messageCount",
      "coverageStatus", "purchaseState",
    ],
  },
  money: {
    required: ["transactions"],
    evidentiary: ["fan_spend_daily", "fan_spend_lifetime"],
    fields: [
      "grossMills", "netMills", "feeMills", "amountMills", "currency",
      "transactionState", "lifetimeSpendMills", "fanEarning",
    ],
  },
  identity: {
    required: ["fans", "page_fans"],
    evidentiary: ["fan_username_aliases", "page_fan_aliases"],
    fields: ["platformUserId", "username", "displayName", "pageAlias", "membershipState"],
  },
  subscription: {
    required: ["page_subscriptions"],
    evidentiary: [],
    fields: ["subscriptionState", "subscriptionPriceMills", "subscriptionExpiresAt"],
  },
  audience: {
    required: ["page_follows"],
    evidentiary: ["daily_followers"],
    fields: ["followed", "presenceAt"],
  },
  crm: {
    required: ["fan_notes"],
    evidentiary: ["fan_summaries", "fan_profiles", "fan_flags"],
    fields: ["noteText", "summaryText"],
  },
} as const satisfies Record<string, AgentClaimClassDefinition>;

export type AgentClaimClass = keyof typeof AGENT_CLAIM_CLASSES;

export const AGENT_CLAIM_CLASS_NAMES = Object.keys(AGENT_CLAIM_CLASSES) as readonly AgentClaimClass[];

/**
 * Literal unions derived from the declaration. These are what make the header's
 * promise real: a typo in a plane or field name is a COMPILE error, and the Zod
 * enums built from these stay narrow instead of degrading to `string`.
 */
export type AgentPlaneName =
  (typeof AGENT_CLAIM_CLASSES)[AgentClaimClass]["required" | "evidentiary"][number];
export type AgentClaimField = (typeof AGENT_CLAIM_CLASSES)[AgentClaimClass]["fields"][number];

/** Every plane name, deduped, in declaration order. Derived — never hand-listed. */
export const AGENT_PLANE_NAMES: readonly AgentPlaneName[] = (() => {
  const seen = new Set<string>();
  const ordered: AgentPlaneName[] = [];
  for (const name of AGENT_CLAIM_CLASS_NAMES) {
    const def = AGENT_CLAIM_CLASSES[name];
    for (const plane of [...def.required, ...def.evidentiary]) {
      if (!seen.has(plane)) {
        seen.add(plane);
        ordered.push(plane);
      }
    }
  }
  return ordered;
})();

/** Derived count. Anything that needs "how many planes" reads THIS, never a literal. */
export const AGENT_PLANE_COUNT = AGENT_PLANE_NAMES.length;

/** Every declared claim field, deduped. Derived. */
export const AGENT_CLAIM_FIELDS: readonly AgentClaimField[] = (() => {
  const seen = new Set<string>();
  const ordered: AgentClaimField[] = [];
  for (const name of AGENT_CLAIM_CLASS_NAMES) {
    for (const field of AGENT_CLAIM_CLASSES[name].fields) {
      if (!seen.has(field)) {
        seen.add(field);
        ordered.push(field);
      }
    }
  }
  return ordered;
})();

/** field -> class. Built once; the test pins that no field lands in two classes. */
export const AGENT_CLAIM_FIELD_CLASS: ReadonlyMap<AgentClaimField, AgentClaimClass> = (() => {
  const map = new Map<AgentClaimField, AgentClaimClass>();
  for (const name of AGENT_CLAIM_CLASS_NAMES) {
    for (const field of AGENT_CLAIM_CLASSES[name].fields) {
      if (!map.has(field)) {
        map.set(field, name);
      }
    }
  }
  return map;
})();

/**
 * Widened view of a class definition.
 *
 * `as const` narrows each array to a literal tuple, which makes `.includes(x)`
 * on a plain `string` a type error (and makes `.length === 0` look like a
 * provably-false comparison). Callers want set membership, not the literals, so
 * the widening happens once here rather than as casts scattered at every use.
 */
export function agentClassPlanes(claimClass: AgentClaimClass): {
  readonly required: readonly string[];
  readonly evidentiary: readonly string[];
  readonly fields: readonly string[];
} {
  return AGENT_CLAIM_CLASSES[claimClass];
}

/** plane -> role within a given class. Used to build `capture.planes[]`. */
export function agentPlaneRole(claimClass: AgentClaimClass, plane: string): AgentPlaneRole | "not_applicable" {
  const { required, evidentiary } = agentClassPlanes(claimClass);
  if (required.includes(plane)) {
    return "required";
  }
  if (evidentiary.includes(plane)) {
    return "evidentiary";
  }
  return "not_applicable";
}

/**
 * Boundary lookup: accepts an UNVALIDATED field name (it arrives from a request)
 * and resolves its class, or `undefined` when the field is unknown. The map
 * itself stays keyed by the literal union so typed callers keep the compile-time
 * guarantee; only this seam widens.
 */
export function agentClaimFieldClass(field: string): AgentClaimClass | undefined {
  return (AGENT_CLAIM_FIELD_CLASS as ReadonlyMap<string, AgentClaimClass>).get(field);
}

/**
 * The planes that must be `read` before a negative conclusion is permitted for
 * this set of claim fields. A field with no class makes the answer fail closed:
 * callers treat `null` as "cannot conclude" (`claim_field_unobservable`).
 */
export function requiredPlanesForClaimFields(fields: readonly string[]): readonly string[] | null {
  // An empty claim is epistemically identical to no claim at all: "every
  // required plane was read" is vacuously true over an empty set, which would
  // authorise a negative conclusion nothing was actually read for. The spec
  // (§5.4) says a missing claim yields `absenceProvable: false`; an empty one
  // must take the same branch rather than a different, permissive one.
  if (fields.length === 0) {
    return null;
  }
  const planes = new Set<string>();
  for (const field of fields) {
    const claimClass = agentClaimFieldClass(field);
    if (!claimClass) {
      return null;
    }
    for (const plane of AGENT_CLAIM_CLASSES[claimClass].required) {
      planes.add(plane);
    }
  }
  return [...planes];
}
