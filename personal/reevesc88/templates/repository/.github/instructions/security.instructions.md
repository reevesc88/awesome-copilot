---
description: 'Security guidance for secrets, permissions, data handling, and human approval checkpoints'
applyTo: '**'
---

# Security

Apply this guidance to code, configuration, workflows, and documentation that could affect trust boundaries.

## Always check

- exposed secrets or copied credentials
- unsafe input handling or injection risks
- excessive permissions in workflows or automation
- production-data exposure or logging problems
- dependency risk or supply-chain drift

## Required behavior

- use least privilege
- ask for human review before changing auth, secrets, encryption, billing, deployments, infrastructure, or production-data access
- prefer report-only automation to silent write automation
- document any manual security follow-up still required
