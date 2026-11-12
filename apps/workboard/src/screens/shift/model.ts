/**
 * «Смена» — what the screen shows of a shift's report, worked out from the
 * `shiftReport` answer; pure, no React. The answer is Hub's (services/
 * shift-handins.ts computes the draft and its amounts); here only the grouping
 * the eye needs, and the same amount rules applied at once to a word the person
 * just said, before Hub's fresh answer comes back.
 */
import type { ShiftReportBody, ShiftReportLine, ShiftReportStatement } from "@agency_hub_core/contracts";
import { millsPercentOf, millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";

export type Line = ShiftReportLine;

/** One fan's sales of a page in «Ваши продажи». */
export interface FanGroup {
  key: string;
  fan: Line["fan"];
  lines: Line[];
  amountMills: number;
  /** «ппв ×3 $36.00 · подписка $4.00» parts: kind, how many, how much. */
  kinds: Array<{ kind: string; count: number; mills: number }>;
  /** Something the person said on any of its sales. */
  marked: boolean;
}

export interface PageGroup {
  pageLabel: string;
  amountMills: number;
  fans: FanGroup[];
}

/** A fan's sum by the rule: their shares, and the whole net of a sale the person added by hand. */
function ruleSum(group: FanGroup): number {
  return group.lines.reduce((sum, line) => sum + (isClaimed(line) ? line.netMills : line.rule.shareMills), 0);
}

/** A sale the person added by hand («Добавить → продажу»). */
export const isClaimed = (line: Line) => line.group === "mine" && line.added && line.statement === "mine";

/** «Ваши продажи» by page (the report's order), inside a page by fan, the larger first. */
export function minePages(body: Pick<ShiftReportBody, "lines" | "pages">): PageGroup[] {
  const mine = body.lines.filter((line) => line.group === "mine");
  const order = [...body.pages.map((page) => page.pageLabel)];
  for (const line of mine) if (!order.includes(line.pageLabel)) order.push(line.pageLabel);
  return order.flatMap((pageLabel) => {
    const lines = mine.filter((line) => line.pageLabel === pageLabel);
    const page = body.pages.find((one) => one.pageLabel === pageLabel);
    if (lines.length === 0 && (page === undefined || page.amountMills === 0)) return [];
    const fans = new Map<string, FanGroup>();
    for (const line of lines) {
      const key = line.fan.fanRef ?? line.fan.username ?? `sale-${line.transactionId}`;
      const group = fans.get(key) ?? { key, fan: line.fan, lines: [], amountMills: 0, kinds: [], marked: false };
      group.lines.push(line);
      group.amountMills += line.amountMills;
      group.marked ||= line.statement !== null || line.note !== null;
      const kind = group.kinds.find((one) => one.kind === line.kind);
      if (kind) {
        kind.count += 1;
        kind.mills += line.amountMills;
      } else {
        group.kinds.push({ kind: line.kind, count: 1, mills: line.amountMills });
      }
      fans.set(key, group);
    }
    return [{
      pageLabel,
      amountMills: page?.amountMills ?? lines.reduce((sum, line) => sum + line.amountMills, 0),
      // The larger first, by what the rule gives (a word said on a line moves no row), then by the first sale, then the fan.
      fans: [...fans.values()].sort((a, b) => ruleSum(b) - ruleSum(a)
        || a.lines[0]!.occurredAt.localeCompare(b.lines[0]!.occurredAt) || a.key.localeCompare(b.key)),
    }];
  });
}

/** «Рядом, но не ваши по правилу». */
export const nearLines = (body: Pick<ShiftReportBody, "lines">) => body.lines.filter((line) => line.group === "near");

/** Half of a net, as Hub's money.ts does it. */
function half(mills: number): number {
  return millsToNumber(millsPercentOf(mills, 50));
}

/** Mills rounded half away from zero to the whole cent, Hub's money.ts. */
function toCent(mills: number): number {
  return millsToNumber(millsRoundedTo(mills, "cent"));
}

/** What a line counts after the person's word: the same rule as Hub's (shift-handin-rules.ts `lineAmount`). */
export function amountAfter(line: Line, statement: ShiftReportStatement | null): { amountMills: number; disputed: boolean } {
  if (line.alreadyIn !== null) return { amountMills: 0, disputed: false };
  if (line.group === "mine" && !isClaimed(line)) {
    if (statement === "not_mine") return { amountMills: 0, disputed: false };
    if (statement === "share") return { amountMills: half(line.netMills), disputed: false };
    return { amountMills: line.rule.shareMills, disputed: false };
  }
  if (statement !== "mine") return { amountMills: 0, disputed: false };
  // The rule already gives the person a share of a sale they added (agreed, decided): that share, settled.
  if (isClaimed(line) && line.rule.shareMills > 0) return { amountMills: line.rule.shareMills, disputed: false };
  return { amountMills: line.netMills, disputed: line.rule.home !== "nobody" || (line.facts?.otherReports.length ?? 0) > 0 };
}

/** The body with one line's word changed and the sums counted again: what the screen shows until Hub answers. */
export function withWord(body: ShiftReportBody, transactionId: number, word: { statement: ShiftReportStatement | null; shareWithUserId: number | null; shareWithName: string | null; note: string | null }): ShiftReportBody {
  const lines = body.lines.map((line) => {
    if (line.transactionId !== transactionId) return line;
    const { amountMills, disputed } = amountAfter(line, word.statement);
    return { ...line, statement: word.statement, shareWithUserId: word.shareWithUserId, shareWithName: word.shareWithName, note: word.note, amountMills, disputed };
  });
  // Hub's one rule of sums (shift-handin-rules.ts `pageSums`): a page is its lines rounded to the cent, the total the pages.
  const pages = body.pages.map((page) => ({
    ...page,
    amountMills: toCent(lines.filter((line) => line.pageLabel === page.pageLabel && (line.group === "mine" || line.amountMills !== 0)).reduce((sum, line) => sum + line.amountMills, 0)),
  }));
  return { ...body, lines, pages, totalMills: pages.reduce((sum, page) => sum + page.amountMills, 0) };
}

/** How many of «Ваши продажи» count, and how much. */
export function mineFacts(body: Pick<ShiftReportBody, "lines">): { count: number; mills: number } {
  const mine = body.lines.filter((line) => line.group === "mine");
  return { count: mine.length, mills: mine.reduce((sum, line) => sum + line.amountMills, 0) };
}
