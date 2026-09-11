import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfapiActionIntent } from "../packages/contracts/src/index.ts";
import { acknowledgeActionCustody, actionCustodyKey, parseActionCustody, readActionCustody, saveActionCustody, settleActionCustody } from "../apps/dashboard/src/lib/ofapiActionCustody.ts";
const request = { id: "bbbbbbbb-0000-4000-8000-000000000001", pageId: 2, label: "Блокировка фана", operation: "dispatch", command: { pageId: 2, action: "user_block", userId: "12345" } };
const encode = (value = request, ownerId = 1) => JSON.stringify({ version: 1, ownerId, request: value });
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  return values;
}
const result = (state: OfapiActionIntent["state"]) => ({ ...request, command: { pageId: 2, action: "user_block" as const, userId: "12345" }, state });
describe("OnlyFans action reload custody", () => {
  it("restores exactly the same action identity and command for explicit recovery", () => {
    expect(parseActionCustody(encode(), 1)).toEqual(request);
    expect(parseActionCustody(null, 1)).toBeNull();
    expect(actionCustodyKey(1)).not.toBe(actionCustodyKey(2));
  });
  it("refuses a different owner, malformed record, or changed account binding", () => {
    expect(() => parseActionCustody(encode(), 2)).toThrow();
    expect(() => parseActionCustody("broken", 1)).toThrow();
    expect(() => parseActionCustody("null", 1)).toThrow();
    expect(() => parseActionCustody(encode({ ...request, pageId: 3 }), 1)).toThrow();
    expect(() => parseActionCustody(encode({ ...request, command: { ...request.command, userId: "not-a-user-id" } }), 1)).toThrow();
  });
  it.each(["dispatching", "indeterminate"] as const)("keeps a 200 %s receipt after reload and repeated GET", state => {
    storage();
    saveActionCustody(1, parseActionCustody(encode(), 1)!);
    settleActionCustody(1, result(state), request.label);
    expect(readActionCustody(1)).toMatchObject({ ...request, outcome: state });
    settleActionCustody(1, result(state), request.label);
    expect(readActionCustody(1)?.id).toBe(request.id);
    if (state === "dispatching") expect(() => acknowledgeActionCustody(1, request.id)).toThrow();
  });
  it("only closes the matching terminal result and preserves a different unresolved action", () => {
    storage();
    saveActionCustody(1, parseActionCustody(encode(), 1)!);
    settleActionCustody(1, { ...result("confirmed"), id: "bbbbbbbb-0000-4000-8000-000000000002" }, request.label);
    expect(readActionCustody(1)?.id).toBe(request.id);
    settleActionCustody(1, result("confirmed"), request.label);
    expect(readActionCustody(1)).toBeNull();
  });
  it("archives an explicitly reviewed unknown outcome before permitting a new action", () => {
    const values = storage();
    settleActionCustody(1, result("indeterminate"), request.label);
    acknowledgeActionCustody(1, request.id);
    expect(readActionCustody(1)).toBeNull();
    expect(JSON.parse(values.get(`${actionCustodyKey(1)}:reviewed:${request.id}`)!).request.command).toEqual(request.command);
  });
});
