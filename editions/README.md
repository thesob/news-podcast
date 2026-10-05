# Editions

One pipeline, several independent podcasts/briefs. Each edition has its own
folder here. The default edition `en` keeps the original URLs; every other
edition lives under its own subpath (`docs/es/feed.xml`, `episode/es/script.txt`).

```
editions/<id>/
  profile.json          feed title/description/language/cover, voice overrides,
                        and the short "prompt" variables (see below)
  prompt/<slot>.md      the edition's own pieces of the agent prompt
```

## Editing an edition's prompt

The agent prompt is **generated**: `prompts/base.md` (shared mechanics) +
this edition's `prompt/*.md` pieces → `prompts/agent-prompt.md` (en) or
`prompts/agent-prompt.<id>.md`. Never edit those two output files by hand.

1. Edit the piece you want (table below).
2. Run `python scripts/assemble_prompt.py` (add an edition id to do just one).
3. Commit the pieces **and** the regenerated `agent-prompt*.md` together. A CI
   check (`check-prompts.yml`) fails if they disagree.
4. Paste the regenerated file into that edition's Cowork task, filling in
   `[YOUR PROXY URL]` / `[YOUR PROXY TOKEN]` there (never in git).

Slot files may contain `<!-- comments -->`; they are stripped before the prompt
is built, so leave notes to yourself freely.

### Slot files (`prompt/<name>.md` → `{{NAME}}` in base.md)

| File | Controls |
|---|---|
| `sources.md` | The list of outlets to check |
| `backup-outlets.md` | Example backup outlets in the fallback chain |
| `paywall-note.md` | Which outlets are paywalled and who covers for them |
| `topics.md` | Topic priorities for story selection |
| `language-rules.md` | Which language each part of the brief is written in |
| `section-order.md` | Section names and their order |
| `news-subsections.md` | The subsections that share the single `[SECTION news]` marker |
| `script-tagging.md` | Which `[EN]/[ES]/[SV]` tags the podcast script uses |
| **`connecting-dots.md`** | **The whole Connecting the Dots section: addressee, regional lens, disclaimer, length** |
| **`hypothesis.md`** | **The standing hypothesis, its four sub-claims, header and framing** |

### Variables (`profile.json` → `"prompt": { ... }`)

`subject_name` (email subject; must match the Apps Script `gmailSearch` for the
edition), `addressee_phrase`, `lang_tag`, `first_news_subsection`,
`integral_review_title`, `month_year`, `month_year_example`.

Auto-derived, nothing to define: `{{EDITION_ID}}`, `{{HYPOTHESIS_LOG_URL}}`,
`{{HYPOTHESIS_REVIEWS_URL}}` (per edition: `…/es/hypothesis-log.md`).

### Constraints

- The hypothesis machinery assumes **four sub-claims (a)–(d) in a chain**; the
  daily log line and the monthly integral review are built on that shape.
  Statement and wording are free; the count is not.
- The log line's tokens (`a:`…`d:`, `support|challenge|neutral`) stay English in
  every edition; only the short reasons are translated.

## Adding an edition

1. `editions/<id>/profile.json` (copy `es`, change title/language/prompt vars).
2. `editions/<id>/prompt/*.md` — copy the `es` set and edit.
3. Add an entry to `CONFIG.EDITIONS` in `scripts/gmail-to-github.gs` (distinct
   email subject, `episode/<id>/script.txt`, `docs/<id>/hypothesis-*.md`,
   `RECIPIENTS_<ID>` property) and paste the script into Apps Script.
4. `python scripts/assemble_prompt.py <id>`, then create the Cowork task.
