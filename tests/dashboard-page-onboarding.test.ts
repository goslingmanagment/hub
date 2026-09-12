import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCredentialsBodySchema } from "@agency_hub_core/contracts";

// Drive the form's actual event handlers and async completions without a DOM.
// Hook slots and mutation promises are controlled; this does not exercise React
// effects, batching or unmount. Real interactions are checked in the browser.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const queries = vi.hoisted(() => ({ verify: vi.fn(), create: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof ReactModule>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAdminVerifyCredentials: () => ({ mutateAsync: queries.verify }),
  useAdminCreatePage: () => ({ mutateAsync: queries.create, isPending: false }),
}));

import { CreatePageModal } from "../apps/dashboard/src/pages/settings/CreatePageModal.tsx";
import {
  buildCredentialsBody,
  PlatformCredentialsFields,
  type PlatformCredentialsValues,
} from "../apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx";

type Element = ReactElement<Record<string, unknown>>;

function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const children: ReactNode[] = [node];
  while (children.length) {
    const child = children.shift();
    if (Array.isArray(child)) { children.push(...child); continue; }
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (matches(child)) return child;
    children.push(child.props.children as ReactNode);
  }
  throw new Error("Form control not found");
}

function renderForm() {
  hooks.cursor = 0;
  return CreatePageModal({
    models: [{ id: 1, slug: "model", name: "Model", pageCount: 0 }],
    onClose: vi.fn(),
  });
}

function button(label: string) {
  return find(renderForm(), element => element.type === "button" && element.props.children === label).props;
}

function changeCredential(field: keyof PlatformCredentialsValues, value: string) {
  const { onChange } = find(renderForm(), element => element.type === PlatformCredentialsFields).props;
  (onChange as (field: keyof PlatformCredentialsValues, value: string) => void)(field, value);
}

function selectOnlyFans() {
  const { onChange } = find(renderForm(), element => element.type === "input" && element.props.value === "onlyfans").props;
  (onChange as () => void)();
  changeCredential("onlyFansUsername", "alice");
}

function verify() {
  return (button("Verify Credentials").onClick as () => Promise<void>)();
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const verified = { valid: true, platform: "fansly", username: "alice", displayName: "Alice" };

describe("page onboarding credentials", () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.cursor = 0;
    queries.verify.mockReset();
    queries.create.mockReset();
    const label = find(renderForm(), element => element.type === "input" && element.props.placeholder === "e.g. alice-fansly");
    (label.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "alice-page" } });
    changeCredential("authorization", "token-a");
    changeCredential("proxyRaw", "socks5://proxy.example:1080");
  });

  it("verifies an OFAPI account by username, with no token or hidden Fansly proxy", async () => {
    changeCredential("proxyRaw", "invalid-hidden-proxy");
    selectOnlyFans();
    expect(button("Verify Credentials").disabled).toBe(false);
    queries.verify.mockResolvedValue({ ...verified, platform: "onlyfans" });
    await verify();
    expect(queries.verify).toHaveBeenCalledWith({ platform: "onlyfans", username: "alice" });
    expect(button("Create Page").disabled).toBe(false);
  });

  it.each(["credentials", "platform"])("discards a pending verification after changing %s", async (change) => {
    const first = deferred();
    queries.verify.mockReturnValueOnce(first.promise);
    const pending = verify();
    if (change === "platform") selectOnlyFans();
    else changeCredential("authorization", "token-b");
    first.resolve(verified);
    await pending;
    expect(button("Create Page").disabled).toBe(true);
    queries.verify.mockResolvedValue({ ...verified, platform: change === "platform" ? "onlyfans" : "fansly" });
    await verify();
    expect(button("Create Page").disabled).toBe(false);
  });

  it("does not replace a newer successful verification with an older failure", async () => {
    const first = deferred();
    queries.verify.mockReturnValueOnce(first.promise);
    const pending = verify();
    changeCredential("authorization", "token-b");
    queries.verify.mockResolvedValue(verified);
    await verify();
    first.reject(new Error("Old credential rejected"));
    await pending;
    expect(button("Create Page").disabled).toBe(false);
  });

  it("uses the existing OnlyFans contract without forwarding obsolete secrets", () => {
    const body = buildCredentialsBody({ platform: "onlyfans", values: {
      authorization: "hidden-fansly-secret", fanslyClientId: "", fanslyClientCheck: "", fanslySessionId: "",
      onlyFansToken: "obsolete-token", onlyFansUsername: " alice ", proxyRaw: "http://",
    } });
    expect(body).toEqual({ platform: "onlyfans", username: "alice" });
    expect(verifyCredentialsBodySchema.parse(body)).toEqual(body);
  });
});
