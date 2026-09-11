import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser, AssignedPage } from "@agency_hub_core/contracts";

// Exercise real event handlers against deferred requests. Browser focus and
// native disabled controls are covered by the shared modal and visual QA.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
const queries = vi.hoisted(() => ({
  useAdminPages: vi.fn(), useAdminUsers: vi.fn(), useAdminUserApiKeys: vi.fn(),
  useAdminSetPassword: vi.fn(), useAdminAssignPage: vi.fn(), useAdminUnassignPage: vi.fn(),
  createUser: vi.fn(), setPassword: vi.fn(), assignPage: vi.fn(), unassignPage: vi.fn(),
  createAgent: vi.fn(), issueKey: vi.fn(), useIssuedUserApiKeys: vi.fn(),
}));
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
  useId: () => "synthetic-page-selection",
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [navigation.search, (next: (previous: URLSearchParams) => URLSearchParams) => { navigation.search = next(navigation.search); }],
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAdminPages: queries.useAdminPages,
  useAdminUsers: queries.useAdminUsers,
  useAdminUserApiKeys: queries.useAdminUserApiKeys,
  useAdminCreateUser: () => ({ mutateAsync: queries.createUser, isPending: false }),
  useAdminSetPassword: queries.useAdminSetPassword,
  useAdminAssignPage: queries.useAdminAssignPage,
  useAdminUnassignPage: queries.useAdminUnassignPage,
  useIssuedUserApiKeys: queries.useIssuedUserApiKeys,
  useAdminIssueApiKey: () => ({ mutateAsync: queries.issueKey, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddChatterModal, ChatterDetailModal, CreateUserModal, KeyRevealModal, UsersTab } from "../apps/dashboard/src/pages/settings/UsersTab.tsx";
import { CreateAgentKeyModal, TokenRevealModal } from "../apps/dashboard/src/pages/settings/AgentKeysTab.tsx";
import { PageAssignmentsEditor } from "../apps/dashboard/src/pages/settings/PageAssignmentsEditor.tsx";
import { UserPageAssignmentModal } from "../apps/dashboard/src/pages/settings/UserPageAssignmentModal.tsx";

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const child = queue.shift();
    if (Array.isArray(child)) { queue.push(...child); continue; }
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (matches(child)) return child;
    queue.push(child.props.children as ReactNode);
  }
  throw new Error("Control not found");
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render<T>(component: (props: T) => ReactNode, props: T) { hooks.cursor = 0; return component(props); }
function change(element: Element, value: string) { (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function click(element: Element) { return (element.props.onClick as () => Promise<void> | void)(); }
function submit(tree: ReactNode) { return (find(tree, (element) => element.type === "form").props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() }); }
function close(tree: ReactNode) { (find(tree, (element) => typeof element.props.onClose === "function").props.onClose as () => void)(); }
function assignments(tree: ReactNode) { return find(tree, (element) => element.type === PageAssignmentsEditor); }
function selectPage(tree: ReactNode, value: string) { (assignments(tree).props.onSelectedLabelChange as (value: string) => void)(value); }
function assign(tree: ReactNode) { return (assignments(tree).props.onAssign as () => Promise<void>)(); }
function unassign(tree: ReactNode) { return (assignments(tree).props.onUnassign as (pageLabel: string) => Promise<void>)("already-assigned"); }
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const page: AssignedPage = {
  id: 1, label: "synthetic-page", platform: "fansly", modelSlug: "synthetic-model", modelName: "Synthetic Model",
  username: null, displayName: null, subscriberCount: { value: 0, available: true },
  followerCount: { value: null, available: false }, lastLightSyncAt: null, lastFollowerSyncAt: null,
};
const user: AdminUser = { id: 7, username: "synthetic-chatter", role: "chatter", mustChangePassword: false, assignedPages: [], apiKeyStatus: null, disabledAt: null, lastActiveAt: null };
const ready = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; navigation.search = new URLSearchParams();
  vi.resetAllMocks();
  queries.useAdminPages.mockReturnValue(ready([page]));
  queries.useAdminUsers.mockReturnValue(ready([user]));
  queries.useAdminUserApiKeys.mockReturnValue(ready([]));
  queries.useAdminSetPassword.mockReturnValue({ mutateAsync: queries.setPassword, isPending: false });
  queries.useAdminAssignPage.mockReturnValue({ mutateAsync: queries.assignPage, isPending: false });
  queries.useAdminUnassignPage.mockReturnValue({ mutateAsync: queries.unassignPage, isPending: false });
  queries.useIssuedUserApiKeys.mockReturnValue({ issued: [], pending: false, acknowledge: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("access forms preserve the target and remaining draft", () => {
  it("continues partially provisioned chatter setup without recreating the user or resetting the saved password", async () => {
    const onClose = vi.fn();
    const draw = () => render(AddChatterModal, { onClose });
    change(find(draw(), (element) => element.props.maxLength === 100), "new-chatter");
    change(find(draw(), (element) => element.props.type === "password"), "synthetic-password");
    change(find(draw(), (element) => element.type === "select"), page.label);
    const request = deferred();
    queries.assignPage.mockReturnValueOnce(request.promise);
    const beforeRequest = draw();
    const pending = submit(beforeRequest);
    await submit(beforeRequest);
    close(beforeRequest);
    await vi.waitFor(() => expect(queries.assignPage).toHaveBeenCalledTimes(1));
    expect(queries.createUser).toHaveBeenCalledTimes(1);
    expect(queries.setPassword).toHaveBeenCalledWith({ password: "synthetic-password", mustChangePassword: false });
    expect(find(draw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    request.reject(new Error("Assignment rejected"));
    await pending;
    expect(find(draw(), (element) => element.props.maxLength === 100).props).toMatchObject({ value: "new-chatter", disabled: true });
    expect(find(draw(), (element) => element.type === "select").props.value).toBe(page.label);
    expect(textOf(draw())).toContain("Пользователь new-chatter уже создан");
    expect(textOf(draw())).toContain("Assignment rejected");
    await submit(draw());
    expect(queries.createUser).toHaveBeenCalledTimes(1);
    expect(queries.setPassword).toHaveBeenCalledTimes(1);
    expect(queries.assignPage).toHaveBeenCalledTimes(2);
    expect(queries.useAdminAssignPage).toHaveBeenLastCalledWith("new-chatter");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("validates staff credentials, freezes them during creation and keeps a failed draft", async () => {
    const onClose = vi.fn();
    const draw = () => render(CreateUserModal, { onClose });
    change(find(draw(), (element) => element.props.maxLength === 100), "new-lead");
    change(find(draw(), (element) => element.props.type === "password"), "short");
    await submit(draw());
    expect(queries.createUser).not.toHaveBeenCalled();
    change(find(draw(), (element) => element.props.type === "password"), "synthetic-password");
    const request = deferred(); queries.createUser.mockReturnValue(request.promise);
    const pending = submit(draw());
    close(draw());
    await submit(draw());
    expect(queries.createUser).toHaveBeenCalledTimes(1);
    expect(find(draw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    request.reject(new Error("Username unavailable")); await pending;
    expect(find(draw(), (element) => element.props.type === "password").props.value).toBe("synthetic-password");
    expect(textOf(draw())).toContain("Username unavailable");
    expect(onClose).not.toHaveBeenCalled();
    change(find(draw(), (element) => element.type === "select"), "chatter");
    queries.createUser.mockResolvedValue({});
    await submit(draw());
    expect(queries.createUser).toHaveBeenLastCalledWith({ username: "new-lead", role: "chatter" });
  });

  it("serializes assignment changes and prevents close until the request settles", async () => {
    const onClose = vi.fn();
    const draw = () => render(UserPageAssignmentModal, { user, onClose });
    selectPage(draw(), page.label);
    const request = deferred(); queries.assignPage.mockReturnValue(request.promise);
    const before = draw(); const pending = assign(before);
    await assign(before); await unassign(before); close(before);
    expect(queries.assignPage).toHaveBeenCalledTimes(1);
    expect(queries.unassignPage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(assignments(draw()).props.disabled).toBe(true);
    request.reject(new Error("Assignment unavailable")); await pending;
    expect(assignments(draw()).props.selectedLabel).toBe(page.label);
    expect(textOf(draw())).toContain("Assignment unavailable");
  });

  it("keeps a selection visible but prevents assigning a page missing after refetch", async () => {
    const draw = () => render(UserPageAssignmentModal, { user, onClose: vi.fn() });
    selectPage(draw(), page.label);
    queries.useAdminPages.mockReturnValue(ready([]));
    const editor = assignments(draw());
    expect(editor.props.selectedLabel).toBe(page.label);
    await assign(draw()); expect(queries.assignPage).not.toHaveBeenCalled();
    hooks.values = [];
    const editorTree = render(PageAssignmentsEditor, editor.props as ReactModule.ComponentProps<typeof PageAssignmentsEditor>);
    expect(textOf(editorTree)).toContain("synthetic-page · сейчас недоступна");
    expect(find(editorTree, (element) => element.type === "button" && textOf(element) === "Назначить").props.disabled).toBe(true);
  });

  it("keeps password draft and blocks assignment, duplicate submit and deactivation while saving", async () => {
    const onClose = vi.fn(); const onDeactivate = vi.fn();
    const draw = () => render(ChatterDetailModal, { user, onClose, onDeactivate });
    change(find(draw(), (element) => element.props.type === "password"), "synthetic-password");
    selectPage(draw(), page.label);
    const request = deferred(); queries.setPassword.mockReturnValue(request.promise);
    const before = draw(); const pending = submit(before);
    await submit(before); await assign(before); await unassign(before); close(before);
    await click(find(before, (element) => element.type === "button" && textOf(element) === "Деактивировать"));
    expect(queries.setPassword).toHaveBeenCalledTimes(1);
    expect(queries.assignPage).not.toHaveBeenCalled(); expect(queries.unassignPage).not.toHaveBeenCalled();
    expect(onDeactivate).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(find(draw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    request.reject(new Error("Password rejected")); await pending;
    expect(find(draw(), (element) => element.props.type === "password").props.value).toBe("synthetic-password");
    expect(assignments(draw()).props.selectedLabel).toBe(page.label);
    expect(textOf(draw())).toContain("Password rejected");
  });

  it("blocks a password request restored from another mounted instance", async () => {
    queries.useAdminSetPassword.mockReturnValue({ mutateAsync: queries.setPassword, isPending: true });
    const onClose = vi.fn(); const onDeactivate = vi.fn();
    const draw = () => render(ChatterDetailModal, { user, onClose, onDeactivate });
    change(find(draw(), (element) => element.props.type === "password"), "newer-password");
    await submit(draw()); await assign(draw()); await unassign(draw()); close(draw());
    expect(queries.setPassword).not.toHaveBeenCalled();
    expect(queries.assignPage).not.toHaveBeenCalled(); expect(queries.unassignPage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(find(draw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    expect(assignments(draw()).props.disabled).toBe(true);
  });

  it("keeps the selected user dialog when refreshed data no longer includes the user", async () => {
    const draw = () => render(UsersTab, {});
    await click(find(draw(), (element) => element.props["aria-label"] === `Управлять доступом ${user.username}`));
    queries.useAdminUsers.mockReturnValue(ready([]));
    const modal = find(draw(), (element) => element.type === ChatterDetailModal);
    expect(modal.props.user).toBe(user);
    expect(modal.props.actionsDisabled).toBe(true);
  });

  it("restores search and role/status filters without deriving password access from API-key absence", () => {
    const inactive = { ...user, id: 8, username: "inactive-lead", role: "team_lead", disabledAt: "2026-09-11T00:00:00Z" };
    const owner = { ...user, id: 9, username: "synthetic-owner", role: "owner" };
    queries.useAdminUsers.mockReturnValue(ready([user, inactive, owner]));
    navigation.search = new URLSearchParams("userStatus=inactive&userRole=team_lead&userQuery=lead");
    const filtered = render(UsersTab, {});
    expect(textOf(filtered)).toContain("inactive-lead");
    expect(textOf(filtered)).not.toContain("synthetic-owner");
    expect(textOf(filtered)).not.toContain("synthetic-chatter");
    navigation.search = new URLSearchParams("userRole=owner");
    const owners = render(UsersTab, {});
    expect(textOf(owners)).toContain("Все страницы");
    expect(textOf(owners)).not.toContain("Нет назначений");
    expect(() => find(owners, (element) => element.type === "tr" && typeof element.props.onClick === "function")).toThrow("Control not found");
  });
});

describe("agent-key form scope and one-time reveal", () => {
  function agentDraw(onClose = vi.fn()) {
    return render(CreateAgentKeyModal, { create: { mutateAsync: queries.createAgent, isPending: false } as unknown as ReactModule.ComponentProps<typeof CreateAgentKeyModal>["create"], onClose, onIssued: vi.fn() });
  }
  function completeAgentForm() {
    change(find(agentDraw(), (element) => element.props.maxLength === 200), "synthetic-audit");
    change(find(agentDraw(), (element) => element.props.type === "checkbox"), "on");
    const pageLabel = find(agentDraw(), (element) => element.type === "label" && textOf(element).includes(page.label));
    change(find(pageLabel, (element) => element.props.type === "checkbox"), "on");
  }
  it("preserves selected page scopes through filtering and blocks a disappeared selection", async () => {
    completeAgentForm();
    change(find(agentDraw(), (element) => element.props["aria-label"] === "Найти страницу для ключа"), "not-found");
    expect(find(agentDraw(), (element) => element.props["aria-label"] === `Убрать ${page.label} из ключа`)).toBeTruthy();
    expect(find(agentDraw(), (element) => element.props.type === "submit").props.disabled).toBe(false);
    queries.useAdminPages.mockReturnValue(ready([]));
    expect(textOf(agentDraw())).toContain("Выбранные страницы отсутствуют в каталоге: synthetic-page");
    await submit(agentDraw()); expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it("rejects fractional/over-limit budgets and >365 days, then retains the failed issuance draft", async () => {
    completeAgentForm();
    change(find(agentDraw(), (element) => element.props.max === 365), "366");
    await submit(agentDraw()); expect(queries.createAgent).not.toHaveBeenCalled();
    change(find(agentDraw(), (element) => element.props.max === 365), "90");
    for (const value of ["0", "1.5", "1000001"]) {
      change(find(agentDraw(), (element) => element.props.max === 1_000_000), value);
      await submit(agentDraw());
    }
    expect(queries.createAgent).not.toHaveBeenCalled();
    change(find(agentDraw(), (element) => element.props.max === 1_000_000), "5000");
    const onClose = vi.fn(); const request = deferred(); queries.createAgent.mockReturnValue(request.promise);
    const before = agentDraw(onClose); const pending = submit(before);
    await submit(before); close(before);
    expect(onClose).not.toHaveBeenCalled(); expect(queries.createAgent).toHaveBeenCalledTimes(1);
    expect(queries.createAgent).toHaveBeenCalledWith({ name: "synthetic-audit", capabilities: ["read:messages"], pageLabels: [page.label], expiresInDays: 90, dailyRequestBudget: 5000, dailyRowBudget: 500000 });
    expect(find(agentDraw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    request.reject(new Error("Synthetic issuance rejected")); await pending;
    expect(find(agentDraw(), (element) => element.props.maxLength === 200).props.value).toBe("synthetic-audit");
    expect(textOf(agentDraw())).toContain("Synthetic issuance rejected");
    expect(textOf(agentDraw())).toContain(page.label);
  });

  it.each(["user", "agent"])("offers manual-copy fallback and explicit acknowledgement for %s secrets", async (kind) => {
    const onClose = vi.fn(); const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const draw = () => render(() => kind === "user" ? KeyRevealModal({ keyValue: "SYNTHETIC_ONLY", username: "synthetic", onClose }) : TokenRevealModal({ token: "SYNTHETIC_ONLY", name: "synthetic", onClose }), {});
    expect(find(draw(), (element) => typeof element.props.onClose === "function").props.closeDisabled).toBe(true);
    await click(find(draw(), (element) => element.type === "button" && textOf(element) === "Скопировать ключ"));
    expect(textOf(draw())).toContain("скопируйте его вручную");
    expect(find(draw(), (element) => element.type === "textarea").props).toMatchObject({ readOnly: true, value: "SYNTHETIC_ONLY" });
    expect(onClose).not.toHaveBeenCalled();
    await click(find(draw(), (element) => element.type === "button" && textOf(element) === "Ключ сохранён — закрыть"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
