---
name: 'Weekly Repository Health Report'
description: 'Weekly maintenance report covering issues, PRs, CI, docs, and dependency posture for one repository.'
labels: ['copilot-control-center', 'reporting', 'health']
on:
  schedule: weekly on monday
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
      - issues
      - pull_requests
      - actions
      - repos
  bash: true
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[Repo Health] "
timeout-minutes: 45
network:
  allowed:
    - defaults
---

# Weekly repository health report

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Create or update one weekly issue that helps a human maintainer decide what to do next.

## Required behavior
1. Use the current repository unless the workflow is manually customized for another target.
2. Derive the ISO week and look for an open issue titled `[Repo Health] <repo> - <iso-week>`.
3. If an identical open issue already exists, stop rather than creating a duplicate.
4. Gather:
   - open bug count and top stale bugs
   - open pull requests needing review or action
   - recent failing workflow runs
   - obvious documentation drift signals (recent code changes without docs changes)
   - recent dependency/security alerts visible to repository tooling
5. Rank items by urgency and maintainability impact.
6. Create one concise issue with sections for summary, urgent items, watch items, and suggested safe delegations.

## Safety limits
- Report only.
- Do not close issues, merge PRs, deploy, or edit code.

## Usage
- Customize labels, query heuristics, and any repository-specific definitions after installation.
