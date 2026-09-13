import { vi } from "vitest";

export const PAGE_ACCOUNT_ID = "acct-dm-sweep";
/** Every provider head defaults to this instant unless a case moves it. */
export const HEAD_CREATED_AT_MS = Date.UTC(2026, 2, 10, 12, 0, 0);
/** What `markThreadSynced` writes: a dm_messages pass that ran BEFORE the
 *  default head, so `shouldRequestDmMessagesFollowup` turns on a newer head
 *  and stays off on an older one. */
export const MESSAGE_SYNC_AT = "2026-03-09T12:00:00.000Z";
/** `ensurePageSyncStates` seeds a never-synced stream as already requested
 *  (`buildSeedPageSyncState`, packages/db/src/repositories/page-sync.ts:1072),
 *  so dm_messages starts at request_seq 1 / "recovery" on a fresh page. Every
 *  follow-up this sweep asks for adds one on top of that. */
export const DM_MESSAGES_SEED_REQUEST_SEQ = 1;

export function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  };
}

type ConversationSpec = {
  groupId: string;
  /** `undefined` → `msg-<groupId>`; `null` → the provider dropped the head id. */
  lastMessageId?: string | null;
  unreadCount?: number;
  flags?: number;
  subscriptionTierId?: string | null;
  lastUnreadMessageId?: string | null;
  headCreatedAt?: number;
  headSenderId?: string;
  headContent?: string;
  /** The aggregation block carries no `lastMessage` for this group. */
  headMissing?: boolean;
};

type GroupsPage = ReturnType<typeof groupsPage>;

/** One provider page. Partners resolve straight from the aggregation block, so
 *  nothing here forces a group-detail fetch; `headMissing` + `lastMessageId:
 *  null` is what forces the head-repair fetch. `total: undefined` produces a
 *  page with no `aggregationData.total` at all (providerTotalMode "absent"). */
export function groupsPage(input: {
  conversations: Array<string | ConversationSpec>;
  total?: number;
  offset: number;
  done: boolean;
}) {
  const specs = input.conversations.map((conversation) =>
    typeof conversation === "string" ? { groupId: conversation } : conversation
  );
  const headIdOf = (spec: ConversationSpec) =>
    spec.lastMessageId === undefined ? `msg-${spec.groupId}` : spec.lastMessageId;
  const items = specs.map((spec) => ({
    groupId: spec.groupId,
    flags: spec.flags ?? 0,
    unreadCount: spec.unreadCount ?? 0,
    subscriptionTierId: spec.subscriptionTierId ?? null,
    lastMessageId: headIdOf(spec),
    lastUnreadMessageId: spec.lastUnreadMessageId ?? null,
    partnerAccountId: `fan-${spec.groupId}`,
    partnerUsername: `fan_${spec.groupId}`,
  }));
  const accounts = specs.map((spec) => ({
    id: `fan-${spec.groupId}`,
    username: `fan_${spec.groupId}`,
    displayName: `Fan ${spec.groupId}`,
  }));
  const groups = specs.map((spec) => ({
    id: spec.groupId,
    users: [
      { groupId: spec.groupId, userId: PAGE_ACCOUNT_ID },
      { groupId: spec.groupId, userId: `fan-${spec.groupId}` },
    ],
    ...(spec.headMissing
      ? {}
      : {
        lastMessage: {
          id: headIdOf(spec),
          senderId: spec.headSenderId ?? `fan-${spec.groupId}`,
          content: spec.headContent ?? `hello from ${spec.groupId}`,
          createdAt: spec.headCreatedAt ?? HEAD_CREATED_AT_MS,
        },
      }),
  }));

  return {
    total: input.total,
    items,
    accounts,
    groups,
    offset: input.offset,
    done: input.done,
    raw: {
      data: items,
      aggregationData: {
        ...(input.total === undefined ? {} : { total: input.total }),
        accounts,
        groups,
      },
    },
  };
}

type RepairMessage = {
  id: string;
  senderId: string;
  content: string;
  createdAt: number;
};

type AdapterCall =
  | { method: "messaging_groups"; offset: number; limit: number; sortOrder: number; flags: number }
  | { method: "group_detail"; groupId: string }
  | { method: "head_repair"; groupId: string; limit: number };

/** Serves the queued pages in order, answers head repairs from a per-group
 *  table, and depletes the chunk budget the way the real transport does (one
 *  observed request per adapter call — group pages, group details and
 *  head repairs alike). Every call is recorded so a test can pin the exact
 *  request sequence. */
export function sweepAdapter(input: {
  pages: GroupsPage[];
  /** groupId → what the `limit: 1` head repair returns. */
  headRepairs?: Record<string, RepairMessage[]>;
}) {
  const calls: AdapterCall[] = [];
  let requestSeq = 0;
  let pageIndex = 0;

  type RequestContext = {
    requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null;
  };
  const observe = async (requestContext: RequestContext, operation: string, endpoint: string) => {
    requestSeq += 1;
    await requestContext.requestObserver?.onRequestEvent({
      requestId: `dm-conversations-${requestSeq}`,
      operation,
      endpointTemplate: endpoint,
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date(),
      state: "started",
    });
  };

  const getMessagingGroupsPage = vi.fn(async (
    requestContext: RequestContext,
    params: { offset: number; limit: number; sortOrder: number; flags: number },
  ) => {
    calls.push({
      method: "messaging_groups",
      offset: params.offset,
      limit: params.limit,
      sortOrder: params.sortOrder,
      flags: params.flags,
    });
    const page = input.pages[pageIndex];
    if (!page) {
      throw new Error(`unexpected messaging-groups call #${pageIndex + 1} at offset ${params.offset}`);
    }
    pageIndex += 1;
    await observe(requestContext, "messaging_groups", "/messaging/groups");
    return page;
  });

  const getMessagesPage = vi.fn(async (
    requestContext: RequestContext,
    params: { groupId: string; limit: number },
  ) => {
    calls.push({ method: "head_repair", groupId: params.groupId, limit: params.limit });
    const messages = input.headRepairs?.[params.groupId];
    if (!messages) {
      throw new Error(`unexpected head-repair call for ${params.groupId}`);
    }
    await observe(requestContext, "messages", "/message");
    return {
      items: messages,
      groupId: params.groupId,
      before: null,
      done: true,
      raw: { messages },
    };
  });

  const getGroupDetail = vi.fn(async (_requestContext: RequestContext, groupId: string) => {
    calls.push({ method: "group_detail", groupId });
    throw new Error(`unexpected group-detail call for ${groupId}`);
  });

  return {
    calls,
    adapter: { getMessagingGroupsPage, getMessagesPage, getGroupDetail } as never,
  };
}

export function seedThreadInput(
  platformAccountId: number,
  platformConversationId: string,
  lastSeenGeneration: number,
) {
  return {
    platformAccountId,
    fanId: null,
    platformConversationId,
    partnerPlatformUserId: `fan-${platformConversationId}`,
    partnerUsername: `fan_${platformConversationId}`,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: `msg-${platformConversationId}`,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-03-09T12:00:00.000Z"),
    lastMessageSenderId: `fan-${platformConversationId}`,
    lastMessageSenderRole: "fan" as const,
    lastMessagePreview: "seeded",
    isVisible: true,
    lastSeenGeneration,
    metadata: {},
  };
}
