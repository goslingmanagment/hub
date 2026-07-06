// Deterministic property/boundary sweep over the REAL money converters.
// Imports the actual source (zero-dependency module) by repo-relative path via tsx.
// Run from repo root: node --import tsx/esm tests/audit-artifacts/money-prop-test.ts
import {
  millsFromInteger,
  millsToDecimalString,
  formatUsdFromMills,
  dollarsToMills,
  sumMills,
  calculateNetMillsFromGross,
  calculateGrossMillsFromNet,
} from "../../packages/shared/src/money.ts";

// Replica of the PRIVATE reporting.ts:100 millsToRoundedCents (half-up round),
// to contrast against the truncating formatUsdFromMills (money.ts:28).
function millsToRoundedCents(value: bigint | number | string): number {
  const mills = millsFromInteger(value);
  return Number((mills + (mills >= 0n ? 5n : -5n)) / 10n);
}
const centsToUsd = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(label: string, actual: unknown, expected: unknown) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`FAIL ${label}: got ${a}, expected ${e}`);
  }
}

// 1. dollarsToMills round-trip + sign + sub-mill behavior
eq("dollarsToMills('1')", dollarsToMills("1"), 1000n);
eq("dollarsToMills('1.5')", dollarsToMills("1.5"), 1500n);
eq("dollarsToMills('1.255')", dollarsToMills("1.255"), 1255n);
eq("dollarsToMills('0.001')", dollarsToMills("0.001"), 1n);
eq("dollarsToMills('-2.5')", dollarsToMills("-2.5"), -2500n);
eq("dollarsToMills(1.255 number)", dollarsToMills(1.255), 1255n);
eq("dollarsToMills('0.0009' sub-mill)", dollarsToMills("0.0009"), 0n); // 4th decimal silently dropped
eq("dollarsToMills(0.0001 number)", dollarsToMills(0.0001), 0n); // toFixed(3) -> '0.000'

// 2. formatUsdFromMills = TRUNCATION (BigInt floor-div)
eq("format(1000)", formatUsdFromMills(1000), "$1.00");
eq("format(1255) trunc", formatUsdFromMills(1255), "$1.25");
eq("format(1259) trunc", formatUsdFromMills(1259), "$1.25");
eq("format(-1255) trunc", formatUsdFromMills(-1255), "-$1.25");
eq("format(999)", formatUsdFromMills(999), "$0.99");
eq("format(5) -> 0c", formatUsdFromMills(5), "$0.00");
eq("format(50)", formatUsdFromMills(50), "$0.05");

// 3. millsToRoundedCents = HALF-UP ROUND
eq("round(1255)", millsToRoundedCents(1255), 126);
eq("round(1254)", millsToRoundedCents(1254), 125);
eq("round(5)", millsToRoundedCents(5), 1);
eq("round(-1255)", millsToRoundedCents(-1255), -126);

// 4. millsToDecimalString exactness (no rounding)
eq("decimal(1255)", millsToDecimalString(1255), "1.255");
eq("decimal(-1255)", millsToDecimalString(-1255), "-1.255");
eq("decimal(5)", millsToDecimalString(5), "0.005");

// 5. sumMills BigInt — no float overflow even past Number.MAX_SAFE_INTEGER
const big = [9_000_000_000_000_000n, 9_000_000_000_000_000n, 7n];
eq("sumMills big", sumMills(big), 18_000_000_000_000_007n);
eq("sumMills mixed types", sumMills([1000n, "500", 250]), 1750n);

// 6. OnlyFans commission round-trip (fee rounded to whole cents)
eq("net(1000 @0.2)", calculateNetMillsFromGross(1000, 0.2), 800n);
eq("net(0 commission)", calculateNetMillsFromGross(12345, 0), 12345n);
// gross from net should be >= net and re-deriving net stays within a cent
const net = calculateNetMillsFromGross(123456, 0.2);
const grossBack = calculateGrossMillsFromNet(net, 0.2);
const netAgain = calculateNetMillsFromGross(grossBack, 0.2);
eq("commission round-trip net stable (±1c)", Math.abs(Number(netAgain - net)) <= 10, true);

console.log(`\n=== money assertions: ${pass} passed, ${fail} failed ===`);
for (const f of failures) console.log("  " + f);

// ===== P-35 demonstration: same stored mills, two display rules, 1c apart =====
console.log("\n=== P-35: truncate (formatUsdFromMills) vs round (millsToRoundedCents) ===");
let divergences = 0;
for (const mills of [1250, 1251, 1255, 1256, 1259, 1260, 2495, 2499]) {
  const t = formatUsdFromMills(mills);
  const r = centsToUsd(millsToRoundedCents(mills));
  const diff = t !== r;
  if (diff) divergences++;
  console.log(`  ${String(mills).padStart(5)} mills -> trunc ${t}  round ${r}  ${diff ? "<-- DIVERGES 1c" : ""}`);
}
console.log(`  divergences: ${divergences}/8 (mills % 10 in {5..9} diverge)`);

// ===== Large-value precision threshold (informational) =====
console.log("\n=== large-value precision (Number(mills/10) past MAX_SAFE_INTEGER) ===");
const safeCents = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991
const atThreshold = safeCents * 10n;          // ~ $90.07 trillion in mills
console.log(`  threshold ~ $${(Number(atThreshold) / 1000 / 1e12).toFixed(2)}T in mills before Number() loses integer precision`);
console.log(`  realistic agency totals ($<1B) are far below; precision risk is theoretical only`);

process.exit(fail > 0 ? 1 : 0);
