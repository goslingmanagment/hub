import type { AppConfig } from "@agency_hub_core/shared";

import { resolveServiceEgressProxy } from "../egress/service-proxy.ts";
import type { BlocklistHistory, BlocklistHistoryPage, BlocklistMessage } from "./reader.ts";

// The FANSLY BLOCKLIST reader's Telegram side (fan marks, 2026-10-27): the
// agency's own user account through GramJS, READ-ONLY. Three requests only:
// `messages.CheckChatInvite` (the group behind the invite, for a member: its
// id and access hash), `messages.GetHistory` (a page of its messages) and the
// library's own connection handshake. Never a send, a join, a reaction or a
// read mark (no `ReadHistory`): reading history marks nothing read.
//
// Egress: the service SOCKS5 identity (SERVICE_EGRESS_PROXY_*) when it is
// configured, as every Telegram request of Hub (egress/resolver.ts); direct
// when it is not, or when TG_READER_DIRECT says so (MTProto is not HTTP, so
// the resolver's dispatcher cannot carry it).
//
// The session is a secret: it goes to GramJS and nowhere else, never into a
// log line or an error. GramJS is imported only when the reader runs.

type ReaderConfig = Pick<
  AppConfig,
  | "tgReaderApiId" | "tgReaderApiHash" | "tgReaderSession" | "tgReaderDirect"
  | "serviceEgressProxyUrl" | "serviceEgressProxyUsername" | "serviceEgressProxyPassword"
>;

/** Why the group cannot be read now. */
export type BlocklistOpenRefusal = "not_member" | "not_a_channel" | "invite_invalid";

export interface BlocklistTelegram {
  /** The group behind the invite, for a member; else why not. */
  open(invite: string): Promise<{ history: BlocklistHistory } | { refused: BlocklistOpenRefusal }>;
  close(): Promise<void>;
}

/** A Telegram FLOOD_WAIT the library would not sleep through: wait `seconds`. */
export class BlocklistFloodWait extends Error {
  override name = "BlocklistFloodWait";
  constructor(readonly seconds: number) {
    super(`Telegram asked to wait ${seconds} s`);
  }
}

