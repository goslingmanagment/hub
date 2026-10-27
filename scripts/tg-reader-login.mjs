#!/usr/bin/env node
// Logs the FANSLY BLOCKLIST reader's Telegram account in once and prints its
// GramJS StringSession — the value of TG_READER_SESSION — to stdout, and
// nothing else there. Prompts and errors go to stderr.
//
//   TG_READER_API_ID=… TG_READER_API_HASH=… node scripts/tg-reader-login.mjs > session.txt
//
// Asks for the phone (+…), the login code Telegram sends to the account's app
// and, if the account has one, its 2FA password; each may come from the
// environment instead: TG_READER_PHONE, TG_READER_CODE, TG_READER_PASSWORD.
// The session is a secret: whoever holds it reads the account. Put it into
// the production env file only; never into a log, a chat or the repository.
// The script sends nothing to anyone and joins nothing.

import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";

// GramJS is the runtime's dependency (apps/runtime/package.json).
const require = createRequire(new URL("../apps/runtime/package.json", import.meta.url));
const { TelegramClient, Logger, sessions } = require("telegram");

const apiId = Number(process.env.TG_READER_API_ID ?? "");
const apiHash = (process.env.TG_READER_API_HASH ?? "").trim();
if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiHash.length === 0) {
  process.stderr.write("Set TG_READER_API_ID and TG_READER_API_HASH (my.telegram.org → API development tools).\n");
  process.exit(2);
}

const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
const ask = async (question, fromEnv) => {
  const preset = (process.env[fromEnv] ?? "").trim();
  if (preset.length > 0) return preset;
  return (await prompt.question(question)).trim();
};

const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
  baseLogger: new Logger("none"),
  deviceModel: "Agency Hub",
  systemVersion: "linux",
  appVersion: "1.0",
});

let failed = false;
try {
  await client.start({
    phoneNumber: () => ask("Phone (+…): ", "TG_READER_PHONE"),
    phoneCode: () => ask("Login code from Telegram: ", "TG_READER_CODE"),
    password: () => ask("2FA password: ", "TG_READER_PASSWORD"),
    onError: async (error) => {
      process.stderr.write(`Telegram: ${error?.message ?? String(error)}\n`);
      failed = true;
      // Stop at the first refusal: a wrong code is asked for again by running the script again.
      return true;
    },
  });
  if (failed || !(await client.checkAuthorization())) {
    process.stderr.write("Not logged in; nothing printed.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${client.session.save()}\n`);
    process.stderr.write("Logged in. The line on stdout is TG_READER_SESSION (a secret).\n");
  }
} finally {
  prompt.close();
  await client.destroy().catch(() => {});
}
