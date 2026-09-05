---
name: 'investigate-ci-failure'
description: 'Reusable investigate ci failure operating procedure for the Reevesc88 Copilot control-center.'
---

# investigate-ci-failure

## Use when
A workflow, test run, or build is failing and you need an evidence-based diagnosis.

## Inputs
- failing run URL, job name, command, or error text
- recent changes if known

## Steps
1. Gather logs and exact failing steps.
2. Separate symptom from likely root cause.
3. Compare against recent changes and repository patterns.
4. Propose the smallest safe fix or next experiment.
5. Identify whether human approval is needed.

## Safety limits
- Do not claim a fix is confirmed unless it was validated.
- Escalate secrets, deployment, credential, or production-data concerns.

## Output
Return root-cause summary, supporting evidence, suggested fix, and validation plan.
