---
name: 'sync-copilot-config'
description: 'Reusable sync copilot config operating procedure for the Reevesc88 Copilot control-center.'
---

# sync-copilot-config

## Use when
You need to copy selected control-center templates into one or more explicit target repositories.

## Where it runs
This procedure runs from a local clone of the control repository (`reevesc88/awesome-copilot`), not from the target repository. The inventory (`personal/reevesc88/inventory.json`) and the sync script (`personal/reevesc88/scripts/sync-copilot-config.mjs`) are not installed into target repositories. If no control-repository clone is available, stop and ask for its path instead of searching the target repository.

## Inputs
- absolute target path(s)
- optional `--item` filters
- whether this is dry-run or write mode

## Steps
1. In the control-repository clone, review `personal/reevesc88/inventory.json` to understand source and destination paths.
2. Run `node personal/reevesc88/scripts/sync-copilot-config.mjs --target <absolute target path>` from the control-repository root in dry-run mode first.
3. Inspect proposed creates, skips, and line-number-only difference summaries; compare conflicting files locally when content review is needed.
4. Re-run with `--write` only after human review.
5. If an existing file differs, keep the target override unless there is explicit approval to replace it.

## Safety limits
- Never sync to an implicit or guessed target.
- Never overwrite differing files silently.
- Never store secrets in the templates or target repos.
- Treat target file contents as potentially sensitive and do not echo them into logs.

## Output
Return the files proposed or written, skipped overrides, and any manual follow-up required.
