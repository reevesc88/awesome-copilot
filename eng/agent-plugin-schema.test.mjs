import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AGENT_PLUGIN_SCHEMA_URL,
  validateAgentPluginManifest,
} from "./agent-plugin-schema.mjs";
import {
  buildEphemeralMarketplace,
  buildVallyLintArgs,
  classifySmokeFailure,
  inspectAgentPluginSpecCompliance,
  normalizePluginPath,
  parseCliArgs,
  resolveFetchSpec,
  truncateOutput,
} from "./external-plugin-quality-gates.mjs";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-schema-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validateAgentPluginManifest validates Agent Plugins v1.0.0 schema constraints", () => {
  assert.deepEqual(
    validateAgentPluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "valid-plugin.v1",
      version: "1.0.0",
      description: "Valid manifest",
      author: { name: "Ada", email: "ada@example.com", url: "https://example.com" },
      keywords: ["workflow"],
      extensions: { "com.github.copilot": { logo: "assets/preview.png" } },
    }),
    [],
  );

  const errors = validateAgentPluginManifest({
    $schema: "https://example.com/wrong.json",
    name: "bad--name",
    author: { name: "Ada", extra: "disallowed" },
    unexpectedField: true,
  });
  assert.ok(errors.some((e) => e.includes("/$schema")));
  assert.ok(errors.some((e) => e.includes("/name")));
  assert.ok(errors.some((e) => e.includes("/author")));
  assert.ok(errors.some((e) => e.includes("additional properties")));
});

test("inspectAgentPluginSpecCompliance and buildVallyLintArgs inspect plugin manifests and skill roots", (t) => {
  const missingDir = makeTempDir(t);
  assert.equal(inspectAgentPluginSpecCompliance(missingDir).status, "warning");
  assert.deepEqual(buildVallyLintArgs(missingDir), [missingDir]);

  // Valid root plugin.json + resolvable skills directory
  const validRoot = makeTempDir(t);
  const skillDir = path.join(validRoot, "skills", "triage");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(validRoot, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "demo-plugin",
      version: "1.0.0",
      description: "Demo plugin",
    }),
    "utf8",
  );
  assert.equal(inspectAgentPluginSpecCompliance(validRoot).status, "pass");

  // Nested .github/plugin/plugin.json with skills array -> spec warning for location, vally targets skill dir
  const nestedRoot = makeTempDir(t);
  const nestedSkill = path.join(nestedRoot, "skills", "linting");
  fs.mkdirSync(path.join(nestedRoot, ".github", "plugin"), { recursive: true });
  fs.mkdirSync(nestedSkill, { recursive: true });
  fs.writeFileSync(
    path.join(nestedRoot, ".github", "plugin", "plugin.json"),
    JSON.stringify({
      name: "nested-plugin",
      version: "1.0.0",
      description: "Nested manifest",
      skills: ["./skills/linting", "./skills/missing"],
    }),
    "utf8",
  );

  const nestedCompliance = inspectAgentPluginSpecCompliance(nestedRoot);
  assert.equal(nestedCompliance.status, "warning");
  assert.match(nestedCompliance.output, /manifest location is/);
  assert.deepEqual(buildVallyLintArgs(nestedRoot), [nestedSkill]);
});

test("quality-gate helpers normalize paths, classify infra errors, truncate ANSI output, and write marketplace", (t) => {
  assert.equal(normalizePluginPath("/"), "");
  assert.equal(normalizePluginPath(" /plugins/demo/ "), "plugins/demo");
  assert.throws(() => normalizePluginPath("../escape"), /Invalid plugin path/);
  assert.throws(() => normalizePluginPath("plugins\\demo"), /Invalid plugin path/);

  assert.equal(resolveFetchSpec({ sha: "a".repeat(40), ref: "v1.0.0" }), "a".repeat(40));
  assert.equal(resolveFetchSpec({ ref: " v1.0.0 " }), "v1.0.0");
  assert.throws(() => resolveFetchSpec({}), /source\.ref or source\.sha is required/);

  assert.equal(classifySmokeFailure("Error: 401 authentication required"), "infra_error");
  assert.equal(classifySmokeFailure("connect ETIMEDOUT"), "infra_error");
  assert.equal(classifySmokeFailure("Invalid manifest schema in plugin.json"), "fail");

  const stripped = truncateOutput("\x1b[31mError\x1b[0m: " + "x".repeat(12_050));
  assert.ok(stripped.startsWith("Error: "));
  assert.match(stripped, /\.\.\.output truncated\.\.\.$/);

  const workDir = makeTempDir(t);
  const marketplaceDir = buildEphemeralMarketplace(workDir, { name: "demo" });
  const written = JSON.parse(
    fs.readFileSync(path.join(marketplaceDir, "marketplace.json"), "utf8"),
  );
  assert.equal(written.name, "external-plugin-intake");
  assert.deepEqual(written.plugins, [{ name: "demo" }]);
  assert.deepEqual(parseCliArgs(["--plugin-json", '{"name":"demo"}']), {
    "plugin-json": '{"name":"demo"}',
  });
});
