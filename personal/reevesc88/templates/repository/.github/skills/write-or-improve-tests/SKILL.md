---
name: 'write-or-improve-tests'
description: 'Reusable write or improve tests operating procedure for the Reevesc88 Copilot control-center.'
---

# write-or-improve-tests

## Use when
A code change needs better test coverage or a flaky/weak test needs improvement.

## Inputs
- changed behavior or bug description
- relevant files and test command

## Steps
1. Find the closest test file and style.
2. Add or improve focused tests around the changed behavior.
3. Cover edge cases that materially affect correctness.
4. Run the smallest relevant test set.
5. Report exact execution results.

## Safety limits
- Do not alter unrelated tests for convenience.
- Do not fake coverage or passing status.

## Output
Return the tests added or changed plus validation results.
