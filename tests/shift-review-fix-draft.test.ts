import { describe, expect, it } from "vitest";

import { fixDraftKind } from "../apps/runtime/src/services/shift-review.ts";

// Whose text a Fix sent: a command to the AI, the chatter's own draft the AI only grew, or the chatter's own. The
// drafts are the real ones the audit of 07.11 found labelled the wrong way round (only the first word was looked at,
// and the length was the completion's, swollen by leaked reasoning).

describe("fixDraftKind", () => {
  it("takes an order anywhere in the draft for a command", () => {
    expect(fixDraftKind("пингани по контексту", "hey you, still around? 👀 been thinking about our chat")).toBe("command");
    expect(fixDraftKind("пингани по контексту спроси есть ли планы на выхи", "any plans for the weekend? :3")).toBe("command");
    expect(fixDraftKind("*развернутый ответ", "x".repeat(400))).toBe("command");
    expect(fixDraftKind("so what are you into sexually? like any specific kinks or fetishes\n\n*вставь по контексту", "so what are you into?"))
      .toBe("command");
    expect(fixDraftKind("36 размер обьясни ему шоб он понял", "it's a size 36, so think small and cute haha")).toBe("command");
  });

  it("takes an order word at the start for a command unless the draft speaks to the fan", () => {
    expect(fixDraftKind("спроси а чем занимается он", "so what do you do?")).toBe("command");
    expect(fixDraftKind("ответь ему мягко что сегодня ты не можешь, но завтра точно сможешь", "not tonight babe, but tomorrow for sure"))
      .toBe("command");
    expect(fixDraftKind("скажи мне потом как тебе", "tell me how you like it after 👀")).toBe("own");
    expect(fixDraftKind("расскажи мне больше о себе, чем занимаешься?", "tell me more about yourself, what do you do?")).toBe("own");
  });

  it("does not take a leading asterisk alone for a command", () => {
    expect(fixDraftKind("*эй джаред как твои дела как твои выходные", "hey jared, how are you? how was your weekend")).toBe("own");
    expect(fixDraftKind("*это тут причем хаха", "what's that got to do with anything haha")).toBe("own");
    expect(fixDraftKind("*короткий поддерживающий ответ", "aww that sounds like a lot, i'm proud of you for pushing through ♡ take it easy tonight"))
      .toBe("command");
  });

  it("measures the length against what was sent, not the completion", () => {
    const draft = "что ж тогда я точно буду спокойна за всех посетителей кто решит покататься хаха";
    expect(fixDraftKind(draft, "well then i'll be totally calm about everyone who decides to go for a ride haha")).toBe("own");
    expect(fixDraftKind("думаю да", "i think so yeah :3 honestly i've been wanting to try that for a while, you always have the best ideas"))
      .toBe("expanded");
  });

  it("keeps «work**» correcting a word apart from an order after an asterisk", () => {
    expect(fixDraftKind("work** ладно все равно картинка стоит тысячи слов смотри сам", "work* anyway a picture's worth a thousand words, see"))
      .toBe("own");
    expect(fixDraftKind("i know i asked that already but *выкручиваемся из ситуации с повтором", "i know i asked that already but humor me"))
      .toBe("command");
  });
});
