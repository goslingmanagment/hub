import { createHmac } from "node:crypto";

import {
  getTelegramSettings,
  insertDeliveryAttempt,
  insertModelApplicationWithinLimit,
  markModelApplicationSessionSubmitted,
  peekNextModelApplicationId,
  setModelApplicationGoogleResult,
  type ModelApplicationAnswer,
  type ModelApplicationGoogleFields,
  type ModelApplicationGoogleStatus,
  type ModelApplicationRow,
} from "@agency_hub_core/db";
import { classifyTransportFailure, MOSCOW_TIME_ZONE } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { fetchWithEgress } from "./egress/fetch.ts";
import { resolveEgress } from "./egress/resolver.ts";
import { TooManyRequestsError } from "./errors.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

// Model questionnaires («анкета модели») from the agency site
// gosling-agency.ru, which posts them same-origin to the public route
// POST /api/v1/model-applications. The answers are sensitive personal data
// (age, boundaries): they live in Hub's table and the agency's own Google
// Form only, and never reach a log line. The client's address is kept only
// as a keyed hash, for the hourly per-address limit.

/** The agency's own Google Form. Never taken from the client. */
export const MODEL_APPLICATION_GOOGLE_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfw4qBbIbYzKIFv5V2vp9laahHueGnxAu0B13eOmnQq6Mf4yw/formResponse";
export const MODEL_APPLICATIONS_PER_ADDRESS_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60_000;
const GOOGLE_FORWARD_TIMEOUT_MS = 15_000;
const USER_AGENT_MAX_CHARS = 300;
const NOTICE_PART_MAX_CHARS = 80;
const IP_HASH_PURPOSE = "agency-hub:model-applications:client-address:v1";

export interface ModelApplicationSubmission {
  form: string;
  answers: ModelApplicationAnswer[];
  google?: ModelApplicationGoogleFields | undefined;
  /** The filling this questionnaire ends (its progress posts' session). */
  session?: string | undefined;
  website?: string | undefined;
}

/** HMAC of the address under a key derived from the encryption key: the
 * same address hashes the same while the key stands, and is not reversible
 * by enumerating the IPv4 space without that key. */
export function modelApplicationAddressHash(encryptionKey: Buffer, address: string): string {
  const key = createHmac("sha256", encryptionKey).update(IP_HASH_PURPOSE, "utf8").digest();
  return createHmac("sha256", key).update(address, "utf8").digest("hex");
}

export type GoogleForwardResult =
  | { status: "recorded" }
  | { status: "failed"; error: string };

function describeForwardFailure(error: unknown): string {
  const kind = classifyTransportFailure(error);
  if (kind !== "transport") {
    return kind;
  }
  return error instanceof Error ? error.name : "error";
}

/**
 * One attempt to submit the fields to the Google Form, through the service
 * egress identity (as Telegram and ElevenLabs go). Arrays go as repeated
 * keys. HTTP 200 counts as recorded; anything else is a failure with a short
 * reason (the status, or the class of the network error).
 */
export async function forwardModelApplicationToGoogle(
  app: Pick<AppContext, "config" | "db">,
  fields: ModelApplicationGoogleFields,
): Promise<GoogleForwardResult> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      body.append(key, item);
    }
  }

  let egress: Awaited<ReturnType<typeof resolveEgress>>;
  try {
    egress = await resolveEgress(app, { kind: "vendor", vendor: "google_forms" });
  } catch (error) {
    return { status: "failed", error: `egress: ${error instanceof Error ? error.name : "error"}` };
  }
  try {
    if (!egress.dispatcher) {
      return { status: "failed", error: "egress: no dispatcher" };
    }
    const response = await fetchWithEgress(fetch, egress.dispatcher, MODEL_APPLICATION_GOOGLE_FORM_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
      signal: AbortSignal.timeout(GOOGLE_FORWARD_TIMEOUT_MS),
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200
      ? { status: "recorded" }
      : { status: "failed", error: `HTTP ${response.status}` };
  } catch (error) {
    return { status: "failed", error: describeForwardFailure(error) };
  } finally {
    await egress.close().catch(() => undefined);
  }
}

