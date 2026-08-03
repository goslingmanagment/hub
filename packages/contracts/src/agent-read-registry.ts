/**
 * Agent Read Plane — the single source of truth for the claim/plane vocabulary.
 *
 * WHY THIS FILE EXISTS (do not "simplify" it back into prose):
 * the design spec restated the same vocabulary in a dozen places — an enum here,
 * a count there, a matrix in the appendix, a pinned number in a test. Three
 * adversarial review rounds each found real defects caused purely by those
 * restatements drifting apart (plane enum said 19 while four other sites still
 * pinned 13; six claim classes in the architecture against four in the contract
 * appendix). The vocabulary is therefore declared ONCE, here, and the enums,
 * counts and required-plane sets are DERIVED. A drift becomes a compile error
 * instead of a silent lie in a response body.
 *
 * SCOPE: this module owns the claim/plane vocabulary only. Per-operation
 * membership (which operation may speak to which fields) lands together with the
 * operations themselves and must be declared HERE when it does — hand-listing it
 * at each route is exactly the drift this file exists to prevent.
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

/**
 * Required planes are declared PER FIELD, not per class.
 *
 * A class-level `required` set is unsound whenever the class groups fields with
 * different authoritative stores: with `crm.required = ["fan_notes"]`, a reader
 * could satisfy the check by reading notes and then claim "this fan has no
 * profile body" without ever touching `fan_profiles`. The question
 * "what must I have read to assert this is absent?" belongs to the field.
 */
export type AgentClaimFieldDefinition = {
  /** Authoritative store(s). ALL must be `read` before absence may be asserted. */
  readonly required: readonly string[];
};

export type AgentClaimClassDefinition = {
  /** Stores reported for provenance; never gate a conclusion. */
  readonly evidentiary: readonly string[];
  /** Wire field -> the store(s) that authoritatively answer for it. */
  readonly fields: Readonly<Record<string, AgentClaimFieldDefinition>>;
};

/**
 * The seven claim classes. A request may declare `claim.fields`; each field maps
 * to exactly one class (pinned by test), and the conclusion is evaluated against
 * the union of the REQUIRED planes of the named fields.
 *
 * Field names are the wire names from the contract appendix §17 — not invented
 * ones. A name that does not exist on the wire makes every real claim resolve to
 * `claim_field_unobservable`, which silently reduces `absenceProvable` to a
 * constant `false`.
 */
