---
name: 'sync-copilot-config'
description: 'Use the Reevesc88 sync script to copy selected Copilot control-center templates into explicit target repositories with dry-run-first safety.'
---

# sync-copilot-config

Use this skill when you want to install part of the personal control-center into another repository.

## Required inputs
- one or more **absolute** target repository paths
- optional inventory item ids to limit what will be copied
- whether the run should remain dry-run or write changes

## Steps
1. Read `personal/reevesc88/inventory.json`.
2. Run the sync script in dry-run mode first.
3. Review creates, skips, and diffs.
4. Only re-run with `--write` after human approval.
5. Preserve differing target files unless there is explicit approval to replace them.

## Safety limits
- Never guess a target path.
- Never overwrite differing files silently.
- Never copy secrets into target repositories.

## Command

```bash
node personal/reevesc88/scripts/sync-copilot-config.mjs --target /absolute/path/to/target-repo
```
