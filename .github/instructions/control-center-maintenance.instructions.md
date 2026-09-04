---
description: 'Maintenance guidance for the Reevesc88 personal Copilot control-center source tree and validation tooling'
applyTo: 'personal/reevesc88/**, .github/copilot-instructions.md, .github/agents/control-center-orchestrator.md, .github/skills/sync-copilot-config/**, eng/sync-copilot-config.test.mjs, eng/validate-reevesc88-control-center.mjs, eng/validate-reevesc88-control-center.test.mjs, package.json'
---

# Control-center maintenance

When editing the Reevesc88 control-center files:

- treat `personal/reevesc88/` as the source-of-truth for reusable templates
- treat `inventory.json` as the machine authority and keep `INVENTORY.md` aligned with it
- keep active root `.github/` files minimal and focused on maintaining this control repo itself
- preserve the separation between reusable templates and repository-specific activation
- keep reusable templates GitHub-native and exclude local ECC/Codex/Claude runtime configuration, credentials, hooks, plugins, and model routing
- prefer report-only and draft-PR patterns over silent write automation
- record the control repository, exact source commit, selected item ids, base branch, and deviations in downstream adoption pull requests
- run `npm run control-center:validate` after changing the control-center templates or inventory
- run `npm run build` after changes that could affect repository-generated docs or validation expectations
- do not remove human approval checkpoints from agents, prompts, skills, or workflows
