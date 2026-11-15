import {
  SHIFT_REPORT_PHASE_CHIPS,
  personNameForms,
  type ShiftReportBoard,
  type ShiftReportOwner,
  type ShiftReportPhase,
  type ShiftReportRow,
} from "@agency_hub_core/contracts";
import { deciderOf, personsOfLogins, teamFactsFor } from "./teams.ts";
import {
  findHandinPersonOfUser,
  findPreviousShiftComment,
  hasShiftReportReviewer,
  listHandinMarks,
  listOffPlatform,
  listCurrentWordsOfSales,
  listHandinCandidates,
  listHandinPeopleOfUsers,
  listNotesOfSales,
  listHandinColleagues,
  listHandinNames,
  listHandinProposals,
  listHandinSaleFans,
  listHandinSalesOnPages,
  listOpenSaleSightings,
  listSaleClaims,
  listTransactionPlatformRefs,
  type CandidateRow,
  type Database,
  type TeamFacts,
  type HandinRow,
  type HandinVersionLine,
  type HandinVersionRow,
  type ProposalRow,
  type SaleClaimRow,
  type SaleSightingRow,
  findTestOwnerLogin,
  isTestUser,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { reportSums } from "./sale-claim-rules.ts";
import { draftFacts, draftLines, linesPageSums, offPlatformOfRows, ruleWordsOfLine, type PageCatalog, type Subject } from "./shift-handins.ts";
import { gengarState, holdsSale, mayAct, signedLines, type BoardActor } from "./shift-report-phases.ts";

/**
 * The «Отчёт» board as a reader sees it (products plan 2026-11-13, package R; the contract shift-report-board.ts): a
 * column per page of the shift, rows as the sites' lists, newest first, the phase, the check, the questions, Gengar's
 * cards, the totals. Read, never written: the operations are shift-report-board.ts. The sums are `pageSums`, the one
 * place every number of a report is made.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const moscowDayStart = (at: number) => Date.parse(`${new Date(at + 3 * HOUR_MS).toISOString().slice(0, 10)}T00:00:00+03:00`);

/**
 * Who decides a dispute of a page's model, and how the texts name them: `deciderOf` (services/teams.ts) — the lead of
 * the model's team («Спор решит Марта»), the owner when it has none or the lead is a side of the shift («Спор решит
 * владелец»). Without the facts (a check with no model): the owner.
 */
export function disputeDecider(input: {
  modelSlug: string | null;
  testOwner?: { userId: number; name: string } | null;
  facts?: TeamFacts;
  /** The people of the shift: a lead who is one of them does not decide its disputes. */
  sidePersonIds?: readonly number[];
}): ShiftReportBoard["decider"] {
  if (input.facts !== undefined && input.modelSlug !== null) {
    const model = input.facts.models.find((one) => one.slug === input.modelSlug);
    const decider = deciderOf(input.facts, model?.modelId ?? null, "dispute", input.sidePersonIds ?? []);
    if (decider.kind === "team_lead") {
      return { kind: "team_lead", user: { userId: decider.userId, name: decider.name, forms: personNameForms(decider.name) }, words: decider.name };
    }
  }
  // A test shift's dispute is decided by the test team's owner BY NAME, never the live owner (sandbox/realm.ts).
  if (input.testOwner) {
    return { kind: "owner", user: { userId: input.testOwner.userId, name: input.testOwner.name, forms: personNameForms(input.testOwner.name) }, words: input.testOwner.name };
  }
  return { kind: "owner", user: null, words: "владелец" };
}

/** The phase a report is in: a report handed in before the board (a version, no phase) is counted. */
export function phaseOf(handin: Pick<HandinRow, "phase" | "state"> | null): ShiftReportPhase {
  if (handin === null) return "draft";
  if (handin.phase === "draft" && handin.state === "submitted") return "counted";
  return handin.phase;
}

/** The board's switch for a shift: the person's right, granted before the shift began (a shift begun before is handed in the old way). */
export function boardOn(subject: Pick<Subject, "person" | "shift">): boolean {
  const since = subject.person?.submitsShiftSince ?? null;
  return since !== null && since.getTime() <= subject.shift.startedAt.getTime();
}

const SITE_WORDS: Record<"fansly" | "onlyfans", Record<string, string>> = {
  fansly: { message_purchase: "Media Sale to", post_purchase: "Media Sale to", subscription: "Subscription Sale to", tip: "Tip from", stream_tip: "Tip from" },
  onlyfans: { message_purchase: "Payment for message from", post_purchase: "Payment for post from", subscription: "Subscription from", tip: "Tip from", stream_tip: "Tip from" },
};
export function siteWordsOf(platform: "fansly" | "onlyfans", kind: string): string {
  return SITE_WORDS[platform][kind] ?? (platform === "fansly" ? "Sale to" : "Payment from");
}

const platformOf = (value: string | undefined): "fansly" | "onlyfans" => (value === "onlyfans" ? "onlyfans" : "fansly");

interface People {
  nameOf(userId: number): string;
  person(userId: number): { userId: number; name: string; forms: ReturnType<typeof personNameForms> };
}

function owner(kind: ShiftReportOwner["kind"], userId: number | null, people: People, me: number): ShiftReportOwner {
  const name = userId === null ? null : people.nameOf(userId);
  const forms = name === null ? null : personNameForms(name);
  switch (kind) {
    case "me": return { kind, userId: me, name: people.nameOf(me), words: "моя" };
    case "share": return { kind, userId, name, words: forms ? `пополам с ${forms.ins}` : "пополам" };
    case "user": return { kind, userId, name, words: forms?.gen ?? "коллеги" };
    case "pot": return { kind, userId: null, name: null, words: "общак" };
    case "waiting": return { kind, userId, name, words: forms ? `ждёт смены ${forms.gen}` : "ждёт смены" };
    case "decide": return { kind, userId: null, name: null, words: "решит владелец" };
    default: return { kind: "nobody", userId: null, name: null, words: "ничья" };
  }
}

/** Whose the rule says the line is. */
function ruleOwner(line: HandinVersionLine, people: People, me: number): ShiftReportOwner {
  if (line.rule.shareMills > 0) {
    return line.rule.shareMills < line.netMills && line.rule.toUserId !== null ? owner("share", line.rule.toUserId, people, me) : owner("me", null, people, me);
  }
  if (line.rule.home === "pot") return owner("pot", null, people, me);
  if (line.rule.home === "waiting") return owner("waiting", line.rule.toUserId ?? line.rule.senderUserId, people, me);
  if (line.rule.home === "decide") return owner("decide", null, people, me);
  if (line.rule.toUserId !== null) return owner("user", line.rule.toUserId, people, me);
  return owner("nobody", null, people, me);
}

/** Whose the line is now: the person's word over the rule, an agreement or a decision as what it counts. */
function lineOwner(line: HandinVersionLine, people: People, me: number): ShiftReportOwner {
  switch (line.statement) {
    case "give": return owner("user", line.toUserId ?? null, people, me);
    case "pot": return owner("pot", null, people, me);
    case "not_mine": return owner("nobody", null, people, me);
    case "share": return owner("share", line.shareWithUserId, people, me);
    case "mine": return owner("me", null, people, me);
    default:
      if (line.settled !== undefined && line.amountMills > 0) return owner("me", null, people, me);
      return ruleOwner(line, people, me);
  }
}

const sameOwner = (a: ShiftReportOwner, b: ShiftReportOwner) => a.kind === b.kind && (a.userId ?? 0) === (b.userId ?? 0);
const plainUsd = (mills: number) => formatUsdFromMills(mills).replace(/\.00$/, "");

export interface BoardRead {
  db: Database;
  subject: Subject;
  catalog: PageCatalog;
  actor: BoardActor;
  /** A reader cut to their pages; null — the whole board. */
  cutTo: Set<string> | null;
  /** The owner and a team lead see the draft before a version exists. */
  draftPreview: boolean;
  handin: HandinRow | null;
  versions: readonly HandinVersionRow[];
  /** The draft now (own, or a preview); null — not read for this reader. */
  draft: readonly HandinVersionLine[] | null;
  now: Date;
  /** Whether the ledger has seen the post of this report's day (own, counted; null — not known or not asked). */
  postSeen?: boolean | null;
  /** The report's posts, one per model (own, counted), and each model's copy (0427). */
  posts?: ReadonlyArray<{ modelSlug: string; modelName: string }>;
  postCopies?: ReadonlyArray<{ modelSlug: string; version: number; copiedAt: Date }>;
}

/** The board of a shift as the reader may see it; null — no board for this shift (the right is off, or was granted after it began). */
export async function readBoard(input: BoardRead): Promise<ShiftReportBoard | null> {
  const { db, subject, catalog, handin, now } = input;
  // Without the board (the right off, or granted after the shift began) the person still sees their own shift as the old
  // screen showed it: read only, by the rule, the old notice. Anyone else sees no board of such a shift.
  const preview = !boardOn(subject);
  if (preview && input.actor.access !== "own") return null;
  const actor: BoardActor = preview ? { ...input.actor, enabled: false } : input.actor;
  const me = subject.shift.userId;
  const own = actor.access === "own";
  const phase = preview ? "draft" : phaseOf(handin);
  const latest = input.versions.at(-1) ?? null;
  const candidates = handin === null ? [] : await listHandinCandidates(db, handin.id);
  const candidate: CandidateRow | null = candidates.at(-1) ?? null;
  const proposals = handin === null ? [] : await listHandinProposals(db, handin.id);
  const ofCandidate = candidate === null ? [] : proposals.filter((one) => one.candidateId === candidate.id);

  // The lines the board stands on: the draft while it is edited, the candidate while it is checked and signed, the
  // version once counted. A reader without the draft sees the counted version only.
  let base: readonly HandinVersionLine[];
  if (!own && !input.draftPreview) base = latest?.lines ?? [];
  else if (phase === "confirm" && candidate !== null && handin !== null) base = (await signableOf(db, { subject, catalog, handin, candidate })).lines;
  else if (phase === "checking" && candidate !== null) base = candidate.lines;
  else if (phase === "counted" && latest !== null) base = latest.lines;
  else base = input.draft ?? latest?.lines ?? [];
  const cut = input.cutTo;
  const visible = (label: string | null) => label !== null && (cut === null || cut.has(label));
  base = base.filter((line) => line.transactionId !== null && visible(line.pageLabel));

  // «После сдачи»: the person's by the rule and not held by what is checked or counted — it came after the hand-in, Hub
  // received it after (a candidate holds every sale the draft had at its cutoff), or it lies there at $0 with nothing on
  // it and the rule gave it to the person since (a colleague's «отдать», a decision): `holdsSale`.
  const heldIds = new Set(base.filter(holdsSale).map((line) => line.transactionId!));
  const late = own && !preview && phase !== "draft" && phase !== "fixing" && candidate !== null && input.draft !== null
    ? input.draft.filter((line) => line.transactionId !== null && !heldIds.has(line.transactionId) && line.group === "mine" && line.amountMills > 0
      && visible(line.pageLabel))
    : [];
  // Its $0 line gives way to the row «после сдачи».
  const lateIds = new Set(late.map((line) => line.transactionId!));
  base = base.filter((line) => !lateIds.has(line.transactionId!));
  const baseIds = new Set(base.map((line) => line.transactionId!));
  // Rows Hub's re-read added: the candidate re-made at the same cutoff names what the one before lacked.
  const previousCandidate = candidate === null ? null : candidates.find((one) => one.supersededBy === candidate.id && one.cutoffAt.getTime() === candidate.cutoffAt.getTime()) ?? null;
  const foundIds = new Set(previousCandidate === null || candidate === null ? [] : candidate.lines
    .flatMap((line) => (line.transactionId === null || previousCandidate.lines.some((one) => one.transactionId === line.transactionId) ? [] : [line.transactionId])));

  // The shift's pages, every one (a page with no sales too), then a page only a line names.
  const shiftLabels = subject.shift.pages.map((page) => page.pageLabel).filter((label) => visible(label));
  const labels = [...shiftLabels];
  for (const line of [...base, ...late]) if (line.pageLabel !== null && !labels.includes(line.pageLabel)) labels.push(line.pageLabel);
  const pageIds = labels.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined);

  // Sales of the same pages and day before the shift began: folded into one row a page.
  const start = subject.shift.startedAt.getTime();
  const before = (await listHandinSalesOnPages(db, { pageIds, from: new Date(moscowDayStart(start)), to: subject.shift.startedAt, limit: 500 }))
    .filter((sale) => !baseIds.has(sale.transactionId));
  // «Нет в Hub»: what the site showed and Hub does not hold, in the shift's window.
  const windowEnd = subject.shift.state === "going" ? now : new Date(subject.shift.endedAt.getTime() + 1);
  const sightings = (await listOpenSaleSightings(db, { pageIds, from: subject.shift.startedAt, to: windowEnd }))
    .filter((one) => one.addedHandinId === null || one.addedHandinId === handin?.id);

  const ids = [...baseIds, ...late.map((line) => line.transactionId!), ...before.map((sale) => sale.transactionId)];
  const claims = ids.length === 0 ? [] : await listSaleClaims(db, { transactionIds: ids, kinds: ["claim"] });
  const fans = await listHandinSaleFans(db, ids);
  const refs = await listTransactionPlatformRefs(db, ids);
  const colleagues = own ? await listHandinColleagues(db, { pageIds, exceptUserIds: subject.userIds }) : [];
  const userIds = new Set<number>([me, ...colleagues.map((one) => one.userId)]);
  for (const line of [...base, ...late]) for (const id of [line.rule.toUserId, line.rule.senderUserId, line.shareWithUserId, line.toUserId ?? null]) if (id !== null) userIds.add(id);
  for (const claim of claims) for (const id of [claim.claimantUserId, claim.sideUserId]) if (id !== null) userIds.add(id);
  for (const sale of before) for (const share of sale.home?.shares ?? []) userIds.add(share.userId);
  const names = await listHandinNames(db, [...userIds]);
  // Who of them hands shifts in by the board: a question, «отдать» or «пополам» with anyone else goes to the decider.
  const boardPeople = await listHandinPeopleOfUsers(db, [...userIds]);
  const onBoard = (userId: number) => boardPeople.get(userId)?.submitsShiftSince != null;
  // «Олега» given and taken back: the colleague's own newest report says «не моё» of it.
  const givenIds = [...base, ...late].flatMap((line) => (line.statement === "give" && line.transactionId !== null ? [line.transactionId] : []));
  const takenBack = new Set((await listCurrentWordsOfSales(db, givenIds))
    .filter((word) => word.statement === "not_mine" && [...base, ...late].some((line) => line.transactionId === word.transactionId && line.toUserId === word.userId))
    .map((word) => word.transactionId));
  const beforeNotes = await listNotesOfSales(db, before.map((sale) => sale.transactionId));
  const people: People = {
    nameOf: (userId) => names.get(userId) ?? `#${userId}`,
    person: (userId) => {
      const name = names.get(userId) ?? `#${userId}`;
      return { userId, name, forms: personNameForms(name) };
    },
  };
  const testShift = await isTestUser(db, subject.shift.userId);
  const teamFacts = await teamFactsFor({ db });
  const decider = disputeDecider({
    modelSlug: catalog.info.get(labels[0] ?? "")?.modelSlug ?? null, testOwner: testShift ? await findTestOwnerLogin(db) : null,
    facts: teamFacts, sidePersonIds: personsOfLogins(teamFacts, [subject.shift.userId]),
  });
  const editable = own && mayAct(actor, "edit", phase);
  const canNote = own && mayAct(actor, "note", phase);
  const counted = phase === "counted";

  const askOf = (transactionId: number) => claims.find((claim) => claim.transactionId === transactionId && claim.claimantHandinId === handin?.id && claim.state !== "withdrawn") ?? null;
  const incomingOf = (transactionId: number) => claims.find((claim) => claim.transactionId === transactionId && claim.sideUserId !== null
    && subject.userIds.includes(claim.sideUserId) && claim.claimantHandinId !== handin?.id && claim.state !== "withdrawn") ?? null;
  const proposalOf = (transactionId: number): ProposalRow | null => {
    const mine = proposals.filter((one) => one.transactionId === transactionId && one.kind === "owner_change");
    const late = mine.find((one) => one.state === "late");
    if (late) return late;
    return candidate === null ? null : mine.find((one) => one.candidateId === candidate.id) ?? null;
  };
  const noteProposalOf = (transactionId: number) => (candidate === null ? null : ofCandidate.find((one) => one.transactionId === transactionId && one.kind === "note") ?? null);

  const rowOf = (line: HandinVersionLine, mode: "base" | "late"): ShiftReportRow => {
    const id = line.transactionId!;
    const platform = platformOf(catalog.info.get(line.pageLabel ?? "")?.platform);
    const fansly = platform === "fansly";
    const ref = refs.get(id) ?? null;
    const ruleWords = ruleWordsOfLine(line, names);
    const rule = ruleOwner(line, people, me);
    const isLate = mode === "late";
    const amount = isLate ? 0 : line.amountMills;
    const ask = askOf(id);
    const incoming = incomingOf(id);
    const proposal = proposalOf(id);
    const noteProposal = noteProposalOf(id);
    let current = lineOwner(line, people, me);
    let reason = "";
    const oldWay = ask !== null && ask.sideUserId !== null && ask.escalatedWhy === "no_side" && (ask.state === "owner" || ask.state === "asked") && !onBoard(ask.sideUserId);
    if (oldWay && ask !== null && ask.sideUserId !== null) {
      // The other side hands shifts in the old way: the decider decides, no day of silence runs.
      current = ask.statement === null ? owner("user", ask.sideUserId, people, me) : ask.statement === "share" ? owner("share", ask.sideUserId, people, me) : rule;
      reason = `${people.nameOf(ask.sideUserId)} сдаёт смену по-старому, решит ${decider.words}`;
    } else if (line.statement === "give" && takenBack.has(id) && line.toUserId != null) {
      current = owner("nobody", null, people, me);
      reason = `${people.nameOf(line.toUserId)} не взял`;
    } else if (isLate) {
      current = { ...owner("me", null, people, me), words: "после сдачи" };
      reason = ruleWords;
    } else if (ask !== null && ask.answer === null && (ask.state === "asked" || ask.state === "owner") && ask.silenceAt === null) {
      current = rule;
      reason = ask.sideUserId === null ? "ждём владельца" : `ждём ответа ${personNameForms(people.nameOf(ask.sideUserId)).gen}`;
    } else if (ask !== null && ask.answer === "disagree" && ask.state === "owner" && ask.sideUserId !== null) {
      current = rule;
      reason = `${people.nameOf(ask.sideUserId)} не согласен, решит ${decider.words}`;
    } else if (ask !== null && ask.state === "agreed" && ask.sideUserId !== null) {
      reason = ask.silenceAt !== null ? `${people.nameOf(ask.sideUserId)} не ответил за сутки` : `${people.nameOf(ask.sideUserId)} согласился`;
    } else if (incoming !== null && (incoming.state === "asked" || incoming.state === "owner") && incoming.claimantUserId !== null) {
      reason = `${people.nameOf(incoming.claimantUserId)} оспаривает`;
    } else if (proposal !== null && (proposal.state === "accepted" || (proposal.state === "proposed" && phase === "confirm"))) {
      reason = "поменял Генгар";
    } else if (proposal !== null && proposal.state === "declined" && counted) {
      reason = `Генгар предлагал иначе, решит ${decider.words}`;
    } else if (line.settled === "owner") {
      // Decided by the decider («общак, решил владелец», «моя, решил владелец»): the word is what the decision gives.
      reason = `решил ${decider.words}`;
    } else if (!sameOwner(current, rule)) {
      reason = `по правилу ${rule.kind === "me" ? "ваша" : rule.words}`;
    } else if (amount <= 0) {
      reason = ruleWords;
    }
    if (current.kind === "share" && amount > 0 && !isLate) reason = `вам ${plainUsd(amount)}`;
    const askWire = ask === null ? null : {
      claimId: ask.id,
      to: ask.sideUserId === null ? "owner" as const : "colleague" as const,
      toUser: ask.sideUserId === null ? null : people.person(ask.sideUserId),
      want: ask.statement === "share" && ask.shareWithUserId !== null ? owner("share", ask.shareWithUserId, people, me) : owner("me", null, people, me),
      note: ask.claimantNote ?? "",
      state: askState(ask),
      answerNote: ask.answerNote,
      answerBy: ask.sideUserId === null || ask.state !== "asked" ? null : new Date(ask.createdAt.getTime() + DAY_MS).toISOString(),
      decision: ask.decisionId === null ? null : "решение владельца",
      oldWay,
    };
    const incomingWire = incoming === null || incoming.claimantUserId === null ? null : {
      claimId: incoming.id,
      from: people.person(incoming.claimantUserId),
      statement: incoming.statement === "share" ? "share" as const : "mine" as const,
      note: incoming.claimantNote,
      state: incoming.state === "asked" ? "asked" as const : incoming.state === "owner" ? "disputed" as const : "settled" as const,
      canAnswer: own && incoming.kind === "claim" && incoming.answer === null && (incoming.state === "asked" || (incoming.state === "agreed" && incoming.silenceAt !== null)),
      answer: incoming.answer,
      answerBy: incoming.state === "asked" ? new Date(incoming.createdAt.getTime() + DAY_MS).toISOString() : null,
    };
    const shownProposal = proposal ?? noteProposal;
    const proposalWire = shownProposal === null ? null : {
      id: shownProposal.id,
      kind: shownProposal.kind,
      from: shownProposal.kind === "owner_change" ? wordOwner(shownProposal.fromWord, shownProposal.fromUserId, line, people, me) : null,
      to: shownProposal.kind === "owner_change" ? wordOwner(shownProposal.toWord, shownProposal.toUserId, line, people, me) : null,
      note: shownProposal.note,
      deltaMills: shownProposal.deltaMills,
      why: shownProposal.why,
      state: shownProposal.state,
      afterCounted: shownProposal.afterCounted,
      by: "Генгар",
    };
    const noteText = line.note ?? (noteProposal !== null && noteProposal.state !== "declined" ? noteProposal.note : null);
    const noteBy = line.noteByAgent === true || (line.note === null && noteText !== null) ? "agent" as const : "person" as const;
    const attention = isLate || (incomingWire?.canAnswer ?? false)
      || (phase === "confirm" && shownProposal !== null && shownProposal.state === "proposed")
      || (shownProposal?.state === "late");
    return {
      key: `t${id}`,
      transactionId: id,
      pageLabel: line.pageLabel!,
      platform,
      platformRef: ref?.ref ?? null,
      refLabel: fansly && ref !== null ? `#…${ref.ref.slice(-4)}` : null,
      kind: line.kind,
      siteWords: siteWordsOf(platform, line.kind),
      fan: fans.get(id) ?? { fanRef: null, name: null, username: null },
      occurredAt: line.occurredAt ?? new Date(0).toISOString(),
      netMills: line.netMills,
      grossMills: fansly || ref === null ? null : ref.grossMills,
      rule: { owner: rule, reason: line.rule.reason, words: ruleWords },
      owner: current,
      statement: line.statement,
      reasonWords: reason,
      ticked: amount > 0,
      amountMills: amount,
      before: null,
      late: isLate,
      ask: askWire,
      incoming: incomingWire,
      proposal: proposalWire,
      note: noteText === null ? null : { text: noteText, by: noteBy, byName: noteBy === "agent" ? "Генгар" : people.nameOf(me) },
      sighting: null,
      editable: editable && !isLate,
      canNote: canNote && !isLate,
      attention,
      choices: editable && !isLate ? choicesOf(line, current) : [],
      foundByHub: foundIds.has(id),
    };
  };

  /** What a row's «чья» menu offers, and whom each choice would ask (R-board §3, §4; arena round 3: the board on both sides). */
  function choicesOf(line: HandinVersionLine, current: ShiftReportOwner): NonNullable<ShiftReportRow["choices"]> {
    const rule = ruleOwner(line, people, me);
    const is = (one: ShiftReportOwner) => sameOwner(one, current);
    const hintOf = (one: ShiftReportOwner, asks: { words: string } | null) => (sameOwner(one, rule) ? "по правилу" : asks?.words ?? "");
    const askOf = (userId: number | null, pot: boolean): { to: "colleague" | "decider"; user: ReturnType<People["person"]> | null; words: string } | null => {
      if (pot) return { to: "decider", user: null, words: `решит ${decider.words}` };
      if (userId === null) return null;
      if (!onBoard(userId)) return { to: "decider", user: people.person(userId), words: `${people.nameOf(userId)} сдаёт смену по-старому, решит ${decider.words}` };
      return { to: "colleague", user: people.person(userId), words: `спросим ${personNameForms(people.nameOf(userId)).acc}` };
    };
    if (line.group !== "mine") {
      // Someone else's sale: «Моя» and «Пополам с <держатель>» only, each a question (a nobody's sale is mine at once,
      // with the one line of why the server asks for). A sale that waits for its PPV's sender is that colleague's.
      const holder = line.rule.toUserId ?? (line.rule.home === "waiting" ? line.rule.senderUserId : null);
      const pot = line.rule.home === "pot" || line.rule.home === "decide";
      const mine = owner("me", null, people, me);
      const out = [{ owner: mine, asks: askOf(holder, pot && holder === null), hint: "", current: is(mine) }];
      if (holder !== null) {
        const half = owner("share", holder, people, me);
        out.push({ owner: half, asks: askOf(holder, false), hint: "", current: is(half) });
      }
      return out.map((one) => ({ ...one, hint: hintOf(one.owner, one.asks) }));
    }
    // One's own sale: «Моя», «Пополам с <каждый коллега>», «<коллега>», «Общак», «Ничья»; with a colleague without the
    // board «пополам» and «отдать» go to the decider.
    const out: NonNullable<ShiftReportRow["choices"]> = [];
    const mine = owner("me", null, people, me);
    out.push({ owner: mine, asks: null, hint: hintOf(mine, null), current: is(mine) });
    for (const colleague of colleagues) {
      const half = owner("share", colleague.userId, people, me);
      const asks = onBoard(colleague.userId) ? null : askOf(colleague.userId, false);
      out.push({ owner: half, asks, hint: hintOf(half, asks), current: is(half) });
    }
    for (const colleague of colleagues) {
      const theirs = owner("user", colleague.userId, people, me);
      const asks = onBoard(colleague.userId) ? null : askOf(colleague.userId, false);
      out.push({ owner: theirs, asks, hint: hintOf(theirs, asks), current: is(theirs) });
    }
    const pot = owner("pot", null, people, me);
    out.push({ owner: pot, asks: null, hint: `решит ${decider.words}`, current: is(pot) });
    const nobody = owner("nobody", null, people, me);
    out.push({ owner: nobody, asks: null, hint: hintOf(nobody, null), current: is(nobody) });
    return out;
  }

  const sightingRow = (one: SaleSightingRow): ShiftReportRow => {
    const label = catalog.labelOf.get(one.pageId) ?? String(one.pageId);
    const platform = platformOf(catalog.info.get(label)?.platform);
    const added = one.addedHandinId !== null && one.addedHandinId === handin?.id;
    // Added, it counts on the board while it is edited; a version takes it only once Hub holds the sale.
    const counts = added && (phase === "draft" || phase === "fixing");
    return {
      key: `s${one.id}`,
      transactionId: null,
      pageLabel: label,
      platform,
      platformRef: one.platformRef,
      refLabel: platform === "fansly" ? `#…${one.platformRef.slice(-4)}` : null,
      kind: one.kind,
      siteWords: siteWordsOf(platform, one.kind),
      fan: { fanRef: one.fanRef, name: one.fanName, username: one.fanRef },
      occurredAt: one.occurredAt.toISOString(),
      netMills: one.netMills,
      grossMills: platform === "fansly" ? null : one.grossMills,
      rule: { owner: owner("me", null, people, me), reason: "sighting", words: "Hub не поймал" },
      owner: added ? owner("me", null, people, me) : { ...owner("me", null, people, me), words: "нет в Hub" },
      statement: null,
      reasonWords: added ? "добавили вы, Hub сверит" : "Hub не поймал",
      ticked: counts,
      amountMills: counts ? one.netMills : 0,
      before: null,
      late: false,
      ask: null,
      incoming: null,
      proposal: null,
      note: null,
      sighting: { id: one.id, seenAt: one.firstSeenAt.toISOString(), added },
      editable: false,
      canNote: false,
      attention: !added,
    };
  };

  const beforeRow = (sale: (typeof before)[number]): ShiftReportRow => {
    const platform = platformOf(sale.platform);
    const ref = refs.get(sale.transactionId) ?? null;
    const holder = sale.home?.shares[0]?.userId ?? null;
    const whose = holder === null ? owner("nobody", null, people, me) : subject.userIds.includes(holder) ? owner("me", null, people, me) : owner("user", holder, people, me);
    return {
      key: `t${sale.transactionId}`,
      transactionId: sale.transactionId,
      pageLabel: sale.pageLabel,
      platform,
      platformRef: ref?.ref ?? null,
      refLabel: platform === "fansly" && ref !== null ? `#…${ref.ref.slice(-4)}` : null,
      kind: sale.kind,
      siteWords: siteWordsOf(platform, sale.kind),
      fan: sale.fan,
      occurredAt: sale.occurredAt.toISOString(),
      netMills: sale.netMills,
      grossMills: platform === "fansly" || ref === null ? null : ref.grossMills,
      rule: { owner: whose, reason: sale.home?.reason ?? "", words: holder === null ? "" : `смена ${personNameForms(people.nameOf(holder)).gen}` },
      owner: whose,
      statement: null,
      reasonWords: holder === null ? "" : `смена ${personNameForms(people.nameOf(holder)).gen}`,
      ticked: false,
      amountMills: 0,
      before: { user: holder === null ? null : people.person(holder) },
      late: false,
      ask: null,
      incoming: null,
      proposal: null,
      // The shift before wrote why: the next one reads it at once.
      note: (() => {
        const written = beforeNotes.get(sale.transactionId);
        return written === undefined ? null : { text: written.note, by: subject.userIds.includes(written.userId) ? "person" as const : "other" as const, byName: people.nameOf(written.userId) };
      })(),
      sighting: null,
      editable: false,
      canNote: false,
      attention: false,
    };
  };

  const byTimeDesc = (a: ShiftReportRow, b: ShiftReportRow) => b.occurredAt.localeCompare(a.occurredAt);
  const allRows = [...base.map((line) => rowOf(line, "base")), ...late.map((line) => rowOf(line, "late")), ...sightings.map(sightingRow)];
  // The sums as a version makes them (`reportSums`): «мимо площадки» the owner confirmed counts on its page — what the
  // board shows and what «Подтверждаю» signs are one number. A reader cut to their pages never sees «мимо площадки».
  const offPlatform = cut !== null || handin === null ? [] : offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf)
    .filter((line) => line.pageLabel == null || visible(line.pageLabel));
  const sums = reportSums(allRows.map((row) => ({ pageLabel: row.pageLabel, amountMills: row.amountMills })), labels, offPlatform);
  const columns = labels.map((label) => {
    const rows = allRows.filter((row) => row.pageLabel === label).sort(byTimeDesc);
    const folded = before.filter((sale) => sale.pageLabel === label).map(beforeRow).sort(byTimeDesc);
    const holders = [...new Set(folded.flatMap((row) => (row.before?.user ? [row.before.user.userId] : [])))].filter((id) => !subject.userIds.includes(id));
    return {
      pageLabel: label,
      platform: platformOf(catalog.info.get(label)?.platform),
      pageHandle: null,
      modelName: catalog.info.get(label)?.modelName ?? null,
      rows,
      before: { count: folded.length, until: subject.shift.startedAt.toISOString(), people: holders.map((id) => people.person(id)), rows: folded },
      marked: rows.filter((row) => row.ticked).length,
      of: rows.length,
      sumMills: sums.pages.find((page) => page.pageLabel === label)?.amountMills ?? 0,
      attention: rows.some((row) => row.attention),
    };
  });

  const models = new Set(labels.map((label) => catalog.info.get(label)?.modelSlug).filter((slug): slug is string => slug !== undefined));
  const offShift = [...catalog.info.entries()]
    .filter(([label, info]) => models.has(info.modelSlug) && !labels.includes(label) && visible(label))
    .map(([pageLabel, info]) => ({ pageLabel, platform: platformOf(info.platform) }))
    .sort((a, b) => a.pageLabel.localeCompare(b.pageLabel));

  const reviewed = candidate === null ? false : await hasShiftReportReviewer(db, pageIds);
  const candidateWire = candidate === null ? null : {
    id: candidate.id,
    number: candidate.number,
    madeAt: candidate.madeAt.toISOString(),
    by: candidate.door === "telegram" ? "со слов, через Генгара" : people.nameOf(candidate.actorUserId ?? me),
    door: candidate.door,
    cutoffAt: candidate.cutoffAt.toISOString(),
    count: candidate.lines.filter((line) => line.amountMills > 0).length,
    totalMills: candidate.totalMills,
    hub: hubOf(candidate),
    gengar: {
      state: gengarState({ reviewed, answeredAt: candidate.gengarAnsweredAt, clean: candidate.gengarClean, handedInAt: candidate.madeAt, now }),
      since: candidate.madeAt.toISOString(),
      answeredAt: candidate.gengarAnsweredAt?.toISOString() ?? null,
      proposals: ofCandidate.filter((one) => one.kind === "owner_change").length,
      notes: ofCandidate.filter((one) => one.kind === "note").length,
    },
    superseded: candidate.supersededAt !== null,
  };

  const flat = columns.flatMap((column) => column.rows);
  const waiting = flat.filter((row) => (row.ask !== null && (row.ask.state === "asked" || row.ask.state === "disputed"))
    || (row.incoming !== null && row.incoming.state !== "settled") || (row.sighting !== null && !row.sighting.added) || row.late)
    .map((row) => ({
      key: row.key, transactionId: row.transactionId, pageLabel: row.pageLabel, fanName: row.fan.name ?? row.fan.username, netMills: row.netMills,
      why: row.late ? "late" as const : row.ask !== null ? "ask" as const : row.incoming !== null ? "incoming" as const : "sighting" as const,
    }));
  const nowMills = sums.totalMills;
  const wasMills = phase === "confirm" && candidate !== null && candidate.totalMills !== nowMills ? candidate.totalMills
    : phase === "fixing" && latest !== null && latest.totalMills !== nowMills ? latest.totalMills : null;
  const canConfirm = own && mayAct(actor, "confirm", phase) && candidate !== null && candidate.supersededAt === null;
  const lateCards = proposals.some((one) => one.state === "late");
  const previousComment = await findPreviousShiftComment(db, { shiftId: subject.shift.id, pageLabels: shiftLabels, before: subject.shift.startedAt });
  const previousNames = previousComment === null ? new Map<number, string>() : await listHandinNames(db, [previousComment.userId]);
  const moscowToday = new Date(now.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10);
  const reportDay = latest?.reportDate ?? handin?.reportDate ?? subject.shift.reportDate;
  const copied = handin?.postCopiedVersion == null ? null : input.versions.find((version) => version.version === handin.postCopiedVersion) ?? null;
  return {
    phase,
    chip: SHIFT_REPORT_PHASE_CHIPS[phase],
    offShift,
    columns,
    candidate: candidateWire,
    totals: { count: flat.filter((row) => row.ticked).length, nowMills, wasMills },
    waiting,
    colleagues: colleagues.map((one) => ({ userId: one.userId, name: one.name, forms: personNameForms(one.name) })),
    decider,
    canConfirm,
    needsMe: own && (phase === "confirm" || flat.some((row) => row.late || (row.incoming?.canAnswer ?? false)) || lateCards),
    handedInAt: candidate?.madeAt.toISOString() ?? null,
    countedAt: latest?.submittedAt.toISOString() ?? null,
    preview,
    previous: previousComment === null ? null : {
      user: { userId: previousComment.userId, name: previousNames.get(previousComment.userId) ?? `#${previousComment.userId}`, forms: personNameForms(previousNames.get(previousComment.userId) ?? `#${previousComment.userId}`) },
      comment: previousComment.comment,
      at: previousComment.at.toISOString(),
    },
    post: !own || latest === null ? null : {
      copiedAt: handin?.postCopiedAt?.toISOString() ?? null,
      seen: input.postSeen ?? null,
      changedSinceCopy: copied !== null && copied.version !== latest.version && postPagesDiffer(copied.pages, latest.pages),
      // Each model's post by its own button: copied or not, and changed since on that model's pages.
      models: (input.posts ?? []).map((post) => {
        const copy = (input.postCopies ?? []).find((one) => one.modelSlug === post.modelSlug) ?? null;
        const from = copy === null ? null : input.versions.find((version) => version.version === copy.version) ?? null;
        const ofModel = (pages: ReadonlyArray<{ pageLabel: string; amountMills: number }>) => pages.filter((page) => catalog.info.get(page.pageLabel)?.modelSlug === post.modelSlug);
        return {
          modelSlug: post.modelSlug, modelName: post.modelName, copiedAt: copy?.copiedAt.toISOString() ?? null,
          changedSinceCopy: from !== null && from.version !== latest.version && postPagesDiffer(ofModel(from.pages), ofModel(latest.pages)),
        };
      }),
      // The ledger's post reader refuses a post whose date is more than a day behind (`date_mismatch`): warn before copying.
      late: Date.parse(`${moscowToday}T00:00:00Z`) - Date.parse(`${reportDay}T00:00:00Z`) > DAY_MS,
    },
  };
}

