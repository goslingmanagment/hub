import type { KernelOperationResponse, ShiftReviewChat, ShiftReviewMessage } from "@agency_hub_core/contracts";

import { demoError, intBetween, pick, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { demoFans, demoPage } from "../world.ts";
import { MIN, teamWorld, type DemoShift } from "./team-world.ts";

/**
 * Команда → «Разбор смены» in the demo: one shift of the simulated team, opened
 * up. Its chats are invented around the shift's real numbers (pages, minutes,
 * pauses, messages), with a share of texts from the AI, some copied past the
 * button, waits that grow when the chatter slows down, and a pause or two.
 */

type Response = KernelOperationResponse<"teamShiftReview">;

const FAN_LINES = [
  "hey beautiful", "how was your day?", "what are you up to rn", "you look amazing in that last pic", "i just got home from work",
  "do you have anything new?", "how much for the video?", "lol you're so cute", "i was thinking about you", "send me something special",
  "are you real?", "good morning babe", "what are you wearing", "i'm bored, entertain me", "that's hot", "maybe later, payday is friday",
] as const;
const OWN_LINES = [
  "hiii how was it", "omg haha", "just got out of the shower", "aww thank u", "what do u want to see", "im so bored too",
  "u always make me smile", "tell me more", "haha stop", "i was waiting for u",
] as const;
const AI_LINES = [
  "aww that's so sweet of you, honestly you just made my whole day brighter ♡ what are you up to tonight?",
  "mmm i love that you're thinking about me... i just finished something i think you'd really enjoy, want a peek?",
  "haha you're trouble, i like it :3 tell me what kind of things you're into and i'll see what i can do",
  "i get it, no rush at all ♡ it'll be right here waiting for you whenever you feel like it",
  "you're too sweet, seriously. i'm just chilling in bed scrolling, kinda wishing someone fun would keep me company",
] as const;
// The chatter's own Russian draft and what Fix made of it. A draft that starts like
// a command («скажи…», «спроси…») is a Fix by command, which the screen tells apart.
const FIX_PAIRS = [
  ["только проснулась и сразу подумала о тебе хах", "just woke up and you were the first thing on my mind hehe"],
  ["а ты откуда кстати", "where are you from btw? :3"],
  ["видео дома, скину чуть позже ок?", "the video is at home rn, i'll send it to you a bit later ok?"],
  // A short draft the AI made far longer: «Fix: свой черновик, ИИ дописал».
  ["думаю да", "i think so yeah :3 honestly i've been wanting to try that for a while, you always come up with the best ideas"],
] as const;
const HI_LINES = [
  "heyyy thanks for the follow ♡ i'm so happy you found me, how's your day going?",
  "hiii welcome! i just posted something new and i'm curious what you think :3",
  "omg hi! thank you for following, tell me a little about yourself?",
] as const;

function reviewOf(shift: DemoShift, now: number): Response {
  const random = rng(`review:${shift.user.id}:${shift.startedAt}`);
  const start = shift.startedAt;
  const end = shift.ongoing ? now : shift.endedAt;
  const minutes = Math.max(1, Math.round((end - start) / MIN));
  const inPause = (at: number) => shift.pauses.some((pause) => at >= pause.from && at < pause.to);
  // Nothing is written after the last action: a shift on a break now has its fans waiting.
  const lastWrite = shift.ongoing ? shift.lastInputAt + MIN : end;
  // A slow hour in the middle: the chatter writes less and the fans wait longer.
  const slowFrom = start + Math.round(minutes * 0.55) * MIN;
  const slowTo = slowFrom + 50 * MIN;

  const chats: ShiftReviewChat[] = [];
  const waits: Response["waits"] = [];
  const pages = shift.pages.filter((page) => page.messages > 0);
  for (const page of pages) {
    const platform = demoPage(page.pageLabel)?.platform ?? "fansly";
    const fans = demoFans(page.pageLabel);
    const chatCount = Math.min(fans.length, Math.max(3, Math.round(page.messages / 4)));
    let left = page.messages;
    for (let index = 0; index < chatCount && left > 0; index += 1) {
      const fan = fans[(index * 7) % fans.length]!;
      const key = `${page.pageLabel}:${fan.platformUserId}`;
      const mineCount = index === chatCount - 1 ? left : Math.min(left, intBetween(random, 1, 8));
      left -= mineCount;
      const messages: ShiftReviewMessage[] = [];
      let at = start + intBetween(random, 0, Math.max(1, minutes - 40)) * MIN;
      for (let before = 0; before < 3; before += 1) {
        messages.push(fanMessage(`${key}:b${before}`, start - (3 - before) * 47 * MIN, pick(random, FAN_LINES), false));
      }
      for (let turn = 0; turn < mineCount && at < lastWrite; turn += 1) {
        while (inPause(at)) at += 5 * MIN;
        const fanAt = at;
        messages.push(fanMessage(`${key}:f${turn}`, fanAt, pick(random, FAN_LINES), true));
        const slow = fanAt >= slowFrom && fanAt < slowTo;
        const delay = Math.round((slow ? intBetween(random, 8, 35) : intBetween(random, 0, 6)) * MIN + intBetween(random, 10, 59) * 1000);
        const replyAt = Math.min(end, fanAt + delay);
        if (replyAt >= lastWrite) {
          waits.push({ chat: key, since: new Date(fanAt).toISOString(), from: new Date(fanAt).toISOString(), to: new Date(end).toISOString(), by: null });
          break;
        }
        waits.push({ chat: key, since: new Date(fanAt).toISOString(), from: new Date(fanAt).toISOString(), to: new Date(replyAt).toISOString(), by: "me" });
        messages.push(myMessage(random, `${key}:m${turn}`, replyAt, Math.round((replyAt - fanAt) / 1000)));
        at = replyAt + intBetween(random, 2, 25) * MIN;
      }
      chats.push({
        key,
        pageLabel: page.pageLabel,
        platform,
        conversationRef: fan.platformUserId,
        fanRef: fan.platformUserId,
        fanUsername: fan.username,
        fanDisplayName: fan.displayName,
        fanLifetimeNetMills: Math.round(fan.totalSpent * 1000),
        shiftNetMills: 0,
        earlierHidden: intBetween(random, 0, 40),
        messages,
      });
    }
  }
  // New followers greeted with the Hi button: the chatter's one message, no word from the fan yet.
  for (const page of pages) {
    const platform = demoPage(page.pageLabel)?.platform ?? "fansly";
    const fans = demoFans(page.pageLabel);
    const used = new Set(chats.map((chat) => chat.key));
    let added = 0;
    for (let index = 0; index < fans.length && added < 4; index += 1) {
      const fan = fans[(index * 5 + 3) % fans.length]!;
      const key = `${page.pageLabel}:${fan.platformUserId}`;
      if (used.has(key)) continue;
      used.add(key);
      added += 1;
      const at = Math.min(start + intBetween(random, 5, Math.max(6, minutes - 5)) * MIN, lastWrite - MIN);
      const text = pick(random, HI_LINES);
      const hi: ShiftReviewMessage = {
        ref: `${key}:hi`, at: new Date(at).toISOString(), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: true, by: "me", byName: null, mass: false,
        mine: { composedWith: "hi", edited: false, origin: "ai", aiShare: 1, aiFeature: "hi-greeting", aiText: text, draft: null, replySeconds: null, repeats: 0, marks: [] },
      };
      chats.push({
        key, pageLabel: page.pageLabel, platform, conversationRef: fan.platformUserId, fanRef: fan.platformUserId,
        fanUsername: fan.username, fanDisplayName: fan.displayName, fanLifetimeNetMills: null, shiftNetMills: 0, earlierHidden: 0, messages: [hi],
      });
    }
  }
  // A chat a colleague kept on the same page, and fans who had waited since before the shift.
  const firstPage = pages[0];
  let colleagueChat: { key: string; at: number } | null = null;
  if (firstPage) {
    const platform = demoPage(firstPage.pageLabel)?.platform ?? "fansly";
    const used = new Set(chats.map((chat) => chat.key));
    const free = demoFans(firstPage.pageLabel).filter((fan) => !used.has(`${firstPage.pageLabel}:${fan.platformUserId}`));
    const chatOf = (fan: (typeof free)[number], messages: ShiftReviewMessage[]): ShiftReviewChat => ({
      key: `${firstPage.pageLabel}:${fan.platformUserId}`, pageLabel: firstPage.pageLabel, platform, conversationRef: fan.platformUserId,
      fanRef: fan.platformUserId, fanUsername: fan.username, fanDisplayName: fan.displayName,
      fanLifetimeNetMills: Math.round(fan.totalSpent * 1000), shiftNetMills: 0, earlierHidden: 0, messages,
    });
    const colleague = free[0];
    if (colleague) {
      const key = `${firstPage.pageLabel}:${colleague.platformUserId}`;
      const first = start + 40 * MIN;
      const theirs = (ref: string, at: number, text: string): ShiftReviewMessage => ({
        ref, at: new Date(at).toISOString(), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: true, by: "other", byName: "sofia", mass: false, mine: null,
      });
      const iso = (at: number) => new Date(at).toISOString();
      chats.push(chatOf(colleague, [
        fanMessage(`${key}:c0`, first, pick(random, FAN_LINES), true),
        theirs(`${key}:c1`, first + 3 * MIN, pick(random, AI_LINES)),
        fanMessage(`${key}:c2`, first + 20 * MIN, pick(random, FAN_LINES), true),
        theirs(`${key}:c3`, first + 26 * MIN, pick(random, AI_LINES)),
        fanMessage(`${key}:c4`, first + 70 * MIN, pick(random, FAN_LINES), true),
      ]));
      colleagueChat = { key, at: first + 24 * MIN };
      waits.push(
        { chat: key, since: iso(first), from: iso(first), to: iso(first + 3 * MIN), by: "other" },
        { chat: key, since: iso(first + 20 * MIN), from: iso(first + 20 * MIN), to: iso(first + 26 * MIN), by: "other" },
        { chat: key, since: iso(first + 70 * MIN), from: iso(first + 70 * MIN), to: iso(end), by: null },
      );
    }
    for (const [index, fan] of free.slice(1, 4).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const since = start - (3 + index * 9) * 60 * MIN;
      chats.push(chatOf(fan, [fanMessage(`${key}:w0`, since, pick(random, FAN_LINES), false)]));
      waits.push({ chat: key, since: new Date(since).toISOString(), from: new Date(start).toISOString(), to: new Date(end).toISOString(), by: null });
    }
    // A colleague still on the page as the shift began: wrote a minute before its start, then answered a fan waiting since
    // the last shift. Both chats are the colleague's.
    const [lateFan, carriedFan] = free.slice(4, 6);
    if (lateFan && carriedFan) {
      const iso = (at: number) => new Date(at).toISOString();
      const theirs = (ref: string, at: number): ShiftReviewMessage => ({
        ref, at: iso(at), side: "page", text: pick(random, AI_LINES), priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: at >= start, by: "other", byName: "sofia", mass: false, mine: null,
      });
      const late = `${firstPage.pageLabel}:${lateFan.platformUserId}`;
      chats.push(chatOf(lateFan, [
        fanMessage(`${late}:l0`, start - 6 * MIN, pick(random, FAN_LINES), false),
        theirs(`${late}:l1`, start - MIN),
        fanMessage(`${late}:l2`, start + 4 * MIN, pick(random, FAN_LINES), true),
        theirs(`${late}:l3`, start + 7 * MIN),
      ]));
      const carried = `${firstPage.pageLabel}:${carriedFan.platformUserId}`;
      chats.push(chatOf(carriedFan, [
        fanMessage(`${carried}:t0`, start - 95 * MIN, pick(random, FAN_LINES), false),
        theirs(`${carried}:t1`, start + 12 * MIN),
      ]));
      waits.push(
        { chat: late, since: iso(start + 4 * MIN), from: iso(start + 4 * MIN), to: iso(start + 7 * MIN), by: "other" },
        { chat: carried, since: iso(start - 95 * MIN), from: iso(start), to: iso(start + 12 * MIN), by: "other" },
      );
    }
    // The tail of past shifts the chatter worked through in the first 15 minutes: fans silent in this shift, each
    // answered a minute or two after the last. Not the shift's queue, and off the median.
    for (const [index, fan] of free.slice(6, 14).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const since = start - (2 + index * 3) * 60 * MIN;
      const replyAt = Math.min(end - MIN, start + (1 + index * 1.7) * MIN + intBetween(random, 5, 50) * 1000);
      chats.push(chatOf(fan, [
        fanMessage(`${key}:h0`, since, pick(random, FAN_LINES), false),
        myMessage(random, `${key}:h1`, replyAt, Math.round((replyAt - start) / 1000)),
      ]));
      waits.push({ chat: key, since: new Date(since).toISOString(), from: new Date(start).toISOString(), to: new Date(replyAt).toISOString(), by: "me" });
    }
    // A pack of Hi to new followers by «Отправить всем»: a second apart, many in a minute, apart from the pace.
    const packAt = start + Math.round(minutes * 0.3) * MIN;
    for (const [index, fan] of free.slice(14, 24).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const text = pick(random, HI_LINES);
      chats.push({ ...chatOf(fan, [{
        ref: `${key}:hi`, at: new Date(packAt + index * 1000).toISOString(), side: "page", text, priceMills: null, bought: null, tipMills: null,
        media: 0, inShift: true, by: "me", byName: null, mass: false,
        mine: { composedWith: "hi", edited: false, origin: "ai", aiShare: 1, aiFeature: "hi-greeting", aiText: text, draft: null, replySeconds: null, repeats: 0, marks: [] },
      }]), fanLifetimeNetMills: null });
    }
  }
  // The same template to several fans.
  const template = "heyy just got back, did you miss me? ♡";
  let repeated = 0;
  for (const chat of chats) {
    const mine = chat.messages.find((message) => message.mine !== null && message.mine.composedWith !== "hi");
    if (mine && repeated < 4 && random() < 0.3) {
      mine.text = template;
      repeated += 1;
    }
  }
  for (const chat of chats) {
    for (const message of chat.messages) if (message.mine !== null && message.text === template) message.mine.repeats = repeated - 1;
  }
  // A Reply sent in two parts ([NEXT]): the second one typed by the extension, the button's all the same.
  const replied = chats.flatMap((chat) => chat.messages.map((message, index) => ({ chat, message, index })))
    .find(({ message }) => message.mine?.composedWith === "reply" && message.mine.origin === "ai");
  if (replied !== undefined) {
    const first = replied.message.mine!;
    const second = "anyway enough about me, how's your night going?";
    first.aiText = `${replied.message.text} [NEXT] ${second}`;
    replied.chat.messages.splice(replied.index + 1, 0, {
      ...replied.message, ref: `${replied.message.ref}:2`, at: new Date(Date.parse(replied.message.at) + 2000).toISOString(), text: second,
      priceMills: null, bought: null, media: 0, mine: { ...first, part: 2, replySeconds: null },
    });
  }
  // Deleted after they were sent. A fan who erased the whole chat half an hour after their last message: shown pale,
  // counted. The chatter's Russian to an English fan, deleted after 6 min 25 s (the fan saw it), and a Fix command sent as
  // text, deleted after 6 s (no one saw it: not counted). One more of the chatter's deleted ones the archive has no text of.
  const isoAt = (at: number) => new Date(at).toISOString();
  const erased = chats.find((chat) => chat.messages.filter((message) => message.side === "fan" && message.inShift).length >= 3);
  if (erased) {
    const lastFan = Math.max(...erased.messages.filter((message) => message.side === "fan").map((message) => Date.parse(message.at)));
    for (const message of erased.messages) if (message.side === "fan") message.deletedAt = isoAt(lastFan + 27 * MIN);
  }
  let deletedMine = 0;
  const struck = chats.filter((chat) => chat !== erased && chat.messages.some((message) => message.mine !== null && message.mine.composedWith !== "hi"))
    .slice(0, 2);
  for (const [index, chat] of struck.entries()) {
    const position = chat.messages.findIndex((message) => message.mine !== null);
    const after = Date.parse(chat.messages[position]!.at);
    const [text, deletedSeconds] = index === 0 ? ["ой я тоже щас пойду отдыхать после работы", 385] : ["*разверни поигривее", 6];
    const at = Math.min(after + 40_000, end - 2 * MIN);
    chat.messages.splice(position + 1, 0, {
      ref: `${chat.key}:del${index}`, at: isoAt(at), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
      inShift: true, by: "me", byName: null, mass: false, deletedAt: isoAt(at + deletedSeconds * 1000),
      mine: { composedWith: "hand", edited: null, origin: "own", aiShare: 0, aiFeature: null, aiText: null, draft: null, replySeconds: null, repeats: 0, marks: ["cyrillic"] },
    });
    deletedMine += 1;
  }
  // One answer Fansly never gave the archive (the chat dropped from sync): the page socket's copy, no price.
  const socketOnly = chats.find((chat) => chat.platform === "fansly" && chat.messages.some((message) => message.mine !== null && message.mine.replySeconds !== null))
    ?.messages.find((message) => message.mine !== null && message.mine.replySeconds !== null);
  if (socketOnly) Object.assign(socketOnly, { unarchived: true, priceMills: null, bought: null });
  chats.sort((a, b) => Date.parse(a.messages.find((m) => m.inShift)?.at ?? "") - Date.parse(b.messages.find((m) => m.inShift)?.at ?? ""));

  const activity: Response["activity"] = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const at = start + minute * MIN;
    if (inPause(at)) continue;
    // After the last action the tab is open with nothing done until the extension's last beat, then closed.
    if (shift.ongoing && at > shift.lastInputAt) {
      if (at <= shift.lastBeatAt) activity.push({ at: new Date(at).toISOString(), input: false });
      continue;
    }
    activity.push({ at: new Date(at).toISOString(), input: !(at >= slowFrom && at < slowTo) || random() < 0.4 });
  }

  // The money: the PPVs bought and a tip in the chatter's chats, a colleague's PPV from before the shift bought in it,
  // a tip after the colleague's message in their chat, a tip under a wall post and a renewal from a fan without a chat.
  // The colleague's sale is in the fan's money of the shift, not in the shift's.
  const sales: Response["sales"] = [];
  const quiet = firstPage === undefined ? undefined
    : demoFans(firstPage.pageLabel).find((fan) => !chats.some((chat) => chat.key === `${firstPage.pageLabel}:${fan.platformUserId}`));
  const withoutChat = firstPage === undefined || quiet === undefined ? null : { pageLabel: firstPage.pageLabel, fan: quiet };
  const me = shift.user.username;
  type Sale = Response["sales"][number];
  const sell = (chat: ShiftReviewChat | null, at: number, kind: Sale["kind"], netMills: number, facts: Partial<Sale> & Pick<Sale, "origin">) => {
    const fan = chat === null ? withoutChat?.fan ?? null : null;
    const lastWriter = facts.lastWriter ?? null;
    sales.push({
      saleRef: `demo-${sales.length + 1}`, at: new Date(Math.min(at, end - 1)).toISOString(), pageLabel: chat?.pageLabel ?? withoutChat?.pageLabel ?? "",
      fanRef: chat?.fanRef ?? fan?.platformUserId ?? null, fanName: chat === null ? fan?.displayName ?? null : chat.fanDisplayName ?? chat.fanUsername,
      chatKey: chat?.key ?? null, kind, netMills, verdict: "mine", holderName: null, ppvSender: null, ppvSentAt: null,
      writers: lastWriter === null ? [] : [{ name: lastWriter, messages: intBetween(random, 2, 9) }], ...facts, lastWriter,
    });
    if (chat !== null) chat.shiftNetMills += netMills;
  };
  let tipped = false;
  let carried = false;
  for (const chat of chats) {
    for (const message of chat.messages) {
      if (message.mine === null || message.bought !== true || message.priceMills === null) continue;
      sell(chat, Date.parse(message.at) + intBetween(random, 3, 40) * MIN, "ppv", Math.round(message.priceMills * 0.8),
        { origin: "own", ppvSender: me, ppvSentAt: message.at, lastWriter: me });
    }
    const mine = chat.messages.filter((message) => message.mine !== null);
    if (!tipped && mine.length >= 3) {
      tipped = true;
      sell(chat, Date.parse(chat.messages.at(-1)!.at) + 2 * MIN, "tip", 16_000, { origin: "own", lastWriter: me });
    } else if (!carried && mine.length >= 2) {
      carried = true;
      sell(chat, Date.parse(mine[0]!.at) + 6 * MIN, "ppv", 31_200,
        { origin: "colleague_ppv", ppvSender: "sofia", ppvSentAt: new Date(start - 5 * 60 * MIN).toISOString(), lastWriter: me });
    }
  }
  const kept = colleagueChat === null ? undefined : chats.find((chat) => chat.key === colleagueChat!.key);
  if (kept && colleagueChat) sell(kept, colleagueChat.at, "tip", 32_000, { origin: "other_wrote", verdict: "theirs", holderName: "sofia", lastWriter: "sofia" });
  if (withoutChat) {
    sell(null, start + Math.round(minutes * 0.3) * MIN, "subscription", 8_000, { origin: "nobody_wrote_48h" });
    sell(null, start + Math.round(minutes * 0.6) * MIN, "tip", 40_000, { origin: "post_tip" });
  }
  sales.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Around the shift: a renewal before it from a fan the chatter wrote to last, no shift's; a PPV of the shift not bought
  // in it, bought the next morning in a colleague's shift.
  const around = (chat: ShiftReviewChat, at: number, kind: Sale["kind"], netMills: number, facts: Partial<Sale>): Sale => ({
    saleRef: `demo-around-${at}`, at: new Date(at).toISOString(), pageLabel: chat.pageLabel, fanRef: chat.fanRef,
    fanName: chat.fanDisplayName ?? chat.fanUsername, chatKey: chat.key, kind, netMills, verdict: "none", holderName: null,
    ppvSender: null, ppvSentAt: null, lastWriter: me, writers: [{ name: me, messages: intBetween(random, 2, 9) }], origin: "own", ...facts,
  });
  const beforeSales: Sale[] = [];
  const laterSales: Sale[] = [];
  const talked = chats.find((chat) => chat.messages.some((message) => message.mine !== null && message.mine.composedWith !== "hi"));
  if (talked) beforeSales.push(around(talked, start - 40 * MIN, "subscription", 12_000, {}));
  const unsold = chats.flatMap((chat) => chat.messages.filter((message) => message.mine !== null && message.priceMills !== null && message.bought !== true)
    .map((message) => ({ chat, message })))[0];
  if (unsold && !shift.ongoing && end + 9 * 60 * MIN < now) {
    unsold.message.bought = true;
    laterSales.push(around(unsold.chat, end + 9 * 60 * MIN, "ppv", Math.round(unsold.message.priceMills! * 0.8), {
      verdict: "theirs", holderName: "sofia", ppvSender: me, ppvSentAt: unsold.message.at,
    }));
  }

  const others = teamWorld(new Date(now)).shifts.filter((one) => one.user.id === shift.user.id).sort((a, b) => a.startedAt - b.startedAt);
  const position = others.findIndex((one) => one.startedAt === shift.startedAt);
  return {
    shift: {
      userId: shift.user.id,
      username: shift.user.username,
      kind: "shift",
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
      lastInputAt: new Date(shift.lastInputAt).toISOString(),
      lastBeatAt: new Date(shift.lastBeatAt).toISOString(),
      pages: [...pages].sort((a, b) => b.messages - a.messages).map((page) => ({
        pageLabel: page.pageLabel, platform: demoPage(page.pageLabel)?.platform ?? "fansly", messages: page.messages, worked: page.messages >= 10,
      })),
      salesNetMills: sales.reduce((sum, sale) => sum + (sale.verdict === "theirs" ? 0 : sale.netMills), 0),
    },
    previousAt: position > 0 ? new Date(others[position - 1]!.startedAt).toISOString() : null,
    nextAt: position >= 0 && position < others.length - 1 ? new Date(others[position + 1]!.startedAt).toISOString() : null,
    activity,
    chats,
    sales,
    beforeSales,
    laterSales,
    waits: waits.sort((a, b) => Date.parse(a.from) - Date.parse(b.from)),
    unarchived: 0,
    deleted: deletedMine === 0 ? 0 : deletedMine + 1,
    serverNow: new Date(now).toISOString(),
  };
}

