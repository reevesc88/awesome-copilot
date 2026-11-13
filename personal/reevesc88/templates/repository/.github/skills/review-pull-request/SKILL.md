---
name: 'review-pull-request'
description: 'Reusable review pull request operating procedure for the Reevesc88 Copilot control-center.'
---

# review-pull-request

## Use when
You need a focused review of an open pull request or local diff.

## Inputs
- PR number, diff, or branch comparison
- repository context
- optional focus areas (security, tests, performance, docs)

## Steps
1. Review the diff and surrounding files.
2. Check correctness, security, tests, and docs.
3. Prioritize high-confidence issues.
4. Note missing validation or risky assumptions.
5. Keep suggestions scoped to the PR.

## Safety limits
- Read-only review by default.
- Do not rewrite code unless separately asked.

## Output
Return a short review summary plus actionable findings with impact.
