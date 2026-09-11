import type * as ReactModule from "react";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const calls = vi.hoisted(() => ({ update: vi.fn(), test: vi.fn(), discover: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const values = hooks.values, index = hooks.cursor++;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useNotificationsSettings: () => ({ data: { configured: false, botTokenSet: false, chatId: null, enabled: true, reportHourUtc: 10 }, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateNotificationsSettings: () => ({ mutateAsync: calls.update, mutate: calls.update, isPending: false }),
  useSendTestMessage: () => ({ mutate: calls.test, isPending: false }),
  useDiscoverTelegramChats: () => ({ mutate: calls.discover, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
import { NotificationsSettingsTab } from "../apps/dashboard/src/pages/notifications/NotificationsSettingsTab.tsx";

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const item = queue.shift();
    if (Array.isArray(item)) { queue.push(...item); continue; }
    if (!isValidElement<Record<string, unknown>>(item)) continue;
    if (matches(item)) return item;
    queue.push(item.props.children as ReactNode);
  }
  throw new Error("Control not found");
}
function draw() { hooks.cursor = 0; return NotificationsSettingsTab(); }
function fields() {
  const tree = draw();
  const token = find(tree, e => e.props["aria-label"] === "Токен Telegram-бота");
  const chat = find(tree, e => typeof e.props.onDetect === "function");
  const tokenRef = token.props.ref as { current: { value: string } };
  const chatRef = chat.props.chatIdRef as { current: { value: string } };
  tokenRef.current = { value: "synthetic-token-a" };
  chatRef.current = { value: "chat-original" };
  return { tree, token, chat, tokenRef, chatRef };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; vi.clearAllMocks(); });

describe("Telegram credential draft recovery", () => {
  it.each(["token", "recipient", "dialog"])("does not apply an older discovery after changing the %s", kind => {
    const form = fields();
    (form.chat.props.onDetect as () => void)();
    expect(calls.discover).toHaveBeenCalledTimes(1);
    if (kind === "token") {
      form.tokenRef.current.value = "synthetic-token-b";
      (form.token.props.onChange as () => void)();
    } else if (kind === "recipient") form.chatRef.current.value = "manually-selected-chat";
    else { form.tokenRef.current = { value: "synthetic-token-a" }; form.chatRef.current = { value: "chat-original" }; }
    const expected = form.chatRef.current.value;
    calls.discover.mock.calls[0]![1].onSuccess({ botUsername: "old-bot", chats: [{ id: "old-chat", title: "Old chat", type: "private" }] });
    expect(form.chatRef.current.value).toBe(expected);
  });

  it("blocks fast duplicate save and keeps credentials when saving fails, without a test message", async () => {
    const form = fields();
    let reject!: (error: Error) => void;
    calls.update.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const save = find(form.tree, e => e.type === "button" && e.props.children === "Сохранить реквизиты");
    const first = (save.props.onClick as () => Promise<boolean>)();
    expect(await (save.props.onClick as () => Promise<boolean>)()).toBe(false);
    expect(calls.update).toHaveBeenCalledTimes(1);
    reject(new Error("Synthetic save failure"));
    expect(await first).toBe(false);
    expect(form.tokenRef.current.value).toBe("synthetic-token-a");
    expect(form.chatRef.current.value).toBe("chat-original");
    expect(calls.test).not.toHaveBeenCalled();
  });
});
