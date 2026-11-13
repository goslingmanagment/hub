import {
  MATTER_INFO_KINDS, WAITING_GROUPS, waitingGroupLink, waitingGroupOf, waitingToneOf, worstWaitingTone, type KernelOperationResponse, type Matter,
} from "@agency_hub_core/contracts";

import { formatDay } from "@agency_hub_core/look/format";

import { isDemoReply, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_USERS } from "../world.ts";
import { demoClaimMatters } from "./sale-claims.ts";
import { teamQuestionsHandlers } from "./team-questions.ts";
import { demoReportDays } from "./team-reports.ts";
import { DAY, HOUR, MIN, isoAt, viewerPages } from "./team-world.ts";
import { wbHeldHandlers } from "./wb-admin.ts";

/**
 * Дела of the invented agency (packages D and K): «Ждут вас» as one list. The
 * owner's matters are the old sections of «Решения» (the same questions and
 * held sends as their own fixtures, so a line shows their words), the
 * console's rows, and the new checks: people and access, the ledger's.
 * The cookie `hub-demo-scenario` picks how many: `matters-0`, `matters-6`,
 * `matters-40`. Without it, every matter of the agency as it stands
 * (about a dozen). Invented names and sums only.
 */

type ListAnswer = KernelOperationResponse<"mattersList">;
type WaitingAnswer = KernelOperationResponse<"mattersWaiting">;

const OWNER_ROLE = { kind: "role" as const, role: "owner" as const };
const LEAD_ROLE = { kind: "role" as const, role: "team_lead" as const };
const CHAT = "https://t.me/c/1000000000/57";

interface Seed {
  kind: string;
  key: string;
  title: string;
  pages?: string[];
  owner?: Matter["owner"];
  money?: boolean;
  evidence?: Record<string, unknown>;
  link?: string | null;
  object?: Matter["object"];
  /** How long ago it was opened. */
  agoMs: number;
}

function matterOf(seed: Seed, id: number, now: number): Matter {
  const opened = isoAt(now - seed.agoMs);
  return {
    id,
    key: seed.key,
    kind: seed.kind,
    source: seed.kind.startsWith("ledger.") ? "ledger" : seed.kind.startsWith("contentops.") ? "contentops" : seed.kind === "agent.reminder" ? "agent" : "server",
    state: "open",
    closedHow: null,
    title: seed.title,
    object: seed.object ?? null,
    pageLabels: seed.pages ?? [],
    owner: seed.owner ?? OWNER_ROLE,
    watcherUserIds: [],
    mine: false,
    money: seed.money ?? false,
    evidence: seed.evidence ?? {},
    link: seed.link ?? null,
    openedAt: opened,
    lastSeenAt: isoAt(now - MIN),
    closedAt: null,
  };
}

