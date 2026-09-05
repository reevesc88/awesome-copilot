---
name: 'Dependency and Security Review'
description: 'Scheduled dependency/security review that reports visible upgrade, alert, and permission hygiene work for human follow-up.'
labels: ['copilot-control-center', 'dependencies', 'security']
on:
  schedule: weekly on thursday
  workflow_dispatch: {}
permissions:
  contents: read
  issues: read
  pull-requests: read
  security-events: read
  vulnerability-alerts: read
  actions: read
engine: copilot
tools:
  github:
    toolsets:
      - repos
      - pull_requests
      - actions
      - issues
      - dependabot
      - code_security
      - secret_protection
safe-outputs:
  create-issue:
    max: 1
    title-prefix: "[Dependency Review] "
timeout-minutes: 45
---

# Dependency and security review

> Adapted for this personal control-center from the safe reporting patterns already used in this repository's existing agentic workflows. Keep these templates audit/report oriented until a target repository deliberately customizes them.

## Goal
Create one weekly issue summarizing dependency and repository security follow-up.

## Required behavior
1. Review visible dependency update PRs, security alerts available to repository automation, and workflow permission drift.
2. Distinguish urgent remediation from routine maintenance.
3. Identify what is safe to delegate (release note gathering, draft PR prep, test updates) versus what needs human approval.
4. Skip duplicate issue creation for the same week.
5. Create one issue with sections for urgent items, recommended upgrades, and follow-up tasks.

## Safety limits
- Do not merge upgrades, rotate secrets, or change protections automatically.
- Keep recommendations reviewable and human-approved.
