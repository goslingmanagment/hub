import {
  listFanslySendGuards,
  readFanslySendReport,
  type Database,
  type FanslySendPaceViolation,
} from "@agency_hub_core/db";

// `fansly-send-guard report --since <ISO> [--page <label>]` — the acceptance
// report of the legacy engine's send guard (plan §2.5 p.3 (b), §15 step 1; one
// hour of production by the owner's decision). Everything comes from the
// journal of guarded attempts (fansly_send_log), every source and process, in
// one READ ONLY transaction. Per page:
//
//   - sends and attempts, by source;
//   - pace: the smallest gap between consecutive actual sends (`sent_at`) and
//     the setting in force for the later one, and the number of pairs closer
//     than their setting — the acceptance needs 0;
//   - the guard's triggers: attempts it made wait (capture refused at least
//     once) plus dispatches it refused — the acceptance needs a non-zero count,
//     or the window proves nothing about the guard;
//   - outcomes and the HTTP status histogram (429 / 401 / 403 called out);
//   - closed periods: attempts held past their lease, from the lease end to
//     their completion or confirmed termination (or still closed).

export const FANSLY_SEND_REPORT_VIOLATION_LIMIT = 50;

export interface FanslySendGuardReportPage {
  page: string | null;
  pageId: number;
  attempts: number;
  sends: number;
  inFlight: number;
  sources: Record<string, { attempts: number; sends: number }>;
  pace: {
    pairs: number;
    pairsCloserThanSetting: number;
    minGapMs: number | null;
    minGapSettingMs: number | null;
    minGapAt: string | null;
    settingMsMin: number | null;
    settingMsMax: number | null;
  };
  guard: {
    /** attemptsThatWaited + sendRefusals: how often the guard held a sender back. */
    triggers: number;
    attemptsThatWaited: number;
    captureRefusals: number;
    sendRefusals: number;
    captureWaitMsTotal: number;
    captureWaitMsMax: number;
  };
  outcomes: Record<string, number>;
  httpStatus: Record<string, number>;
  http429: number;
  http401: number;
  http403: number;
  closedPeriods: Array<{
    from: string;
    until: string | null;
    holder: string;
    source: string;
    operation: string;
    outcome: string | null;
    outcomeDetail: string | null;
    holderToken: string;
  }>;
  closedNow: boolean;
}

export interface FanslySendGuardReport {
  since: string;
  until: string;
  pages: FanslySendGuardReportPage[];
  /** The pairs closer than their setting, earliest first (at most 50). */
  violations: Array<{
    page: string | null;
    gapMs: number;
    settingMs: number;
    earlier: { id: number; sentAt: string; source: string; operation: string; holder: string };
    later: { id: number; sentAt: string; source: string; operation: string; holder: string };
  }>;
  /** Checks of an unknown session (onboarding, credentials verify): journaled,
   *  paced against no page (owner decision №4). */
  unpacedAttempts: number;
  verdict: {
    pairsCloserThanSetting: number;
    guardTriggers: number;
    http429: number;
    http401: number;
    http403: number;
    closedPeriods: number;
    /** 0 pairs closer than the setting. */
    paceHeld: boolean;
    /** The guard held a sender back at least once (otherwise the window
     *  proves nothing about it). */
    guardTriggered: boolean;
    /** No 429, 401 or 403. */
    noRejections: boolean;
  };
}

function violationView(violation: FanslySendPaceViolation): FanslySendGuardReport["violations"][number] {
  const side = (send: FanslySendPaceViolation["earlier"]) => ({
    id: send.id,
    sentAt: send.sentAt.toISOString(),
    source: send.source,
    operation: send.operation,
    holder: `${send.holderRole}@${send.holderHost}`,
  });
  return {
    page: violation.pageLabel,
    gapMs: Math.floor(violation.gapMs),
    settingMs: violation.settingMs,
    earlier: side(violation.earlier),
    later: side(violation.later),
  };
}

