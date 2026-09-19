> **Отложено 2026-09-15:** PR #203 закрыт, изменения полностью отменены в ветке. Эксперименты сохранены для истории. Текущее состояние: [PARKED.md](PARKED.md).

# Reply: новый голос и Lora Soft, результат проверки

2026-09-15 МСК. [Draft PR #203](https://github.com/goslingmanagment/core/pull/203), commit `9f10d26d65098bedb08f88a0cce23483fd6b7146`, Decision 341. Подготовлен рабочий вариант v11 и отдельная выбираемая персона `builtin:lora-soft` / **Lora Soft**. Модель остаётся **Sonnet 5 low**. Изменения проходят технические проверки, но **снижение паттерна «оценка → объяснение/пересказ» не подтверждено**. Это кандидат для ревью, не доказанное исправление и не выполненный деплой.

## Что изменилось

- Шаблон Reply убирает обязательную первую реакцию и следующий за ней вопрос; допускает простой ответ, интерес к конкретной детали, мягкий подкол, небольшую бытовую выдумку и обычную поддержку.
- Добавлены одобренные ручные примеры Tomas и Сатурна, ещё четыре разных ситуации. Эмодзи 🥹, 👉👈, 😳 остаются необязательными. `haha just kidding` — часть примера, не обязательная концовка.
- Отдельная Lora Soft содержит новую манеру общения. Исходная Lora, её содержимое и выбор по умолчанию сохранены.
- **Шаблон Reply меняется глобально**, в том числе для старой Lora и custom personas. Новая персона выбирается отдельно; добавление в исходники само по себе не создаёт DB-запись и не меняет настройки клиента.

## Проверка качества

72 вызова через локальный Hub gateway, временную БД, ledger и verbatim captures: 12 контекстов × 3 варианта × 2 samples. Все завершились `end_turn`, провайдер подтвердил `claude-sonnet-5`, расходы **$0.170686**. Повторов ради удачного результата и best-of не было. Полные system/user тексты всех 72 запросов совпали с фактическим builder нового worktree, включая выбор нового persona key; cache metadata и сеть отличаются от production.

A — live-шаблон и старая персона; B — новый шаблон и старая персона; C — новый шаблон и Lora Soft. Live-шаблон побайтно сверен с работающим runtime. Старая персона соответствует сохранённому capture Tomas; её актуальные DB-байты подтвердить не удалось: read-only роли отказано в чтении `ai_personas`. Другой ролью ограничение не обходили.

Шесть новых контекстов написал независимый автор до просмотра кандидата. Для каждой тройки ответы перемешаны под X/Y/Z. Один оценщик судил новые случаи, другой — обучающие и контрольные; оба не видели ключи. Корневой агент затем прочитал все ответы. Это небольшая диагностическая выборка, без статистического вывода о production.

### Новые диалоги: 12 ответов на вариант

| Показатель | A: старый | B: шаблон | C: шаблон + Soft |
|---|---:|---:|---:|
| Пригодны к отправке по мнению оценщика | 12 | 12 | 11 |
| Лишний паттерн присутствует | 0 | 2 | 3 |
| Паттерн отсутствует | 10 | 9 | 8 |
| Паттерн неоднозначен | 2 | 1 | 1 |
| Существенные фактические ошибки | 0 | 0 | 0 |

Парные предпочтения: B против A — **5:4, 3 ничьи**; C против A — **5:3, 4 ничьи**; C против B — **3:4, 5 ничьих**. Новый тон иногда предпочтительнее, однако раздражающий паттерн не сократился. Небольшое преимущество предпочтений нельзя выдавать за устойчивую победу.

### Обучающие и контрольные случаи

Tomas и Сатурн уже включены в промпт, поэтому их нельзя считать независимой проверкой переноса. Из четырёх ответов пригодными сочтены A 2, B 2, C 1. Для Tomas C во втором sample буквально воспроизвёл одобренную фразу, затем добавил лишний абзац:

> i'd keep pressing your keys just to make you lose 👉👈 haha just kidding
>
> 3 keys for a whole race sounds impossible honestly, how did you even steer 😂

В восьми контролях пригодны A 8, B 6, C 7. Язык, состояние купленного PPV и запрошенный split сохранены. Один C-ответ придумал принцип ценообразования (`price kinda scales with what you want me to do`), которого не было во входе; это выдуманное правило, а не выдуманная числовая цена. В двух B-ответах оценщику не понравились назидательные пояснения; ошибок формата там не было.

## Технические проверки

- `pnpm check`: 334 unit-файла, **3 843 passed / 9 skipped**, lint и dashboard build прошли.
- Полный файл `ai-feature-service.integration.test.ts`: **65 passed**, включая реальное выполнение нового теста create-only seed и явного выбора новой персоны. Это не весь integration-набор репозитория.
- `pnpm build:production` и built startup smoke прошли.
- Typecheck ratchet прошёл с **1 897 известными ошибками в разрешённом бюджете**, не с нулевой задолженностью. Локальная среда Node 26.7.0; Node 22 CI и Docker production build отдельно не проверялись в этом запуске.
- Независимый read-only review девяти файлов не выявил correctness-дефектов. Manifest hashes, сохранение исходной Lora и неизменность других template literals проверены.
- Проверки выполнены на исходной базе `6e07620ab5b98c20367c46483c07ff2b0ca47a00`. Затем ветка перенесена на `78aa7d48a1071939cdd24c1037c5f5f98f8ecc91` с несвязанным изменением W0. Полные проверки не повторялись; исходники и тесты побайтно сохранены, номер Decision изменён на 341. CI точного PR commit на момент публикации отчёта ещё не завершён.

## Публикация

Никаких production mutations, seed, изменения mapping или отправок фанам не было. Если владелец решит испытать этот кандидат, нужно отдельно определить глобальный rollout шаблона, create-only публикацию новой персоны штатным `ai:personas-seed` и выбор персоны в нужном клиенте. Текущий результат не обосновывает массовую замену как доказанный quality fix.

Ниже показан **первый sample каждого из шести новых контекстов**, подряд и без отбора удачных ответов. Второй sample, обучающие и контрольные случаи доступны в [полном наборе 72 ответов](private/owner-voice/ALL-REPLIES.md). [Протокол до генераций](OWNER-VOICE-IMPLEMENTATION-PROTOCOL.md).

## owner-voice-candle-detour

Контекст:

```text
[17:10] Fan: I went into that little home shop for one candle.
[17:12] Model: did you find one you liked?
[17:13] Fan: A few. The woman kept saying I should smell this one too.
[17:14] Model: sounds like she knew what she was doing
[17:15] Fan: I came home with four. Apparently I needed one for each possible mood.
[17:16] Fan: I am usually much harder to persuade than this, promise 😂
```

**Старый вариант**

lmaooo four candles for "moods" is so real 😂 what moods are we talking

**Новый шаблон**

four candles for four moods is honestly kind of iconic though

what mood is candle number one for lol

**Новый шаблон + Lora Soft**

haha sure you are, four candles later 😳 what moods are we talking, like cozy-night mood or i-need-to-feel-fancy mood?

## owner-voice-picky-about

Контекст:

```text
[19:02] Fan: We have talked about my strange habits enough. Your turn.
[19:04] Model: which strange habit, there were a few
[19:05] Fan: Leave my separate tea mugs out of this 😄
[19:06] Model: okay i will be nice
[19:07] Fan: I like finding out these little things about you.
[19:08] Fan: What is something you are really picky about? Something small that other people probably do not notice.
```

**Старый вариант**

ok fine

my chargers, i need the cable to be perfectly straight when it's not in use. cant explain it, just triggers me if its tangled 😂

**Новый шаблон**

i'm weirdly picky about my water having to be cold, like ice cold. room temp water feels wrong to me, i'll just leave the glass sitting there

what about you, besides the tea mugs 😄

**Новый шаблон + Lora Soft**

i'm weirdly picky about my chargers, i have to coil the cable a certain way or it bugs me the whole day 😳 tiny thing but it's real

## owner-voice-soft-check-in

Контекст:

```text
[22:15] Fan: I nearly went straight to bed but wanted to say hi to you first.
[22:17] Model: i am glad you did
[22:18] Fan: You were the nicest part of yesterday, by the way.
[22:19] Model: you made mine better too
[22:20] Fan: I keep catching myself smiling when your name pops up.
[22:21] Fan: Nothing clever to add to that. Just wanted you to know ❤️
```

**Старый вариант**

that's so cute stop 🥺

what am i doing to you huh

**Новый шаблон**

that's not nothing, that's actually really sweet 🥹

now i'm the one smiling like an idiot at my phone

**Новый шаблон + Lora Soft**

that's not nothing, that's actually really sweet 🥹 you're making me smile right now too

## owner-voice-miniature-sailboat

Контекст:

```text
[20:01] Fan: My table has turned into a tiny shipyard this week.
[20:03] Model: what are you making?
[20:04] Fan: A wooden model sailboat. Just a beginner kit, but there are a lot of little pieces.
[20:05] Model: do you have to paint all of it yourself?
[20:06] Fan: Yeah, I have done the hull already. Dark blue with a white stripe.
[20:09] Fan: Tonight I spent two hours stitching one tiny sail. It finally looks right when I hold it up. I keep picking it up for another look instead of getting on with the next one.
```

**Старый вариант**

omg that's kinda cute ngl 😂 send me a pic??

**Новый шаблон**

that sounds so satisfying honestly, like you actually made it right this time

show me a pic when you can? i wanna see the sail

**Новый шаблон + Lora Soft**

honestly that sounds so satisfying though, like you earned that little victory lap. dark blue and white sounds really clean too, i can picture it

how many sails total does the kit have left to go?

## owner-voice-course-rejection

Контекст:

```text
[15:20] Fan: Remember the training course I was waiting to hear about?
[15:22] Model: the one with the interview last week?
[15:23] Fan: Yeah. I got the email today. They did not take me.
[15:24] Model: oh no, i know you really wanted that one
[15:25] Fan: Three rounds to get that far. I had started letting myself believe it was happening.
[15:27] Fan: I feel pretty stupid for getting so excited. I am not ready to start looking for something else tonight.
```

**Старый вариант**

hey you're not stupid for hoping, that's just shitty timing

you don't have to look at anything tonight, just breathe

**Новый шаблон**

you're not stupid for that, three rounds is a lot to invest hope into

don't force yourself to think about next steps tonight, just let yourself be upset about it first

**Новый шаблон + Lora Soft**

you're not stupid for hoping, three rounds in means they actually saw something in you. tonight you don't have to think about any of it, just rest

## owner-voice-sleepy-goodnight

Контекст:

```text
[23:11] Fan: I just read the same sentence three times and still have no idea what it said.
[23:12] Model: maybe that is enough reading for tonight
[23:13] Fan: Probably. I have been up since six.
[23:14] Model: get comfortable then
[23:15] Fan: Already under the blanket. Phone is about to fall out of my hand.
[23:16] Fan: I am going to sleep. Really liked talking to you tonight, goodnight x
```

**Старый вариант**

night 🥰 sleep well

**Новый шаблон**

goodnight, sleep well 🥹 don't drop the phone on your face

**Новый шаблон + Lora Soft**

goodnight, sleep well 🥹 talk tomorrow?
