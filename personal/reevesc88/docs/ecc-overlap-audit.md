# ECC and Copilot control-center overlap audit

## Decision

Keep the existing GitHub-native control-center as the portable policy layer. Adapt a small set of ECC governance ideas into documentation and validation. Reject ECC runtime internals and unsafe distribution behavior from reusable Copilot templates.

This preserves the current 34-item ReceiptFlow pilot while making the central source easier to govern and audit.

## Keep

| Current control-center surface | Decision |
| --- | --- |
| Repository and topic instructions | Keep as concise GitHub-native policy |
| Ten focused agents | Keep as role definitions |
| Ten reusable skills | Keep as repeatable procedures |
| Six prompts | Keep as interactive task launchers |
| Dry-run-first Node sync tool | Keep because it requires explicit Git roots and does not commit or push |
| Machine inventory and validator | Keep as the enforceable source map |
| Six workflow sources | Keep as opt-in, customize-before-enable templates |

The apparent overlap between agents, skills, prompts, and instructions is intentional:

- instructions state policy and constraints
- agents define responsibility and perspective
- skills define a reusable operating procedure
- prompts launch a specific interactive task
- workflows schedule or trigger a reviewed procedure

## Adapt

| ECC or research idea | Adaptation in this repository |
| --- | --- |
| Scoped `AGENTS.md` governance | Add subtree rules for source ownership, portability, validation, and rollout |
| Human-readable inventory | Add `INVENTORY.md` and validate that it covers every machine inventory id |
| Explicit decision records | Record Keep, Adapt, and Reject decisions in this audit |
| Provenance | Require downstream pull requests to record the control repo, exact source commit, selected items, base branch, and deviations |
| Test-first control changes | Add validator regressions before changing validation or distribution behavior |
| Bounded agent execution | Keep narrow roles, explicit human checkpoints, and draft-pull-request delivery |

ECC remains a useful research and local developer-runtime layer. Only portable policies that improve GitHub Copilot behavior belong in this repository.

## Reject

Do not import these into the default profile:

- local `.codex/` or `.claude/` configuration
- MCP server configuration, credentials, or plugin installation
- provider-specific model routing or hard-coded model ids
- hook-based enforcement that GitHub Copilot does not natively load
- machine-specific paths or global user-directory installers
- remote synchronizers that clone during dry run
- scripts that automatically stage, commit, push, open pull requests, or force-replace files
- workflow activation by default
- generic React or Python instructions for repositories that use a different stack

The reviewed Clawsider distribution concepts were not adopted because their dry-run and apply paths could create local state or perform Git operations, assumed a `main` base branch, and could install templates that still required customization.

## ReceiptFlow pilot

ReceiptFlow stays a downstream pilot, not a second source of truth.

- Its existing 34 copied default files remain unchanged during this central audit.
- It does not receive `main-instructions` until project placeholders are filled.
- It does not receive workflows until one workflow is separately customized, compiled, and manually tested.
- Its actual base branch is `master`, so no distributor may assume `main`.
- Its repository-specific guidance should reflect TypeScript, Preact, Vite, Tailwind, Cloudflare Workers, Hono, Drizzle, and Zod.

## Downstream provenance contract

Every adoption pull request should record:

1. control repository URL
2. exact control-center source commit SHA
3. selected inventory item ids or named profile
4. target repository and base branch
5. dry-run and write commands used
6. files skipped, replaced, or intentionally modified
7. validation and manual behavior tests run

This evidence belongs in the downstream pull request or adoption record. It must not contain credentials, local OAuth data, or machine-private configuration.
