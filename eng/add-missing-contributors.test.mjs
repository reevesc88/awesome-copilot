import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  addContributor,
  addToIgnoreList,
  analyzeContributor,
  getContributorFiles,
  main,
  printSummaryReport,
  processContributor,
} from "./add-missing-contributors.mjs";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-contributors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("getContributorFiles and analyzeContributor deduplicate PR files and fall back to 'code'", () => {
  assert.deepEqual(
    getContributorFiles("alice", {
      fetchMergedPrs: () => [
        { files: [{ path: "agents/a.agent.md" }, { path: "README.md" }] },
        { files: [{ path: "agents/a.agent.md" }, { path: "skills/demo/SKILL.md" }] },
      ],
    }),
    ["agents/a.agent.md", "README.md", "skills/demo/SKILL.md"],
  );

  // Empty PR list or generated-only files -> 'code' fallback
  assert.equal(analyzeContributor("bob", { fetchMergedPrs: () => [] }), "code");
  assert.equal(
    analyzeContributor("carol", {
      fetchMergedPrs: () => [{ files: [{ path: "README.md" }] }],
    }),
    "code",
  );

  // Substantive files -> sorted comma-separated types
  assert.equal(
    analyzeContributor("dave", {
      fetchMergedPrs: () => [
        { files: [{ path: "instructions/ts.instructions.md" }, { path: "agents/a.agent.md" }] },
      ],
    }),
    "agents,instructions",
  );
});

test("addToIgnoreList updates .all-contributorsrc once and handles missing config gracefully", (t) => {
  const cwd = makeTempDir(t);
  assert.equal(addToIgnoreList("ghost-user", { cwd }), false);

  const rcPath = path.join(cwd, ".all-contributorsrc");
  fs.writeFileSync(rcPath, JSON.stringify({ contributors: [], ignoreList: ["bot-a"] }), "utf8");

  assert.equal(addToIgnoreList("ghost-user", { cwd }), true);
  assert.equal(addToIgnoreList("ghost-user", { cwd }), false);

  const updated = JSON.parse(fs.readFileSync(rcPath, "utf8"));
  assert.deepEqual(updated.ignoreList, ["bot-a", "ghost-user"]);
});

test("addContributor, processContributor, and main handle success, 404 ignore-listing, and rate-limit propagation", async (t) => {
  const cwd = makeTempDir(t);
  const rcPath = path.join(cwd, ".all-contributorsrc");
  fs.writeFileSync(rcPath, JSON.stringify({ contributors: [] }), "utf8");

  // 404 adds user to ignoreList and returns false
  assert.equal(
    addContributor("deleted-account", "code", {
      cwd,
      execCommand: () => {
        throw new Error("404 user not found");
      },
    }),
    false,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(rcPath, "utf8")).ignoreList, ["deleted-account"]);

  // Unknown non-system error returns false without throwing
  assert.equal(
    addContributor("weird-error", "code", {
      cwd,
      execCommand: () => {
        throw new Error("unexpected CLI failure");
      },
    }),
    false,
  );

  // System-level rate-limit error propagates through processContributor and main
  await assert.rejects(
    () =>
      processContributor("octocat", {
        cwd,
        fetchMergedPrs: () => [],
        execCommand: () => {
          throw new Error("403 API rate limit exceeded");
        },
      }),
    /rate limit/,
  );

  // Full offline main run with mixed results + printSummaryReport
  const commands = [];
  const summary = await main({
    getMissing: () => ["alice", "missing-user"],
    fetchMergedPrs: (user) =>
      user === "alice" ? [{ files: [{ path: "agents/helper.agent.md" }] }] : [],
    execCommand: (cmd) => {
      commands.push(cmd);
      if (cmd.includes("missing-user")) {
        throw new Error("User not found");
      }
    },
    cwd,
  });

  assert.deepEqual(summary, { processed: 2, added: 1, failed: 1 });
  assert.equal(commands[0], "npx all-contributors add alice agents");
  printSummaryReport({ processed: 0, added: 0, failed: 0 });
  printSummaryReport(summary);
});