function fanMessage(ref: string, at: number, text: string, inShift: boolean): ShiftReviewMessage {
  return { ref, at: new Date(at).toISOString(), side: "fan", text, priceMills: null, bought: null, tipMills: null, media: 0, inShift, by: null, byName: null, mass: false, mine: null };
}

function myMessage(random: () => number, ref: string, at: number, replySeconds: number): ShiftReviewMessage {
  const roll = random();
  let text: string;
  let mine: NonNullable<ShiftReviewMessage["mine"]>;
  const base = { replySeconds, repeats: 0, marks: [] as NonNullable<ShiftReviewMessage["mine"]>["marks"] };
  if (roll < 0.3) {
    text = pick(random, AI_LINES);
    mine = { ...base, composedWith: "reply", edited: false, origin: "ai", aiShare: 1, aiFeature: "fast-reply", aiText: text, draft: null };
  } else if (roll < 0.45) {
    text = pick(random, AI_LINES);
    mine = { ...base, composedWith: "hand", edited: null, origin: "ai", aiShare: 0.92, aiFeature: "coach-chat", aiText: `${text} (or tease him a little first)`, draft: null };
  } else if (roll < 0.7) {
    const [draft, polished] = pick(random, FIX_PAIRS);
    text = polished;
    mine = {
      ...base, composedWith: "fix", edited: false, origin: "fix", aiShare: 1, aiFeature: "improve-draft", aiText: polished, draft,
      fixExpanded: polished.length > 2.2 * draft.length && polished.length - draft.length > 60,
    };
  } else {
    text = pick(random, OWN_LINES);
    mine = { ...base, composedWith: "hand", edited: null, origin: "own", aiShare: null, aiFeature: null, aiText: null, draft: null };
  }
  const priced = random() < 0.06;
  return {
    ref, at: new Date(at).toISOString(), side: "page", text,
    priceMills: priced ? intBetween(random, 8, 25) * 1000 : null, bought: priced ? random() < 0.4 : null,
    tipMills: null, media: priced ? 1 : 0, inShift: true, by: "me", byName: null, mass: false, mine,
  };
}

export function teamShiftReview(request: DemoRequest): Response | DemoReply {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Разбор смены — только для владельца.");
  const userId = queryNumber(request, "userId", Number.NaN);
  const at = Date.parse(queryString(request, "at") ?? "");
  if (!Number.isInteger(userId) || Number.isNaN(at)) return demoError(400, "Bad Request", "userId и at обязательны.");
  const shift = teamWorld(request.now).shifts.find((one) => one.user.id === userId && one.startedAt <= at && at <= (one.ongoing ? request.now.getTime() : one.endedAt));
  if (!shift) return demoError(404, "Not Found", "В это время у этого человека не было смены.");
  return reviewOf(shift, request.now.getTime());
}
