# Code-map regeneration prompt — core (Agency Hub)

This is the re-runnable generator for the machine maps in `docs/generated/`.
Every file there cites this prompt in its banner. Run it on Opus 4.8, in a
fresh session opened in this repo, whenever the maps need regenerating.
(Originally the Project-Kernel Pass-1 map prompt; the historical Pass-1
originals have been retired now that `docs/generated/` is the living reference.)

---

You are mapping a codebase so that a stronger model can later perform a
deep architecture review and design a rework plan across a three-project
ecosystem. This pass covers ONE project; the other two get their own
passes. Your output is the reviewer's map of this territory — make it
complete, precise, and factual.

The project: /Users/dmitriy/code/goose/hub — the backend hub of an
OnlyFans/Fansly agency stack. It ingests platform data (OFAPI webhooks,
sync jobs), stores it, and serves a dashboard plus client applications
(a desktop chat workspace and a browser extension, documented in their
own passes).

Scan all the code — every package, module, service, script — and
document everything important, so that the reviewer can understand this
project completely without re-discovering it from scratch. Let the
codebase itself dictate what the documentation covers and how it is
structured; do not work from any predefined checklist of topics — if
something exists in the code and matters, it belongs in the map. The one
thing to treat with special care is the project's boundaries: every
contract it has with the outside world, described from this side —
what it exposes and for whom, what it calls, and exactly what data
crosses each boundary — because the reviewer will be stitching three
projects together. Anchor claims in file paths so the reader can jump
straight to code.

Strictly descriptive. No ratings, no "should", no recommendations, no
architectural opinions — the reviewing model must form its own judgment,
and your job is only to make the territory legible. Where the code's
actual behavior differs from what names or comments suggest, describe
the actual behavior.

Ignore old audit/review/plan documents in the repo — document the code
as it is now, not as documents say it was or should be.

Write the documentation in English into `docs/generated/` in this repo
(create the folder if absent), alongside this prompt file — leave this prompt
(`REGENERATION-PROMPT.md`) and the auth-policy table untouched, and overwrite
the previous maps.

---

## Regeneration notes

When regenerating the maps:

- Write the maps into `docs/generated/` in this repo (create the folder if
  absent). This prompt lives there too, as `REGENERATION-PROMPT.md`.
- Start every generated file with this banner (fill in the current date and
  `git rev-parse --short HEAD`):

  > Generated <YYYY-MM-DD> from <path to this prompt> at commit <sha>.
  > Machine-generated reference — regenerate by re-running that prompt in a
  > fresh session; do not hand-edit.

- Map the tree as it is TODAY (post-kernel-migration). Every claim must be
  verified against current code — subsystems that no longer exist are
  dropped, new ones (whatever the code contains now) are mapped.
- Keep file naming NN-topic.md with a 00-overview.md index, but let today's
  codebase dictate the actual breakdown.
