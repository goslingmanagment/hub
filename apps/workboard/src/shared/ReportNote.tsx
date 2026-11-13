import type { ReactNode } from "react";
import { Tooltip } from "@agency_hub_core/ui";
import { noteHint, noteParts, noteSaleLine, noteSalesMore, type NotePart, type PlacedNote } from "./reportNotes";
import "./reportNote.css";

/**
 * A report day's note under its row's money (reportNotes.ts): one line, its parts joined by « · », each saying on
 * hover why it is there and what to do — the sales no report pays listed by time, page, kind and amount. `own` — the
 * days are the reader's own: the words say «ваши». `sum` false — the row's number is the report's own sum already
 * («Мои смены»): it is not said again. Nothing when the day has nothing to say.
 */
export function ReportNoteLine({ placed, own = false, sum = true }: { placed: PlacedNote; own?: boolean; sum?: boolean }) {
  const parts = noteParts(placed, { sum });
  if (parts.length === 0) return null;
  return (
    <span className="wb-report-note">
      {parts.map((part, index) => (
        // A part keeps its « · » at its own end: where the line breaks in a narrow column, no line begins with it.
        <span key={part.kind} className="wb-report-note__item">
          <Tooltip content={hintOf(part, placed, own)} align="end">
            <span className="wb-report-note__part">{part.text}</span>
          </Tooltip>
          {index < parts.length - 1 && <span className="wb-report-note__sep" aria-hidden>·</span>}
        </span>
      ))}
    </span>
  );
}

function hintOf(part: NotePart, placed: PlacedNote, own: boolean): ReactNode {
  const words = noteHint(part.kind, { own, ofDay: placed.ofDay });
  if (part.kind !== "unreported") return words;
  const more = noteSalesMore(placed.note);
  return (
    <span className="wb-report-note__hint">
      <span>{words}</span>
      <span className="wb-report-note__sales">
        {placed.note.unreported.sales.map((sale) => <span key={sale.saleId}>{noteSaleLine(sale)}</span>)}
        {more !== null && <span>{more}</span>}
      </span>
    </span>
  );
}
