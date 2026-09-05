# Repository Copilot Instructions Template

> **Template status:** fill every `{{PLACEHOLDER}}` value before relying on this file in a target repository.

## Repository-specific placeholders to complete first

- `{{PROJECT_NAME}}`
- `{{SYSTEM_OVERVIEW}}`
- `{{PRIMARY_LANGUAGES_AND_FRAMEWORKS}}`
- `{{BUILD_AND_TEST_COMMANDS}}`
- `{{IMPORTANT_DIRECTORIES}}`
- `{{SECURITY_BOUNDARIES}}`
- `{{DEPLOYMENT_AND_ENVIRONMENT_RULES}}`

## Project overview and architecture

This repository is `{{PROJECT_NAME}}`.

- **Purpose:** `{{SYSTEM_OVERVIEW}}`
- **Architecture style:** `{{ARCHITECTURE_STYLE}}`
- **Important boundaries:** `{{SECURITY_BOUNDARIES}}`
- **Non-goals / dangerous areas:** `{{HIGH_RISK_AREAS}}`

Before proposing or making changes, summarize which part of the architecture is affected and which neighboring files or services may also need review.

## Technology stack

- **Primary languages/frameworks:** `{{PRIMARY_LANGUAGES_AND_FRAMEWORKS}}`
- **Package/build tools:** `{{PACKAGE_AND_BUILD_TOOLS}}`
- **Test tools:** `{{TEST_TOOLING}}`
- **CI systems:** `{{CI_SYSTEMS}}`

If the stack is unclear from the current task, inspect the repository before making assumptions.

## Repository navigation

Start by inspecting existing patterns before editing anything.

Focus on:

- `{{IMPORTANT_DIRECTORIES}}`
- existing tests near the code being changed
- existing config, lint, and workflow files
- existing naming, error-handling, and documentation patterns

Do not invent a new pattern when a repository-specific pattern already exists.

## Coding conventions

- Follow established naming, file layout, and dependency patterns already present in the repository.
- Prefer the smallest complete change that solves the task.
- Reuse existing utilities before adding new helpers or dependencies.
- Keep functions/modules cohesive and avoid unrelated refactors.
- If the task touches generated files, confirm the generation workflow before editing them manually.

## Testing requirements

Use the repository's real test and validation commands:

`{{BUILD_AND_TEST_COMMANDS}}`

Rules:

- run the smallest targeted test set that validates the change first
- widen to broader validation only when needed
- add or update tests when behavior changes and there is existing test infrastructure
- never claim tests, builds, or linters ran if they did not
- never fabricate passing results

## Security and secrets

- Never commit secrets, credentials, tokens, private keys, copied `.env` files, or production data.
- Treat authentication, authorization, billing, encryption, infrastructure, and deployment changes as high-risk.
- Ask for human review before any destructive, security-sensitive, deployment, billing, production-data, or credential change.
- Use least privilege for workflow permissions and automation.
- Prefer issue/comment/report outputs over automatic write behavior when designing automation.

## Documentation expectations

- Update nearby documentation when behavior, setup, or workflows materially change.
- Keep documentation aligned with the actual commands and file paths used in the repository.
- Call out any placeholders or manual follow-up required by maintainers.

## Git and pull-request workflow

- Work on a branch, keep changes scoped, and prepare a draft PR for significant work.
- Never merge, deploy, or rewrite shared history autonomously.
- Summarize what changed, how it was validated, and what still needs human review.
- Prefer human approval checkpoints before broad automation or risky edits.

## CI expectations

- Inspect existing workflow patterns before editing or adding CI automation.
- Keep schedules conservative and timeouts explicit.
- Use `workflow_dispatch` for safe manual testing before trusting automation.
- Do not auto-merge, auto-deploy, auto-close issues, or take destructive action from scheduled automation.

## Definition of done

A task is done only when all of the following are true:

- the requested change is implemented completely
- existing repository patterns were inspected and followed
- targeted validation actually ran, or a clear reason was given when it could not run
- documentation/config updates required by the change are included
- remaining risks, manual steps, or approval requirements are stated clearly

## Non-negotiable operating rules

1. Inspect existing code, tests, and workflows before modifying them.
2. Do not claim commands ran when they did not.
3. Do not claim tests passed when they were not executed.
4. Stop and ask for human review before destructive, security-sensitive, deployment, billing, production-data, or credential changes.
5. If repository context is missing, ask or inspect rather than guessing.
