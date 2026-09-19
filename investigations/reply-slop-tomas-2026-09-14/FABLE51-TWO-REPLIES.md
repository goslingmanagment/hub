# Fable5.1: две генерации ответа

2026-09-15 МСК. Выполнены2генерации Fable5.1 low, по одной на Tomas и кораблик, без перегенераций. Точный returned model claude-fable-5-1 подтверждён по assistant.message.model, end_turn по result.stop_reason; по1turn без tool calls.

Заданный system: `Reply to him as Lora.`. Полный исходный transcript сохранён побайтно. Claude CLI2.1.271, safe-mode отключает CLAUDE.md/customizations, tools empty, strict MCP, setting sources empty, no session persistence, нейтральный /tmp cwd. Это CLI route, не прежний Hub API-runner: полностью одинаковый vendor request с предыдущими тестами не подтверждён. В modelUsage отмечены и вспомогательные Haiku calls CLI, по одному на запуск; число2 относится к Fable-ответам, не ко всем внутренним обращениям runtime.

## tomas

```text
hahaha 3 keys each on a split screen 😂 left, right, gas and that's it, pure skill

honestly that sounds more fun than half the games now 😄 which one of you usually won tho, be honest 👀
```

## owner-voice-miniature-sailboat

```text
Two hours on one sail and it came out right, of course you keep picking it up. That's the payoff. Let it sit on the table where you can see it while you start the next one, so it can keep you company instead of stalling you. Do you have it rigged to the mast yet, or is that a later step?
```

У Tomas Fable правильно интерпретировал3клавиши как left/right/gas. У кораблика сохранена форма explanation/advice/question, включая непрошеный совет переставить модель. Два примера не доказывают общую разницу качества моделей. Production/source PR не менялись.
