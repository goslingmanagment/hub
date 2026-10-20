import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";

// The owner's password and 2FA code on the dashboard's side (Project Browser
// PR 15; Astra's review, item 1): React Query keeps a mutation's arguments
// (`state.variables`) in the client's mutation cache for its gcTime — 300 s
// after the page is gone — so the form's steps go straight to the API, and
// nothing of what was typed stays in the query client. The real QueryClient
// (the dashboard's copy of @tanstack/react-query), the API client mocked.

const sdk = vi.hoisted(() => ({
  pageBrowserLoginSubmit: vi.fn(),
  pageBrowserLoginCode: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

// A dashboard module first: tsc must reach @tanstack/react-query through its bare
// import (resolved to the real pnpm path, where query-core sits beside it) before
// the relative node_modules path below, or its query-core re-exports go missing.
import { pageBrowserLoginKey, sendPageBrowserLoginStep } from "../apps/dashboard/src/api/pageBrowser.ts";
import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const LOGIN = "pb15-dash-login-4e7a1c";
const PASSWORD = "pb15-dash-password-9b2f6d03";
const CODE = "730518";
/** The code Fansly e-mailed for a login from a new device (owner decision 2026-10-15). */
const EMAIL_CODE = "pb-email-code-48c1e2";
const MARKERS = [LOGIN, PASSWORD, CODE, EMAIL_CODE];

const ANSWER: PageBrowserLoginStepResponse = { screen: { screen: "code", screenVersion: "fansly-login/1", fields: ["code"], siteError: null }, refused: null, unreachable: false };

/** Everything the query client holds: its mutations and its queries. */
function held(qc: QueryClient): string {
  const mutations = qc.getMutationCache().getAll().map((mutation) => ({ state: mutation.state, key: mutation.options.mutationKey ?? null }));
  const queries = qc.getQueryCache().getAll().map((query) => ({ key: query.queryKey, state: query.state }));
  return JSON.stringify({ mutations, queries });
}

beforeEach(() => {
  sdk.pageBrowserLoginSubmit.mockReset().mockResolvedValue(ANSWER);
  sdk.pageBrowserLoginCode.mockReset().mockResolvedValue({ ...ANSWER, screen: { ...ANSWER.screen!, screen: "success", fields: [] } });
});

describe("the login form's steps and the query client (Astra's review of PR 15, item 1)", () => {
  it("the form's steps go straight to the API: nothing of what was typed in the client — answered, refused or failed", async () => {
    const qc = new QueryClient();
    // The login's state is in the client, as the open page reads it.
    qc.setQueryData(pageBrowserLoginKey("lilly-1"), { login: { state: "wanted" } });
    expect(await sendPageBrowserLoginStep(qc, "lilly-1", { kind: "submit", login: LOGIN, password: PASSWORD })).toEqual(ANSWER);
    expect(sdk.pageBrowserLoginSubmit).toHaveBeenCalledWith({ params: { pageLabel: "lilly-1" }, body: { login: LOGIN, password: PASSWORD } });
    expect(await sendPageBrowserLoginStep(qc, "lilly-1", { kind: "code", code: CODE })).toMatchObject({ screen: { screen: "success" } });
    expect(sdk.pageBrowserLoginCode).toHaveBeenCalledWith({ params: { pageLabel: "lilly-1" }, body: { code: CODE } });
    // The code from the e-mail of a new device's login goes the same way.
    sdk.pageBrowserLoginCode.mockResolvedValueOnce({ ...ANSWER, screen: { ...ANSWER.screen!, screen: "error", siteError: "2FA code is invalid or already used.", codeFrom: "email" } });
    expect(await sendPageBrowserLoginStep(qc, "lilly-1", { kind: "code", code: EMAIL_CODE })).toMatchObject({ screen: { screen: "error", codeFrom: "email" } });
    expect(sdk.pageBrowserLoginCode).toHaveBeenLastCalledWith({ params: { pageLabel: "lilly-1" }, body: { code: EMAIL_CODE } });
    // A failed step: no retry, and nothing kept either.
    sdk.pageBrowserLoginCode.mockRejectedValueOnce(new Error("the API cannot be reached"));
    await expect(sendPageBrowserLoginStep(qc, "lilly-1", { kind: "code", code: CODE })).rejects.toThrow("cannot be reached");
    expect(sdk.pageBrowserLoginCode).toHaveBeenCalledTimes(3);

    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    const text = held(qc);
    for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
    // The login's state is read anew after each step.
    expect(qc.getQueryCache().find({ queryKey: pageBrowserLoginKey("lilly-1") })?.state.isInvalidated).toBe(true);
  });
});