/** Whether two versions' page sums differ (what a post's lines say). Pure. */
export function postPagesDiffer(a: ReadonlyArray<{ pageLabel: string; amountMills: number }>, b: ReadonlyArray<{ pageLabel: string; amountMills: number }>): boolean {
  const of = (pages: ReadonlyArray<{ pageLabel: string; amountMills: number }>) => new Map(pages.filter((page) => page.amountMills !== 0).map((page) => [page.pageLabel, page.amountMills]));
  const left = of(a);
  const right = of(b);
  return left.size !== right.size || [...left].some(([label, amount]) => right.get(label) !== amount);
}

function askState(claim: SaleClaimRow): "asked" | "agreed" | "disputed" | "silence" | "decided" | "withdrawn" {
  if (claim.state === "withdrawn") return "withdrawn";
  if (claim.state === "decided") return "decided";
  if (claim.state === "agreed") return claim.silenceAt !== null ? "silence" : "agreed";
  if (claim.state === "owner" && claim.answer === "disagree") return "disputed";
  return "asked";
}

function wordOwner(word: ProposalRow["fromWord"], userId: number | null, line: HandinVersionLine, people: People, me: number): ShiftReportOwner {
  switch (word) {
    case "mine": return owner("me", null, people, me);
    case "share": return owner("share", userId, people, me);
    case "give": return owner("user", userId, people, me);
    case "pot": return owner("pot", null, people, me);
    case "not_mine": return owner("nobody", null, people, me);
    default: return ruleOwner(line, people, me);
  }
}

