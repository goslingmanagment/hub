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
