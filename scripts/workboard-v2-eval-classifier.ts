// Offline eval for the L2 closing classifier (no DB — calls Haiku only).
// Measures whether the prompt classifies the fan's tail correctly, with a focus on
// buy_signal PRECISION (the high-stakes label that tops the queue with "закрывай
// сделку"). The gold set deliberately includes the interest-vs-intent confusions
// that caused false "Готов купить" on $0 fans (see closing-classifier.ts).
//
//   (envs from .env)  node --import tsx/esm scripts/workboard-v2-eval-classifier.ts
//
// Exit code is non-zero if any non-buy case is mislabeled buy_signal (a false
// positive — the exact regression we are guarding), so this can gate a prompt change.
import { createAnthropicClosingClassifier, type ClosingClassifierInput } from "../apps/runtime/src/services/workboard-v2/closing-classifier.ts";
import type { ConversationState } from "../apps/runtime/src/services/workboard-v2/types.ts";

interface EvalCase extends ClosingClassifierInput {
  expected: ConversationState;
  /** Why this is the gold label — keeps the set auditable. */
  note: string;
  /** Acceptable states (when more than one is defensible, e.g. greeting → smalltalk|question). */
  accept?: ConversationState[];
  /** Assert needs_reply too — for cases where the crux is "must not be suppressed". */
  expectReply?: boolean;
}

