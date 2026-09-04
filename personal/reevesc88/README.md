# Reevesc88 Copilot Control Center

This directory is the **source-of-truth layer** for @reevesc88's personal GitHub Copilot setup. Use [`INVENTORY.md`](INVENTORY.md) for the human review index and [the ECC overlap audit](docs/ecc-overlap-audit.md) for the Keep, Adapt, and Reject decisions.

## Why this lives under `personal/reevesc88/`

This fork still tracks `github/awesome-copilot`, so the personal control-center files are isolated under a clearly named directory instead of being spread across upstream-maintained paths. That keeps upstream sync conflicts small, makes reviews easier, and gives you one place to maintain the reusable templates that should later be copied into other repositories.

Only a **small set of repository-active files** live under the repository root `.github/` directory:

- `.github/copilot-instructions.md` keeps this control repository itself understandable to Copilot
- `.github/instructions/control-center-maintenance.instructions.md` guides maintenance work on this control-center
- `.github/agents/control-center-orchestrator.md` gives this repository a safe coordination chat mode
- `.github/skills/sync-copilot-config/SKILL.md` exposes the sync workflow locally

Everything else in this directory is a **template until you explicitly install it into a target repository**.

## What each customization type does

| Primitive | Purpose | Typical location in a target repo | Reusable? |
| --- | --- | --- | --- |
| `copilot-instructions.md` | Repository-wide default behavior for Copilot | `.github/copilot-instructions.md` | Yes, with placeholders filled in |
| `*.instructions.md` | Topic- or file-specific guidance | `.github/instructions/` | Yes |
| Agent files | Narrow chat modes with explicit responsibilities | `.github/agents/` | Yes |
| Skills | Repeatable operating procedures with safety steps | `.github/skills/<skill>/SKILL.md` | Yes |
| Prompt files | One-click interactive task launchers | `.github/prompts/` | Yes |
| Agentic workflows (`.md`) | Natural-language workflow source files compiled into Actions | `.github/workflows/` | Yes, after target-repo customization |
| Hooks | Session automation during Copilot coding-agent use | `.github/hooks/` | Optional; not part of v1 |
| MCP configuration | External tool wiring for GitHub/Copilot clients | local user config or repo-specific config | Usually repo- or user-specific |

## Directory map

```text
personal/reevesc88/
├── AGENTS.md
├── INVENTORY.md
├── README.md
├── inventory.json
├── targets.example.json
├── docs/
│   ├── control-center-safety.tdd.md
│   └── ecc-overlap-audit.md
├── scripts/
│   └── sync-copilot-config.mjs
└── templates/
    └── repository/
        └── .github/
            ├── copilot-instructions.md
            ├── agents/
            ├── instructions/
            ├── prompts/
            ├── skills/
            └── workflows/
```

## Immediately active in this repository

Active now in `reevesc88/awesome-copilot`:

| Path | Purpose | Safety level |
| --- | --- | --- |
| `.github/copilot-instructions.md` | Maintains this control repository with awareness of the personal source tree | Advisory only |
| `.github/instructions/control-center-maintenance.instructions.md` | Applies maintenance rules to the control-center source tree | Advisory only |
| `.github/agents/control-center-orchestrator.md` | Coordinates planning → implementation → validation with human checkpoints | Human approval required |
| `.github/skills/sync-copilot-config/SKILL.md` | Teaches Copilot how to sync templates safely | Human approval required |
| `personal/reevesc88/scripts/sync-copilot-config.mjs` | Dry-run-first sync tool for selected target repositories | Manual invocation only |
| `eng/validate-reevesc88-control-center.mjs` | Validation for this curated setup | Read-only validation |

Template only until installed in another repository:

- the main instruction template
- topic-specific instructions
- the agent set
- the prompt set
- the six maintenance workflows

## Guided next steps on Windows

This repository is the control center. Copying templates into another repository is a separate, deliberate step. Start with one low-risk pilot repository, not every repository at once.

1. Validate the control-center branch from PowerShell:

   ```powershell
   Set-Location C:\dev\awesome-copilot
   npm ci
   npm run control-center:test
   npm run control-center:validate
   npm run build
   ```

