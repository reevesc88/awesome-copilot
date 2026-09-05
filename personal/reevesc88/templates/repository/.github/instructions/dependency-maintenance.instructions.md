---
description: 'Dependency maintenance guidance for safe upgrades, reviewable diffs, and vulnerability awareness'
applyTo: '**/package.json, **/package-lock.json, **/npm-shrinkwrap.json, **/pnpm-lock.yaml, **/yarn.lock, **/requirements*.txt, **/pyproject.toml, **/poetry.lock, **/go.mod, **/go.sum, **/pom.xml, **/build.gradle*, **/Gemfile*, **/Cargo.toml, **/Cargo.lock, **/Dockerfile*'
---

# Dependency maintenance

Use this guidance for version bumps, security updates, and lockfile review.

## Required behavior

- prefer the smallest safe upgrade set
- review changelog or release notes for major-risk changes when feasible
- keep lockfiles and manifests aligned
- validate the affected build/test path after upgrades
- call out manual rollout or migration steps for breaking updates
- do not auto-merge dependency changes without repository approval policy