export function clip(text: string, max = NOTICE_PART_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The owner's one-message notice: who, and whether the Google Form got it. */
export function formatModelApplicationNotice(input: {
  id: number;
  answers: readonly ModelApplicationAnswer[];
  googleStatus: ModelApplicationGoogleStatus;
  googleError: string | null;
}): string {
  const answer = (key: string) => {
    const value = input.answers.find((item) => item.key === key)?.value ?? "";
    return clip(value);
  };
  const telegram = answer("telegram");
  const parts = [
    answer("name"),
    answer("age"),
    answer("place"),
    /^[A-Za-z0-9_]{4,32}$/.test(telegram) ? `@${telegram}` : telegram,
  ].filter((part) => part !== "");
  const google = input.googleStatus === "recorded"
    ? "записана"
    : input.googleStatus === "skipped"
      ? "не отправлялась"
      : `не записана (${input.googleError ?? "ошибка"})`;
  const head = parts.length > 0
    ? `Новая анкета модели №${input.id}: ${parts.join(", ")}.`
    : `Новая анкета модели №${input.id}.`;
  return `${head} Google-форма: ${google}.\n`
    + `Целиком: model-applications:show ${input.id} (CLI хаба)`;
}

/** One plain-text notice to the owner's Telegram, recorded as a delivery attempt. */
export async function notifyOwnerOfModelApplication(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: "model_application" | "model_application_started" | "model_application_abandoned";
    idempotencyKey: string;
    text: string;
  },
): Promise<void> {
  const settings = await getTelegramSettings(app.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });
  const delivery: TelegramSendResult = settings.enabled
    ? await sendTelegramMessage(app, { text: input.text, idempotencyKey: input.idempotencyKey })
    : { status: "skipped", reason: "disabled" };
  await insertDeliveryAttempt(app.db, {
    kind: input.kind,
    status: delivery.status,
    messageId: delivery.status === "sent" ? delivery.messageId : null,
    error: delivery.status === "failed"
      ? delivery.error
      : delivery.status === "skipped"
        ? delivery.reason
        : null,
  });
}

export type SubmitModelApplicationResult =
  | { stored: true; id: number; googleStatus: ModelApplicationGoogleStatus }
  | { stored: false; id: number };

/**
 * The intake: honeypot → hourly limit → store → Google Form (awaited, one
 * attempt, ≤ 15 s) → the owner's Telegram notice (not awaited: its retries
 * can take minutes). After the row is stored nothing can fail the request.
 */
