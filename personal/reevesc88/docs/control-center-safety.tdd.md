# Control-center safety TDD evidence

## Source and user journeys

No plan file was used. The guarantees came from local control-center auditing, an independent code review, and strict gh-aw compilation.

- As a maintainer, I want guarded items excluded from default installation so that placeholder instructions and scheduled workflows cannot be activated accidentally.
- As a maintainer, I want synchronization contained within approved repository roots so that traversal, symlinks, and Windows junctions cannot redirect reads or writes.
- As a target-repository owner, I want workflow templates to compile with least-privilege permissions so that issue creation occurs only through safe outputs.

## RED and GREEN evidence

| Stage | Command | Result |
|---|---|---|
| Sync RED | `npm run control-center:test` | 9 of 10 passed. The malformed guarded default test failed because no exception was thrown. The earlier compile-time RED also showed that the junction guard export did not exist. |
| Sync GREEN | `npm run control-center:test` | 10 of 10 passed after the guarded-default invariant and junction checks were implemented. |
| Coverage GREEN | `node --experimental-test-coverage --test ./eng/sync-copilot-config.test.mjs` | 16 of 16 passed; the synchronizer reached 93.45% lines, 89.90% branches, and 100.00% functions. |
| Workflow RED | `gh aw compile --no-emit --strict` | 0 of 6 compiled because each template requested direct `issues: write`. |
| Workflow GREEN | `gh aw compile <workflow-id> --no-emit --strict` | 6 of 6 compiled with 0 warnings in an isolated Git fixture with repository context. |
| Security contract RED | `npm run control-center:test` | 15 of 16 passed. The dependency/security workflow lacked `vulnerability-alerts: read` and the alert toolsets promised by its behavior. |
| Security contract GREEN | `npm run control-center:test` | 16 of 16 passed after adding the Dependabot, code-security, and secret-protection toolsets with matching read permissions. |
| Validator path RED | `npm run control-center:test` | The original 16 tests passed, and the validator suite failed because the shared inventory path guard did not exist. |
| Validator path GREEN | `npm run control-center:test` | 21 of 21 passed after the validator reused the synchronizer's relative-path and symlink/junction guards. |

## Test specification

| Guarantee | Evidence | Type | Result |
|---|---|---|---|
| Guarded templates cannot be selected by default even if inventory metadata is malformed | `default selection rejects a customize-before-enable item marked as default` | Unit | PASS |
| Explicit item selection can install a guarded template | `explicit selection can include a customize-before-enable item` | Unit | PASS |
| Unknown IDs, missing option values, invalid targets, and traversal paths fail closed | `eng/sync-copilot-config.test.mjs` | Unit | PASS |
| Existing target overrides are preserved unless `--replace` is explicit | `CLI preserves a conflicting target file unless replace is explicit` | Integration | PASS |
| A Windows junction beneath the approved root is rejected by the real CLI and the outside destination stays unchanged | `CLI write rejects a junctioned .github and leaves outside unchanged` | Platform integration | PASS |
| Absolute inventory roots and source-root/item junctions are rejected by validation | `eng/validate-reevesc88-control-center.test.mjs` | Unit and platform integration | PASS |
| Dry run, create, unchanged, and replace-preview paths behave as documented | `main handles help, dry run, create, idempotence, and replace preview` | Integration | PASS |
| All six workflow templates use safe outputs without direct write permissions | strict gh-aw compilation | Integration | PASS |
| The dependency/security workflow can read Dependabot, code-scanning, and secret-scanning alerts | `dependency security workflow exposes its promised alert sources` | Contract | PASS |

## Additional verification

- `npm run control-center:test`: 21 of 21 passed.
- `npm run control-center:validate`: passed.
- `npm run build`: passed with no generated drift.
- `npm audit`: 0 vulnerabilities.
- `npm run skill:validate`: all 410 skills passed.
- `npm run plugin:validate`: all 93 plugins and the external catalog passed; existing external metadata warnings remain.
- All six selected workflow IDs passed `gh aw compile <workflow-id> --no-emit --strict` with zero warnings.
- Modified JavaScript modules passed `node --check`.

## Coverage and known gaps

- This repository declares no lint or typecheck script, so syntax checks were used for the modified JavaScript modules.
- Synchronizer coverage exceeds the 80% gate. The validator integration suite exercises the full successful validation path and every new path-boundary case; full validator-module line coverage is 76.44% because legacy error-reporting branches are not all fixture-tested.
- Strict workflow compilation used `--no-emit`; target repositories must compile and commit their own `.lock.yml` files after customization.
- Repository feature validation against the control fork correctly reports that GitHub Issues is disabled. The rollout guide now requires Issues and `--validate` in the actual pilot repository.
- No downstream pilot repository has been selected or modified.
- No branch has been pushed and no pull request has been updated by this local review.

## Checkpoint commits

- `2e10bb43`: RED regression tests and test script.
- `3aecb29b`: GREEN synchronization hardening and safe inventory defaults.
- `7a35c828`: coverage expansion above the 80% gate.
- `c1d63758`: strict-safe workflow permissions, fuzzy schedules, and validator hardening.
- `bbc187fd`: guided rollout and initial safety evidence.
- `439ba80e`: security-contract and end-to-end junction regression tests.
- `f1ba885f`: security-alert toolsets and selected-workflow compile guidance.
- `148d98d5`: validator path-contract regression tests.
- `768095a5`: validator reuse of synchronizer path guards.
- `4a58434c`: validator integration coverage and pilot Issues prerequisite.
