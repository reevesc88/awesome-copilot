---
name: 'Open Pull Request Review Report'
description: 'Scheduled report summarizing open pull requests that need review, rebase, tests, or maintainer attention.'
labels: ['copilot-control-center', 'pull-requests', 'review']
on:
  schedule: weekly on tuesday
  workflow_dispatch: {}
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
engine: copilot
tools:
  github:
    toolsets:
      - pull_requests
      - issues
      - actions
      - repos
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[Open PR Review] "
timeout-minutes: 45
---

# Open PR review report

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Surface open pull requests that need human attention.

## Required behavior
1. Inspect all open pull requests.
2. Highlight PRs that are:
   - waiting for review
   - failing CI
   - stale or merge-conflicted
   - missing tests or documentation
   - risky because they touch security, workflows, billing, deployment, credentials, or production-data paths
3. Group findings by urgency.
4. Avoid duplicate issue creation for the same review window.
5. Create one issue with a short summary table and recommended next actions.

## Safety limits
- Do not approve, merge, or push changes.
- Keep the workflow report-only.
