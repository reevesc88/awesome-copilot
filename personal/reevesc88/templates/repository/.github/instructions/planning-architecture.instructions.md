---
description: 'Planning and architecture guidance for scoped implementation plans, design tradeoffs, and explicit checkpoints'
applyTo: '**/*.{md,mdx,txt,js,jsx,ts,tsx,py,go,java,cs,rb,php,rs}, **/docs/architecture/**, **/docs/adr/**'
---

# Planning and architecture

Use this guidance when the task is ambiguous, cross-cutting, or risky.

## Required behavior

- restate the goal, constraints, and unknowns before proposing a solution
- inspect existing architecture and adjacent systems first
- propose the smallest design that satisfies the goal
- identify tradeoffs, dependencies, rollout risks, and validation strategy
- insert explicit human checkpoints before destructive, security-sensitive, deployment, billing, production-data, or credential changes
- distinguish immediate work from later optional improvements
