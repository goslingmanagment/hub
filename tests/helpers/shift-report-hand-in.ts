import { shiftReportConfirmResponseSchema, shiftReportResponseSchema, type ShiftReportResponse } from "@agency_hub_core/contracts";
import { expect } from "vitest";

import { readShiftReport, submitShiftReport, type HandinPersonActor } from "../../apps/runtime/src/services/shift-handins.ts";
import { confirmShiftReport, reopenShiftReport } from "../../apps/runtime/src/services/shift-report-board.ts";

/**
 * The «Отчёт» board (package R): «Сдать смену» records a candidate, «Подтверждаю» makes the version. What the tests of
 * the reports and the claims did with one «Сдать смену» is these two presses (and «Исправить» first when the report is
 * counted or waits for its confirmation), through the routes or the service.
 */

type Inject = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  Promise<{ statusCode: number; body: string; json(): unknown }>;

export async function handInAndConfirm(asSession: Inject, who: string, shiftId: number): Promise<ShiftReportResponse> {
  const before = shiftReportResponseSchema.parse((await asSession(who, "GET", `/api/v1/shift-reports/${shiftId}`)).json());
  if (before.board?.phase === "counted" || before.board?.phase === "confirm") {
    const reopened = await asSession(who, "POST", `/api/v1/shift-reports/${shiftId}/reopen`);
    expect(reopened.statusCode, reopened.body).toBe(200);
  }
  const handed = await asSession(who, "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(handed.statusCode, handed.body).toBe(200);
  const candidateId = shiftReportResponseSchema.parse(handed.json()).board?.candidate?.id;
  expect(candidateId).toBeDefined();
  const confirmed = await asSession(who, "POST", `/api/v1/shift-reports/${shiftId}/confirm`, { candidateId: candidateId! });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const answer = shiftReportConfirmResponseSchema.parse(confirmed.json());
  expect(answer.confirmed, JSON.stringify(answer.refused)).toBe(true);
  return answer.report;
}

type BoardApp = Parameters<typeof submitShiftReport>[0];

export async function handInAndConfirmDirect(
  app: BoardApp,
  actor: HandinPersonActor,
  input: { shiftId: number },
  options: Parameters<typeof confirmShiftReport>[3] = {},
): Promise<ShiftReportResponse> {
  const before = await readShiftReport(app, actor, input.shiftId);
  if (before.board?.phase === "counted" || before.board?.phase === "confirm") await reopenShiftReport(app, actor, input);
  const handed = await submitShiftReport(app, actor, input);
  const candidateId = handed.board?.candidate?.id;
  expect(candidateId).toBeDefined();
  const answer = await confirmShiftReport(app, actor, { shiftId: input.shiftId, candidateId: candidateId! }, options);
  expect(answer.confirmed, JSON.stringify(answer.refused)).toBe(true);
  return answer.report;
}

/**
 * On the board ticks and «чья» change only while the report is edited: a counted report (or one that waits for its
 * confirmation) is reopened first with «Исправить», as the person does. Wraps a test's session caller.
 */
export function editingSession<T extends Inject>(asSession: T): T {
  return (async (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) => {
    const line = /^\/api\/v1\/shift-reports\/(\d+)\/lines\//.exec(url);
    if (method === "PUT" && line !== null) {
      const report = shiftReportResponseSchema.safeParse((await asSession(who, "GET", `/api/v1/shift-reports/${line[1]}`)).json());
      const phase = report.success ? report.data.board?.phase : undefined;
      if (phase === "counted" || phase === "confirm") await asSession(who, "POST", `/api/v1/shift-reports/${line[1]}/reopen`);
    }
    return asSession(who, method, url, payload);
  }) as T;
}

