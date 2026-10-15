import type { SyncBlocksPage } from "@agency_hub_core/contracts";

import type { PageStatus } from "../sync/SyncPageParts.js";
import {
  engineBlockLabel,
  engineBlockOrder,
  engineBlockState,
  engineStateLabel,
  isEngineBlock,
  type EngineBlock,
} from "./engineBlockDisplay.js";
import { browserHeadline } from "./engineBrowserDisplay.js";
import {
  engineAgeText,
  engineReadingTone,
  isCredentialsStop,
  type EngineReadingState,
  type EngineStatusState,
} from "./engineDisplay.js";

// A Fansly page in one line, and the developer's commands of the screen.
// The line is what the owner reads first on the page's card and detail:
// «Работает», «На паузе», «Нужен вход», «Нет прокси», «Отстаёт», «Не
// читается» — each from the server's facts the screen already shows below.

function engineBlocksOf(page: SyncBlocksPage): EngineBlock[] {
  return engineBlockOrder().map((key) => page.blocks[key]).filter(isEngineBlock);
}

function blocksPhrase(blocks: readonly EngineBlock[]): string {
  const quoted = blocks.map((block) => `«${engineBlockLabel(block.block)}»`);
  return `${quoted.length === 1 ? "блок" : "блоки"} ${quoted.join(", ")}`;
}

/** The browser login is how a page with a server browser gets a new session. */
export function engineLoginNeeded(page: SyncBlocksPage, state: EngineStatusState): boolean {
  const browser = state.kind === "ready" ? state.status.browser : undefined;
  if (browser?.login.needed) return true;
  return engineBlocksOf(page).some((block) => block.engine.stops.some(isCredentialsStop));
}

/** A page with a server browser: its login is the way to new credentials. */
export function engineHasBrowser(state: EngineStatusState): boolean {
  return state.kind === "ready" && state.status.browser !== undefined;
}

/**
 * What a Fansly page is now, in one line, first match: it needs a login
 * (Fansly refuses its credentials or signed its browser out); its browser's
 * proxy fails; nothing reads it; it is switching; every block is paused by
 * the owner; something holds it or needs the owner; it works.
 */
