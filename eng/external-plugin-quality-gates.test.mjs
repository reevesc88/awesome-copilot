import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { after, test } from "node:test";
import {
  buildEphemeralMarketplace,
  buildVallyLintArgs,
  classifySmokeFailure,
  inspectAgentPluginSpecCompliance,
  normalizePluginPath,
  parseCliArgs,
  resolveFetchSpec,
  runCanvasStructureGate,
  runExternalPluginQualityGates,
  runRefShaConsistencyGate,
  runVersionMatchGate,
  truncateOutput,
} from "./external-plugin-quality-gates.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runGit(repoDir, ...args) {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stdout}\n${result.stderr}`);
  }
  return String(result.stdout ?? "").trim();
}

function createTempRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-plugin-quality-"));
  tempDirs.push(repoDir);

  runGit(repoDir, "init", "-q");
  runGit(repoDir, "config", "user.name", "Copilot Test");
  runGit(repoDir, "config", "user.email", "copilot@example.com");
  return repoDir;
}

function commitAll(repoDir, message) {
  runGit(repoDir, "add", "-A");
  runGit(repoDir, "commit", "-m", message, "--quiet");
  return runGit(repoDir, "rev-parse", "HEAD");
}

test("runCanvasStructureGate passes when extensions/extension.mjs exists", () => {
  const repoDir = createTempRepo();
  fs.mkdirSync(path.join(repoDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "extensions", "extension.mjs"), "export default {};\n");
  const sha = commitAll(repoDir, "Add canvas extension container");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass");
  assert.match(result.output, /found "extensions"/);
});

test("runCanvasStructureGate fails when extension entrypoint is only at repo root", () => {
  const repoDir = createTempRepo();
  fs.writeFileSync(path.join(repoDir, "extension.mjs"), "export default {};\n");
  const sha = commitAll(repoDir, "Add root extension entrypoint");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "fail");
  assert.match(result.output, /missing required canvas extension directory "extensions"/);
});

