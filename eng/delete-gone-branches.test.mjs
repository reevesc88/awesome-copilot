import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "delete-gone-branches.sh",
);
const SUBPROCESS_TIMEOUT_MS = 10_000;
const BASH_BIN = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";

function runCmd(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runGit(cwd, ...args) {
  const result = runCmd("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

test("delete-gone-branches.sh prints usage on --help and rejects unknown flags", () => {
  const help = runCmd(BASH_BIN, [SCRIPT_PATH, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: bash eng\/delete-gone-branches\.sh \[--apply\]/);

  const unknown = runCmd(BASH_BIN, [SCRIPT_PATH, "--unknown-flag"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --unknown-flag/);
});

test("delete-gone-branches.sh handles clean repos, dry runs, --apply deletion, and current-branch safety", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-gone-branches-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const remoteDir = path.join(tempRoot, "remote.git");
  const workDir = path.join(tempRoot, "work");
  fs.mkdirSync(remoteDir, { recursive: true });

  runGit(remoteDir, "init", "--bare", "-q");
  runCmd("git", ["clone", "-q", remoteDir, workDir], { cwd: tempRoot });
  runGit(workDir, "config", "user.name", "Copilot Test");
  runGit(workDir, "config", "user.email", "copilot@example.com");

  runGit(workDir, "checkout", "-b", "main");
  fs.writeFileSync(path.join(workDir, "README.md"), "initial\n", "utf8");
  runGit(workDir, "add", "README.md");
  runGit(workDir, "commit", "-m", "initial", "--quiet");
  runGit(workDir, "push", "-u", "origin", "main", "--quiet");

  // Local-only branch without upstream should never be treated as gone
  runGit(workDir, "checkout", "-b", "local-untracked");
  runGit(workDir, "checkout", "main");

  const noneGone = runCmd(BASH_BIN, [SCRIPT_PATH], { cwd: workDir });
  assert.equal(noneGone.status, 0, noneGone.stderr);
  assert.match(noneGone.stdout, /No local branches with gone upstreams found\./);

  // Create two remote-tracked feature branches and one active remote branch
  for (const branch of ["feat/stale-one", "feat/stale-current", "feat/active"]) {
    runGit(workDir, "checkout", "-b", branch, "main");
    fs.writeFileSync(path.join(workDir, `${branch.replace("/", "-")}.txt`), `${branch}\n`, "utf8");
    runGit(workDir, "add", "-A");
    runGit(workDir, "commit", "-m", `add ${branch}`, "--quiet");
    runGit(workDir, "push", "-u", "origin", branch, "--quiet");
  }

  // Delete two branches from the bare remote so their upstreams become [gone] after fetch --prune
  runGit(remoteDir, "branch", "-D", "feat/stale-one");
  runGit(remoteDir, "branch", "-D", "feat/stale-current");

  // Stay checked out on feat/stale-current to verify current-branch protection
  runGit(workDir, "checkout", "feat/stale-current");

  const dryRun = runCmd(BASH_BIN, [SCRIPT_PATH], { cwd: workDir });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Found 2 branch\(es\) with gone upstreams:/);
  assert.match(dryRun.stdout, /feat\/stale-one/);
  assert.match(dryRun.stdout, /feat\/stale-current/);
  assert.match(dryRun.stdout, /Dry run only\./);

  // Dry run must leave branches intact
  const branchesAfterDryRun = runGit(workDir, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  assert.ok(branchesAfterDryRun.includes("feat/stale-one"));
  assert.ok(branchesAfterDryRun.includes("feat/stale-current"));

  const applyRun = runCmd(BASH_BIN, [SCRIPT_PATH, "--apply"], { cwd: workDir });
  assert.equal(applyRun.status, 0, applyRun.stderr);
  assert.match(applyRun.stdout, /Skipping current branch: feat\/stale-current/);
  assert.match(applyRun.stdout, /Deleted 1 branch\(es\)\./);

  const branchesAfterApply = runGit(workDir, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  assert.ok(!branchesAfterApply.includes("feat/stale-one"));
  assert.ok(branchesAfterApply.includes("feat/stale-current"));
  assert.ok(branchesAfterApply.includes("feat/active"));
  assert.ok(branchesAfterApply.includes("local-untracked"));
  assert.ok(branchesAfterApply.includes("main"));
});
