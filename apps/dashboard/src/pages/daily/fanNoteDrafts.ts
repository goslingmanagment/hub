export interface FanNoteDraftState {
  readonly principalId: number | null;
  readonly drafts: Readonly<Record<string, string>>;
}

type FanNoteDraftAction =
  | { type: "principal"; principalId: number | null }
  | { type: "edit"; principalId: number | null; routeKey: string; text: string }
  | { type: "saved"; principalId: number | null; routeKey: string; submittedText: string };

export function fanNoteDraftsReducer(state: FanNoteDraftState, action: FanNoteDraftAction): FanNoteDraftState {
  if (action.type === "principal") {
    return state.principalId === action.principalId ? state : { principalId: action.principalId, drafts: {} };
  }
  if (action.type === "edit") {
    return {
      principalId: action.principalId,
      drafts: { ...(state.principalId === action.principalId ? state.drafts : {}), [action.routeKey]: action.text },
    };
  }
  // A late response belongs to its submitted scope, even if another fan is now
  // open. It cannot clear a newer draft or a new principal's state.
  if (state.principalId !== action.principalId || state.drafts[action.routeKey] !== action.submittedText) return state;
  const drafts = { ...state.drafts };
  delete drafts[action.routeKey];
  return { ...state, drafts };
}
