---
name: 'summarize-failing-ci-and-recommend-fix'
agent: ask
description: 'Summarize a failing CI run, identify the likely root cause, and recommend the safest next fix.'
---

# Summarize failing CI and recommend a fix

## Inputs
- Run URL or job name: ${input:run:Which failing run or job should be investigated?}
- Extra context (optional): ${input:context:Recent changes, branch, or known symptoms}

## Instructions
1. Gather the failing step and exact error.
2. Separate symptom, likely root cause, and safe next fix.
3. State what still needs validation.
4. Escalate if the problem touches secrets, deployments, or credentials.

## Output
Return sections for failure summary, likely cause, recommended fix, and validation plan.
