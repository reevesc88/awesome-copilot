import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSourceTreeUrl,
  parseCliArgs,
  runExternalPluginPrQualityGates,
} from "./external-plugin-pr-quality-gates.mjs";

function makeValidExternalPlugin(name, overrides = {}) {
  return {
    name,
    description: "External PR plugin",
    version: "1.0.0",
    author: { name: "Maintainer" },
    repository: `https://github.com/example/${name}`,
    keywords: ["workflow"],
    license: "MIT",
    source: {
      source: "github",
      repo: `example/${name}`,
      ref: "v1.0.0",
    },
    ...overrides,
  };
}

test("buildSourceTreeUrl and parseCliArgs format GitHub source tree links and CLI flags", () => {
  assert.equal(buildSourceTreeUrl({}), "");
  assert.equal(
    buildSourceTreeUrl({ source: { repo: "octo/demo" } }),
    "https://github.com/octo/demo",
  );
  assert.equal(
    buildSourceTreeUrl({ source: { repo: "octo/demo", ref: "v1.0.0", path: "/" } }),
    "https://github.com/octo/demo/tree/v1.0.0",
  );
  assert.equal(
    buildSourceTreeUrl({
      source: {
        repo: "octo/demo",
        ref: "v1.0.0",
        sha: "a".repeat(40),
        path: "/packages/my plugin/",
      },
    }),
    `https://github.com/octo/demo/tree/${"a".repeat(40)}/packages/my%20plugin`,
  );

  assert.deepEqual(parseCliArgs(["--plugins-json", "[]"]), {
    "plugins-json": "[]",
  });
});

test("runExternalPluginPrQualityGates validates input, short-circuits invalid entries with spec=not_run, and aggregates gate statuses", async () => {
  await assert.rejects(
    () => runExternalPluginPrQualityGates("not-an-array"),
    /plugins must be an array/,
  );

  const emptyResult = await runExternalPluginPrQualityGates([]);
  assert.equal(emptyResult.overall_status, "not_run");
  assert.equal(emptyResult.failure_class, "none");

  // Invalid external.json entry skips runner and formats spec=not_run (not spec=undefined)
  let runnerCalled = false;
  const invalidResult = await runExternalPluginPrQualityGates(
    [{ name: "broken-entry" }],
    {
      runQualityGates: async () => {
        runnerCalled = true;
        throw new Error("should not run");
      },
    },
  );
  assert.equal(runnerCalled, false);
  assert.equal(invalidResult.overall_status, "fail");
  assert.equal(invalidResult.failure_class, "submitter_fixes");
  assert.match(invalidResult.summary, /spec=not_run, vally-lint=fail/);
  assert.doesNotMatch(invalidResult.summary, /undefined/);

  // Infra error surfaces failure_class: "infra" when no plugin has overall_status: "fail"
  const infraResult = await runExternalPluginPrQualityGates(
    [makeValidExternalPlugin("alpha-pack")],
    {
      runQualityGates: async () => ({
        overall_status: "infra_error",
        spec_compliance_status: "pass",
        vally_lint_status: "pass",
        smoke_status: "infra_error",
        version_match_status: "pass",
        ref_sha_consistency_status: "not_run",
        canvas_structure_status: "not_run",
      }),
    },
  );
  assert.equal(infraResult.overall_status, "infra_error");
  assert.equal(infraResult.failure_class, "infra");

  // Submitter failure takes precedence over infra_error across multiple plugins
  const mixedResult = await runExternalPluginPrQualityGates(
    [makeValidExternalPlugin("alpha-pack"), makeValidExternalPlugin("beta-pack")],
    {
      runQualityGates: async (plugin) => ({
        overall_status: plugin.name === "alpha-pack" ? "infra_error" : "fail",
        spec_compliance_status: "pass",
        vally_lint_status: plugin.name === "alpha-pack" ? "pass" : "fail",
        smoke_status: plugin.name === "alpha-pack" ? "infra_error" : "pass",
        version_match_status: "pass",
        ref_sha_consistency_status: "not_run",
        canvas_structure_status: "not_run",
      }),
    },
  );
  assert.equal(mixedResult.overall_status, "fail");
  assert.equal(mixedResult.failure_class, "submitter_fixes");
});
