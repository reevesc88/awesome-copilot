---
name: 'repository-health-check'
description: 'Reusable repository health check operating procedure for the Reevesc88 Copilot control-center.'
---

# repository-health-check

## Use when
You need a maintenance summary covering bugs, PRs, CI, docs, and dependencies.

## Inputs
- repository scope
- time window
- optional focus labels or workflows

## Steps
1. Gather issue, PR, CI, docs, and dependency signals.
2. Highlight items that need human attention.
3. Separate urgent issues from routine follow-up.
4. Recommend safe delegation opportunities.
5. Package the findings into a bounded report.

## Safety limits
- Report only by default.
- Do not auto-close, auto-merge, or auto-deploy.

## Output
Return a concise health report with priorities and recommended next actions.
