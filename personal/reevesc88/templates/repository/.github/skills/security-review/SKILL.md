---
name: 'security-review'
description: 'Reusable security review operating procedure for the Reevesc88 Copilot control-center.'
---

# security-review

## Use when
Changes touch dependencies, permissions, secrets, authentication, workflows, or trust boundaries.

## Inputs
- diff, files, workflow config, or dependency update details

## Steps
1. Inspect for exposed secrets and permission drift.
2. Review auth, data handling, and dependency risk.
3. Identify whether the change should remain audit-only.
4. Recommend mitigations or human approval checkpoints.

## Safety limits
- Do not publish exploit details beyond what is needed for remediation.
- Do not approve risky write automation without human review.

## Output
Return findings, severity, recommended mitigation, and approval needs.
