import { useState } from "react";
import type { AdminSyncBlockResponse, SyncBlockStatus, SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  useAdminSyncBlockPause,
  useAdminSyncBlockReset,
  useAdminSyncBlockResume,
  useAdminSyncBlockTrigger,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { buildSettingsRoute } from "@/lib/navigation";
import {
  ENGINE_BLOCK_NOT_READ,
  engineAttentionLines,
  engineBlockButtons,
  engineBlockCredentialsRefused,
  engineBlockDescription,
  engineBlockLabel,
  engineBlockOrder,
  engineBlockState,
  engineBlockStopText,
  engineBlockSummary,
  engineCadenceText,
  engineChatsUnavailableLine,
  engineDueText,
  engineLeverNotice,
  engineRequeueConfirmText,
  engineStateLabel,
  engineStateTone,
  engineStreamLabel,
  engineSubstreamState,
  engineSubstreamStateText,
  isEngineBlock,
  type EngineBlock,
  type EngineLeverAction,
} from "./engineBlockDisplay.js";
import {
  engineAgeText,
  engineReadingTone,
  engineReadingWords,
  isCredentialsStop,
  type EngineReadingState,
} from "./engineDisplay.js";

// The five blocks of a Fansly page as the «Синк» tab shows them: a line each
// on the page's card of the list, a card each on the page's detail, and the
// buttons that act on the engine. What a block says — read, paused, held,
// without an owner — is the server's verdict over the block's own keys
// (`engineBlockDisplay.ts`); a button says what it moved.

const CREDENTIALS_LINK = "Обновить данные входа";

/** The states in which nothing of a block is due: no host runs the page, or
 *  every key of it is stopped. */
const NOTHING_DUE: ReadonlySet<EngineReadingState> = new Set(["no_owner", "switching", "paused", "page_held", "held"]);

/** A block at a glance (the page's card of the list). */
export function EngineBlockRow({ block, now = Date.now() }: { block: SyncBlockStatus; now?: number }) {
  const label = engineBlockLabel(block.block);
  const engine = isEngineBlock(block) ? block : null;
  const tone = engine === null ? null : engineStateTone(engineBlockState(engine));
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-x-3 py-1 items-baseline" data-engine-block={block.block}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone?.dot ?? "bg-text-muted/50"}`} />
        {label}
      </span>
      <span className={`text-xs min-w-0 break-words ${tone?.text ?? "text-text-muted"}`}>
        {engine === null ? "не читается" : engineBlockSummary(engine, now)}
      </span>
    </div>
  );
}

/** What on a page needs the owner: new credentials, else the work of its
 *  blocks that is quarantined or refused by Fansly, with the commands that
 *  list it. Nothing when nothing does. */
export function EnginePageAttention({
  page,
  className = "",
  now = Date.now(),
}: {
  page: SyncBlocksPage;
  className?: string;
  now?: number;
}) {
  const blocks = engineBlockOrder().map((key) => page.blocks[key]).filter(isEngineBlock);
  const refusal = blocks.flatMap((block) => block.engine.stops).find(isCredentialsStop);
  if (refusal !== undefined) {
    return (
      <div className={`rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5 ${className}`} data-engine-attention="credentials">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="font-medium text-danger">{engineBlockStopText(refusal, now)}</span>
          <span className="text-text-secondary">Из страницы ничего не читается.</span>
          <Link to={buildSettingsRoute("credentials")} className="font-semibold text-accent hover:underline">
            {CREDENTIALS_LINK}
          </Link>
        </div>
      </div>
    );
  }
  const lines = blocks.flatMap((block) =>
    engineAttentionLines(block, page.pageLabel).map((line) => `${engineBlockLabel(block.block)} — ${line}`));
  if (lines.length === 0) return null;
  return (
    <div className={`rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 space-y-0.5 ${className}`} data-engine-attention="work">
      {lines.map((line) => (
        <p key={line} className="break-words text-xs font-medium text-warning-dark">{line}</p>
      ))}
    </div>
  );
}

function notify(notice: ReturnType<typeof engineLeverNotice>): void {
  if (notice.kind === "success") toast.success(notice.text);
  else if (notice.kind === "warning") toast.warning(notice.text);
  else toast.message(notice.text);
}

const LEVER_FAILED: Record<EngineLeverAction, string> = {
  trigger: "Не удалось поставить опросы в очередь",
  pause: "Не удалось поставить на паузу",
  resume: "Не удалось снять паузу",
  reset: "Не удалось вернуть из карантина",
};

const BUTTON = "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40";
const BUTTON_PLAIN = `${BUTTON} border border-border bg-card text-text-secondary hover:bg-hover`;

