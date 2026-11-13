---
name: 'CI Failure Summary'
description: 'Scheduled or manual investigation trigger that summarizes recent failing workflow runs and recommends next debugging steps.'
labels: ['copilot-control-center', 'ci', 'debug']
on:
  schedule: every 8h
  workflow_dispatch: {}
permissions:
  contents: read
  actions: read
  pull-requests: read
  issues: read
engine: copilot
tools:
  github:
    toolsets:
      - actions
      - pull_requests
      - repos
      - issues
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[CI Summary] "
timeout-minutes: 30
---

# CI failure summary

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Summarize the most important recent CI failures and recommend the safest next investigation step.

## Required behavior
1. Look at recent completed workflow runs in the current repository.
2. Focus on failed or flaky-looking runs from the last 24 hours unless manually overridden.
3. For each important failure, record:
   - workflow and job name
   - first failing step
   - likely cause category (test regression, infra flake, missing secret, config drift, dependency failure, unknown)
   - safest next action
4. If no recent failures exist, stop without creating a new issue unless manually dispatched and explicitly asked for a clean summary.
5. Build a canonical duplicate key from the FULL failing set: list every failing pair as `workflow / job`, sort the pairs, join them with a newline, and take the first 12 hex characters of the SHA-256 of that text (the set digest). Title the issue `[CI Summary] <YYYY-MM-DD> set:<digest>`. The title never holds a truncated pair list, so the digest always stands for the whole set.
6. Before creating an issue, search open issues whose title starts with `[CI Summary] `. Stop without creating another issue only when an open issue's title carries the same `set:<digest>` (on any date). Do not compare pair-list prefixes or titles. A different failure set, even on the same UTC day, has a different digest and is NOT a duplicate. `create-issue.max: 1` only limits a single run, so this digest check is the cross-run dedup.
7. When an issue is created, keep it concise and bounded, and repeat the UTC date, the set digest and the full sorted failing workflow/job list in the body.

## Safety limits
- Do not rerun, cancel, or modify workflows automatically.
- Do not expose secrets from logs.

## Usage
- If a repository wants event-driven triggers later, customize this template after installation to watch specific `workflow_run` events.
