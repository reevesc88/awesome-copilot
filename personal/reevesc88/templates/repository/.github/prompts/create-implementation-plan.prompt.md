---
name: 'create-implementation-plan'
agent: Plan
description: 'Create an implementation plan for a repository task with explicit assumptions, risks, validation, and approval gates.'
---

# Create an implementation plan

## Inputs
- Goal: ${input:goal:What needs to be planned?}
- Scope hints: ${input:scope:Which files, folders, or systems matter?}
- Constraints: ${input:constraints:What limits, deadlines, or approval rules apply?}

## Instructions
1. Inspect the relevant repository context before proposing changes.
2. Produce a small, phased implementation plan.
3. Include assumptions, unknowns, validation steps, and human checkpoints.
4. Call out anything that should remain out of scope.

## Output
Return sections for summary, assumptions, plan, validation, and approval gates.
