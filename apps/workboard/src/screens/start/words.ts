import type { AccountStartResponse, PersonStart, PersonStartStepId } from "@agency_hub_core/contracts";
import { formatDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { platformWord } from "@agency_hub_core/ui";

/**
 * «Начало» in words: what each step says done and to do, and «Как сдаётся
 * смена». Every sentence is true whether the person hands shifts in through
 * Hub or through Генгар: the texts that differ follow `submitsShift`.
 */

/** «Firefox · Windows · ChatGoose» → «Firefox, Windows»: the product's own name says nothing here. */
export function deviceWords(label: string): string {
  const parts = label.split("·").map((part) => part.trim()).filter((part) => part !== "" && !/^chatgoose$/i.test(part));
  return parts.join(", ");
}

/** «Mia Hart: mia-1, mia-2 (Fansly)»; the pages of one model on one line. */
export function pagesWords(pages: PersonStart["pages"]): string[] {
  const byModel = new Map<string, PersonStart["pages"]>();
  for (const page of pages) byModel.set(page.modelName, [...(byModel.get(page.modelName) ?? []), page]);
  return [...byModel].map(([model, list]) => {
    const platforms = [...new Set(list.map((page) => platformWord(page.platform) ?? page.platform))].join(", ");
    return `${model}: ${list.map((page) => page.pageLabel).join(", ")} (${platforms})`;
  });
}

/** «Осталось 3 шага до первой смены». */
export function leftWords(start: PersonStart): string {
  const left = start.total - start.done;
  return left === 0 ? "Все шаги пройдены" : `${left === 1 ? "Остался" : "Осталось"} ${left} ${ruPlural(left, "шаг", "шага", "шагов")} до первой смены`;
}

/** The name to greet by: the first word of how the agency calls the person. */
export function firstName(data: AccountStartResponse): string {
  return (data.person?.displayName ?? data.username).trim().split(/\s+/)[0] ?? data.username;
}

export interface StepWords {
  title: string;
  /** What Hub saw, or what to do. */
  text: string | null;
}

export function stepWords(step: PersonStartStepId, done: boolean, data: AccountStartResponse): StepWords {
  const start = data.start!;
  switch (step) {
    case "install":
      return done
        ? { title: "Расширение установлено", text: null }
        : { title: "Установите расширение ChatGoose", text: "На компьютере, в Firefox: на сайте ChatGoose нажмите «Установить в Firefox», потом «Добавить»." };
    case "extension": {
      if (!done || start.extension === null) {
        return { title: "Войдите в расширение", text: "Окно входа откроется само после установки. Логин ниже, пароль тот, что вы придумали по ссылке." };
      }
      const device = deviceWords(start.extension.label);
      const seen = [device, formatDay(start.extension.signedInAt)].filter(Boolean).join(", ");
      return {
        title: "Расширение подключено",
        text: start.extension.active ? seen : `${seen}. Этот вход уже завершён: войдите снова, когда сядете за смену.`,
      };
    }
    case "pages":
      return done
        ? { title: "Страницы назначены", text: null }
        : { title: "Страницу назначает владелец", text: "Владелец уже видит, что её нет. Строка закроется сама, когда страница появится." };
    case "activity":
      return done && start.firstActivity
        ? { title: "Первая работа на странице", text: `${start.firstActivity.pageLabel}, ${formatDay(start.firstActivity.at)}` }
        : {
          title: "Первая работа на странице",
          text: "Доступ к аккаунту страницы на Fansly или OnlyFans даёт владелец. Откройте чат страницы в Firefox с расширением, и строка закроется сама.",
        };
    case "payout":
      return done
        ? { title: "Куда переводить выплаты", text: null }
        : { title: "Куда переводить выплаты", text: "Как вы получаете деньги: например, UID в Bybit или адрес кошелька USDT и сеть. Это видите только вы и владелец." };
  }
}

/** «Как сдаётся смена»: one screen of the product's words, true for both ways of handing a shift in. */
export function shiftRules(submitsShift: boolean): { title: string; text: string; list?: string[]; after?: string }[] {
  return [
    {
      title: "Смена",
      text: "Hub видит смену сам, по работе в расширении: от двух часов и 50 сообщений. Ваши смены и отчёты по ним собраны в «Мои смены».",
    },
    {
      title: "Отчёт смены",
      text: submitsShift
        ? "В конце смены откройте её в «Мои смены»: черновик Hub уже собрал. Проверьте строки, нажмите «Сдать смену», затем «Скопировать пост» и отправьте пост в топик «Отчётность» рабочей группы."
        : "В конце смены напишите Генгару /smena в рабочей группе модели: он соберёт черновик по продажам смены. Проверьте его и отправьте постом в топик «Отчётность». Отправленный отчёт появится в «Мои смены».",
    },
    {
      title: "Чья продажа",
      text: "Черновик раскладывает продажи по правилу: кто писал фану и чья смена шла. Если вы не согласны со строкой:",
      list: [
        "«не моё»: продажа не ваша, в ваш отчёт она не войдёт;",
        "«делим»: продажу сделали вдвоём с коллегой, каждому половина;",
        "«мимо площадки»: фан заплатил не через Fansly или OnlyFans; сумма ждёт подтверждения владельца.",
      ],
      after: submitsShift ? "Эти слова стоят у каждой строки черновика." : "Сейчас это говорят Генгару, когда он собирает черновик.",
    },
    {
      title: "Где спросить",
      text: "О смене и отчёте спрашивайте Генгара в рабочей группе. Доступ, страницы и выплаты решает владелец: пишите ему в Telegram.",
    },
  ];
}