// ── Gold set ────────────────────────────────────────────────────────────────────
// Each case ends with the fan's tail. Labels are intentionally unambiguous so a
// disagreement is a real classifier miss, not a debatable judgement call.
const CASES: EvalCase[] = [
  // ── Genuine buy_signal: concrete move toward paying ──────────────────────────
  {
    id: "buy-accept-offer",
    expected: "buy_signal",
    note: "accepts a specific paid offer the creator just made",
    context: [
      { role: "creator", text: "want me to send you that new custom video? it's $30 😈" },
      { role: "fan", text: "yes!! send it" },
    ],
  },
  {
    id: "buy-accept-ru",
    expected: "buy_signal",
    note: "accepts a paid offer in Russian",
    context: [
      { role: "creator", text: "хочешь распакую новый сет за $15?" },
      { role: "fan", text: "да, давай" },
    ],
  },
  {
    id: "buy-ask-price",
    expected: "buy_signal",
    note: "proactively asks a price",
    context: [{ role: "fan", text: "how much for a custom?" }],
  },
  {
    id: "buy-ask-price-ru",
    expected: "buy_signal",
    note: "asks price in Russian",
    context: [
      { role: "creator", text: "только что выложила новое видео 🔥" },
      { role: "fan", text: "сколько стоит?" },
    ],
  },
  {
    id: "buy-wants-to-buy",
    expected: "buy_signal",
    note: "states intent to buy a paid product",
    context: [{ role: "fan", text: "I wanna buy your premium bundle, how do I do it?" }],
  },
  {
    id: "buy-just-tipped",
    expected: "buy_signal",
    note: "says they just paid / about to pay",
    context: [{ role: "fan", text: "just sent you a tip babe, check it 😘" }],
  },

  // ── Interest / engagement — NOT buy_signal (the regression guards) ────────────
  {
    id: "smalltalk-both-followed", // the exact false positive from the screenshot
    expected: "smalltalk",
    note: "interest in content, no purchase ask — was wrongly buy_signal",
    context: [
      { role: "creator", text: "do you prefer my chatting or my content?" },
      { role: "fan", text: "Both, that's why I followed both accounts" },
    ],
  },
  {
    id: "smalltalk-compliment",
    expected: "smalltalk",
    note: "compliment / attraction, no ask",
    context: [{ role: "fan", text: "you're so gorgeous 😍 love your page" }],
  },
  {
    id: "smalltalk-long-fan",
    expected: "smalltalk",
    note: "loyalty statement, no purchase intent",
    context: [{ role: "fan", text: "I've been a fan for years, everything you post is amazing" }],
  },
  {
    id: "smalltalk-yes-not-sale",
    expected: "smalltalk",
    note: "an affirmative 'yes' that is NOT answering a sales offer",
    context: [
      { role: "creator", text: "are you enjoying your weekend so far?" },
      { role: "fan", text: "yeah it's been great, went hiking earlier 😊" },
    ],
  },
  {
    id: "smalltalk-flirt-ru",
    expected: "smalltalk",
    note: "flirting in Russian, no ask",
    context: [{ role: "fan", text: "ты невероятная, обожаю тебя 🔥" }],
  },

  // ── must-need-a-reply: real cases the classifier used to suppress (see dialog audit) ──
  {
    id: "reply-bare-greeting",
    expected: "smalltalk",
    accept: ["smalltalk", "question"],
    expectReply: true,
    note: "a lone fan greeting OPENS the chat — must need a reply, NOT closing",
    context: [
      { role: "creator", text: "heyy thanks for following 🤍 are you more into chatting or the content?" },
      { role: "fan", text: "Hi" },
    ],
  },
  {
    id: "reply-greeting-intro",
    expected: "smalltalk",
    accept: ["smalltalk", "question"],
    expectReply: true,
    note: "greeting + self-intro is an opener — needs a reply, not closing",
    context: [{ role: "fan", text: "Hey Lora, I'm Rey :) new here, nice to meet you" }],
  },
  {
    id: "reply-decline-but-chat",
    expected: "smalltalk",
    accept: ["smalltalk", "question"],
    expectReply: true,
    note: "declined the paid offer but asks to keep chatting — needs a reply, NOT cold",
    context: [
      { role: "creator", text: "i can do that here, for $25" },
      { role: "fan", text: "ah i don't really have money so forget it, i'm still a student. can i just chat with you?" },
    ],
  },

  // ── question: wants info, not itself a purchase ──────────────────────────────
  {
    id: "question-online",
    expected: "question",
    note: "asks for info, no price/yes yet",
    context: [{ role: "fan", text: "are you online rn?" }],
  },
  {
    id: "question-customs",
    expected: "question",
    note: "asks whether a service exists (no commitment yet)",
    context: [{ role: "fan", text: "do you do video calls?" }],
  },

  // ── complaint ────────────────────────────────────────────────────────────────
  {
    id: "complaint-not-arrived",
    expected: "complaint",
    note: "paid but content did not arrive",
    context: [{ role: "fan", text: "I paid for the video but it never showed up :(" }],
  },
  {
    id: "complaint-broken-link",
    expected: "complaint",
    note: "problem with delivered content",
    context: [
      { role: "creator", text: "thanks for the tip babe! here's your clip 💕" },
      { role: "fan", text: "the link won't open, says error" },
    ],
  },

  // ── cold: declining / disengaged ─────────────────────────────────────────────
  {
    id: "cold-too-expensive",
    expected: "cold",
    note: "declines an offer on price",
    context: [
      { role: "creator", text: "want it for $20?" },
      { role: "fan", text: "nah too expensive sorry" },
    ],
  },
  {
    id: "cold-stop",
    expected: "cold",
    note: "explicit disengagement",
    context: [{ role: "fan", text: "not interested, please stop messaging me" }],
  },

  // ── solicitation: other creators / bots blasting their own opener (sender_role='fan' is correct) ──
  {
    id: "cold-solicitation-thanks-follow",
    expected: "cold",
    expectReply: false,
    note: "role-reversed bot/cross-promo opener (other creator), not a real prospect — no reply",
    context: [{ role: "fan", text: "Hey! I'm Lilly🥰 thanks for the follow! So, what's your name?👀" }],
  },
  {
    id: "cold-solicitation-sfs",
    expected: "cold",
    expectReply: false,
    note: "share-4-share / self-promo spam — no reply",
    context: [{ role: "fan", text: "Someone down for a share4share? https://fansly.com/post/836 Xoxo" }],
  },

  // ── closing: ack / goodbye, no reply needed ──────────────────────────────────
  {
    id: "closing-goodnight",
    expected: "closing",
    note: "thanks + goodbye ends the exchange",
    context: [
      { role: "creator", text: "had so much fun chatting tonight 💕" },
      { role: "fan", text: "thanks babe, goodnight 😘" },
    ],
  },
];