/** Hub's check of a candidate as the board says it. */
export function hubOf(candidate: Pick<CandidateRow, "hubCheck">): NonNullable<ShiftReportBoard["candidate"]>["hub"] {
  const pages = candidate.hubCheck.map((page) => ({ ...page, at: page.at ?? null }));
  const any = (state: string) => pages.some((page) => page.state === state);
  // «сошлись» only when every page proved it: no pages (nothing asked) is «Hub не сверил», never «сошлись».
  const state = pages.length === 0 ? "unchecked" as const
    : any("running") ? "running" as const : any("statement") ? "statement" as const : any("unchecked") ? "unchecked" as const : any("found") ? "found" as const : "matched" as const;
  return {
    state,
    pages,
    foundCount: pages.reduce((sum, page) => sum + page.foundCount, 0),
    foundMills: pages.reduce((sum, page) => sum + page.foundMills, 0),
  };
}

/** Whether Hub's check of a candidate is still reading a page. */
export function hubPending(candidate: Pick<CandidateRow, "hubCheck">): boolean {
  return candidate.hubCheck.some((page) => page.state === "running" || page.state === "statement");
}

/**
 * The cards of «отдать» whose colleague hands shifts in the old way (no board): by transaction, the colleague. Such a gift
 * is the decider's (a Telegram post knows decisions, not agreements): it is never settled in the colleague's favour.
 */