/** The buttons of a block: each acts on the block's own keys, and its toast
 *  says what the engine's lever answered. */
export function EngineBlockActions({ pageLabel, block }: { pageLabel: string; block: EngineBlock }) {
  const [confirmRequeue, setConfirmRequeue] = useState(false);
  const mutations = {
    trigger: useAdminSyncBlockTrigger(),
    pause: useAdminSyncBlockPause(),
    resume: useAdminSyncBlockResume(),
    reset: useAdminSyncBlockReset(),
  };
  const pending = Object.values(mutations).some((mutation) => mutation.isPending);
  const buttons = engineBlockButtons(block);
  const label = engineBlockLabel(block.block);

  async function run(action: EngineLeverAction) {
    try {
      const response: AdminSyncBlockResponse = await mutations[action].mutateAsync({ pageLabel, block: block.block });
      notify(engineLeverNotice(action, block, response));
      if (action === "reset") setConfirmRequeue(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : LEVER_FAILED[action]);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {buttons.trigger && (
          <button
            type="button"
            onClick={() => void run("trigger")}
            disabled={pending}
            className={`${BUTTON} bg-accent text-white hover:opacity-90`}
          >
            Опросить сейчас
          </button>
        )}
        {buttons.pause && (
          <button type="button" onClick={() => void run("pause")} disabled={pending} className={BUTTON_PLAIN}>
            {buttons.pause.label}
          </button>
        )}
        {buttons.resume && (
          <button type="button" onClick={() => void run("resume")} disabled={pending} className={BUTTON_PLAIN}>
            {buttons.resume.label}
          </button>
        )}
        {buttons.requeue && (
          <button
            type="button"
            onClick={() => setConfirmRequeue(true)}
            disabled={pending}
            className={`${BUTTON} border border-danger/25 bg-danger/5 font-medium text-danger hover:bg-danger/10`}
          >
            {buttons.requeue.label}
          </button>
        )}
      </div>

      {confirmRequeue && (
        <ConfirmModal
          title={`Вернуть из карантина: ${label}?`}
          message={engineRequeueConfirmText(block, pageLabel)}
          confirmLabel="Вернуть"
          cancelLabel="Отмена"
          closeLabel="Закрыть"
          tone="primary"
          isPending={mutations.reset.isPending}
          onConfirm={() => void run("reset")}
          onClose={() => setConfirmRequeue(false)}
        />
      )}
    </>
  );
}

function StateBadge({ state }: { state: EngineReadingState }) {
  const tone = engineStateTone(state);
  return (
    <span
      title={engineReadingWords(state, "ru").detail}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.badge}`}
      data-engine-state={state}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {engineStateLabel(state)}
    </span>
  );
}

function readAgo(iso: string | null, now: number): string {
  const age = engineAgeText(iso, now);
  return age === null ? "—" : `${age} назад`;
}

const STREAM_HEAD = "px-3 py-1.5 text-left font-medium text-text-muted";
const STREAM_CELL = "px-3 py-1.5 text-text-secondary";

/** The streams of a block: a table where its five columns fit, and one
 *  labelled block per stream where they would run past the card (a phone, a
 *  narrow window). */
function EngineStreams({ block, now }: { block: EngineBlock; now: number }) {
  const streams = block.substreams.map((substream) => {
    const state = engineSubstreamState(block, substream);
    const tone = engineStateTone(state);
    return {
      stream: substream.stream,
      label: engineStreamLabel(substream.stream),
      dot: tone.dot,
      stateClass: engineReadingTone(state) === "warn" ? tone.text : "text-text-secondary",
      stateText: engineSubstreamStateText(block, substream),
      read: readAgo(substream.succeededAt, now),
      // Nothing is due of a stream no host reads, or every key of which is stopped.
      next: NOTHING_DUE.has(state) || substream.nextDueAt === null ? "—" : engineDueText(substream.nextDueAt, now),
      // A stream read on a trigger, not on a poll, has no period.
      poll: substream.cadenceSeconds > 0 ? engineCadenceText(substream.cadenceSeconds) : "—",
    };
  });
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <table className="hidden w-full text-xs @md:table" data-engine-streams="table">
        <thead>
          <tr className="bg-hover-alt">
            <th className={STREAM_HEAD}>Поток</th>
            <th className={STREAM_HEAD}>Состояние</th>
            <th className={STREAM_HEAD}>Последнее чтение</th>
            <th className={STREAM_HEAD}>Следующее</th>
            <th className={STREAM_HEAD}>Опрос</th>
          </tr>
        </thead>
        <tbody>
          {streams.map((row) => (
            <tr key={row.stream} className="border-t border-border" data-engine-stream={row.stream}>
              <td className="px-3 py-1.5 font-medium text-text-primary">{row.label}</td>
              <td className="px-3 py-1.5">
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${row.dot}`} />
                  <span className={row.stateClass}>{row.stateText}</span>
                </span>
              </td>
              <td className={STREAM_CELL}>{row.read}</td>
              <td className={STREAM_CELL}>{row.next}</td>
              <td className={STREAM_CELL}>{row.poll}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border text-xs @md:hidden" data-engine-streams="list">
        {streams.map((row) => (
          <li key={row.stream} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium text-text-primary">{row.label}</span>
              <span className="flex items-center gap-1.5">
                <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${row.dot}`} />
                <span className={row.stateClass}>{row.stateText}</span>
              </span>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-text-secondary">
              <dt className="text-text-muted">Последнее чтение</dt>
              <dd>{row.read}</dd>
              <dt className="text-text-muted">Следующее</dt>
              <dd>{row.next}</dd>
              <dt className="text-text-muted">Опрос</dt>
              <dd>{row.poll}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One block of a page in detail: what is true of it, what stops it, what of
 *  it needs the owner, its streams and its buttons. */
export function EngineBlockCard({
  block,
  pageLabel,
  now = Date.now(),
}: {
  block: SyncBlockStatus;
  pageLabel: string;
  now?: number;
}) {
  const label = engineBlockLabel(block.block);
  if (!isEngineBlock(block)) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-4" data-engine-block={block.block}>
        <span className="text-sm font-semibold text-text-muted">{label}</span>
        <p className="mt-1 text-xs text-text-muted">{ENGINE_BLOCK_NOT_READ}</p>
      </div>
    );
  }

  const state = engineBlockState(block);
  const { engine } = block;
  const attention = engineAttentionLines(block, pageLabel);
  const chatsUnavailable = engineChatsUnavailableLine(block, pageLabel);
  const nothingDue = NOTHING_DUE.has(state);
  // The owner's pause is the owner's own doing: it is said, not sounded.
  const stopsTone = engine.stops.every((stop) => stop.reason === "paused")
    ? "border-border bg-hover-alt text-text-secondary"
    : "border-warning/25 bg-warning/10 text-warning-dark";

  return (
    <div className="@container rounded-xl border border-border bg-card px-5 py-4" data-engine-block={block.block}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        <StateBadge state={state} />
      </div>
      <p className="mt-0.5 text-xs text-text-muted">{engineBlockDescription(block.block)}</p>

      {!engine.ownerRunning && (
        <p className="mt-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 text-xs font-medium text-warning-dark">
          {engineReadingWords(state, "ru").detail}
        </p>
      )}

      {engine.stops.length > 0 && (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 space-y-1 ${stopsTone}`} data-engine-stops>
          {engine.stops.map((stop) => (
            <p key={`${stop.reason}:${stop.by.join(",")}:${stop.until ?? ""}`} className="break-words text-xs font-medium">
              {engineBlockStopText(stop, now, engine.keys.length)}
            </p>
          ))}
          {block.block === "connection" && engineBlockCredentialsRefused(block) && (
            <Link
              to={buildSettingsRoute("credentials")}
              className="inline-block text-xs font-semibold text-accent hover:underline"
            >
              {CREDENTIALS_LINK} &rarr;
            </Link>
          )}
        </div>
      )}

      {attention.length > 0 && (
        <div className="mt-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 space-y-1" data-engine-attention="work">
          {attention.map((line) => (
            <p key={line} className="break-words text-xs font-medium text-warning-dark">{line}</p>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <span className="text-text-muted">Последнее чтение</span>
        <span className="text-text-secondary">{block.succeededAt === null ? "ещё не было" : readAgo(block.succeededAt, now)}</span>
        {!nothingDue && block.nextDueAt !== null && (
          <>
            <span className="text-text-muted">Следующее</span>
            <span className="text-text-secondary">{engineDueText(block.nextDueAt, now)}</span>
          </>
        )}
        {block.intervals.length > 0 && (
          <>
            <span className="text-text-muted">Опросы</span>
            <span className="text-text-secondary">
              {block.intervals
                .map((interval) => `${engineStreamLabel(interval.stream)} — ${engineCadenceText(interval.cadenceSeconds)}`)
                .join(", ")}
            </span>
          </>
        )}
      </div>

      {chatsUnavailable !== null && (
        <p className="mt-2 break-words text-xs text-text-secondary" data-engine-chats-unavailable>
          {chatsUnavailable}
        </p>
      )}

      {block.substreams.length > 1 && <EngineStreams block={block} now={now} />}

      <div className="mt-4">
        <EngineBlockActions pageLabel={pageLabel} block={block} />
      </div>
    </div>
  );
}
