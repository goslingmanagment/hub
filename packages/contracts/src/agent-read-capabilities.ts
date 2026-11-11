/**
 * Agent Read Plane — the closed capability matrix.
 *
 * WHY A SEPARATE CONST (and why it is closed): a key's grant is the only thing
 * standing between a machine principal and the agency's verbatim transcripts and
 * money. An unknown capability at issuance is REJECTED, never ignored — silently
 * dropping a typo would mint a key the owner believes is narrower than it is, and
 * silently accepting one would mint a grant nothing in the code can check.
 *
 * The list is normative in the contract appendix (§17.0.5). It is declared here
 * once so that key issuance, the per-operation requirement table, the `agent_keys`
 * CHECK constraint and the capabilities response all derive from the same literal.
 * Sibling of `agent-read-registry.ts`, which owns the claim/plane vocabulary only.
 *
 * Design reference: `investigations/agent-read-api-design-2026-07-31.md` §8.
 */

/**
 * Adding one is a contract change: it widens what a key can be granted, so it
 * travels with a migration for the `agent_keys` CHECK, an entry in the
 * per-operation requirement table, and regression coverage.
 */
export const AGENT_CAPABILITIES = [
  /** Verbatim message text: transcripts, search snippets, thread material. */
  "read:messages",
  /** Money: transactions, spend rollups, subscription prices. */
  "read:money",
  /** Observation ENVELOPES (metadata only — the payload is owner-session, #9b). */
  "read:observations_envelope",
  /** The registered dataset queries (#10). Money-bearing datasets ALSO need read:money. */
  "read:datasets",
  /** Filing a hydration request (#11/#12). Execution stays an owner decision. */
  "request:hydration",
  /** Drafting publications (wall posts, vault albums) on the key's pages, and uploading their files. */
  "write:publication_drafts",
  /** Approving those drafts, on the owner's word in the chat (owner 2026-10-27). */
  "approve:publications",
  /**
   * Approving vault albums and nothing else, on the word of the person who asked
   * (owner 2026-11-04). Fans do not see an album, so a content manager's own agent
   * holds this instead of approve:publications, which also reaches paid posts.
   */
  "approve:vault_albums",
  /**
   * Managing fan queues on the key's pages (docs/plans/2026-10-29-fan-queues):
   * preview a rule, create, change, add fans, read results — each write on the
   * word of the person who asked (`requestedBy`). Nothing is sent to a fan.
   */
  "write:fan_queues",
  /**
   * The page's own published material and its statistics, nothing else: the
   * datasets marked `ownContent` (posts, attachments, files, vault, their
   * views and likes, capture coverage, sync streams) with this capability
   * ALONE — no `read:datasets`, so no thread inventory, fans, purchases or
   * money. The ContentOps key's narrow right (owner 2026-10-29).
   */
  "read:content",
  /**
   * The team's work and the facts of every sale on the key's pages: who held
   * the page, the bought PPV's sender, post tips and Campaign, the last
   * writer, the chatters' marks and the owner's split (`agentTeamSales`).
   * The agency ledger's right (ledger release 2, owner 2026-11-09): whose a
   * sale is and what anyone is paid is the ledger's. Needs read:money too.
   */
  "read:team",
  /**
   * Taking a Hub post off the platform's schedule on the key's pages, any Hub
   * post there, not only this key's drafts (owner 2026-11-11: an agent may take
   * a post off the schedule at any time without asking): the owner's own
   * withdrawal, refusals and all, and the page's schedule read to see it.
   * Never a published post's deletion, never a whole page at once. With it a
   * key also takes off a post put in the schedule by hand, by the platform's
   * post id, once Hub's own fresh read of the page's schedule shows it.
   */
  "withdraw:publications",
  /**
   * Deleting a published post of the key's pages (owner 2026-11-11: only on the
   * owner's «да» for that post — the agent's rules hold that word, Hub does not
   * check it): a post Hub has among the page's own synced posts, never one still
   * in the schedule. A daily ceiling per key, one command per post, the agent's
   * reason in the owner's audit.
   */
  "delete:posts",
  /**
   * Looking at the page's own media: frames (≤ 512 px) of a file of a post in
   * the platform's schedule, pulled through the page's session at its pace —
   * never the file, never a link (owner 2026-11-11). Fansly only; a daily cap
   * per page; a fan's media is refused.
   */
  "look:media",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const AGENT_CAPABILITY_SET: ReadonlySet<string> = new Set(AGENT_CAPABILITIES);

/**
 * Boundary check for an UNVALIDATED capability name (it arrives from an issuance
 * request or from a stored row). Typed callers keep the literal union; only this
 * seam widens to `string`.
 */
export function isAgentCapability(value: string): value is AgentCapability {
  return AGENT_CAPABILITY_SET.has(value);
}
