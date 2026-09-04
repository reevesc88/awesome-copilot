# Human inventory

`inventory.json` is the machine-readable authority. This document is the review index and must name every item id so drift is caught by `npm run control-center:validate`.

## Default profile

The default profile contains 34 ready, portable items: ten agents, eight topic instructions, six prompts, and ten skills. It does not contain the placeholder-based main instruction or any workflow.

### Agents

| Item id | Responsibility |
| --- | --- |
| `planner-architect` | Plan bounded work and architecture changes |
| `implementer-software-engineer` | Implement an approved plan |
| `pull-request-reviewer` | Review current pull-request changes |
| `debugger-ci-investigator` | Investigate CI and runtime failures |
| `test-specialist` | Design and improve tests |
| `security-dependency-reviewer` | Review security and dependency risk |
| `issue-bug-triager` | Triage bugs and issues |
| `documentation-maintainer` | Maintain documentation |
| `repository-health-reporter` | Produce repository health reports |
| `orchestrator` | Coordinate bounded agent work |

### Topic instructions

| Item id | Focus |
| --- | --- |
| `code-review` | Correctness-focused reviews |
| `testing` | Test design and verification |
| `security` | Security-sensitive changes |
| `documentation` | Documentation quality |
| `ci-github-actions` | CI and GitHub Actions |
| `issue-triage` | Issue classification |
| `dependency-maintenance` | Dependency changes |
| `planning-architecture` | Planning and architecture |

### Prompts

| Item id | Launches |
| --- | --- |
| `create-implementation-plan` | An implementation plan |
| `review-current-pr` | A pull-request review |
| `summarize-failing-ci-and-recommend-fix` | A CI failure summary |
| `run-weekly-bug-triage` | Weekly bug triage |
| `produce-repository-health-report` | A health report |
| `identify-safe-delegation-tasks` | A safe delegation assessment |

### Skills

| Item id | Procedure |
| --- | --- |
| `plan-work` | Plan a bounded change |
| `implement-approved-plan` | Implement an approved plan |
| `review-pull-request` | Review a pull request |
| `investigate-ci-failure` | Investigate CI failures |
| `triage-bugs` | Triage bugs |
| `write-or-improve-tests` | Improve test coverage |
| `security-review` | Perform a security review |
| `update-documentation` | Update documentation |
| `repository-health-check` | Check repository health |
| `sync-copilot-config` | Preview and copy selected templates |

## Opt-in items

These seven items are `customize-before-enable` and are never selected by the default profile.

### Repository-wide instruction

| Item id | Why opt-in |
| --- | --- |
| `main-instructions` | Contains target-specific placeholders |

### Agentic workflow sources

| Item id | Why opt-in |
| --- | --- |
| `weekly-repository-health-report` | Schedule and issue output require target review |
| `weekly-bug-issue-triage-report` | Labels and issue queries require target review |
| `open-pr-review-report` | Pull-request scope requires target review |
| `ci-failure-summary` | CI names and failure sources require target review |
| `documentation-drift-check` | Documentation scope requires target review |
| `dependency-security-review` | Security sources and permissions require target review |

Each workflow remains source-only until it is customized, strictly compiled in the target repository, committed with its generated lock file, and tested manually with `workflow_dispatch`.