2. Choose one pilot target. The target must be the absolute root of a Git repository and must contain a `.git` file or directory:

   ```powershell
   $TargetRepo = 'C:\dev\YOUR-PILOT-REPOSITORY'
   Test-Path (Join-Path $TargetRepo '.git')
   ```

   Continue only when `Test-Path` returns `True`.

3. Preview the safe default set. This does not write files:

   ```powershell
   node personal/reevesc88/scripts/sync-copilot-config.mjs --target $TargetRepo
   ```

4. Review every `CREATE`, `DIFF`, and `SKIP` line. Existing differing files are preserved by default.

5. After review, copy the safe default set:

   ```powershell
   node personal/reevesc88/scripts/sync-copilot-config.mjs --target $TargetRepo --write
   ```

The safe default deliberately excludes the placeholder-filled main instruction template and all six workflow templates. Those seven items require explicit `--item` selection.

6. Add the main instruction template only when you are ready to replace every `{{PLACEHOLDER}}` immediately:

   ```powershell
   node personal/reevesc88/scripts/sync-copilot-config.mjs --target $TargetRepo --item main-instructions --write
   ```

7. Pilot one workflow at a time. Review its schedule, labels, permissions, queries, and issue output before copying it. Confirm GitHub Issues is enabled because the report templates create bounded issues through safe outputs. Then validate and compile the selected workflow inside the target repository:

   ```powershell
   node personal/reevesc88/scripts/sync-copilot-config.mjs --target $TargetRepo --item weekly-repository-health-report --write
   Set-Location $TargetRepo
   gh aw compile weekly-repository-health-report --no-emit --strict --validate
   gh aw compile weekly-repository-health-report --strict
   ```

8. Review the target repository diff, commit on a branch, and open a draft PR. Do not enable additional schedules until the first manual `workflow_dispatch` run produces a safe report.

## Inventory

The machine-readable inventory lives in [`inventory.json`](./inventory.json), and the complete human review index lives in [`INVENTORY.md`](INVENTORY.md). The validator requires the human index to name every machine inventory item. The machine file records each template's:

- source path in this repository
- default destination path in target repositories
- scope (`global-reusable` or `repo-template`)
- maturity (`ready`, `pilot`, or `customize-before-enable`)
- activation method
- safety level

A condensed human inventory is below.

| Group | Purpose | Activation | Safety | Scope |
| --- | --- | --- | --- | --- |
| Main instruction template | Baseline Copilot behavior for a target repo | Copy to `.github/copilot-instructions.md` | Advisory | Global reusable |
| Topic instructions | Specialize review/testing/security/docs/CI/triage/dependencies/planning | Copy to `.github/instructions/` | Advisory | Global reusable |
| Agents | Planner, implementer, reviewer, debugger, tester, security reviewer, triager, docs maintainer, health reporter, orchestrator | Copy to `.github/agents/` | Mixed; human checkpoints built in | Global reusable |
| Skills | Repeatable procedures for plan/implement/review/CI triage/bug triage/testing/security/docs/health/sync | Copy to `.github/skills/` | Mixed; human checkpoints built in | Global reusable |
| Prompt files | Common interactive launches for plan/review/CI/triage/health/delegation | Copy to `.github/prompts/` | Advisory | Global reusable |
| Agentic workflows | Scheduled reporting and maintenance templates | Copy then compile in target repo | Audit/report only by default | Repo template |
| Sync script | Reviewable copier for explicit target repos | Run manually with `--target` | Human approval required | Control repo only |

## Reusable vs repository-specific files

### Broadly reusable

These are written to work across repositories after filling in obvious placeholders:

- `templates/repository/.github/copilot-instructions.md`
- `templates/repository/.github/instructions/*.instructions.md`
- `templates/repository/.github/agents/*.md`
- `templates/repository/.github/skills/*/SKILL.md`
- `templates/repository/.github/prompts/*.prompt.md`

### Requires target-repository customization before activation

