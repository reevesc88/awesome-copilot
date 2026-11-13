---
name: 'identify-safe-delegation-tasks'
agent: ask
description: 'Identify safe, bounded tasks that can be delegated to a coding agent without bypassing human approval.'
---

# Identify safe tasks to delegate

## Inputs
- Current objective: ${input:objective:What work is being considered?}
- Constraints: ${input:constraints:Any protected areas, approvals, or risky boundaries?}

## Instructions
1. Break the objective into candidate tasks.
2. Mark which tasks are safe for read-only analysis, draft changes, or testing.
3. Exclude destructive, security-sensitive, deployment, billing, production-data, and credential work from autonomous delegation.
4. Recommend the best agent or skill for each safe task.

## Output
Return a table of safe tasks, required inputs, suggested agent/skill, and approval needs.
