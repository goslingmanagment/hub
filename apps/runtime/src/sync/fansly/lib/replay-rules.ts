// The named legacy rules of the journal replay (design §3.12 B5). A replay
// compares what the engine would have stored with what legacy stored; where
// legacy stored nothing to compare with — on purpose, or through a gap of its
// own the engine does not share — the replay says so by name, checked per
// observation (never a blanket skip), and the shadow report counts every
// name. Not-replayable reasons listed here leave B5's denominator
// (`REPLAY_EXCUSED_REASONS`); match rules (`ReplayVerdict.via`) keep the
// observation in it and are counted beside the matches.

/** `group_detail`: legacy's socket-hint path (B1) journals the detail of a
 *  chat it has no thread for and then defers on purpose until the list binds
 *  the chat ("a group detail is not proof that the group belongs to the
 *  visible roster"); for a direct chat the list never shows, legacy stores no
 *  thread at all, while the engine's `.find` creates it (D5). Only with
 *  legacy's own `membership_pending` record of that very group. */
export const LEGACY_WS_HINT_MEMBERSHIP_PENDING = "legacy_ws_hint_membership_pending";

/** `group_detail`: a detail that names no single partner (the page's own
 *  mass-message container: a type-3 group of the page alone) is not a chat;
 *  neither legacy nor the engine stores a thread for it. A match rule. */
export const DETAIL_NOT_A_CHAT = "detail_not_a_chat";

/** `dm_messages`: rows legacy's journal-only readers never stored — the B1
 *  socket-hint walk keeps staged pages as raw refs and drops them at its
 *  five-page limit, the AI fast lane and accelerator only journal — older
 *  than every row legacy stored for the chat. The engine stores every page it
 *  reads. */
export const LEGACY_UNSTORED_BELOW_WINDOW = "legacy_unstored_below_window";
/** The same, in a chat legacy marks `complete`: a legacy coverage claim the
 *  served history disproves (listed apart: step 3 must never trust it). */
export const LEGACY_UNSTORED_BELOW_COMPLETE_CLAIM = "legacy_unstored_below_complete_claim";
/** `dm_messages`: a row a journal-only read served seconds before Fansly
 *  deleted it (an exact socket deletion receipt); legacy's deletion writer
 *  only marks rows it holds. */
export const LEGACY_UNSTORED_DELETED_ON_PLATFORM = "legacy_unstored_deleted_on_platform";
