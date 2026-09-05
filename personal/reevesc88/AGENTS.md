# Control-center maintenance rules

These instructions apply to the `personal/reevesc88/` subtree.

## Source of truth

- Treat this subtree as the reusable Copilot control-center source.
- Treat `inventory.json` as the machine-readable authority and keep `INVENTORY.md` aligned with it.
- Read `README.md`, `INVENTORY.md`, and `docs/ecc-overlap-audit.md` before changing the template set.
- Keep repository-active files at the root `.github/` limited to maintaining this control repository.

## Portability boundary

- Templates may contain portable, GitHub-native instructions, agents, skills, prompts, and opt-in agentic workflow sources.
- Do not copy tool-specific runtime configuration into reusable templates, including local `.codex/` or `.claude/` state, MCP credentials, hooks, model routing, plugin installation, or machine-specific paths.
- Keep repository stack, commands, branch names, environments, labels, and ownership rules in the target repository.
- Agents define responsibility, skills define procedures, prompts launch tasks, and instructions provide policy. Preserve that separation instead of combining all behavior into one oversized file.

## Change and validation workflow

1. Inspect the affected inventory entries and templates.
2. Add or update a regression test before changing validator or sync behavior.
3. Keep every new template represented in both inventories.
4. Run `npm run control-center:test`.
5. Run `npm run control-center:validate`.
6. Run `npm run build` when generated documentation or repository-wide validation could change.
7. Review the complete diff and report any gate that was not run.

## Downstream rollout

- Require an explicit absolute Git-root target and preview the sync before writing.
- Preserve differing target files unless replacement is separately approved.
- Record the control repository, exact source commit, selected item ids or profile, target base branch, and local deviations in the target pull request.
- Use a dedicated branch and draft pull request. Never merge, deploy, modify credentials, or enable scheduled automation without explicit human approval.
- Keep `main-instructions` and every workflow opt-in until target-specific placeholders and settings are reviewed.