- `templates/repository/.github/copilot-instructions.md` placeholders such as architecture, stack, and test commands
- workflow schedules, labels, and any workflow-specific search queries
- any branch names, CODEOWNERS usernames, environment names, secret names, and deployment policies

## Installing a selected profile into another repository

1. Clone or open the target repository locally and confirm its root contains `.git`.
2. Review the source inventory in this control repository.
3. Preview the safe default set first:

   ```bash
   node personal/reevesc88/scripts/sync-copilot-config.mjs \
     --target /absolute/path/to/target-repo
   ```

4. Review the proposed file list and any diff output for existing files.
5. Install the safe default set only after review:

   ```bash
   node personal/reevesc88/scripts/sync-copilot-config.mjs \
     --target /absolute/path/to/target-repo \
     --write
   ```

6. Explicitly select `main-instructions` only when you are ready to fill every `{{PLACEHOLDER}}` immediately.
7. Explicitly select workflow templates one at a time after customizing schedules, labels, permissions, and queries.
8. Confirm GitHub Issues is enabled in the target repository. Run `gh aw compile <selected-workflow-id> --no-emit --strict --validate`, then `gh aw compile <selected-workflow-id> --strict` for each approved workflow source to produce its `.lock.yml` file.
9. Commit both the workflow source `.md` and compiled `.lock.yml` on a branch.
10. Open a **draft PR** for human review and test with `workflow_dispatch` before relying on a schedule.

### Selecting only part of the profile

Use `--item` one or more times:

```bash
node personal/reevesc88/scripts/sync-copilot-config.mjs \
  --target /absolute/path/to/target-repo \
  --item main-instructions \
  --item planner-architect \
  --item weekly-repository-health-report
```

## How sync/upstream maintenance works

1. Keep personal source files inside `personal/reevesc88/`.
2. Sync upstream normally into this fork.
3. Resolve conflicts in upstream-owned paths first.
4. Re-run:

   ```bash
   npm run control-center:validate
   npm run build
   ```

5. Review whether upstream examples introduced a better pattern worth manually adopting into the personal templates.
6. Only after review, sync updated templates into downstream repositories.

This avoids storing personal defaults inside upstream-maintained directories unless they need to be active in this repository.

The verified RED/GREEN, coverage, security, and strict workflow compiler evidence is recorded in [`docs/control-center-safety.tdd.md`](docs/control-center-safety.tdd.md).

## Safe testing guide

### Instructions
- Open Copilot Chat in VS Code or github.com.
- Confirm the repository-wide instructions load without placeholder mistakes.
- Ask one narrow question per instruction (review, testing, security, etc.) and verify the response respects the instruction intent.

### Agents
- Start with read-only agents first (planner, reviewer, triager, health reporter).
- Give each agent a tiny scoped task and verify it stops when human approval is required.
- For editing agents, require a branch + draft PR workflow and verify the agent does not claim to merge or deploy.

### Skills
- Invoke the skill by name from Copilot Chat or Copilot CLI.
- Verify the skill asks for missing inputs, follows its listed steps, and produces the expected output format.

### Prompt files
- Run prompts from VS Code's prompt picker.
- Confirm `${input:...}` placeholders render correctly.
- Verify the chosen agent and tool expectations match the task.

### Workflows
- Keep new workflows in **audit-only mode** first.
- Use `workflow_dispatch` before trusting a schedule.
- If using agentic workflows, compile them to `.lock.yml` in the target repo and test on a non-protected branch.
- Confirm the workflow writes to one bounded output location (issue, comment, summary, or artifact) and does not merge, deploy, close issues, or mutate production state.

## Secrets, permissions, environments, branch protection, and reviews

### Secrets
- Store credentials only in GitHub Actions secrets, environment secrets, or Codespaces/user config when appropriate.
- Never commit tokens, PATs, cloud keys, connection strings, or copied `.env` files.
- Prefer fine-grained tokens and GitHub App credentials over broad personal tokens.

### Permissions
- Default workflows to `contents: read` and add only the minimum extra scopes required.
- Prefer issue creation or comments over write access to code.
- Keep scheduled automations read-only or report-only until they earn trust.

