---
description: 'Maintenance guidance for the Reevesc88 personal Copilot control-center source tree and validation tooling'
applyTo: 'personal/reevesc88/**, .github/copilot-instructions.md, .github/agents/control-center-orchestrator.md, .github/skills/sync-copilot-config/**, eng/validate-reevesc88-control-center.mjs, package.json'
---

# Control-center maintenance

When editing the Reevesc88 control-center files:

- treat `personal/reevesc88/` as the source-of-truth for reusable templates
- keep active root `.github/` files minimal and focused on maintaining this control repo itself
- preserve the separation between reusable templates and repository-specific activation
- prefer report-only and draft-PR patterns over silent write automation
- run `npm run control-center:validate` after changing the control-center templates or inventory
- run `npm run build` after changes that could affect repository-generated docs or validation expectations
- do not remove human approval checkpoints from agents, prompts, skills, or workflows
