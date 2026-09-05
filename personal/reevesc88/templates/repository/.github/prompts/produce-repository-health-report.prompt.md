---
name: 'produce-repository-health-report'
agent: ask
description: 'Produce a repository health report covering bugs, PRs, CI, docs, and dependency risk.'
---

# Produce a repository health report

## Inputs
- Scope: ${input:scope:Repository, project area, or team focus}
- Time window: ${input:window:How far back should the report look?}

## Instructions
1. Gather signals from issues, PRs, CI, docs, and dependencies.
2. Highlight what needs human attention.
3. Separate urgent items from routine upkeep.
4. Suggest safe tasks that can be delegated to Copilot later.

## Output
Return a concise health report with priorities, evidence, and suggested follow-up.
