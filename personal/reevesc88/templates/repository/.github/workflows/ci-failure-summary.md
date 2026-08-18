---
name: 'CI Failure Summary'
description: 'Scheduled or manual investigation trigger that summarizes recent failing workflow runs and recommends next debugging steps.'
labels: ['copilot-control-center', 'ci', 'debug']
on:
  schedule:
    - cron: "0 */8 * * *"
  workflow_dispatch: {}
permissions:
  contents: read
  issues: write
  actions: read
  pull-requests: read
engine: copilot
tools:
  github:
    toolsets:
      - actions
      - pull_requests
      - repos
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
5. When an issue is created, keep it concise and bounded.

## Safety limits
- Do not rerun, cancel, or modify workflows automatically.
- Do not expose secrets from logs.

## Usage
- If a repository wants event-driven triggers later, customize this template after installation to watch specific `workflow_run` events.
