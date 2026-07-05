import type { SpenderDiagnosisRow } from "@agency_hub_core/db";

import { isClosingMessage } from "./closing.ts";

export interface SpenderDiagnosticsSummary {
  spenders: number;
  diagnosed: number;
  pending: number;
  l2Classified: number;
  closings: number;
  noVisibleDialog: number;
  modelLast: number;
  fanLast: number;
  unknownLast: number;
  states: Array<{ state: string; count: number }>;
}

const L2_STATES = new Set(["question", "buy_signal", "smalltalk", "closing", "cold", "complaint"]);

function stateKey(row: SpenderDiagnosisRow): string {
  const role = row.last_message_sender_role;
  if (!role) {
    return "no_visible_dialog";
  }
  if (role === "model") {
    return "model_last";
  }
  if (role !== "fan") {
    return "unknown_sender";
  }
  if (isClosingMessage(row.last_message_preview)) {
    return "closing";
  }
  if (!row.platform_message_id) {
    return "missing_message_id";
  }
  if (row.l2_needs_reply != null) {
    return row.l2_state && L2_STATES.has(row.l2_state) ? row.l2_state : "(unset)";
  }
  return "pending_ai";
}

export function summarizeSpenderDiagnostics(rows: SpenderDiagnosisRow[]): SpenderDiagnosticsSummary {
  const counts = new Map<string, number>();
  let l2Classified = 0;
  let pending = 0;
  let noVisibleDialog = 0;
  let modelLast = 0;
  let fanLast = 0;
  let unknownLast = 0;
  let closings = 0;

  for (const row of rows) {
    const state = stateKey(row);
    counts.set(state, (counts.get(state) ?? 0) + 1);

    if (!row.last_message_sender_role) {
      noVisibleDialog += 1;
    } else if (row.last_message_sender_role === "model") {
      modelLast += 1;
    } else if (row.last_message_sender_role === "fan") {
      fanLast += 1;
      if (state === "pending_ai") {
        pending += 1;
      }
      if (row.l2_needs_reply != null) {
        l2Classified += 1;
      }
    } else {
      unknownLast += 1;
    }

    if (state === "closing" || (row.l2_needs_reply === false && row.l2_state === "cold")) {
      closings += 1;
    }
  }

  const stateOrder = [
    "buy_signal",
    "question",
    "complaint",
    "smalltalk",
    "closing",
    "cold",
    "model_last",
    "unknown_sender",
    "no_visible_dialog",
    "missing_message_id",
    "pending_ai",
    "(unset)",
  ];
  const states = [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => {
      const ai = stateOrder.indexOf(a.state);
      const bi = stateOrder.indexOf(b.state);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
      }
      return b.count - a.count;
    });

  return {
    spenders: rows.length,
    diagnosed: rows.length - pending,
    pending,
    l2Classified,
    closings,
    noVisibleDialog,
    modelLast,
    fanLast,
    unknownLast,
    states,
  };
}
