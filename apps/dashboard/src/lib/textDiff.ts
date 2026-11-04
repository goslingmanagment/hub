/**
 * The difference between two texts by lines, without dependencies: the longest
 * common subsequence of lines, then the unchanged runs folded around the changes.
 * Only reads: what is shown before a persona is saved (design/screens/settings.md §3.4).
 */

export type DiffLine =
  | { kind: "same"; text: string; before: number; after: number }
  | { kind: "removed"; text: string; before: number }
  | { kind: "added"; text: string; after: number };

/** Every line of both texts, in order, each marked as kept, removed or added. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common head and tail: a long text with one changed paragraph stays cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const lines: DiffLine[] = [];
  for (let index = 0; index < head; index += 1) lines.push({ kind: "same", text: a[index]!, before: index, after: index });

  // The table of common lengths, from the end.
  const rows = midA.length;
  const cols = midB.length;
  const table: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && midA[i] === midB[j]) {
      lines.push({ kind: "same", text: midA[i]!, before: head + i, after: head + j });
      i += 1;
      j += 1;
    } else if (j < cols && (i === rows || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      lines.push({ kind: "added", text: midB[j]!, after: head + j });
      j += 1;
    } else {
      lines.push({ kind: "removed", text: midA[i]!, before: head + i });
      i += 1;
    }
  }

  for (let index = 0; index < tail; index += 1) {
    const at = a.length - tail + index;
    const bt = b.length - tail + index;
    lines.push({ kind: "same", text: a[at]!, before: at, after: bt });
  }
  return lines;
}

/** A changed pair: only the stretch between the common start and the common end is marked. */
export function changedStretch(before: string, after: string): { start: number; beforeEnd: number; afterEnd: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { start, beforeEnd: before.length - end, afterEnd: after.length - end };
}

export type DiffRow =
  | { kind: "same"; before: string; after: string }
  | { kind: "changed"; before: string | null; after: string | null }
  | { kind: "folded"; count: number; lines: { before: string; after: string }[] };

/**
 * Lines side by side: a removed line beside the added one in its place, the runs of
 * unchanged lines folded beyond `context` lines around each change.
 */
export function diffRows(before: string, after: string, context = 2): DiffRow[] {
  const lines = diffLines(before, after);
  const paired: Exclude<DiffRow, { kind: "folded" }>[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === "same") {
      paired.push({ kind: "same", before: line.text, after: line.text });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < lines.length && lines[index]!.kind !== "same") {
      const change = lines[index]!;
      if (change.kind === "removed") removed.push(change.text);
      else added.push(change.text);
      index += 1;
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      paired.push({ kind: "changed", before: removed[k] ?? null, after: added[k] ?? null });
    }
  }

  const near = new Array<boolean>(paired.length).fill(false);
  paired.forEach((row, index) => {
    if (row.kind !== "changed") return;
    for (let k = Math.max(0, index - context); k <= Math.min(paired.length - 1, index + context); k += 1) near[k] = true;
  });

  const rows: DiffRow[] = [];
  let run: { before: string; after: string }[] = [];
  const flush = () => {
    // Folding one or two lines saves nothing: they are shown.
    if (run.length > 2) rows.push({ kind: "folded", count: run.length, lines: run });
    else for (const line of run) rows.push({ kind: "same", before: line.before, after: line.after });
    run = [];
  };
  paired.forEach((row, index) => {
    if (row.kind === "same" && !near[index]) {
      run.push({ before: row.before, after: row.after });
      return;
    }
    flush();
    rows.push(row);
  });
  flush();
  return rows;
}