/** The agency's matters as they stand: the old queues from their own fixtures, then the rest. */
function standing(request: DemoRequest): Seed[] {
  const now = request.now.getTime();
  const seeds: Seed[] = [];
  const ownerRequest: DemoRequest = { ...request, role: "owner", query: {} };
  const questions = teamQuestionsHandlers.teamLedgerQuestions?.(ownerRequest);
  if (questions && !isDemoReply(questions)) {
    for (const question of questions.owner) {
      seeds.push({
        kind: "ledger.sale_question", key: `ledger.sale_question:${question.id}`, title: `Вопрос «чья продажа» №${question.id}: ${question.pageLabel}`,
        pages: question.pageLabel ? [question.pageLabel] : [], money: question.netMills !== null,
        evidence: { questionId: question.id, askedAt: question.askedAt, occurredAt: question.occurredAt, netMills: question.netMills },
        link: "/workboard/decisions#questions", agoMs: now - Date.parse(question.askedAt),
      });
    }
  }
  // Заявки (package G): the owner's disputes, «мимо площадки», the week's nobody's sales; the chatter's claims to answer.
  seeds.push(...demoClaimMatters(request.now));
  seeds.push({
    kind: "ledger.report_post", key: "ledger.report_post:8812", title: "Пост в «Отчётности» не разобран", pages: ["mia-1"], money: true,
    evidence: { postId: 8812, reportDate: isoAt(now - 3 * DAY).slice(0, 10), postedAt: isoAt(now - 2.2 * DAY), flags: ["unknown_author"], totalMills: 124_200, telegram: CHAT },
    link: "/workboard/decisions#reports", agoMs: 2.2 * DAY,
  });
  seeds.push({
    kind: "ledger.paid_day_changed", key: "ledger.paid_day_changed:77", title: "Выплаченный день изменён: kate.v", money: true,
    evidence: { changeId: 77, day: isoAt(now - 11 * DAY).slice(0, 10), model: "Mia", person: "kate-v", postedMills: 38_000, newMills: 43_000 },
    link: "/workboard/payouts?person=kate-v", agoMs: 1.3 * DAY,
  });
  const held = wbHeldHandlers.clientSendCustodyList?.({ ...ownerRequest, query: { state: "held", limit: "100", offset: "0" } });
  if (held && !isDemoReply(held)) {
    for (const send of held.items) {
      seeds.push({
        kind: "send.held", key: `send.held:${send.attemptId}`, title: `Отправка без отчёта: ${send.pageLabel}`, pages: [send.pageLabel], owner: LEAD_ROLE,
        evidence: { attemptId: send.attemptId, purpose: send.purpose, partIndex: send.partIndex, partCount: send.partCount, sentBy: send.username, sentAt: send.createdAt },
        link: `/workboard/decisions?send=${send.attemptId}#held`, agoMs: now - Date.parse(send.createdAt),
      });
    }
  }
  seeds.push(
    { kind: "publication.draft", key: "publication.draft:5101", title: "Пост на утверждение: mia-1", pages: ["mia-1"], link: "/content/publications?status=draft&window=all&page=all", agoMs: 5 * HOUR },
    { kind: "people.login_unlinked", key: "people.login_unlinked:12", title: "Вход без человека: tester.q", evidence: { userId: 12, username: "tester.q", namesake: { person: "tester-q", name: "Тестер", state: "left", leftOn: isoAt(now - 40 * DAY).slice(0, 10) } }, link: "/workboard/people/12/access", agoMs: 6 * DAY },
    { kind: "people.page_without_access", key: "people.page_without_access:olya-m", title: "Работает без доступа: Оля, mia-of", pages: ["mia-of"], evidence: { person: "olya-m", pages: ["mia-of"], logins: ["olya.m"] }, link: "/workboard/people/7/access", agoMs: 20 * HOUR },
    {
      kind: "ledger.check", key: "ledger.check:card_cover", title: "Проверка ledger не проходит: карты покрывают списания", money: true,
      evidence: { check: "card_cover", name: "карты покрывают списания", severity: "warn", summary: "карта •0042: на счёте 5.40, к списанию 120.00 до 14.11, не хватает 114.60", failingSince: isoAt(now - 1.6 * DAY) },
      agoMs: 0.6 * DAY,
    },
    { kind: "page.login_needed", key: "page.login_needed:nova-1", title: "Нужен вход в Fansly: nova-1", pages: ["nova-1"], link: "/settings/pages/nova-1/login", agoMs: 3 * HOUR },
    { kind: "incident.open", key: "incident.open:901", title: "Сбой: Сбор сообщений mia-2 стоит 2 часа", pages: ["mia-2"], evidence: { openedAt: isoAt(now - 2 * HOUR) }, link: "/system/failures?page=all", agoMs: 2 * HOUR },
    // ContentOps' findings (its hub-orders/matters.ts): a custom's copy outside the customs folder, a custom in the plan.
    {
      kind: "contentops.custom_copy", key: "contentops.custom_copy:demo-case-1", title: "Копия кастома CUS-217 лежит вне папки кастомов: Фото/2026-11/IMG_0412.jpg",
      object: { type: "contentops_case", id: "demo-case-1" },
      evidence: { model: "mia-hart", custom: "CUS-217", path: "Фото/2026-11/IMG_0412.jpg", source: "yadisk", seenAt: isoAt(now - 26 * HOUR), rule: "кастом и всё, что из него сделано, не ставится в фуп, сториз и на стену без цены" },
      agoMs: 26 * HOUR,
    },
    {
      kind: "contentops.custom_in_plan", key: "contentops.custom_in_plan:demo-row-1", title: "В плане ContentOps VID-88 из CUS-203 стоит на стене без цены: mia-1 · стена · завтра 18:00",
      pages: ["mia-1"], object: { type: "contentops_plan_row", id: "demo-row-1" },
      evidence: { model: "mia-hart", item: "VID-88", custom: "CUS-203", account: "mia-1", surface: "wall", slot: `${isoAt(now + DAY).slice(0, 10)} 18:00` },
      agoMs: 4 * HOUR,
    },
    { kind: "agent.reminder", key: "agent.reminder:owner-1", title: "Генгар: цены на mia-2 не меняли 30 дней, пересмотрите перед выходными", pages: ["mia-2"], agoMs: 9 * HOUR },
    {
      kind: "people.access_idle", key: "people.access_idle:all", title: "Доступ без работы 30 дней: 3 страницы у 2 человек",
      evidence: { days: 30, activitySince: null, people: [{ person: "ivan-p", name: "Иван", pages: ["mia-of", "mia-vip-of"] }, { person: "kate-v", name: "Катя", pages: ["nova-1"] }] },
      link: "/workboard/people", agoMs: 4 * DAY,
    },
  );
  return seeds;
}

