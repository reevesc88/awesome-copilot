---
name: 'Weekly Bug and Issue Triage Report'
description: 'Weekly triage report that groups bugs and open issues into clear next-action buckets without mutating issue state.'
labels: ['copilot-control-center', 'triage', 'bugs']
on:
  schedule:
    - cron: "30 9 * * 1"
  workflow_dispatch: {}
permissions:
  contents: read
  issues: write
  pull-requests: read
engine: copilot
tools:
  github:
    toolsets:
      - issues
      - pull_requests
      - repos
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[Bug Triage] "
timeout-minutes: 45
---

# Weekly bug / issue triage report

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Produce one weekly issue that turns the open bug backlog into actionable buckets.

## Required behavior
1. Search for open issues labeled `bug` when available; otherwise use repository issue state plus bug-like terms conservatively.
2. Bucket items into:
   - urgent / high impact
   - likely duplicates / related clusters
   - needs reproduction or more information
   - stale but still relevant
   - probably safe to delegate for planning, docs, tests, or implementation prep
3. Identify security-sensitive reports and keep the public summary minimal.
4. Skip duplicate issue creation if the same weekly title already exists.
5. Create one issue with a prioritized table and recommended next actions.

## Safety limits
- Do not close, relabel, or edit issues automatically.
- Do not publish exploit details for security-sensitive bugs.