export const AGENT_CLAIM_CLASSES = {
  messages: {
    evidentiary: ["page_dm_messages", "page_dm_threads", "observations", "sync_raw_payloads"],
    fields: {
      textPlain: { required: ["message_archive", "dm_message_archive"] },
      textHtml: { required: ["message_archive", "dm_message_archive"] },
      priceMills: { required: ["message_archive", "dm_message_archive"] },
      isOpened: { required: ["message_archive", "dm_message_archive"] },
      isNew: { required: ["message_archive", "dm_message_archive"] },
      isTip: { required: ["message_archive", "dm_message_archive"] },
      tipAmountMills: { required: ["message_archive", "dm_message_archive"] },
      tipTextPlain: { required: ["message_archive", "dm_message_archive"] },
      inReplyToRef: { required: ["message_archive", "dm_message_archive"] },
      replyMetadata: { required: ["message_archive", "dm_message_archive"] },
      mediaMetadata: { required: ["message_archive", "dm_message_archive"] },
      deletedAt: { required: ["message_archive", "dm_message_archive"] },
      conversationRef: { required: ["message_archive", "dm_message_archive"] },
      messageCount: { required: ["message_archive", "dm_message_archive"] },
      coverageStatus: { required: ["message_archive", "dm_message_archive"] },
      purchaseState: { required: ["message_archive", "dm_message_archive"] },
    },
  },
  money: {
    evidentiary: ["fan_spend_daily"],
    fields: {
      grossMills: { required: ["transactions"] },
      netMills: { required: ["transactions"] },
      feeMills: { required: ["transactions"] },
      amountMills: { required: ["transactions"] },
      currency: { required: ["transactions"] },
      transactionState: { required: ["transactions"] },
      // Refund/chargeback outcome of a transaction. Declared as its own field
      // because `transactionState` alone reads as observable while neither
      // platform's capture can actually answer "was this refunded": Fansly has
      // no refund/chargeback lane at all (FEAT-004; rows stay `posted`
      // forever), and the OF chargeback capture is not projected into any
      // agent-readable store. The per-platform truth lives in
      // AGENT_PLATFORM_CAPABILITIES, and claiming this field is what routes a
      // "no refunds happened" conclusion through that table.
      refundState: { required: ["transactions"] },
      fanEarning: { required: ["transactions"] },
      // Lifetime totals have their own rollup; reading `transactions` for a
      // window says nothing about a lifetime figure.
      lifetimeSpendMills: { required: ["fan_spend_lifetime"] },
    },
  },
  identity: {
    evidentiary: [],
    fields: {
      platformUserId: { required: ["fans"] },
      username: { required: ["fans"] },
      displayName: { required: ["fans"] },
      membershipState: { required: ["page_fans"] },
      // Aliases live in their own stores; `fans` alone cannot answer for them.
      pageAlias: { required: ["page_fans", "page_fan_aliases", "fan_username_aliases"] },
    },
  },
  subscription: {
    evidentiary: [],
    fields: {
      subscriptionState: { required: ["page_subscriptions"] },
      subscriptionPriceMills: { required: ["page_subscriptions"] },
      subscriptionExpiresAt: { required: ["page_subscriptions"] },
    },
  },
  audience: {
    evidentiary: ["daily_followers"],
    fields: {
      followed: { required: ["page_follows"] },
      presenceAt: { required: ["page_fans"] },
    },
  },
  crm: {
    evidentiary: [],
    fields: {
      // Each CRM field has a DIFFERENT authoritative store. This is the case
      // that proved class-level `required` unsound: with `required:
      // ["fan_notes"]`, a reader could satisfy the check by reading notes and
      // then assert "no profile body" without ever opening `fan_profiles`.
      noteText: { required: ["fan_notes"] },
      summaryText: { required: ["fan_summaries"] },
      profileBody: { required: ["fan_profiles"] },
      fanFlag: { required: ["fan_flags"] },
    },
  },
  content: {
    // The current-head projections are authoritative for creator-post material
    // and monetization snapshots. Per-tip rows have their own immutable plane;
    // journal rows remain lineage evidence and are not re-read by dataset #10.
    evidentiary: ["observations", "sync_raw_payloads"],
    fields: {
      postRef: { required: ["creator_posts"] },
      postText: { required: ["creator_posts"] },
      publishedAt: { required: ["creator_posts"] },
      firstObservedAt: { required: ["creator_posts"] },
      lastObservedAt: { required: ["creator_posts"] },
      attachmentCount: { required: ["creator_posts"] },
      postTargetTipAmountMills: { required: ["creator_posts"] },
      attachmentTipAmountMills: { required: ["creator_posts"] },
      postTipTotalMills: { required: ["creator_posts"] },
      tipGoalLinked: { required: ["creator_posts"] },
      tipGoalRef: { required: ["creator_posts"] },
      tipGoalLabelText: { required: ["creator_posts"] },
      tipGoalTargetMills: { required: ["creator_posts"] },
      tipGoalCurrentMills: { required: ["creator_posts"] },
      tipGoalAmountsHidden: { required: ["creator_posts"] },
      postTipPostRef: { required: ["creator_post_tips"] },
      postTipRef: { required: ["creator_post_tips"] },
      tipSenderPlatformUserId: { required: ["creator_post_tips"] },
      postTipOccurredAt: { required: ["creator_post_tips"] },
      postTipAmountMills: { required: ["creator_post_tips"] },
      receiverTransactionRef: { required: ["creator_post_tips"] },
      postTipGoalRef: { required: ["creator_post_tips"] },
      postTipMessageText: { required: ["creator_post_tips"] },
      linkedPostCount: { required: ["creator_posts"] },
    },
  },
} as const satisfies Record<string, AgentClaimClassDefinition>;

export type AgentClaimClass = keyof typeof AGENT_CLAIM_CLASSES;

export const AGENT_CLAIM_CLASS_NAMES = Object.keys(AGENT_CLAIM_CLASSES) as readonly AgentClaimClass[];

