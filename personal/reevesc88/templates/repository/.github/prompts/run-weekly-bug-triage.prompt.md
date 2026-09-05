---
name: 'run-weekly-bug-triage'
agent: ask
description: 'Run a weekly bug triage pass that groups issues by severity, evidence, staleness, and next action.'
---

# Run weekly bug triage

## Inputs
- Query or label scope: ${input:query:Which bug set should be triaged?}
- Time window (optional): ${input:window:What time window should be emphasized?}

## Instructions
1. Separate confirmed bugs, likely bugs, needs-info items, and duplicates.
2. Highlight urgent user-impacting issues first.
3. Recommend safe follow-up actions and delegation candidates.
4. Keep security-sensitive items for human review.

## Output
Return a prioritized triage report with next actions.