export function enginePageStatus(page: SyncBlocksPage, state: EngineStatusState, now: number = Date.now()): PageStatus {
  const blocks = engineBlocksOf(page);
  const browser = state.kind === "ready" ? state.status.browser : undefined;

  if (browser?.login.needed) {
    return {
      kind: "login",
      label: "Нужен вход",
      tone: "danger",
      reason: browser.login.why === "login_required"
        ? "Fansly вышел из аккаунта в браузере страницы"
        : "Fansly не принимает сессию браузера",
    };
  }
  if (blocks.some((block) => block.engine.stops.some(isCredentialsStop))) {
    return { kind: "login", label: "Нужен вход", tone: "danger", reason: "Fansly не принимает данные входа — ничего не читается" };
  }
  if (browser !== undefined && browser.transport === "browser" && (browser.proxy.problem === "unavailable" || browser.proxy.problem === "auth")) {
    return {
      kind: "proxy",
      label: "Нет прокси",
      tone: "danger",
      reason: browser.proxy.problem === "auth" ? "прокси не принимает вход" : "прокси недоступен",
    };
  }
  if (state.kind === "loading") return { kind: "loading", label: "Загружаем…", tone: "neutral", reason: null };
  if (state.kind === "error") return { kind: "unknown", label: "Нет данных", tone: "neutral", reason: "состояние сбора не загрузилось" };
  if (state.kind === "idle") {
    return { kind: "off", label: "Не читается", tone: "warning", reason: "сбор Fansly эту страницу не ведёт" };
  }

  const { status } = state;
  if (!status.owner.running) {
    const age = engineAgeText(status.owner.heartbeatAt, now);
    return {
      kind: "off",
      label: "Не читается",
      tone: "danger",
      reason: status.mode === "handover"
        ? "страница переключается на новый сбор"
        : age === null ? "обработчик сбора не запущен" : `обработчик сбора не отвечает ${age}`,
    };
  }
  if (status.mode === "handover") {
    return { kind: "switching", label: "Переключается", tone: "warning", reason: "страница переходит на новый сбор" };
  }

  const states = blocks.map((block) => [block, engineBlockState(block)] as const);
  if (states.length > 0 && states.every(([, blockState]) => blockState === "paused")) {
    return { kind: "paused", label: "На паузе", tone: "neutral", reason: "пауза владельца" };
  }

  const troubled = states.filter(([, blockState]) => engineReadingTone(blockState) === "warn");
  if (status.holds.page !== null || troubled.length > 0) {
    const first = troubled[0];
    return {
      kind: "lagging",
      label: "Отстаёт",
      tone: "warning",
      // One block: what is true of it; several: which (each says its own below).
      reason: first === undefined
        ? "сбор удерживает страницу"
        : troubled.length === 1
          ? `${blocksPhrase([first[0]])}: ${lowerFirst(engineStateLabel(first[1]))}`
          : blocksPhrase(troubled.map(([block]) => block)),
    };
  }
  if (browser !== undefined && browser.transport === "browser") {
    const headline = browserHeadline(browser);
    if (headline.tone === "warn" || headline.tone === "danger") {
      return { kind: "lagging", label: "Отстаёт", tone: "warning", reason: `браузер: ${headline.text}` };
    }
  }

  const paused = states.filter(([, blockState]) => isPaused(blockState)).map(([block]) => block);
  const lastSend = engineAgeText(status.pause.lastSendAt, now);
  return {
    kind: "working",
    label: "Работает",
    tone: "success",
    reason: paused.length > 0
      ? `на паузе: ${blocksPhrase(paused)}`
      : lastSend === null ? null : `последний запрос ${lastSend} назад`,
  };
}

function isPaused(state: EngineReadingState): boolean {
  return state === "paused" || state === "partly_paused";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// ── «Для разработчика» ───────────────────────────────────────────────────────

export interface EngineDevCommand {
  label: string;
  command: string;
}

/**
 * The server console's commands for what the screen shows of a page: the
 * work in quarantine, the keys Fansly refuses, the chats Fansly does not
 * serve, and the page's browser. They are said once, in the screen's
 * «Для разработчика», never in the owner's lines.
 */
export function engineDevCommands(page: SyncBlocksPage, state: EngineStatusState): EngineDevCommand[] {
  const label = page.pageLabel;
  const list = `pnpm cli sync work list --page ${label}`;
  const blocks = engineBlocksOf(page);
  const status = state.kind === "ready" ? state.status : null;
  const commands: EngineDevCommand[] = [];
  if (blocks.some((block) => block.engine.quarantined.count > 0) || (status?.quarantined ?? 0) > 0) {
    commands.push({ label: "Работа в карантине", command: `${list} --state quarantined` });
  }
  const refused = [...new Set(blocks.flatMap((block) => block.engine.blockedByVendor.resources))];
  for (const resource of refused) {
    commands.push({ label: `Fansly отказывает: ${resource}`, command: `${list} --state open --resource ${resource}` });
  }
  if (blocks.some((block) => (block.engine.chatsUnavailable ?? 0) > 0)) {
    commands.push({ label: "Чаты, которые Fansly не отдаёт", command: `pnpm cli sync chats unavailable --page ${label}` });
  }
  if (status?.browser !== undefined && status !== null) {
    commands.push(
      { label: "Состояние браузера", command: `pnpm cli sync browser status --page ${label}` },
      { label: "Запустить браузер", command: `pnpm cli sync browser start ${label}` },
      { label: "Остановить браузер", command: `pnpm cli sync browser stop ${label}` },
      { label: "Самопроверка браузера", command: `pnpm cli sync browser selftest ${label}` },
    );
  }
  return commands;
}
