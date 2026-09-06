import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionDraftMatches, actionFieldValues, buildOfapiAction, createActionAdmissionRegistry, initialActionValues, isUncertainActionFailure, localActionDateTimeToIso, reviewActionFieldValue } from "../apps/dashboard/src/pages/ofapi-actions/form-values.ts";
import { KernelApiError } from "@kernel/sdk";
import { ofapiCollectionForms } from "../apps/dashboard/src/pages/ofapi-actions/collection-forms.ts";
import type { OfapiActionField } from "../apps/dashboard/src/pages/ofapi-actions/form-types.ts";

vi.mock("../apps/dashboard/src/api/ofapiActions.ts", () => ({ accountActions: {}, useOfapiActions: vi.fn() }));
vi.mock("../apps/dashboard/src/api/adminOfapiCollection.ts", () => ({ useAdminOfapiCollection: vi.fn() }));
import { OfapiActionCommandReview, OfapiActionFields } from "../apps/dashboard/src/pages/OfapiActions.tsx";

afterEach(() => vi.unstubAllEnvs());
const field = (name: string, type: OfapiActionField["type"], extra: Partial<OfapiActionField> = {}): OfapiActionField => ({ name, type, label: name, ...extra });
const renderFields = (fields: OfapiActionField[], values: Record<string, unknown>) => renderToStaticMarkup(createElement(OfapiActionFields, { fields, values, update: vi.fn(), disabled: false }));