/** Waits up to this long the library sleeps through by itself. */
const FLOOD_SLEEP_THRESHOLD_S = 60;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (typeof value === "object" && value !== null ? value as Rec : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const idText = (value: unknown): string | null => {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const text = typeof (value as { toString?: unknown } | null)?.toString === "function" ? String(value) : null;
  return text !== null && /^-?\d+$/.test(text) ? text : null;
};
const seconds = (value: unknown): Date | null => (typeof value === "number" && value > 0 ? new Date(value * 1000) : null);

/** The proxy GramJS rides: the service SOCKS5 identity, or none. */
export function blocklistTelegramProxy(config: ReaderConfig): { ip: string; port: number; socksType: 5; username?: string; password?: string; timeout: number } | undefined {
  if (config.tgReaderDirect === true) return undefined;
  // Throws on a partial or malformed tuple: never a silent direct fallback.
  const proxy = resolveServiceEgressProxy(config);
  if (proxy === null) return undefined;
  const url = new URL(proxy.url);
  return {
    ip: url.hostname,
    port: Number(url.port),
    socksType: 5,
    ...(proxy.username ? { username: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
    timeout: 15,
  };
}

/** One message as the reader keeps it, or null for a gone one (MessageEmpty). */
function messageOf(raw: unknown, names: ReadonlyMap<string, string>): { id: number; message: BlocklistMessage | null } | null {
  const message = rec(raw);
  const id = typeof message.id === "number" ? message.id : null;
  if (id === null || message.className === "MessageEmpty") return null;
  if (message.className !== "Message") return { id, message: null };
  const from = rec(message.fromId);
  const fromRef = from.className === "PeerUser" ? idText(from.userId) : from.className === "PeerChannel" ? idText(from.channelId) : null;
  const urls = (Array.isArray(message.entities) ? message.entities : [])
    .map(rec)
    .filter((entity) => entity.className === "MessageEntityTextUrl")
    .flatMap((entity) => str(entity.url) ?? []);
  return {
    id,
    message: {
      id,
      postedAt: seconds(message.date) ?? new Date(0),
      editedAt: seconds(message.editDate),
      text: typeof message.message === "string" ? message.message : "",
      urls,
      authorName: (fromRef === null ? undefined : names.get(fromRef)) ?? str(message.postAuthor),
    },
  };
}

/** Display names of the users and chats an answer carries, by id. */
function namesOf(answer: Rec): Map<string, string> {
  const names = new Map<string, string>();
  for (const user of (Array.isArray(answer.users) ? answer.users : []).map(rec)) {
    const id = idText(user.id);
    const name = [str(user.firstName), str(user.lastName)].filter((part) => part !== null).join(" ").trim();
    if (id !== null && name.length > 0) names.set(id, name);
  }
  for (const chat of (Array.isArray(answer.chats) ? answer.chats : []).map(rec)) {
    const id = idText(chat.id);
    const title = str(chat.title);
    if (id !== null && title !== null) names.set(id, title);
  }
  return names;
}

/** Connect the reader's account. Throws when it cannot connect or the session is not authorized. */
export async function connectBlocklistTelegram(config: ReaderConfig): Promise<BlocklistTelegram> {
  const { TelegramClient, Api, Logger, sessions, errors, helpers } = await import("telegram");
  const apiId = config.tgReaderApiId ?? null;
  const apiHash = config.tgReaderApiHash ?? null;
  const session = config.tgReaderSession ?? null;
  if (apiId === null || apiHash === null || session === null) {
    throw new Error("The blocklist reader needs TG_READER_API_ID, TG_READER_API_HASH and TG_READER_SESSION");
  }
  const proxy = blocklistTelegramProxy(config);
  const client = new TelegramClient(new sessions.StringSession(session), apiId, apiHash, {
    connectionRetries: 2,
    autoReconnect: false,
    floodSleepThreshold: FLOOD_SLEEP_THRESHOLD_S,
    baseLogger: new Logger("none" as never),
    deviceModel: "Agency Hub",
    systemVersion: "linux",
    appVersion: "1.0",
    ...(proxy === undefined ? {} : { proxy }),
  });

  const close = async () => {
    try {
      await client.destroy();
    } catch {
      // Closing is best effort: the next run connects anew.
    }
  };
  const invoke = async <R>(request: Parameters<typeof client.invoke>[0]): Promise<R> => {
    try {
      return await client.invoke(request) as R;
    } catch (error) {
      if (error instanceof errors.FloodWaitError) throw new BlocklistFloodWait(error.seconds);
      throw error;
    }
  };

  try {
    await client.connect();
    if (!(await client.checkAuthorization())) throw new Error("The blocklist reader's session is not authorized (log in again)");
  } catch (error) {
    await close();
    throw error;
  }

  return {
    async open(invite) {
      let answer: Rec;
      try {
        answer = rec(await invoke(new Api.messages.CheckChatInvite({ hash: invite })));
      } catch (error) {
        if (error instanceof BlocklistFloodWait) throw error;
        const message = error instanceof Error ? error.message : "";
        if (/INVITE_HASH_(EXPIRED|INVALID|EMPTY)/.test(message)) return { refused: "invite_invalid" };
        throw error;
      }
      if (answer.className !== "ChatInviteAlready") return { refused: "not_member" };
      const chat = rec(answer.chat);
      const chatId = idText(chat.id);
      if (chat.className !== "Channel" || chatId === null || chat.accessHash === undefined) return { refused: "not_a_channel" };
      const peer = new Api.InputPeerChannel({ channelId: helpers.returnBigInt(chatId), accessHash: chat.accessHash as never });
      const history: BlocklistHistory = {
        chatId: Number(chatId),
        async page({ offsetId, minId, limit }): Promise<BlocklistHistoryPage> {
          const page = rec(await invoke(new Api.messages.GetHistory({
            peer, offsetId, offsetDate: 0, addOffset: 0, limit, maxId: 0, minId, hash: helpers.returnBigInt(0),
          })));
          const names = namesOf(page);
          const read = (Array.isArray(page.messages) ? page.messages : []).flatMap((raw) => messageOf(raw, names) ?? []);
          return { ids: read.map((one) => one.id), messages: read.flatMap((one) => one.message ?? []) };
        },
      };
      return { history };
    },
    close,
  };
}
