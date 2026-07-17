import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../apps/runtime/node_modules/playwright");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent("<title>runtime-smoke</title><main>ok</main>");

  const title = await page.title();
  const body = await page.locator("main").textContent();
  if (title !== "runtime-smoke" || body !== "ok") {
    throw new Error(`Unexpected browser smoke result: title=${title}, body=${body}`);
  }
} finally {
  await browser.close();
}

console.log("Chromium Headless Shell runtime smoke passed");
