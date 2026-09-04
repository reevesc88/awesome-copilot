---
name: 'Documentation Drift Check'
description: 'Scheduled check that reports likely documentation drift after code or workflow changes.'
labels: ['copilot-control-center', 'documentation']
on:
  schedule: weekly on wednesday
  workflow_dispatch: {}
permissions:
  contents: read
  issues: read
  pull-requests: read
engine: copilot
tools:
  github:
    toolsets:
      - repos
      - pull_requests
      - issues
  bash: true
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[Docs Drift] "
timeout-minutes: 30
---

# Documentation drift check

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Report likely cases where code, automation, or setup changed but docs did not keep up.

## Required behavior
1. Review recent merged pull requests and direct commits from the last 7 days.
2. Look for changes in code, workflows, configuration, or setup files without corresponding doc updates.
3. Highlight missing README/setup/operations/security documentation candidates.
4. Skip duplicate issue creation for the same reporting window.
5. Create one issue with evidence and suggested follow-up docs tasks.

## Safety limits
- Report only.
- Do not edit documentation automatically from the schedule.