/** More of the same kinds, for a full screen (`matters-40`). */
function filler(count: number): Seed[] {
  const pages = ["mia-1", "mia-2", "mia-3", "nova-1", "ivy-1", "ivy-2", "mia-of", "mia-vip-of"];
  const out: Seed[] = [];
  for (let index = 0; index < count; index += 1) {
    const page = pages[index % pages.length]!;
    const pick = index % 5;
    if (pick === 0) out.push({ kind: "publication.draft", key: `publication.draft:${6000 + index}`, title: `Пост на утверждение: ${page}`, pages: [page], link: "/content/publications?status=draft&window=all&page=all", agoMs: (index + 1) * 47 * MIN });
    else if (pick === 1) out.push({ kind: "incident.open", key: `incident.open:${1000 + index}`, title: `Сбой: Сбор подписчиков ${page} не отвечает`, pages: [page], link: "/system/failures?page=all", agoMs: (index + 2) * 31 * MIN });
    else if (pick === 2) out.push({ kind: "people.agent_key_expiring", key: `people.agent_key_expiring:${30 + index}`, title: `Ключ агента истекает ${String(13 + (index % 6)).padStart(2, "0")}.11: агент-${index}`, link: "/system/agent-keys", agoMs: (index + 1) * 2 * HOUR });
    else if (pick === 3) out.push({ kind: "ledger.off_platform", key: `ledger.off_platform:${400 + index}`, title: `Мимо площадки, ${8 + (index % 5)} дней не в отчёте: ${page}`, pages: [page], money: true, evidence: { decisionId: 400 + index, netMills: 50_000 + index * 1000, saidBy: "alex.k", telegram: CHAT }, agoMs: (8 + (index % 5)) * DAY });
    else out.push({ kind: "agent.reminder", key: `agent.reminder:fill-${index}`, title: `Генгар: фан с ${page} ждёт ответа на вопрос о цене`, pages: [page], agoMs: (index + 3) * 23 * MIN });
  }
  return out;
}

/** The owner's six: one of each sort, for a calm screen (`matters-6`). */
function six(seeds: readonly Seed[]): Seed[] {
  const want = ["ledger.sale_question", "publication.draft", "send.held", "people.page_without_access", "ledger.check", "incident.open"];
  return want.map((kind) => seeds.find((seed) => seed.kind === kind)).filter((seed): seed is Seed => seed !== undefined);
}

