import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getGitFileDate, getGitFileDates } from "./git-dates.mjs";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-git-dates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runGit(cwd, args, env = {}) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

test("getGitFileDates and getGitFileDate return latest commit timestamps and support paths with spaces", (t) => {
  const repoDir = makeTempDir(t);
  runGit(repoDir, ["init", "-q"]);
  runGit(repoDir, ["config", "user.name", "Test User"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);

  fs.mkdirSync(path.join(repoDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "skills", "my skill"), { recursive: true });

  fs.writeFileSync(path.join(repoDir, "agents", "alpha.agent.md"), "v1\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "skills", "my skill", "SKILL.md"), "v1\n", "utf8");
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", "initial", "--quiet"], {
    GIT_AUTHOR_DATE: "2026-01-10T08:00:00+00:00",
    GIT_COMMITTER_DATE: "2026-01-10T08:00:00+00:00",
  });

  // Update alpha.agent.md in a newer commit
  fs.writeFileSync(path.join(repoDir, "agents", "alpha.agent.md"), "v2\n", "utf8");
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", "update alpha", "--quiet"], {
    GIT_AUTHOR_DATE: "2026-02-15T12:30:00+00:00",
    GIT_COMMITTER_DATE: "2026-02-15T12:30:00+00:00",
  });

  const dates = getGitFileDates(["agents/", "skills/my skill/"], repoDir);
  assert.equal(dates.get("agents/alpha.agent.md"), "2026-02-15T12:30:00Z");
  assert.equal(dates.get("skills/my skill/SKILL.md"), "2026-01-10T08:00:00Z");

  assert.equal(
    getGitFileDate("skills/my skill/SKILL.md", repoDir),
    "2026-01-10T08:00:00Z",
  );
  assert.equal(getGitFileDate("agents/untracked.agent.md", repoDir), null);
});

test("getGitFileDates and getGitFileDate degrade gracefully outside a git repository", (t) => {
  const nonRepoDir = makeTempDir(t);
  const dates = getGitFileDates(["agents/"], nonRepoDir);
  assert.equal(dates.size, 0);
  assert.equal(getGitFileDate("README.md", nonRepoDir), null);
});