### Environments
- Put any deployment- or production-adjacent steps behind GitHub Environments with required reviewers.
- Do not let Copilot-controlled workflows bypass environment protection rules.

### Branch protection
- Require pull requests, status checks, and at least one human review on branches where Copilot-created changes could land.
- Disable force-push for protected branches.
- Do not allow workflow-created branches to auto-merge without explicit approval.

### CODEOWNERS
- Add maintainers for `.github/`, workflow files, security-sensitive files, billing/config files, and infrastructure.
- Require owner review for instructions, agents, and workflow changes so the control surface stays intentional.

### Dependabot and dependency review
- Enable Dependabot security updates and version updates.
- Pair it with dependency review checks, lockfile review, and human approval for major upgrades.

## Using this setup in common interfaces

### GitHub Desktop
- Use GitHub Desktop for branch creation, diff review, and opening draft PRs after syncing templates.
- Keep Desktop focused on review and commit hygiene; do not rely on it as the only validation surface.

### VS Code
- Best experience for repo-local instructions, agents, prompts, and skills.
- Test prompt files and agent behavior here first.
- Use the Problems panel and integrated terminal for validation commands.

### GitHub.com
- Good for PR review, Actions logs, issues, discussions, and scheduled report consumption.
- Use it for reviewing draft PRs or weekly issue-based reports created by workflows.

### Copilot CLI
- Useful for installing skills, invoking prompt-driven workflows, and compiling/running agentic workflows with `gh aw`.
- Prefer CLI for repeatable dry runs and scripted control-center rollout.

## Recommended staged rollout

1. **Audit-only first**
   - Enable instructions, prompts, read-only agents, and report-only workflows.
   - No direct code writes from scheduled automation.
2. **Draft-PR second**
   - Allow curated implementation/test/documentation agents to prepare changes on branches or draft PRs.
   - Require human review before merge.
3. **Carefully approved write automation last**
   - Only after repeated safe runs.
   - Limit to narrowly scoped repositories and protected environments.
   - Keep destructive, security-sensitive, billing, deployment, or credential work under explicit human approval.

## Weekly operating routine

1. Review the repository health report issue.
2. Review the bug/issue triage report.
3. Review the open PR review report.
4. Review CI failure summaries and decide whether to delegate investigation.
5. Review dependency/security output and schedule only the safe follow-up work.
6. Assign or run prompt/skill-based work for planning, docs, tests, and implementation.
7. Close the loop by updating statuses, labels, or draft PRs manually.

## Limitations

- Repository files alone cannot create organization-wide Copilot policy.
- ECC, Codex, Claude, MCP, hook, plugin, and model-routing configuration remains local runtime configuration and is not distributed by this GitHub-native profile.
- This setup cannot automatically reconfigure unrelated repositories unless you run an explicit sync/install mechanism.
- Workflow templates still require target-repository customization for labels, protected branch names, CI workflow names, and environment policies.
- Model availability changes over time, so agents intentionally avoid hard-coding a model identifier.

## Target repository adoption checklist

Copy this checklist into the target repository PR description when installing the profile.

- [ ] Control repository URL and exact source commit SHA recorded
- [ ] Selected inventory item ids or profile recorded
- [ ] Target base branch and intentional local deviations recorded
- [ ] Dry run reviewed with `sync-copilot-config.mjs`
- [ ] GitHub Issues enabled for issue-based safe outputs
- [ ] `{{PROJECT_NAME}}`, stack, architecture, test, and CI placeholders filled in
- [ ] CODEOWNERS updated for `.github/`, workflows, and security-sensitive files
- [ ] Branch protection requires human review and status checks
- [ ] Dependabot and dependency review enabled
- [ ] Required secrets stored outside the repository
- [ ] Prompt files tested in VS Code
- [ ] Read-only agents tested before edit-capable agents
- [ ] Workflows tested with `workflow_dispatch` before schedules are trusted
- [ ] Any workflow that can open a draft PR has a reviewer/approval policy
- [ ] No workflow can auto-merge, deploy, close issues, rotate credentials, or touch production data without a human checkpoint
