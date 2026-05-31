import {
  AlarmClock,
  AlertTriangle,
  Archive,
  BadgeDollarSign,
  CalendarClock,
  Clock,
  Crown,
  Flame,
  HandCoins,
  HelpCircle,
  type LucideIcon,
  MessageCircle,
  MessageSquareDot,
  MoonStar,
  RefreshCwOff,
  ShieldAlert,
  Snowflake,
  Sparkles,
} from "lucide-react";

// Workboard v2 visual tone system. Mirrors the established getSyncUxTone pattern
// (class strings + token colors). Color is never the only signal — every entry
// pairs an icon and a Russian label. See docs/workboard-v2-priority-design.md §12.

export type WorkboardV2Tab = "subscribers" | "spenders" | "fresh_mass" | "old_mass" | "service";
export type SecondaryStatus = "recent_purchase" | "need_reply" | "due_now" | "later" | "dont_touch_today";
export type UrgencySeverity = "critical" | "high" | "medium" | "normal" | "muted";
export type ValueTier = "whale" | "vip" | "payer" | "new";

export const TAB_LABELS: Record<WorkboardV2Tab, string> = {
  subscribers: "Подписчики",
  spenders: "Спендеры",
  fresh_mass: "Свежие",
  old_mass: "Старая база",
  service: "Сервис",
};

export const STATUS_ORDER: SecondaryStatus[] = [
  "recent_purchase",
  "need_reply",
  "due_now",
  "later",
  "dont_touch_today",
];

interface StatusTone {
  label: string;
  icon: LucideIcon;
  dot: string;
  pill: string;
}

export const STATUS_TONES: Record<SecondaryStatus, StatusTone> = {
  recent_purchase: { label: "Недавняя покупка", icon: BadgeDollarSign, dot: "bg-accent", pill: "text-accent" },
  need_reply: { label: "Ответить", icon: MessageSquareDot, dot: "bg-accent", pill: "text-accent" },
  due_now: { label: "Срочно", icon: AlarmClock, dot: "bg-warning-dark", pill: "text-warning-dark" },
  later: { label: "Позже", icon: Clock, dot: "bg-text-secondary", pill: "text-text-secondary" },
  dont_touch_today: { label: "Не трогать сегодня", icon: MoonStar, dot: "bg-text-muted", pill: "text-text-muted" },
};

/** Left-rail border class by urgency severity (reuses RemainingBar's 1/3/7d ladder). */
export function urgencyRailClass(severity: UrgencySeverity): string {
  switch (severity) {
    case "critical":
      return "border-l-danger";
    case "high":
      return "border-l-warning-dark";
    case "medium":
      return "border-l-warning";
    case "normal":
      return "border-l-border";
    default:
      return "border-l-transparent";
  }
}

interface ChipTone {
  label: string;
  icon: LucideIcon;
  className: string;
}

export const REASON_TONES: Record<string, ChipTone> = {
  renew_off: { label: "Откл. продление", icon: RefreshCwOff, className: "bg-warning/15 text-warning-dark" },
  expires_soon: { label: "Истекает", icon: CalendarClock, className: "bg-warning/15 text-warning-dark" },
  recent_purchase: { label: "Покупка", icon: BadgeDollarSign, className: "bg-accent/15 text-accent" },
  replies_waiting: { label: "Ждёт ответа", icon: MessageSquareDot, className: "bg-accent/15 text-accent" },
  fresh_day_n: { label: "Свежий", icon: Sparkles, className: "bg-fansly/15 text-fansly" },
  vip_whale: { label: "VIP", icon: Crown, className: "bg-[#7c3aed]/12 text-[#7c3aed]" },
  freeloader: { label: "Халявщик", icon: HandCoins, className: "bg-text-muted/15 text-text-muted" },
  cooldown: { label: "Кулдаун", icon: Snowflake, className: "bg-text-muted/15 text-text-muted" },
  cold_start: { label: "Мало данных", icon: HelpCircle, className: "bg-border text-text-muted" },
  cross_page_block: { label: "Другая стр.", icon: ShieldAlert, className: "bg-text-muted/15 text-text-muted" },
  unverified: { label: "Не проверено", icon: HelpCircle, className: "bg-text-muted/10 text-text-muted" },
  // L2-intent (Haiku read the tail in context).
  buy_signal: { label: "Готов купить", icon: Flame, className: "bg-accent/15 text-accent" },
  complaint: { label: "Жалоба", icon: AlertTriangle, className: "bg-warning/15 text-warning-dark" },
};

export function reasonTone(code: string): ChipTone | null {
  return REASON_TONES[code] ?? null;
}

const VALUE_TIER_TONES: Record<ValueTier, ChipTone | null> = {
  whale: { label: "Кит", icon: Crown, className: "bg-green/15 text-green" },
  vip: { label: "VIP", icon: Crown, className: "bg-green/12 text-green" },
  payer: { label: "Платит", icon: HandCoins, className: "bg-hover-alt text-text-secondary" },
  new: null,
};

export function valueTierTone(tier: ValueTier): ChipTone | null {
  return VALUE_TIER_TONES[tier];
}

interface LifecycleTone {
  label: string;
  icon: LucideIcon;
  dot: string;
}