/** The matters the demo's viewer reads, by the server's rule: the owner every one, a team lead their role's on their pages, a chatter their own. */
function visible(request: DemoRequest): Matter[] {
  const now = request.now.getTime();
  const scenario = request.scenario ?? "";
  const all = standing(request);
  let seeds: Seed[];
  if (scenario === "matters-0") seeds = [];
  else if (scenario === "matters-6") seeds = six(all);
  else if (scenario === "matters-40") seeds = [...all, ...filler(Math.max(0, 40 - all.length))];
  else seeds = all;
  const chatter = DEMO_USERS.find((user) => user.role === "chatter" && user.active)!;
  if (scenario !== "matters-0") {
    // The chatter's own: one in the calm scenario, five otherwise (the strip shows three and unfolds the rest).
    const own = [
      ["Генгар: ответьте в «Обучалке» про смену 10 нояб.", 5 * HOUR],
      ["Отдайте фану Dennis кастом CUS-0014: файл у вас в «Кастомах»", 9 * HOUR],
      ["Генгар: уточните у фана Ivan K. цену за видео до вечера", 26 * HOUR],
      ["Генгар: фан Lars P. ждёт ответа про оплату после выходных", 2 * DAY],
      ["Проверьте, ушло ли приветствие фану Theo C.", 40 * MIN],
    ] as const;
    for (const [index, [title, agoMs]] of own.slice(0, scenario === "matters-6" ? 1 : own.length).entries()) {
      seeds.push({
        kind: "agent.reminder", key: `agent.reminder:${chatter.username}-${index}`, title, pages: ["mia-1"],
        owner: { kind: "user", userId: chatter.id, username: chatter.username, displayName: chatter.name }, agoMs,
      });
    }
    // Their post in «Отчётность» whose sum the ledger cannot accrue (`report.post_fix`): the newest posted day before
    // the shifts were handed in at Hub (5 days, shift-reports.ts), whose row in «Мои смены» opens to the post.
    const handedFrom = isoAt(now - 5 * DAY).slice(0, 10);
    const changed = demoReportDays(request.now)
      .filter((day) => day.user.id === chatter.id && day.date < handedFrom && day.pages.some((one) => one.postedMills !== null))
      .sort((left, right) => right.date.localeCompare(left.date))[0];
    if (changed && scenario !== "matters-6") {
      seeds.push({
        kind: "report.post_fix", key: `report.post_fix:${changed.posts[0]?.id ?? 8840}`,
        title: `Отчёт за ${formatDay(`${changed.date}T12:00:00+03:00`)} не начислен: строки аккаунтов не дают итог. Поправьте пост в «Отчётности»`,
        pages: changed.pages.map((one) => one.pageLabel),
        owner: { kind: "user", userId: chatter.id, username: chatter.username, displayName: chatter.name },
        evidence: { postId: changed.posts[0]?.id ?? 8840, reportDate: changed.date, day: changed.date, flags: ["sum_mismatch"] },
        link: `/workboard/my/shifts?week=${changed.date}&report=${changed.date}`, agoMs: 4 * HOUR,
      });
    }
  }
  // What waits for the person who leads customs (the invented agency's: kate.v): the owner reads it as oversight.
  const lead = DEMO_USERS.find((user) => user.username === "kate.v")!;
  if (scenario !== "matters-0") {
    seeds.push(
      {
        kind: "custom.not_at_model", key: "custom.not_at_model:CUS-0012", title: "Кастом CUS-0012 оплачен и сутки не у модели: mia-1", pages: ["mia-1"],
        owner: { kind: "user", userId: lead.id, username: lead.username, displayName: lead.name }, link: "/workboard/customs/CUS-0012", agoMs: 26 * HOUR,
      },
      {
        kind: "custom.overdue", key: "custom.overdue:CUS-0009", title: "Кастом CUS-0009 просрочен: mia-3", pages: ["mia-3"],
        owner: { kind: "user", userId: lead.id, username: lead.username, displayName: lead.name }, link: "/workboard/customs/CUS-0009", agoMs: 2 * DAY,
      },
    );
  }
  const matters = seeds.map((seed, index) => matterOf(seed, 9000 + index, now));
  // Whose: the viewer's own user, or a role they hold. The invented agency has team leads, so the owner is not the
  // acting team lead: the team lead's matters wait for them, and the owner reads them as oversight.
  const owner = DEMO_USERS.find((user) => user.role === "owner")!;
  if (request.role === "owner") {
    return matters.map((matter) => ({ ...matter, mine: matter.owner.kind === "role" ? matter.owner.role === "owner" : matter.owner.userId === owner.id }));
  }
  const pages = viewerPages(request);
  if (request.role === "team_lead") {
    return matters.filter((matter) => !matter.money && matter.owner.kind === "role" && matter.owner.role === "team_lead"
      && (matter.pageLabels.length === 0 || matter.pageLabels.some((label) => pages?.includes(label)))).map((matter) => ({ ...matter, mine: true }));
  }
  return matters.filter((matter) => !matter.money && matter.owner.kind === "user" && matter.owner.userId === chatter.id).map((matter) => ({ ...matter, mine: true }));
}