const BUY: ConversationState = "buy_signal";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const model = process.env.WB_CLOSING_LLM_MODEL?.trim() || "claude-haiku-4-5";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const classifier = createAnthropicClosingClassifier({ apiKey, model });
  console.log(`Evaluating ${CASES.length} cases against ${model}…\n`);

  const { verdicts, inputTokens, outputTokens } = await classifier.classifyBatch(
    CASES.map(({ id, context }) => ({ id, context })),
  );
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  let correct = 0;
  let buyTp = 0; // predicted buy & actually buy
  let buyFp = 0; // predicted buy & NOT buy  → the bug we are guarding
  let buyFn = 0; // actually buy & predicted something else
  const misses: string[] = [];
  const falsePositives: string[] = [];

  let replyMiss = 0; // suppressed a fan who needed a reply (or vice-versa)
  for (const c of CASES) {
    const v = byId.get(c.id);
    const got = v?.state ?? "(none)";
    const reason = v?.reason ?? "";
    const reply = v?.needsReply ?? null;
    const stateOk = c.accept ? c.accept.includes(got as ConversationState) : got === c.expected;
    const replyOk = c.expectReply == null || reply === c.expectReply;
    const ok = stateOk && replyOk;
    if (ok) correct += 1;
    if (!replyOk) replyMiss += 1;
    if (got === BUY && c.expected === BUY) buyTp += 1;
    if (got === BUY && c.expected !== BUY) {
      buyFp += 1;
      falsePositives.push(`  ✗ ${c.id}: predicted buy_signal, want ${c.expected} — "${reason}" [${c.note}]`);
    }
    if (got !== BUY && c.expected === BUY) buyFn += 1;
    const want = c.accept ? c.accept.join("|") : c.expected;
    const replyTag = c.expectReply == null ? "" : ` reply=${reply}${replyOk ? "" : `(want ${c.expectReply})`}`;
    const line = `${ok ? "✓" : "✗"} ${c.id.padEnd(26)} want ${want.padEnd(16)} got ${String(got).padEnd(10)}${replyTag} ${ok ? "" : `← "${reason}"`}`;
    console.log(line);
    if (!ok) misses.push(`  ${c.id}: want ${want}, got ${got}${replyTag} — "${reason}" [${c.note}]`);
  }

  const buyPrecision = buyTp + buyFp === 0 ? 1 : buyTp / (buyTp + buyFp);
  const buyRecall = buyTp + buyFn === 0 ? 1 : buyTp / (buyTp + buyFn);

  console.log(`\nAccuracy: ${correct}/${CASES.length} (${Math.round((100 * correct) / CASES.length)}%)`);
  console.log(
    `buy_signal — precision ${buyPrecision.toFixed(2)} (${buyTp}/${buyTp + buyFp}), recall ${buyRecall.toFixed(2)} (${buyTp}/${buyTp + buyFn})`,
  );
  console.log(`needs_reply mismatches: ${replyMiss}`);
  console.log(`tokens in/out: ${inputTokens}/${outputTokens}`);

  if (falsePositives.length > 0) {
    console.log(`\nFALSE "Готов купить" (the bug — fails the eval):`);
    falsePositives.forEach((l) => console.log(l));
  }
  if (buyFn > 0) {
    console.log(`\nMissed real buy_signals (false negatives — also bad, fan with intent buried):`);
    misses.filter((m) => m.includes("want buy_signal")).forEach((l) => console.log(l));
  }

  // Gate: any false "буду купить" is the regression we fixed → fail loudly.
  if (buyFp > 0) {
    console.error(`\nFAILED: ${buyFp} false buy_signal(s).`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASSED: no false buy_signal.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
