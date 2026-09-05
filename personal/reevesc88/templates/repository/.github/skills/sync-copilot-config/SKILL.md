---
name: 'sync-copilot-config'
description: 'Run the Reevesc88 control-center sync safely from a separate local checkout against the current target repository.'
---

# sync-copilot-config

## Use when
You need to copy selected control-center templates into one or more explicit target repositories.

## Inputs
- absolute path to a local checkout of `reevesc88/awesome-copilot` containing `personal/reevesc88/inventory.json`
- absolute target path(s)
- optional `--item` filters
- whether this is dry-run or write mode

## Steps
1. Ask for the control-center checkout path if it was not provided. Never assume the sync script or inventory exists in the target repository.
2. Review `<control-center>/personal/reevesc88/inventory.json` to understand source and destination paths.
3. From the control-center checkout, run `personal/reevesc88/scripts/sync-copilot-config.mjs` in dry-run mode against the absolute target path.
4. Inspect proposed creates, skips, and line-number-only difference summaries; compare conflicting files locally when content review is needed.
5. Re-run with `--write` only after human review.
6. If an existing file differs, keep the target override unless there is explicit approval to replace it.

## Safety limits
- Never claim the target repository contains the control-center inventory or sync script.
- Never sync to an implicit or guessed target.
- Never overwrite differing files silently.
- Never store secrets in the templates or target repos.
- Treat target file contents as potentially sensitive and do not echo them into logs.

## Output
Return the files proposed or written, skipped overrides, and any manual follow-up required.