const MIRRORED = [
  "publication.draft", "publication.unknown", "ledger.sale_question", "ledger.report_post", "ledger.paid_day_changed",
  "send.held", "page.login_needed", "incident.open", "extension.critical", "history.request",
];
const CHECKS = [
  "people.left_with_access", "people.login_unlinked", "people.no_pay_terms", "people.no_working_page", "people.page_without_access",
  "people.access_idle", "people.agent_key_expiring", "people.proposal_open", "ledger.check", "ledger.sheet_column", "ledger.off_platform",
];

function mattersList(request: DemoRequest): ListAnswer {
  const matters = visible(request);
  const counts = new Map<string, number>();
  for (const matter of matters) counts.set(matter.kind, (counts.get(matter.kind) ?? 0) + 1);
  const known = request.role === "owner" ? [...MIRRORED, ...CHECKS] : request.role === "team_lead" ? ["send.held"] : [];
  const kinds = [...new Set([...known, ...counts.keys()])].sort().map((kind) => ({
    kind,
    open: counts.get(kind) ?? 0,
    checked: known.includes(kind) ? "yes" as const : "not_mirrored" as const,
    checkedAt: known.includes(kind) ? isoAt(request.now.getTime() - MIN) : null,
  }));
  return { matters, kinds, serverNow: request.now.toISOString() };
}

function mattersWaiting(request: DemoRequest): WaitingAnswer {
  // Only what waits for the viewer themself; the owner here holds no team lead's role (the agency has team leads).
  const matters = request.role === "chatter" ? [] : visible(request).filter((matter) => matter.mine);
  // The list's groups, as Hub counts them (the one table), for every role: the Home's chips and the number.
  const waiting = matters.filter((matter) => !MATTER_INFO_KINDS.includes(matter.kind));
  const groups = request.role === "chatter" ? [] : WAITING_GROUPS.filter((group) => group.id !== "info").flatMap((group) => {
    const inGroup = waiting.filter((matter) => waitingGroupOf(matter.kind) === group.id);
    const tone = worstWaitingTone(inGroup.map((matter) => waitingToneOf(matter.kind)));
    return inGroup.length === 0 ? [] : [{ id: group.id, title: group.title, count: inGroup.length, checked: true, tone, to: waitingGroupLink(group.id) }];
  });
  return {
    active: true,
    groups,
    total: groups.reduce((sum, group) => sum + group.count, 0),
    failed: [],
    customOrders: 0,
    serverNow: request.now.toISOString(),
  };
}

export const mattersHandlers: DemoHandlers = { mattersList, mattersWaiting };
