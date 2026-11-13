---
name: 'plan-work'
description: 'Reusable plan work operating procedure for the Reevesc88 Copilot control-center.'
---

# plan-work

## Use when
You need an implementation plan, sequencing, risks, or a phased rollout before coding begins.

## Inputs
- goal or issue statement
- relevant repo or file paths
- constraints, deadlines, or approval limits

## Steps
1. Restate the objective and success criteria.
2. Inspect existing patterns, architecture, tests, and workflows.
3. Break the work into small reviewable steps.
4. Call out dependencies, unknowns, validation, and rollback considerations.
5. Mark explicit human approval checkpoints.

## Safety limits
- Do not edit code.
- Do not promise effort or timing with false precision.
- Escalate destructive, security-sensitive, deployment, billing, production-data, or credential work for review.

## Output
Return a concise plan with assumptions, tasks, validation, and approval gates.
