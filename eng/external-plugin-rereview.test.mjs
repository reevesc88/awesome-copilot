import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractSubmissionData,
  matchExternalPluginForIssue,
  parseRereviewCommand,
  readCliArgs,
  removePluginFromExternalJson,
  slugifyPluginName,
  stripIssueTitlePrefix,
} from "./external-plugin-rereview.mjs";

function makeCatalogPlugin(name, repo, sourcePath) {
  return {
    name,
    description: `Plugin ${name}`,
    version: "1.0.0",
    author: { name: "Maintainer" },
    repository: `https://github.com/${repo}`,
    keywords: ["workflow"],
    license: "MIT",
    source: {
      source: "github",
      repo,
      ...(sourcePath ? { path: sourcePath } : {}),
      ref: "v1.0.0",
    },
  };
}

test("parseRereviewCommand recognizes valid slash commands and ignores invalid variants", () => {
  assert.equal(parseRereviewCommand("/re-review-keep"), "keep");
  assert.equal(parseRereviewCommand("Checked repo:\n  /RE-REVIEW-NEEDS-CHANGES  "), "needs-changes");
  assert.equal(parseRereviewCommand("/re-review-remove archived upstream"), "remove");

  assert.equal(parseRereviewCommand("/re-review-keep-extra"), undefined);
  assert.equal(parseRereviewCommand("inline /re-review-keep command"), undefined);
  assert.equal(parseRereviewCommand(""), undefined);
});

test("stripIssueTitlePrefix, slugifyPluginName, readCliArgs, and extractSubmissionData handle structured and fallback issues", () => {
  assert.equal(stripIssueTitlePrefix("[External Plugin]: my-plugin"), "my-plugin");
  assert.equal(stripIssueTitlePrefix("External plugin submission - beta-tool"), "beta-tool");
  assert.equal(stripIssueTitlePrefix("Public external plugin: gamma"), "gamma");
  assert.equal(slugifyPluginName("Gamma Tool!"), "gamma-tool");
  assert.deepEqual(readCliArgs(["--plugin-name", "gamma", "--file", "ext.json"]), {
    "plugin-name": "gamma",
    file: "ext.json",
  });

  // Fallback extraction from legacy non-form issue
  const legacy = extractSubmissionData({
    title: "[External Plugin]: legacy-helper",
    body: "Submitted from https://github.com/OctoOrg/Legacy-Helper.git for review.",
  });
  assert.deepEqual(legacy, {
    pluginName: "legacy-helper",
    sourceRepo: "octoorg/legacy-helper",
    sourcePath: undefined,
    repository: "https://github.com/octoorg/legacy-helper",
    ref: undefined,
  });
});

test("matchExternalPluginForIssue resolves exact, name, single-repo, and ambiguous/none matches", () => {
  const catalog = [
    makeCatalogPlugin("alpha-pack", "org/alpha", "plugins/alpha"),
    makeCatalogPlugin("mono-one", "org/monorepo", "plugins/one"),
    makeCatalogPlugin("mono-two", "org/monorepo", "plugins/two"),
    makeCatalogPlugin("solo-repo-plugin", "org/solo-repo", undefined),
  ];

  // Exact match (name + repo + path)
  const exactIssue = {
    title: "[External Plugin]: alpha-pack",
    body: [
      "### Plugin name",
      "alpha-pack",
      "### GitHub repository",
      "org/alpha",
      "### Plugin path inside the repository",
      "/plugins/alpha/",
    ].join("\n\n"),
  };
  assert.equal(matchExternalPluginForIssue(exactIssue, catalog).matchReason, "exact");

  // Name fallback when path changed in catalog
  const nameFallbackIssue = {
    title: "[External Plugin]: alpha-pack",
    body: [
      "### Plugin name",
      "alpha-pack",
      "### GitHub repository",
      "org/alpha",
      "### Plugin path inside the repository",
      "plugins/old-location",
    ].join("\n\n"),
  };
  assert.equal(matchExternalPluginForIssue(nameFallbackIssue, catalog).matchReason, "name");

  // Single-repo fallback when plugin was renamed in external.json
  const repoFallbackIssue = {
    title: "[External Plugin]: old-solo-name",
    body: "Repository: https://github.com/org/solo-repo",
  };
  const repoMatch = matchExternalPluginForIssue(repoFallbackIssue, catalog);
  assert.equal(repoMatch.matchReason, "repo");
  assert.equal(repoMatch.plugin.name, "solo-repo-plugin");

  // Ambiguous monorepo with unknown name -> "none"
  const ambiguousIssue = {
    title: "[External Plugin]: unknown-mono-name",
    body: "Repository: https://github.com/org/monorepo",
  };
  assert.equal(matchExternalPluginForIssue(ambiguousIssue, catalog).matchReason, "none");
});

test("removePluginFromExternalJson removes matched plugin and throws when unmatched", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-rereview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "external.json");

  const alpha = makeCatalogPlugin("alpha-pack", "org/alpha");
  const beta = makeCatalogPlugin("beta-pack", "org/beta");
  fs.writeFileSync(filePath, `${JSON.stringify([alpha, beta], null, 2)}\n`, "utf8");

  // Mismatched name + repo pair should NOT remove either plugin
  assert.throws(
    () =>
      removePluginFromExternalJson({
        pluginName: "alpha-pack",
        sourceRepo: "org/beta",
        filePath,
      }),
    /Could not find external plugin/,
  );

  const removed = removePluginFromExternalJson({
    pluginName: "alpha-pack",
    sourceRepo: "org/alpha",
    filePath,
  });
  assert.equal(removed.name, "alpha-pack");

  const remaining = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(
    remaining.map((p) => p.name),
    ["beta-pack"],
  );
});