export const LIFECYCLE_TONES: Record<string, LifecycleTone> = {
  fresh: { label: "Свежий", icon: Sparkles, dot: "bg-fansly" },
  gray: { label: "Серый", icon: MoonStar, dot: "bg-text-muted" },
  active: { label: "Активный", icon: MessageCircle, dot: "bg-green" },
  dead: { label: "Спит", icon: MoonStar, dot: "bg-text-muted/60" },
  archived: { label: "Архив", icon: Archive, dot: "bg-text-muted/40" },
};

/** Severity → hex (for the SVG quadrant glyph fill, where Tailwind fill-utilities are unreliable). */
export const SEVERITY_HEX: Record<UrgencySeverity, string> = {
  critical: "#d14343",
  high: "#b5711a",
  medium: "#f59e0b",
  normal: "#a8a29e",
  muted: "#d6d3ce",
};

export function valueTierRadius(tier: ValueTier): number {
  return tier === "whale" ? 3 : tier === "vip" ? 2.6 : tier === "payer" ? 2.2 : 1.8;
}

interface CoverageTone {
  label: string;
  filled: number; // 0..4 dots
  className: string;
}

export function coverageTone(status: string): CoverageTone {
  switch (status) {
    case "complete":
      return { label: "Полное покрытие", filled: 4, className: "text-green" };
    case "partial_window":
      return { label: "Частичная история", filled: 2, className: "text-warning-dark" };
    default:
      return { label: "Нет истории", filled: 0, className: "text-text-muted" };
  }
}

/** Conversation-quality Q (-1..1) → short label. */
export function qualityLabel(q: number | null): { label: string; className: string } {
  if (q == null) {
    return { label: "—", className: "text-text-muted" };
  }
  if (q >= 0.5) {
    return { label: "Тёплый диалог", className: "text-green" };
  }
  if (q >= 0.2) {
    return { label: "Живой диалог", className: "text-green" };
  }
  if (q >= -0.2) {
    return { label: "Нейтральный", className: "text-text-secondary" };
  }
  return { label: "Натянутый (форсим)", className: "text-warning-dark" };
}

/** Conversation state (Haiku's read) → short label + tone. */
export function conversationStateLabel(
  state: string | null | undefined,
): { label: string; className: string } | null {
  switch (state) {
    case "buy_signal":
      return { label: "готов купить — закрывай сделку", className: "text-accent" };
    case "question":
      return { label: "задал вопрос — ответь", className: "text-accent" };
    case "complaint":
      return { label: "жалоба/проблема — разберись", className: "text-warning-dark" };
    case "smalltalk":
      return { label: "просто болтает — можно ответить", className: "text-text-secondary" };
    case "cold":
      return { label: "охладел — без напора", className: "text-text-muted" };
    case "closing":
      return { label: "закрывающее — ответ не нужен", className: "text-text-muted" };
    default:
      return null;
  }
}

/** Closing-detector verdict on the tail message → human label (transparency panel). */
export function closingVerdictLabel(
  verdict: { layer: string; needsReply: boolean; state?: string | null } | null | undefined,
): { label: string; className: string } | null {
  if (!verdict) {
    return null;
  }
  switch (verdict.layer) {
    case "l1":
      return { label: "Список закрывающих — ответ не нужен", className: "text-text-muted" };
    case "l2": {
      const s = conversationStateLabel(verdict.state);
      if (s) {
        return { label: `ИИ Haiku: ${s.label}`, className: s.className };
      }
      return verdict.needsReply
        ? { label: "ИИ Haiku: нужен ответ", className: "text-accent" }
        : { label: "ИИ Haiku: закрывающее — ответ не нужен", className: "text-text-muted" };
    }
    case "fresh":
      return { label: "Свежее (<24ч) — ждём ответа", className: "text-accent" };
    case "unverified":
      return { label: "Ещё не проверено ИИ — показано на всякий случай", className: "text-warning-dark" };
    case "model_last":
      return { label: "Вы ответили последним — ход за фаном", className: "text-text-muted" };
    case "unknown":
      return { label: "Роль отправителя не определена", className: "text-text-muted" };
    default:
      return null;
  }
}

/** Human "why now" line built from the engine's winning driver. */
export function whyNowLabel(code: string | null, value: number | null): string {
  switch (code) {
    case "purchase":
      return value != null && value < 2 ? "Только что купил(а) — поблагодари и допродай" : "Недавняя покупка — допродай";
    case "buy_signal":
      return "Готов купить — закрывай сделку";
    case "complaint":
      return "Жалоба/проблема — разберись";
    case "question":
      return "Задал вопрос — ответь";
    case "expiry": {
      const d = value ?? 0;
      if (d <= 0) return "Истекает сегодня — спаси подписку";
      if (d === 1) return "Истекает завтра — спаси подписку";
      return `Истекает через ${d}д`;
    }
    case "sla": {
      const h = value ?? 0;
      if (h < 24) return `Ждёт ответа ${Math.max(1, Math.round(h))}ч`;
      return `Ждёт ответа ${Math.round(h / 24)}д`;
    }
    case "cadence":
      return value != null ? `Не писали ${value}д` : "Пора написать";
    case "reactivation":
      return "Попытка реактивации";
    case "presence":
      return "Онлайн сейчас";
    default:
      return "В очереди";
  }
}