describe("owner action form values and review", () => {
  it("initializes required false booleans without turning optional booleans into mutations", () => {
    const fields = [field("enabled", "boolean", { required: true }), field("optional", "boolean"), field("text", "textarea", { defaultValue: "" }), field("priceCents", "money", { defaultValue: 0 })];
    const values = initialActionValues(fields);
    expect(values).toEqual({ enabled: false, text: "", priceCents: 0 });
    expect(actionFieldValues(fields, values)).toEqual({ enabled: false, text: "", priceCents: 0 });
    expect(actionFieldValues(fields, { optional: false })).toEqual({ optional: false });
  });

  it("separates omitted blank fields from an explicit empty list", () => {
    const fields = [field("mediaFiles", "strings"), field("numbers", "numbers"), field("money", "money-list"), field("texts", "rows"), field("text", "textarea", { defaultValue: "" })];
    expect(actionFieldValues(fields, { mediaFiles: " \n ", numbers: " ", money: "", text: "" })).toEqual({ text: "" });
    expect(actionFieldValues(fields, { mediaFiles: [], numbers: [], money: [], texts: [] })).toEqual({ mediaFiles: [], numbers: [], money: [], texts: [] });
    expect(actionFieldValues([field("countries", "strings", { required: true })], { countries: [] })).toEqual({ countries: [] });
  });

  it("converts exact USD values and refuses fractional-cent or overflowing input", () => {
    const fields = [field("amountCents", "money", { required: true })];
    for (const [value, cents] of [["0.29", 29], ["6,97", 697], ["6.97", 697], ["0", 0], ["90071992547409.91", Number.MAX_SAFE_INTEGER]] as const)
      expect(actionFieldValues(fields, { amountCents: value })).toEqual({ amountCents: cents });
    for (const value of ["", " ", "-1", "1.001", "1e3", "Infinity", "90071992547409.92"])
      expect(() => actionFieldValues(fields, { amountCents: value })).toThrow();
  });

  it("keeps decimal commas inside money-list amounts rather than silently splitting money", () => {
    const fields = [field("tips", "money-list")];
    expect(actionFieldValues(fields, { tips: "6,97\n3,00" })).toEqual({ tips: [697, 300] });
    expect(actionFieldValues(fields, { tips: "5.00, 10.00; 15" })).toEqual({ tips: [500, 1000, 1500] });
    expect(actionFieldValues(fields, { tips: ["5.00", "10"] })).toEqual({ tips: [500, 1000] });
    expect(() => actionFieldValues(fields, { tips: "5.000" })).toThrow();
  });

  it("preserves typed select values and rejects unlisted or malformed numbers", () => {
    const fields = [field("choice", "select", { options: [{ label: "Нет", value: false }, { label: "Ноль", value: 0 }] }), field("count", "number", { required: true }), field("sizes", "numbers")];
    expect(actionFieldValues(fields, { choice: "false", count: "0", sizes: "10, 20\n30" })).toEqual({ choice: false, count: 0, sizes: [10, 20, 30] });
    expect(actionFieldValues(fields, { choice: "0", count: "-2.5" })).toEqual({ choice: 0, count: -2.5 });
    for (const count of ["", " ", "0x10", "Infinity", "NaN", "1e3"]) expect(() => actionFieldValues(fields, { count })).toThrow();
    expect(() => actionFieldValues(fields, { choice: "not-listed", count: "1" })).toThrow();
  });

  it("builds nested story rows using each child's declared type and rejects invalid row shapes", () => {
    const fields = [field("texts", "rows", { fields: [field("text", "text", { required: true }), field("fontWeight", "select", { options: [{ value: 400, label: "Обычный" }] }), field("top", "number"), field("enabled", "boolean")] })];
    expect(actionFieldValues(fields, { texts: [{ text: "Hi", fontWeight: "400", top: "0", enabled: false, injected: "ignored" }] })).toEqual({ texts: [{ text: "Hi", fontWeight: 400, top: 0, enabled: false }] });
    for (const texts of ["[]", {}, [null], [[]]]) expect(() => actionFieldValues(fields, { texts })).toThrow();
  });

  it("converts local schedules to UTC and rejects calendar normalization", () => {
    vi.stubEnv("TZ", "UTC");
    expect(localActionDateTimeToIso("2026-09-06T12:34:56")).toBe("2026-09-06T12:34:56.000Z");
    expect(localActionDateTimeToIso("2028-02-29T12:34")).toBe("2028-02-29T12:34:00.000Z");
    for (const value of ["2026-02-29T12:00", "2026-02-30T12:00", "2026-09-06T24:00", "2026-09-06", "2026-09-06T12:00Z", "nonsense"]) expect(() => localActionDateTimeToIso(value)).toThrow();
  });

  it("rejects a nonexistent DST hour rather than scheduling one hour later", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(() => localActionDateTimeToIso("2026-03-08T02:30")).toThrow();
    expect(localActionDateTimeToIso("2026-03-08T03:30")).toBe("2026-03-08T07:30:00.000Z");
  });

  it("keeps request IDs stable through lost responses, edits and page switches until explicit new intent", () => {
    const createId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("edited").mockReturnValueOnce("other-page").mockReturnValueOnce("new-explicit");
    const registry = createActionAdmissionRegistry(createId);
    const command = { action: "user_block", pageId: 7, userId: "8" };
    expect(registry.forCommand(command)).toBe("first");
    expect(registry.forCommand(structuredClone(command))).toBe("first"); // Retrying after a lost response.
    expect(registry.forCommand({ ...command, userId: "9" })).toBe("edited");
    expect(registry.forCommand({ ...command, pageId: 9 })).toBe("other-page");
    expect(registry.forCommand(command)).toBe("first"); // Editing back or returning to the original page.
    registry.startNew(command);
    expect(registry.forCommand(command)).toBe("new-explicit");
    expect(createId).toHaveBeenCalledTimes(4);
  });

  it("recovers lost or unreadable responses without trapping a definite kernel refusal", () => {
    expect(isUncertainActionFailure(new KernelApiError("Forbidden", "auth", 403, null, null))).toBe(false);
    expect(isUncertainActionFailure(new KernelApiError("Conflict", "conflict", 409, null, null))).toBe(false);
    expect(isUncertainActionFailure(new KernelApiError("Network", "network", null, null, null))).toBe(true);
    expect(isUncertainActionFailure(new KernelApiError("Unreadable", "contract", 200, null, null))).toBe(true);
    expect(isUncertainActionFailure(new KernelApiError("Server", "server", 503, null, null))).toBe(true);
    expect(isUncertainActionFailure(new Error("Lost response"))).toBe(true);
  });

  it("binds drafts to the real schema and detects changes without mutating the reviewed command", () => {
    const form = ofapiCollectionForms.find(form => form.action === "user_list_update")!;
    const values = { listId: "7", name: "Chosen list", isPinnedToFeed: "false" };
    const command = buildOfapiAction(form, 3, { ...values, path: "/users/8/subscribe" });
    expect(command).toEqual({ action: "user_list_update", pageId: 3, listId: "7", name: "Chosen list", isPinnedToFeed: false });
    expect(actionDraftMatches(form, 3, values, command)).toBe(true);
    expect(actionDraftMatches(form, 4, values, command)).toBe(false);
    expect(actionDraftMatches(form, 3, { ...values, name: "Edited list" }, command)).toBe(false);
    expect(actionDraftMatches(form, 3, { ...values, listId: "../escape" }, command)).toBe(false);
    expect(command).toMatchObject({ pageId: 3, name: "Chosen list" });
  });

  it("renders frozen money as USD, nested labels as labels and escaped text as text", () => {
    const fields = [field("priceCents", "money", { label: "Цена" }), field("tips", "money-list", { label: "Чаевые" }), field("texts", "rows", { label: "Надписи", fields: [field("text", "text", { label: "Текст" }), field("fontWeight", "select", { label: "Шрифт", options: [{ value: 400, label: "Обычный" }] })] })];
    const html = renderToStaticMarkup(createElement(OfapiActionCommandReview, { fields, command: { priceCents: 697, tips: [500, 1000], texts: [{ text: "<script>bad()</script>", fontWeight: 400 }] } }));
    expect(html).toContain("6,97 USD"); expect(html).toContain("5,00 USD"); expect(html).toContain("10,00 USD");
    expect(html).not.toContain(">697<"); expect(html).not.toContain("fontWeight"); expect(html).toContain("Обычный");
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(reviewActionFieldValue(field("empty", "strings"), [])).toEqual([]);
  });

  it("lets the owner explicitly clear required lists without a browser-required-field dead end", () => {
    const fields = [field("blockedCountries", "strings", { required: true, label: "Страны" })];
    const empty = renderFields(fields, { blockedCountries: [] });
    expect(empty).toContain("Передать пустой список");
    expect(empty).not.toMatch(/<textarea[^>]*required/);
    expect(empty).toMatch(/<input[^>]*checked=""/);
    expect(renderFields(fields, {})).toMatch(/<textarea[^>]*required=""/);
  });

  it("renders boolean, numeric-option, list-option, date and nested-row inputs without JSON editing", () => {
    const fields = [field("enabled", "boolean", { required: true }), field("optional", "boolean"), field("types", "strings", { options: [{ value: "post", label: "Посты" }] }), field("date", "datetime"), field("texts", "rows", { fields: [field("text", "text", { required: true, label: "Текст надписи" })] })];
    const html = renderFields(fields, { ...initialActionValues(fields), types: ["post"], texts: [{ text: "Hello" }] });
    expect(html).toContain('type="datetime-local"'); expect(html).toContain("Часовой пояс:");
    expect(html).toContain("Не изменять / по умолчанию"); expect(html).toContain("Посты");
    expect(html).toContain("Текст надписи"); expect(html).toContain("Добавить строку"); expect(html).toContain("Убрать строку 1");
    expect(html).not.toContain("JSON");
  });
});
