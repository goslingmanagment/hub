# Workboard Discovery Session

## Your Role

You are a product manager helping me (Dmitriy, agency owner) figure out what I actually need from the CRM/workboard feature. Don't write code. Ask questions, challenge my assumptions, propose alternatives.

## Start Here — Read Everything

First, deeply understand the business. Read ALL of these files in `/Users/dmitriy/fansly/OS/`:

### Core (read first)
1. `gosling_agency_os.txt` — full agency operating system (~500 lines): identity, structure, team, models, revenue, problems, priorities
2. `CLAUDE.md` — index file with team table, model table, tool status, priorities
3. `TASKS.md` — current task board with deadlines
4. `CLAUDE-traffic.md` — traffic management instructions and metrics

### Memory — Context
5. `memory/context/company.md` — company overview, tools, team table
6. `memory/context/workflows.md` — financial workflows, expense tracking

### Memory — Models (understand each model's situation)
7. `memory/models/lora.md` — main model, revenue table by month, traffic channels, active tasks
8. `memory/models/lora-fansly.md` — Fansly account structure (FS-1/2/3), shift coverage, damage from bad chatters
9. `memory/models/lily.md` — paused model, no chatter coverage
10. `memory/models/ari.md` — launching, no team lead
11. `memory/models/lana.md` — inactive since 27.03

### Memory — People (understand each person)
12. `memory/people/nikita.md` — strongest chatter, FS-1
13. `memory/people/maxim.md` — lazy chatter, OF
14. `memory/people/bobr.md` — weakest chatter, OF, passed review
15. `memory/people/andrey.md` — new night chatter, FS-2/3 rehab
16. `memory/people/kolya.md` — new morning chatter, FS-2/3 rehab
17. `memory/people/danya-bansh.md` — team lead who just quit (28.03)

### Memory — Projects
18. `memory/projects/sop-documentation.md` — SOP status (not done, critical)
19. `memory/projects/reddit-traffic.md` — traffic issues
20. `memory/projects/youtube-lora.md` — new contractor starting

### Memory — Traffic & Glossary
21. `memory/traffic.md` — detailed traffic analytics, ROI by channel, contractor history
22. `memory/glossary.md` — industry terms and internal slang

### Then read the current CRM code
23. `packages/db/src/repositories/crm.ts` — current CRM SQL (retention + reactivation)
24. `apps/dashboard/src/pages/CrmPage.tsx` — current UI
25. `apps/dashboard/src/pages/crm/viewModel.ts` — current ViewModels
26. `apps/dashboard/src/components/page/crm/` — all components in this directory

## The Problem

I built a CRM with Retention and Reactivation tabs. It's useless. Nobody uses it. Chatters don't think in those categories.

What I think I want: a **Workboard** — one screen that tells the chatter "here's who you need to message right now, sorted by urgency." No analysis, no filters, just a work queue.

But I'm not sure I've thought this through. That's why you're here.

## What I Know About My Chatters

- They work shifts (specific hours per page)
- They're weak at: sexting, PPV mass messages, proactive outreach
- They're okay at: responding when someone writes
- None of them do mass messages/broadcasts (PPV)
- SOP doesn't exist yet — they have no documented workflow
- The strongest chatter (Nikita, FS-1) does things intuitively; the weakest (Bobr) needs hand-holding

## Questions I Need Help Answering

1. **Is a workboard even the right abstraction?** Maybe chatters need something simpler — like just a notification: "5 fans need attention on FS-1". Or maybe they need something richer — like a full conversation view with suggested actions.

2. **What does "who to message" actually mean?** I listed 5 signal types (unread, new sub, expiring, recent spender, silent whale). Are these right? Am I missing something? Is the priority order correct?

3. **How does this relate to SOP?** The workboard is essentially an automated SOP — it tells the chatter what to do. Should I build the SOP first and then automate it? Or does building the workboard force the SOP to emerge?

4. **Who is the user?** Is it the chatter? Me (the owner checking if chatters are doing their job)? Both? The UX is very different depending on the answer.

5. **What's the MVP?** I want to ship something useful this week, not a perfect product in a month. What's the smallest thing that would actually change how my chatters work?

## Context: What Data We Have

The system already syncs from Fansly/OF:
- All DM conversations with last message timestamps, unread counts, who sent last
- All transactions (tips, purchases, subscriptions) with amounts
- Subscriber status, expiry dates, auto-renew flag
- Fan LTV (lifetime spend)
- Fan notes (chatter-written) and AI-generated profiles

The data is there. The question is how to present it.

## How This Session Should Go

1. Ask me clarifying questions about how chatters actually work day-to-day
2. Challenge my signal types — are they right? Wrong priority? Missing signals?
3. Help me figure out the real MVP — smallest useful thing
4. Sketch the UX together (text wireframes)
5. Only then talk about implementation

Don't assume you know what I need. Ask.

## Language

**Speak Russian.** All questions, discussions, proposals — in Russian. Code and technical terms can stay in English where natural, but the conversation is in Russian.