export async function submitModelApplication(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    submission: ModelApplicationSubmission;
    clientAddress: string;
    userAgent: string | null;
  },
): Promise<SubmitModelApplicationResult> {
  const { submission } = input;
  if ((submission.website ?? "").trim() !== "") {
    // A bot: the same answer as a success, and nothing kept, sent or said.
    return { stored: false, id: await peekNextModelApplicationId(app.db) };
  }

  const google = submission.google !== undefined && Object.keys(submission.google).length > 0
    ? submission.google
    : null;
  const ipHash = modelApplicationAddressHash(app.config.encryptionKey, input.clientAddress);
  const stored = await insertModelApplicationWithinLimit(app.db, {
    form: submission.form,
    answers: submission.answers.map((answer) => ({
      section: answer.section,
      key: answer.key,
      label: answer.label,
      value: answer.value,
    })),
    googleFields: google,
    // Until the forward settles; a crash in between leaves an honest failure.
    googleStatus: google === null ? "skipped" : "failed",
    googleError: google === null ? null : "not sent",
    ipHash,
    userAgent: input.userAgent === null ? null : input.userAgent.slice(0, USER_AGENT_MAX_CHARS),
    maxPerWindow: MODEL_APPLICATIONS_PER_ADDRESS_PER_HOUR,
    windowMs: RATE_WINDOW_MS,
  });
  if (stored.status === "rate_limited") {
    throw new TooManyRequestsError("Too many questionnaires from this address; try again in an hour");
  }
  const { id } = stored;

  if (submission.session !== undefined) {
    try {
      const name = submission.answers.find((answer) => answer.key === "name")?.value.trim() ?? "";
      await markModelApplicationSessionSubmitted(app.db, {
        session: submission.session,
        form: submission.form,
        applicationId: id,
        name: name === "" ? null : clip(name, 120),
        ipHash,
      });
    } catch (error) {
      app.logger.error({ err: error, modelApplicationId: id }, "model application: filling not marked sent");
    }
  }

  let googleStatus: ModelApplicationGoogleStatus = "skipped";
  let googleError: string | null = null;
  if (google !== null) {
    try {
      const forwarded = await forwardModelApplicationToGoogle(app, google);
      googleStatus = forwarded.status;
      googleError = forwarded.status === "failed" ? forwarded.error : null;
    } catch (error) {
      googleStatus = "failed";
      googleError = error instanceof Error ? error.name : "error";
    }
    try {
      await setModelApplicationGoogleResult(app.db, { id, status: googleStatus, error: googleError });
    } catch (error) {
      app.logger.error({ err: error, modelApplicationId: id }, "model application: Google result not saved");
    }
  }

  const text = formatModelApplicationNotice({ id, answers: submission.answers, googleStatus, googleError });
  void notifyOwnerOfModelApplication(app, {
    kind: "model_application",
    idempotencyKey: `model-application:${id}`,
    text,
  }).catch((error: unknown) => {
    app.logger.error({ err: error, modelApplicationId: id }, "model application: owner notice failed");
  });

  app.logger.info({ modelApplicationId: id, googleStatus }, "model application stored");
  return { stored: true, id, googleStatus };
}

// --- The hub CLI's reading (model-applications:list / :show) ---

const moscowMinute = new Intl.DateTimeFormat("sv-SE", {
  timeZone: MOSCOW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatMoscowMinute(date: Date): string {
  return moscowMinute.format(date);
}

function answerOf(row: ModelApplicationRow, key: string): string {
  return clip(row.answers.find((answer) => answer.key === key)?.value ?? "", 40);
}

/** Newest first: id, Moscow time, name, age, telegram, Google status. */
export function formatModelApplicationList(rows: readonly ModelApplicationRow[]): string {
  if (rows.length === 0) {
    return "no model applications";
  }
  const table = [
    ["id", "date (MSK)", "name", "age", "telegram", "google"],
    ...rows.map((row) => [
      String(row.id),
      moscowMinute.format(row.createdAt),
      answerOf(row, "name"),
      answerOf(row, "age"),
      answerOf(row, "telegram"),
      row.googleStatus,
    ]),
  ];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((line) => line[column]!.length)));
  return table
    .map((line) => line.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
    .join("\n");
}

/** Every non-empty answer, grouped by section in the order given, `label: value`. */
export function formatModelApplication(row: ModelApplicationRow): string {
  const google = row.googleStatus === "failed"
    ? `failed (${row.googleError ?? "?"})`
    : row.googleStatus;
  return [
    `№${row.id} · ${moscowMinute.format(row.createdAt)} MSK · form ${row.form} · Google: ${google}`,
    ...formatAnswersBySection(row.answers),
  ].join("\n");
}

/** Non-empty answers grouped by section in the order given: a blank line, the section, `  label: value`. */
export function formatAnswersBySection(answers: readonly ModelApplicationAnswer[]): string[] {
  const sections = new Map<string, ModelApplicationAnswer[]>();
  for (const answer of answers) {
    if (answer.value.trim() === "") {
      continue;
    }
    const list = sections.get(answer.section) ?? [];
    list.push(answer);
    sections.set(answer.section, list);
  }
  const lines: string[] = [];
  for (const [section, list] of sections) {
    lines.push("", section);
    for (const answer of list) {
      lines.push(`  ${answer.label}: ${answer.value.trim().replace(/\n/g, "\n    ")}`);
    }
  }
  return lines;
}
