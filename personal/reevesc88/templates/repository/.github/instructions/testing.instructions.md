---
description: 'Testing guidance for targeted validation, honest reporting, and maintainable automated checks'
applyTo: '**/*.{js,jsx,ts,tsx,py,go,java,cs,rb,php,rs}, **/test/**, **/tests/**, **/*test*, **/*spec*'
---

# Testing

Use the smallest meaningful validation first.

## Required behavior

- locate the closest existing tests before adding new ones
- prefer targeted tests over full-suite runs while iterating
- expand validation when the change affects shared code paths
- keep tests deterministic and descriptive
- report the exact commands that were actually run
- if tests could not run, state why and what remains to be checked manually

## When adding tests

- match the existing framework and style
- cover the changed behavior and important edge cases
- avoid rewriting unrelated tests to make the task easier
