import { type ReactNode } from "react";
import { Link } from "react-router";
import { Tooltip } from "@/components/shared/Tooltip";
import { goneReason, tierOf } from "./fanWords.js";

/** «Ушёл»: the page does not see the account. A focusable mark: the reason is not hover-only. */
export function GoneMark({ missAt }: { missAt: string | null | undefined }) {
  if (!missAt) return null;
  return (
    <Tooltip content={goneReason(missAt)} focusable className="shrink-0">
      <span className="badge">Ушёл</span>
    </Tooltip>
  );
}

export function TierMark({ lifetimeNetMills }: { lifetimeNetMills: number | null | undefined }) {
  const tier = lifetimeNetMills === null || lifetimeNetMills === undefined ? null : tierOf(lifetimeNetMills);
  return tier ? <span className="badge">{tier}</span> : null;
}

/**
 * One way to show a fan on every list: the name is a real link, its marks beside it,
 * the second line quiet. The whole row opens the same address (`isPlainRowClick`).
 */
export function FanCell({ name, to, state, handle, marks, note, title }: {
  name: string;
  to?: string | undefined;
  state?: unknown;
  handle?: string | null | undefined;
  marks?: ReactNode;
  /** After the nick on the second line: «Ждёт ответа 6 ч», the subscription's tier. */
  note?: ReactNode;
  title?: string | undefined;
}) {
  const hasNote = note !== null && note !== undefined && note !== false && note !== "";
  return (
    <div className="fan-cell">
      <div className="fan-cell-name">
        {to
          ? <Link to={to} state={state} className="fan-link" title={title}>{name}</Link>
          : <span className="fan-link-plain" title={title}>{name}</span>}
        {marks}
      </div>
      {(handle || hasNote) && (
        <div className="fan-cell-sub">
          {handle && <span>@{handle}</span>}
          {note}
        </div>
      )}
    </div>
  );
}

/** «Ждёт ответа 6 ч»: the chatter's work, not the owner's: a grey dot, not an accent. */
export function AwaitingNote({ words }: { words: string | null }) {
  if (!words) return null;
  return (
    <span className="fan-awaiting">
      <span className="status-dot" aria-hidden="true" />
      {words}
    </span>
  );
}
