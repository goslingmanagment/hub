// AI media describer page policies (AI_MEDIA_DESCRIBE_PAGE_POLICIES).
//
// JSON keyed by EXACT page label: {"since": ISO, "until"?: ISO}. Fails closed:
// a malformed document, a missing or unparsable `since`, or an `until` not
// after `since` grants nothing for that page.
//
// `since` is the enable boundary (plan §3): only messages newer than it are
// ever described; the first generation or a replayed projection never starts
// a historical pass. `until` ends new describe calls (a canary window); the
// descriptions already made keep serving prompts.

export interface AiMediaDescribePagePolicy {
  since: Date;
  until: Date | null;
}

export type AiMediaDescribePagePolicies = ReadonlyMap<string, AiMediaDescribePagePolicy>;

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseAiMediaDescribePagePolicies(raw: string | null | undefined): AiMediaDescribePagePolicies {
  const policies = new Map<string, AiMediaDescribePagePolicy>();
  if (!raw) {
    return policies;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return policies;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return policies;
  }
  for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const since = parseInstant(record.since);
    if (!since) {
      continue;
    }
    const hasUntil = record.until !== undefined && record.until !== null;
    const until = hasUntil ? parseInstant(record.until) : null;
    if (hasUntil && (until === null || until.getTime() <= since.getTime())) {
      continue;
    }
    policies.set(label, { since, until });
  }
  return policies;
}

export interface AiMediaDescribeSwitches {
  aiMediaDescribeEnabled?: boolean;
  aiMediaDescribePagePolicies?: string;
}

/** The page may show image notes in prompts (master switch + a policy). */
export function aiMediaNotesPolicyForPage(
  config: AiMediaDescribeSwitches,
  pageLabel: string,
): AiMediaDescribePagePolicy | null {
  if (config.aiMediaDescribeEnabled !== true) {
    return null;
  }
  return parseAiMediaDescribePagePolicies(config.aiMediaDescribePagePolicies).get(pageLabel) ?? null;
}

/** New describe calls are allowed for the page at `now`. */
export function isAiMediaDescribeWindowOpen(policy: AiMediaDescribePagePolicy, now: Date) {
  return now.getTime() >= policy.since.getTime()
    && (policy.until === null || now.getTime() < policy.until.getTime());
}

/** A message is inside the enable boundary (strictly newer than `since`). */
export function isAfterAiMediaDescribeBoundary(policy: AiMediaDescribePagePolicy, messageAt: Date | null) {
  return messageAt !== null && messageAt.getTime() > policy.since.getTime();
}
