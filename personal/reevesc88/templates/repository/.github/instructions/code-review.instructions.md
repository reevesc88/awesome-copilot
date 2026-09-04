---
description: 'Code review guidance for human-first, high-signal pull request review in target repositories'
applyTo: '**'
---

# Code review

Use this instruction when reviewing pull requests, branches, or proposed patches.

## Review priorities

1. correctness and regressions
2. security and secrets
3. missing tests or unsafe validation gaps
4. architecture drift from established repository patterns
5. documentation drift

## Required behavior

- review the diff and the surrounding files, not only the changed lines
- call out only high-confidence issues first
- explain the impact of each issue and what a safe fix would look like
- prefer a short list of material findings over noisy style commentary
- confirm whether the author validated the change with real commands
- ask for human review on destructive, security-sensitive, deployment, billing, production-data, or credential changes

## Do not do this

- do not invent failing scenarios without evidence
- do not praise or nitpick as filler when no issue exists
- do not suggest unrelated refactors in a focused review
