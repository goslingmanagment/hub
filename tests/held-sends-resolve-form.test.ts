import { describe, expect, it } from "vitest";

import { EMPTY_RESOLVE_DRAFT, resolveFailure, resolveForm, type ResolveDraft } from "../packages/ui/src/heldSends.ts";
import { KernelApiError } from "../packages/sdk/src/index.ts";

// «Разобрать отправку» (chat-extension H-7e, Workboard's Решения): the resolve as
// the form builds it. What the hub answers is tests/client-held-sends.integration.test.ts.

describe("the resolve form of a held send", () => {
  const draft = (overrides: Partial<ResolveDraft>): ResolveDraft => ({ ...EMPTY_RESOLVE_DRAFT, ...overrides });

  it("preselects no answer and sends nothing until there is an outcome and a reason", () => {
    expect(EMPTY_RESOLVE_DRAFT).toEqual({ outcome: null, platformMessageId: "", note: "" });
    expect(resolveForm(EMPTY_RESOLVE_DRAFT)).toEqual({
      body: null, platformMessageIdError: null, noteLeft: 500, missing: "Выберите, ушло сообщение или нет.",
    });
    // A reason typed first does not choose an outcome for the person.
    expect(resolveForm(draft({ note: "видел в чате" })).body).toBeNull();
    for (const outcome of ["sent", "not_sent"] as const) {
      expect(resolveForm(draft({ outcome }))).toMatchObject({ body: null, missing: "Напишите, почему вы так решили." });
      expect(resolveForm(draft({ outcome, note: "   \n " }))).toMatchObject({ body: null, missing: "Напишите, почему вы так решили." });
    }
    expect(resolveForm(draft({ outcome: "not_sent", note: "в чате пусто" })).body).toEqual({ outcome: "not_sent", note: "в чате пусто" });
  });

  it("says a send the extension already reported is gone, with nothing recorded", () => {
    const refusal = new KernelApiError("conflict", "conflict", 409, "conflict", {
      error: "conflict", message: "The send attempt is not held", statusCode: 409, reason: "custody_not_held",
    });
    expect(resolveFailure(refusal, draft({ outcome: "not_sent" }))).toEqual({
      message: "Разбирать уже нечего: расширение само сообщило, чем закончилась отправка. Ничего не записано, список обновлён.",
      gone: true,
    });
  });
});