export async function buildFanslySendGuardReport(
  db: Database,
  input: { since: Date; pageLabel: string | null },
): Promise<FanslySendGuardReport> {
  const { data, guards } = await db.transaction(async (tx) => {
    const readOnly = tx as unknown as Database;
    return {
      data: await readFanslySendReport(readOnly, {
        since: input.since,
        pageLabel: input.pageLabel,
        violationLimit: FANSLY_SEND_REPORT_VIOLATION_LIMIT,
      }),
      guards: await listFanslySendGuards(readOnly),
    };
  }, { accessMode: "read only" });
  if (input.pageLabel !== null && data.pages.length === 0) {
    throw new Error(`No Fansly page "${input.pageLabel}" has a send guard`);
  }

  const closedNow = new Set(guards.filter((row) => row.holderToken !== null && row.leaseExpired).map((row) => row.pageId));
  const pages = data.pages.map((page): FanslySendGuardReportPage => {
    const attempts = data.attempts.find((row) => row.pageId === page.pageId);
    const gaps = data.gaps.find((row) => row.pageId === page.pageId);
    const sources: FanslySendGuardReportPage["sources"] = {};
    for (const row of data.sources) {
      if (row.pageId === page.pageId) sources[row.source] = { attempts: row.attempts, sends: row.sends };
    }
    const outcomes: Record<string, number> = {};
    const httpStatus: Record<string, number> = {};
    for (const row of data.outcomes) {
      if (row.pageId !== page.pageId) continue;
      const outcome = row.outcome ?? "in_flight";
      outcomes[outcome] = (outcomes[outcome] ?? 0) + row.attempts;
      if (row.httpStatus !== null) {
        const status = String(row.httpStatus);
        httpStatus[status] = (httpStatus[status] ?? 0) + row.attempts;
      }
    }
    const attemptsThatWaited = attempts?.attemptsThatWaited ?? 0;
    const sendRefusals = attempts?.sendRefusals ?? 0;
    return {
      page: page.pageLabel,
      pageId: page.pageId,
      attempts: attempts?.attempts ?? 0,
      sends: attempts?.sends ?? 0,
      inFlight: attempts?.inFlight ?? 0,
      sources,
      pace: {
        pairs: gaps?.pairs ?? 0,
        pairsCloserThanSetting: gaps?.pairsCloserThanSetting ?? 0,
        minGapMs: gaps?.minGapMs === null || gaps?.minGapMs === undefined ? null : Math.floor(gaps.minGapMs),
        minGapSettingMs: gaps?.minGapSettingMs ?? null,
        minGapAt: gaps?.minGapAt?.toISOString() ?? null,
        settingMsMin: attempts?.settingMsMin ?? null,
        settingMsMax: attempts?.settingMsMax ?? null,
      },
      guard: {
        triggers: attemptsThatWaited + sendRefusals,
        attemptsThatWaited,
        captureRefusals: attempts?.captureRefusals ?? 0,
        sendRefusals,
        captureWaitMsTotal: attempts?.captureWaitMsTotal ?? 0,
        captureWaitMsMax: attempts?.captureWaitMsMax ?? 0,
      },
      outcomes,
      httpStatus,
      http429: httpStatus["429"] ?? 0,
      http401: httpStatus["401"] ?? 0,
      http403: httpStatus["403"] ?? 0,
      closedPeriods: data.closedPeriods
        .filter((row) => row.pageId === page.pageId)
        .map((row) => ({
          from: row.closedFrom.toISOString(),
          until: row.closedUntil?.toISOString() ?? null,
          holder: `${row.holderRole}@${row.holderHost} pid ${row.holderPid}`,
          source: row.source,
          operation: row.operation,
          outcome: row.outcome,
          outcomeDetail: row.outcomeDetail,
          holderToken: row.guardToken,
        })),
      closedNow: closedNow.has(page.pageId),
    };
  });

  const sum = (pick: (page: FanslySendGuardReportPage) => number) => pages.reduce((total, page) => total + pick(page), 0);
  const pairsCloserThanSetting = sum((page) => page.pace.pairsCloserThanSetting);
  const guardTriggers = sum((page) => page.guard.triggers);
  const http429 = sum((page) => page.http429);
  const http401 = sum((page) => page.http401);
  const http403 = sum((page) => page.http403);
  return {
    since: data.since.toISOString(),
    until: data.until.toISOString(),
    pages,
    violations: data.violations.map(violationView),
    unpacedAttempts: data.unpacedAttempts,
    verdict: {
      pairsCloserThanSetting,
      guardTriggers,
      http429,
      http401,
      http403,
      closedPeriods: sum((page) => page.closedPeriods.length),
      paceHeld: pairsCloserThanSetting === 0,
      guardTriggered: guardTriggers > 0,
      noRejections: http429 + http401 + http403 === 0,
    },
  };
}
