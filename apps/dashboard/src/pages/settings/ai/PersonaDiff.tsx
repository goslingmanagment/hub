import { useMemo, useState, type ReactNode } from "react";
import { ruPlural } from "@/lib/plural";
import { changedStretch, diffRows, type DiffRow } from "@/lib/textDiff";

/** A changed line: only the stretch between the common start and end is marked. */
function Marked({ text, other, side }: { text: string; other: string | null; side: "before" | "after" }): ReactNode {
  if (other === null || text === "") return text || " ";
  const stretch = side === "before" ? changedStretch(text, other) : changedStretch(other, text);
  const start = stretch.start;
  const end = side === "before" ? stretch.beforeEnd : stretch.afterEnd;
  if (end <= start) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className="persona-diff-mark">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function foldedLabel(count: number): string {
  return `… ${count} ${ruPlural(count, "строка", "строки", "строк")} без изменений …`;
}

function Cell({ kind, text, other, side }: { kind: "same" | "removed" | "added" | "empty"; text: string | null; other: string | null; side: "before" | "after" }) {
  if (kind === "empty" || text === null) return <div className="persona-diff-cell is-empty" aria-hidden="true" />;
  const sign = kind === "removed" ? "−" : kind === "added" ? "+" : " ";
  return (
    <div className={`persona-diff-cell ${kind === "removed" ? "is-removed" : kind === "added" ? "is-added" : ""}`}>
      <span className="persona-diff-sign" aria-hidden="true">{sign}</span>
      <span className="persona-diff-text">{kind === "same" ? (text || " ") : <Marked text={text} other={other} side={side} />}</span>
    </div>
  );
}

/**
 * The instruction before and after, computed in the browser and sent nowhere:
 * side by side on a wide screen, one column on a narrow one. Unchanged lines are
 * folded beyond two around each change; «−» and «+» say it without the colour.
 */
export function PersonaDiff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());

  const open = (index: number) => setOpened((previous) => new Set(previous).add(index));

  const render = (row: DiffRow, index: number) => {
    if (row.kind === "folded" && !opened.has(index)) {
      return (
        <button key={index} type="button" className="persona-diff-fold" onClick={() => open(index)}>
          {foldedLabel(row.count)}
        </button>
      );
    }
    if (row.kind === "folded") {
      return row.lines.map((line, k) => (
        <div key={`${index}-${k}`} className="persona-diff-row">
          <Cell kind="same" text={line.before} other={null} side="before" />
          <Cell kind="same" text={line.after} other={null} side="after" />
        </div>
      ));
    }
    if (row.kind === "same") {
      return (
        <div key={index} className="persona-diff-row">
          <Cell kind="same" text={row.before} other={null} side="before" />
          <Cell kind="same" text={row.after} other={null} side="after" />
        </div>
      );
    }
    return (
      <div key={index} className="persona-diff-row is-changed">
        <Cell kind={row.before === null ? "empty" : "removed"} text={row.before} other={row.after} side="before" />
        <Cell kind={row.after === null ? "empty" : "added"} text={row.after} other={row.before} side="after" />
      </div>
    );
  };

  return (
    <div className="persona-diff" role="group" aria-label="Изменения инструкции">
      <div className="persona-diff-row persona-diff-head" aria-hidden="true">
        <div>Было</div>
        <div>Стало</div>
      </div>
      {rows.map(render)}
    </div>
  );
}