/**
 * Literal unions derived from the declaration. These make the header's promise
 * real: a typo in a plane or field name is a COMPILE error, and Zod enums built
 * from these stay narrow instead of degrading to `string`.
 */
export type AgentClaimField = {
  [C in AgentClaimClass]: keyof (typeof AGENT_CLAIM_CLASSES)[C]["fields"];
}[AgentClaimClass];

type RequiredPlaneOf<C extends AgentClaimClass> = {
  [F in keyof (typeof AGENT_CLAIM_CLASSES)[C]["fields"]]:
  (typeof AGENT_CLAIM_CLASSES)[C]["fields"][F] extends { required: readonly (infer P)[] } ? P : never;
}[keyof (typeof AGENT_CLAIM_CLASSES)[C]["fields"]];

export type AgentPlaneName =
  | (typeof AGENT_CLAIM_CLASSES)[AgentClaimClass]["evidentiary"][number]
  | { [C in AgentClaimClass]: RequiredPlaneOf<C> }[AgentClaimClass];

function classFieldEntries(claimClass: AgentClaimClass): readonly (readonly [string, AgentClaimFieldDefinition])[] {
  return Object.entries(AGENT_CLAIM_CLASSES[claimClass].fields as Record<string, AgentClaimFieldDefinition>);
}

/** Every plane name, deduped, in declaration order. Derived — never hand-listed. */
export const AGENT_PLANE_NAMES: readonly AgentPlaneName[] = (() => {
  const seen = new Set<string>();
  const ordered: AgentPlaneName[] = [];
  const push = (plane: string) => {
    if (!seen.has(plane)) {
      seen.add(plane);
      ordered.push(plane as AgentPlaneName);
    }
  };
  for (const name of AGENT_CLAIM_CLASS_NAMES) {
    for (const [, def] of classFieldEntries(name)) {
      for (const plane of def.required) {
        push(plane);
      }
    }
    for (const plane of AGENT_CLAIM_CLASSES[name].evidentiary) {
      push(plane);
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
    for (const [field] of classFieldEntries(name)) {
      if (!seen.has(field)) {
        seen.add(field);
        ordered.push(field as AgentClaimField);
      }
    }
  }
  return ordered;
})();

/** field -> class. Built once; the test pins that no field lands in two classes. */
export const AGENT_CLAIM_FIELD_CLASS: ReadonlyMap<AgentClaimField, AgentClaimClass> = (() => {
  const map = new Map<AgentClaimField, AgentClaimClass>();
  for (const name of AGENT_CLAIM_CLASS_NAMES) {
    for (const [field] of classFieldEntries(name)) {
      const key = field as AgentClaimField;
      if (!map.has(key)) {
        map.set(key, name);
      }
    }
  }
  return map;
})();

/**
 * Widened view of a class: its evidentiary planes, and the union of the required
 * planes of all its fields.
 *
 * `as const` narrows each array to a literal tuple, which makes `.includes(x)`
 * on a plain `string` a type error. Callers want set membership, so the widening
 * happens once here rather than as casts scattered at every use.
 */
export function agentClassPlanes(claimClass: AgentClaimClass): {
  readonly required: readonly string[];
  readonly evidentiary: readonly string[];
  readonly fields: readonly string[];
} {
  const required = new Set<string>();
  const fields: string[] = [];
  for (const [field, def] of classFieldEntries(claimClass)) {
    fields.push(field);
    for (const plane of def.required) {
      required.add(plane);
    }
  }
  return {
    required: [...required],
    evidentiary: AGENT_CLAIM_CLASSES[claimClass].evidentiary,
    fields,
  };
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
 * these claim fields — the union of each named field's authoritative stores.
 *
 * Returns `null` (fail closed) when any field is unknown, or when the claim is
 * empty: callers treat `null` as "cannot conclude".
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
    const classFields = AGENT_CLAIM_CLASSES[claimClass].fields as Record<string, AgentClaimFieldDefinition>;
    const def = classFields[field];
    if (!def) {
      return null;
    }
    for (const plane of def.required) {
      planes.add(plane);
    }
  }
  return [...planes];
}