export async function oldWayGives(db: Database, proposals: ReadonlyArray<Pick<ProposalRow, "kind" | "toWord" | "toUserId" | "transactionId">>): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const proposal of proposals) {
    if (proposal.kind !== "owner_change" || proposal.toWord !== "give" || proposal.toUserId === null) continue;
    const colleague = await findHandinPersonOfUser(db, proposal.toUserId);
    if (colleague?.submitsShiftSince == null) out.set(proposal.transactionId, proposal.toUserId);
  }
  return out;
}

/**
 * What «Подтверждаю» would sign now: the ONE computation the board shows in «Подтвердите» and `confirmShiftReport`
 * writes, so the person signs exactly what they see. The lines (`signedLines`: settlements as of now, the person's
 * comments now, the cards kept), «мимо площадки» with the owner's confirmed sums on their pages, the page sums, the
 * total and the count. `db` — the caller's transaction (the confirmation's turn) or the pool (the board's read).
 */
export async function signableOf(db: Database, input: { subject: Subject; catalog: PageCatalog; handin: HandinRow; candidate: CandidateRow }) {
  const { subject, catalog, handin, candidate } = input;
  const proposals = (await listHandinProposals(db, handin.id)).filter((one) => one.candidateId === candidate.id);
  const applied = proposals.filter((one) => one.state === "proposed");
  const marks = await listHandinMarks(db, handin.id);
  const draft = draftLines(await draftFacts(db, subject, handin, catalog, candidate.cutoffAt, marks), marks);
  const oldWay = await oldWayGives(db, applied);
  const lines = signedLines({ candidate: candidate.lines, draft, proposals, notes: new Map(marks.map((mark) => [mark.transactionId, mark.note])), oldWay });
  const offPlatform = offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf);
  const sums = linesPageSums(lines, candidate.pages.map((page) => page.pageLabel), offPlatform);
  return { lines, offPlatform, sums, count: lines.filter((line) => line.amountMills > 0).length, proposals, applied, oldWay };
}
