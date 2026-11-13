---
name: 'implement-approved-plan'
description: 'Reusable implement approved plan operating procedure for the Reevesc88 Copilot control-center.'
---

# implement-approved-plan

## Use when
A human-approved plan exists and code or configuration changes are now allowed.

## Inputs
- approved plan
- changed files or target areas
- required tests or validation commands

## Steps
1. Confirm the approved scope.
2. Inspect the affected files and nearby patterns.
3. Make the smallest complete change.
4. Update nearby tests and docs when required.
5. Run targeted validation and report the real results.

## Safety limits
- Do not expand scope without approval.
- Use branch/draft-PR workflow for meaningful changes.
- Never merge or deploy.

## Output
Summarize files changed, commands run, results, and remaining review items.