test("runCanvasStructureGate fails when extension entrypoint path is a directory", () => {
  const repoDir = createTempRepo();
  fs.mkdirSync(path.join(repoDir, "extensions", "extension.mjs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "extensions", "extension.mjs", "placeholder.txt"), "not-a-module\n");
  const sha = commitAll(repoDir, "Add invalid extension entrypoint directory");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "fail");
  assert.match(result.output, /"extensions\/extension\.mjs" must be a file/);
});

test("runCanvasStructureGate passes when extension lives in a nested subfolder", () => {
  const repoDir = createTempRepo();
  fs.mkdirSync(path.join(repoDir, "extensions", "modernize-dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "extensions", "modernize-dashboard", "extension.mjs"),
    "export default {};\n",
  );
  const sha = commitAll(repoDir, "Add nested canvas extension");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass");
  assert.match(result.output, /entry point "extensions\/modernize-dashboard\/extension\.mjs"/);
});

test("runCanvasStructureGate fails when no extension.mjs exists flat or nested", () => {
  const repoDir = createTempRepo();
  fs.mkdirSync(path.join(repoDir, "extensions", "modernize-dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "extensions", "modernize-dashboard", "index.mjs"),
    "export default {};\n",
  );
  const sha = commitAll(repoDir, "Add extensions directory without entry point");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "fail");
  assert.match(result.output, /missing required canvas extension entry point/);
});

test("runCanvasStructureGate finds a nested extension listed past the legacy output cap", () => {
  const repoDir = createTempRepo();
  // Many sibling directories push the real extension past the ~12 KB stdout cap that the
  // previous truncating implementation applied, which would silently drop it from the listing.
  // Long names inflate each git ls-tree record so fewer directories are needed to exceed the cap.
  for (let index = 0; index < 160; index += 1) {
    const filler = path.join(
      repoDir,
      "extensions",
      `filler-directory-that-pads-the-tree-listing-${String(index).padStart(4, "0")}`,
    );
    fs.mkdirSync(filler, { recursive: true });
    fs.writeFileSync(path.join(filler, "readme.txt"), "filler\n");
  }
  fs.mkdirSync(path.join(repoDir, "extensions", "zzz-real-extension"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "extensions", "zzz-real-extension", "extension.mjs"),
    "export default {};\n",
  );
  const sha = commitAll(repoDir, "Add nested extension after many siblings");

  const plugin = {
    name: "canvas-plugin",
    keywords: ["canvas"],
    source: {
      source: "github",
      repo: "owner/repo",
      sha,
    },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass");
  assert.match(result.output, /entry point "extensions\/zzz-real-extension\/extension\.mjs"/);
});

// Regression tests for issue #2397: a tag-name locator (e.g. "v1.0.0") must be
// readable by the version-match and canvas-structure gates. `git fetch origin <tag>`
// only updates FETCH_HEAD and never creates a local `refs/tags/<tag>`, so reading via
// `git show <tag>:...` used to die with "fatal: invalid object name" and roll up to a
// bogus infra_error/fail even though the referenced content was valid.

function initRemoteRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-plugin-quality-remote-"));
  tempDirs.push(repoDir);
  runGit(repoDir, "init", "-q");
  runGit(repoDir, "config", "user.name", "Copilot Test");
  runGit(repoDir, "config", "user.email", "copilot@example.com");
  // Mirror github.com: allow the submission repo to shallow-fetch an arbitrary SHA.
  runGit(repoDir, "config", "uploadpack.allowAnySHA1InWant", "true");
  return repoDir;
}

function writeValidPluginContent(repoDir) {
  fs.mkdirSync(path.join(repoDir, ".github", "plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, ".github", "plugin", "plugin.json"),
    `${JSON.stringify({ name: "tag-plugin", version: "1.0.0" }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repoDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "extensions", "extension.mjs"), "export default {};\n");
}

// Mirrors cloneSubmissionRepository in external-plugin-quality-gates.mjs: fetch only the
// primary locator and detach HEAD onto it. The tag ref is deliberately never created
// locally, reproducing the CI environment where `git show <tag>:...` fails.
function cloneSubmissionRepo(remoteDir, primaryFetchSpec) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-plugin-quality-sub-"));
  tempDirs.push(repoDir);
  runGit(repoDir, "init", "-q");
  runGit(repoDir, "remote", "add", "origin", remoteDir);
  runGit(repoDir, "fetch", "--depth=1", "origin", primaryFetchSpec);
  runGit(repoDir, "checkout", "--detach", "FETCH_HEAD");
  return repoDir;
}

test("runVersionMatchGate passes for a tag ref alongside a sha", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  const sha = commitAll(remoteDir, "Add plugin manifest");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  const repoDir = cloneSubmissionRepo(remoteDir, sha);
  const plugin = {
    name: "tag-plugin",
    version: "1.0.0",
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0", sha },
  };

  const result = runVersionMatchGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass", result.output);
  // Both the tag ref and the sha must be verified.
  assert.match(result.output, /- v1\.0\.0: matched version "1\.0\.0"/);
  assert.match(result.output, new RegExp(`- ${sha}: matched version "1\\.0\\.0"`));
});

test("runCanvasStructureGate passes for a tag ref alongside a sha", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  const sha = commitAll(remoteDir, "Add canvas extension container");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  const repoDir = cloneSubmissionRepo(remoteDir, sha);
  const plugin = {
    name: "tag-plugin",
    keywords: ["canvas"],
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0", sha },
  };

  const result = runCanvasStructureGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass", result.output);
  assert.match(result.output, /- v1\.0\.0: found "extensions"/);
  assert.match(result.output, new RegExp(`- ${sha}: found "extensions"`));
});

test("runVersionMatchGate passes when the primary locator is a tag ref", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  commitAll(remoteDir, "Add plugin manifest");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  const repoDir = cloneSubmissionRepo(remoteDir, "v1.0.0");
  const plugin = {
    name: "tag-plugin",
    version: "1.0.0",
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0" },
  };

  const result = runVersionMatchGate(repoDir, plugin, "v1.0.0");
  assert.equal(result.status, "pass", result.output);
  assert.match(result.output, /- v1\.0\.0: matched version "1\.0\.0"/);
});

test("runCanvasStructureGate passes when the primary locator is a tag ref", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  commitAll(remoteDir, "Add canvas extension container");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  const repoDir = cloneSubmissionRepo(remoteDir, "v1.0.0");
  const plugin = {
    name: "tag-plugin",
    keywords: ["canvas"],
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0" },
  };

  const result = runCanvasStructureGate(repoDir, plugin, "v1.0.0");
  assert.equal(result.status, "pass", result.output);
  assert.match(result.output, /- v1\.0\.0: found "extensions"/);
});

test("runRefShaConsistencyGate fails when ref and sha point to different commits", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  const firstSha = commitAll(remoteDir, "Add plugin manifest v1");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");
  fs.writeFileSync(path.join(remoteDir, "README.md"), "v2\n");
  const secondSha = commitAll(remoteDir, "Add plugin manifest v2");

  const repoDir = cloneSubmissionRepo(remoteDir, secondSha);
  const plugin = {
    name: "tag-plugin",
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0", sha: secondSha },
  };

  const result = runRefShaConsistencyGate(repoDir, plugin, secondSha);
  assert.equal(result.status, "fail", result.output);
  assert.match(result.output, new RegExp(`resolves to "${firstSha}"`));
});

test("runRefShaConsistencyGate passes when ref and sha point to the same commit", () => {
  const remoteDir = initRemoteRepo();
  writeValidPluginContent(remoteDir);
  const sha = commitAll(remoteDir, "Add plugin manifest");
  runGit(remoteDir, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  const repoDir = cloneSubmissionRepo(remoteDir, sha);
  const plugin = {
    name: "tag-plugin",
    source: { source: "github", repo: "owner/repo", ref: "v1.0.0", sha },
  };

  const result = runRefShaConsistencyGate(repoDir, plugin, sha);
  assert.equal(result.status, "pass", result.output);
});

test("truncateOutput, normalizePluginPath, resolveFetchSpec, classifySmokeFailure, and parseCliArgs handle boundary inputs", () => {
  assert.equal(truncateOutput("\x1b[31mError:\x1b[0m failed  "), "Error: failed");
  const oversized = "x".repeat(12_050);
  const truncated = truncateOutput(oversized);
  assert.match(truncated, /\.\.\.output truncated\.\.\.$/);
  assert.ok(truncated.length < oversized.length);

  assert.equal(normalizePluginPath(""), "");
  assert.equal(normalizePluginPath("/"), "");
  assert.equal(normalizePluginPath(" /packages/my-plugin/ "), "packages/my-plugin");
  assert.throws(() => normalizePluginPath("../escape"), /Invalid plugin path/);
  assert.throws(() => normalizePluginPath("packages\\win"), /Invalid plugin path/);

  const sha = "a".repeat(40);
  assert.equal(resolveFetchSpec({ sha, ref: "v1.0.0" }), sha);
  assert.equal(resolveFetchSpec({ ref: " refs/tags/v1.0.0 " }), "refs/tags/v1.0.0");
  assert.equal(resolveFetchSpec({ ref: "v1.0.0" }), "v1.0.0");
  assert.throws(() => resolveFetchSpec({}), /source\.ref or source\.sha is required/);
  assert.throws(() => resolveFetchSpec({ ref: "   " }), /source\.ref or source\.sha is required/);

  assert.equal(classifySmokeFailure("HTTP 401 Unauthorized"), "infra_error");
  assert.equal(classifySmokeFailure("Error: getaddrinfo ENOTFOUND github.com"), "infra_error");
  assert.equal(classifySmokeFailure("Request timeout after 30s"), "infra_error");
  assert.equal(classifySmokeFailure("Invalid manifest schema in plugin.json"), "fail");

  assert.deepEqual(parseCliArgs(["positional", "--plugin-json", '{"name":"x"}', "--mode", "strict"]), {
    "plugin-json": '{"name":"x"}',
    mode: "strict",
  });
});

test("inspectAgentPluginSpecCompliance, buildVallyLintArgs, and buildEphemeralMarketplace validate plugin layouts", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-plugin-quality-spec-"));
  tempDirs.push(workDir);

  // Missing plugin.json
  assert.equal(inspectAgentPluginSpecCompliance(workDir).status, "warning");
  assert.deepEqual(buildVallyLintArgs(workDir), [workDir]);

  // Nested .plugin/plugin.json with invalid JSON
  fs.mkdirSync(path.join(workDir, ".plugin"), { recursive: true });
  const nestedManifestPath = path.join(workDir, ".plugin", "plugin.json");
  fs.writeFileSync(nestedManifestPath, "{not-json", "utf8");
  const invalidJsonCompliance = inspectAgentPluginSpecCompliance(workDir);
  assert.equal(invalidJsonCompliance.status, "warning");
  assert.match(invalidJsonCompliance.output, /not valid JSON/);
  assert.deepEqual(buildVallyLintArgs(workDir), [workDir]);

  // Nested manifest with comprehensive spec violations
  fs.writeFileSync(
    nestedManifestPath,
    JSON.stringify({
      $schema: "https://example.com/wrong.json",
      name: "Bad--Name",
      version: "",
      description: "   ",
      homepage: 123,
      author: { name: "Ok", extra: "disallowed", url: 99 },
      keywords: ["ok", 42],
      extensions: { "com.example": [] },
      nonStandardField: true,
    }),
    "utf8",
  );
  const warningsResult = inspectAgentPluginSpecCompliance(workDir);
  assert.equal(warningsResult.status, "warning");
  assert.match(warningsResult.output, /manifest location is/);
  assert.match(warningsResult.output, /\$schema should be/);
  assert.match(warningsResult.output, /does not match Agent Plugins naming constraints/);
  assert.match(warningsResult.output, /author\.extra/);
  assert.match(warningsResult.output, /nonStandardField/);

  // Valid root plugin.json + resolvable skill directory
  fs.rmSync(path.join(workDir, ".plugin"), { recursive: true, force: true });
  const skillDir = path.join(workDir, "skills", "triage");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "clean-plugin",
      version: "1.2.3",
      description: "Fully compliant manifest",
    }),
    "utf8",
  );
  const passResult = inspectAgentPluginSpecCompliance(workDir);
  assert.equal(passResult.status, "pass", passResult.output);

  // With skills array in plugin.json, buildVallyLintArgs resolves existing skill dirs
  fs.writeFileSync(
    path.join(workDir, "plugin.json"),
    JSON.stringify({
      name: "clean-plugin",
      version: "1.2.3",
      skills: ["./skills/triage", "./skills/missing"],
    }),
    "utf8",
  );
  assert.deepEqual(buildVallyLintArgs(workDir), [skillDir]);

  const marketplaceDir = buildEphemeralMarketplace(workDir, { name: "clean-plugin", version: "1.2.3" });
  const marketplace = JSON.parse(fs.readFileSync(path.join(marketplaceDir, "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "external-plugin-intake");
  assert.equal(marketplace.plugins[0].name, "clean-plugin");
});

test("version, ref/sha, and canvas gates cover not_run, mismatch, invalid JSON, and non-directory extensions", () => {
  const repoDir = createTempRepo();
  fs.writeFileSync(path.join(repoDir, "extensions"), "not-a-directory\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "plugin.json"), JSON.stringify({ name: "demo", version: "2.0.0" }), "utf8");
  const sha = commitAll(repoDir, "Version mismatch and blob extensions");

  // Skips when locators or canvas keyword are absent
  assert.equal(runVersionMatchGate(repoDir, { name: "demo", version: "2.0.0", source: {} }, sha).status, "not_run");
  assert.equal(runRefShaConsistencyGate(repoDir, { name: "demo", source: { sha } }, sha).status, "not_run");
  assert.equal(
    runRefShaConsistencyGate(repoDir, { name: "demo", source: { ref: sha, sha: "short" } }, sha).status,
    "not_run",
  );
  assert.equal(runCanvasStructureGate(repoDir, { name: "demo", keywords: ["other"], source: { sha } }, sha).status, "not_run");
  assert.equal(runCanvasStructureGate(repoDir, { name: "demo", keywords: ["canvas"], source: {} }, sha).status, "not_run");

  // Version mismatch -> fail
  const mismatch = runVersionMatchGate(
    repoDir,
    { name: "demo", version: "1.0.0", source: { sha } },
    sha,
  );
  assert.equal(mismatch.status, "fail");
  assert.match(mismatch.output, /does not match/);

  // extensions path is a file -> fail
  const blobExtensions = runCanvasStructureGate(
    repoDir,
    { name: "demo", keywords: ["canvas"], source: { sha } },
    sha,
  );
  assert.equal(blobExtensions.status, "fail");
  assert.match(blobExtensions.output, /"extensions" must be a directory/);

  // Invalid JSON in plugin.json -> fail
  fs.writeFileSync(path.join(repoDir, "plugin.json"), "{broken-json\n", "utf8");
  const invalidJsonSha = commitAll(repoDir, "Broken plugin.json");
  const invalidManifest = runVersionMatchGate(
    repoDir,
    { name: "demo", version: "1.0.0", source: { sha: invalidJsonSha } },
    invalidJsonSha,
  );
  assert.equal(invalidManifest.status, "fail");
  assert.match(invalidManifest.output, /Invalid JSON/);
});

test("runExternalPluginQualityGates orchestrates offline local clone, vally lint, smoke gate, missing path, and CLI checks", async () => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-plugin-quality-e2e-"));
  tempDirs.push(hostRoot);

  // Create a local remote repo at <hostRoot>/owner/e2e-plugin.git and map https://github.com/owner/ -> file://<hostRoot>/owner/
  const remoteRepo = path.join(hostRoot, "owner", "e2e-plugin.git");
  fs.mkdirSync(remoteRepo, { recursive: true });
  runGit(remoteRepo, "init", "-q");
  runGit(remoteRepo, "config", "user.name", "Copilot Test");
  runGit(remoteRepo, "config", "user.email", "copilot@example.com");
  runGit(remoteRepo, "config", "uploadpack.allowAnySHA1InWant", "true");

  fs.mkdirSync(path.join(remoteRepo, "skills", "demo-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(remoteRepo, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: 'Valid offline skill for quality gate testing'\n---\n# Demo Skill\n\nInstructions.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(remoteRepo, "plugin.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "e2e-plugin",
        version: "1.0.0",
        description: "Offline quality gate plugin",
        skills: ["./skills/demo-skill"],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const sha = commitAll(remoteRepo, "Initial valid plugin");
  runGit(remoteRepo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");

  // Stub copilot CLI on PATH to exercise runInstallSmokeGate end-to-end
  const fakeBin = path.join(hostRoot, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const copilotPath = path.join(fakeBin, "copilot");
  fs.writeFileSync(
    copilotPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then exit 0; fi',
      'if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then',
      '  dest="$HOME/.copilot/installed-plugins/external-plugin-intake/e2e-plugin"',
      '  mkdir -p "$dest"',
      '  printf \'{"name":"e2e-plugin","version":"1.0.0"}\\n\' > "$dest/plugin.json"',
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );

  const savedEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1,
    GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1,
  };

  try {
    process.env.PATH = `${fakeBin}:${savedEnv.PATH}`;
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${path.join(hostRoot, "owner")}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/owner/";
    process.env.GIT_CONFIG_KEY_1 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_1 = "always";

    const passRes = await runExternalPluginQualityGates({
      name: "e2e-plugin",
      version: "1.0.0",
      source: { source: "github", repo: "owner/e2e-plugin", ref: "v1.0.0", sha },
    });
    assert.equal(passRes.overall_status, "pass", passRes.summary);
    assert.equal(passRes.failure_class, "none");
    assert.equal(passRes.smoke_status, "pass");
    assert.equal(passRes.vally_lint_status, "pass");

    // Missing source.path inside cloned repo -> submitter_fixes fail
    const missingSubdir = await runExternalPluginQualityGates({
      name: "e2e-plugin",
      version: "1.0.0",
      keywords: ["canvas"],
      source: { source: "github", repo: "owner/e2e-plugin", path: "nonexistent/dir", sha },
    });
    assert.equal(missingSubdir.overall_status, "fail");
    assert.equal(missingSubdir.failure_class, "submitter_fixes");
    assert.equal(missingSubdir.canvas_structure_status, "fail");

    // Unfetchable locator triggers catch -> infra_error
    const infraRes = await runExternalPluginQualityGates({
      name: "e2e-plugin",
      version: "1.0.0",
      source: { source: "github", repo: "owner/e2e-plugin", ref: "v99.99.99-missing" },
    });
    assert.equal(infraRes.overall_status, "infra_error");
    assert.equal(infraRes.failure_class, "infra");
  } finally {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }

  // CLI usage check when --plugin-json is omitted
  const cliRun = spawnSync(
    process.execPath,
    [new URL("./external-plugin-quality-gates.mjs", import.meta.url).pathname],
    { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  assert.equal(cliRun.status, 1);
  assert.match(cliRun.stderr, /Usage:/);
});
