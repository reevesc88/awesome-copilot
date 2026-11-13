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
5. Build the canonical failing set without hashing (this workflow has no shell tool). Encode each failing pair as a JSON array of two strings, `["<workflow>","<job>"]`, using standard JSON string escaping, so a name that contains ` / `, `; `, a comma, a quote or a newline cannot collide with another pair or break the line. Then replace every `<` with `\u003c` and every `>` with `\u003e`, so no name can close the HTML comment. Drop duplicate encoded pairs, sort them by plain character order, and join them with `,` inside one outer `[` `]` with no spaces. The result is a single-line JSON array of pairs: the canonical set. Put it on the first line of the issue body as exactly `<!-- ci-summary-set: <canonical set> -->`, followed by the same list in readable form. Title the issue `[CI Summary] <YYYY-MM-DD> <N> failing job(s)`. The title is a label only and is never used for dedup.
6. Before creating an issue, list the open issues whose title starts with `[CI Summary] ` and read their raw markdown bodies (the API `body` field, not rendered text, since rendering drops HTML comments). Build the expected marker line `<!-- ci-summary-set: ` + canonical set + ` -->`. Stop without creating another issue only when an open issue's raw body has a line exactly equal to that whole marker line, on any date. Never compare titles, prefixes, partial lists or the payload without its wrapper. A different failure set, even on the same UTC day, is NOT a duplicate. `create-issue.max: 1` only limits a single run, so this exact raw-body marker check is the cross-run dedup.
7. When an issue is created, keep it concise and bounded, and include the UTC date, the exact `<!-- ci-summary-set: <canonical set> -->` marker line and the full sorted failing workflow/job list in the body.

## Safety limits
- Do not rerun, cancel, or modify workflows automatically.
- Do not expose secrets from logs.

## Usage
- If a repository wants event-driven triggers later, customize this template after installation to watch specific `workflow_run` events.
