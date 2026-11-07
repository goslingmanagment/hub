import type { DemoHandlers } from "../core.ts";
import { adminAiChatterLimits, adminAiSpend, adminChatterUsage } from "./costs-attention-ai.ts";
import { adminAiAccountsList, adminAiReconciliation, adminVoiceAccount } from "./costs-attention-anthropic.ts";
import {
  adminOfapiCreditsDaily,
  adminOfapiCreditsLedger,
  adminOfapiCreditsSummary,
  adminOfapiSpendComparison,
  ofapiKeyScopeGet,
} from "./costs-attention-ofapi.ts";
import {
  agentHydrationRequestList,
  clientSendCustodyList,
  notificationsIncidents,
  notificationsReportHistory,
  notificationsReportPreview,
  notificationsSettings,
} from "./costs-attention-queues.ts";

/** Demo answers of this area's screens (see demo/core.ts): «Расходы» (OnlyFans
 *  API credits, AI usage, AI spend), «Требует внимания» (held sends, history
 *  requests, incidents) and the Telegram notifications. */
export const costsAttentionHandlers: DemoHandlers = {
  adminAiSpend,
  adminAiChatterLimits,
  adminChatterUsage,
  adminAiAccountsList,
  adminAiReconciliation,
  adminVoiceAccount,
  adminOfapiCreditsSummary,
  adminOfapiCreditsDaily,
  adminOfapiCreditsLedger,
  adminOfapiSpendComparison,
  ofapiKeyScopeGet,
  clientSendCustodyList,
  agentHydrationRequestList,
  notificationsIncidents,
  notificationsSettings,
  notificationsReportPreview,
  notificationsReportHistory,
};
