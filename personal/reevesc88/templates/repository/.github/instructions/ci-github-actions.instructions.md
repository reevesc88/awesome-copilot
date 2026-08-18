---
description: 'Guidance for CI, GitHub Actions, and agentic workflow changes with minimal permissions and safe rollout'
applyTo: '**/.github/workflows/*.{yml,yaml,md}, **/.github/actions/**, **/action.{yml,yaml}'
---

# CI and GitHub Actions

Treat CI and workflow changes as production-adjacent.

## Required behavior

- inspect existing workflows before introducing a new pattern
- keep permissions minimal and explicit
- include `workflow_dispatch` for manual testing when practical
- prefer bounded outputs such as issue reports, comments, artifacts, or job summaries
- set timeouts and avoid unbounded loops
- never auto-merge, auto-deploy, or perform destructive actions from schedules by default

## Validation

- validate syntax and referenced paths
- check permissions, triggers, and output locations
- describe how the workflow should be tested safely before enabling schedules
