---
name: 'review-current-pr'
agent: ask
description: 'Review the current pull request for correctness, security, tests, and documentation drift.'
---

# Review the current PR

## Inputs
- Focus area (optional): ${input:focus:Any special focus such as security, tests, or CI?}

## Instructions
1. Review the current pull request or local diff.
2. Prioritize high-confidence issues.
3. Confirm whether the author ran real validation.
4. Keep the review concise and actionable.

## Output
Return a short summary and a ranked list of findings, or say that no material issue was found.
