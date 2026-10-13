// The operator's process (s6 service `operator`, as pb-operator): the
// settings of the container, Chrome through s6, and the operator of
// operator.ts. It stands with the exit closed until the engine connects and
// starts the page.

import { loadConfig } from "./config.ts";
import { S6Chrome } from "./chrome.ts";
import { Operator } from "./operator.ts";
import { envInt, envStr, errorMessage, makeLog } from "../shared/util.ts";

const log = makeLog("operator");

let operator: Operator | null = null;

process.on("uncaughtException", (error) => {
  // The proxy dies with the process: the exit closes. s6 starts it again.
  log("uncaught", { error: error.stack ?? errorMessage(error) });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  log("unhandled", { error: errorMessage(error) });
  process.exit(1);
});
process.on("SIGTERM", () => {
  void (operator?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
});

try {
  const config = loadConfig();
  operator = new Operator({ config, chrome: new S6Chrome(envStr("PB_CHROME_SERVICE", "/run/service/chrome"), envInt("PB_CHROME_UID", 1001)) });
  await operator.start();
} catch (error) {
  log("fatal", { error: errorMessage(error) });
  process.exit(2);
}
