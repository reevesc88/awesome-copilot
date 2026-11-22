import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AGENT_PLUGIN_SCHEMA_URL } from "./agent-plugin-schema.mjs";
import {
  isReusableExtensionRegistered,
  validateCompositionNamespace,
  validateDescription,
  validateExtensionReferences,
  validateKeywords,
  validateName,
  validatePlugin,
  validatePlugins,
  validateSchema,
  validateSpecPaths,
  validateVersion,
} from "./validate-plugins.mjs";

const AWESOME_NS = "com.github.awesome-copilot";
const COPILOT_NS = "com.github.copilot";

function makeTempRepo(t) {
  const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-plugins-"));
  const pluginsDir = path.join(rootFolder, "plugins");
  const extensionsDir = path.join(rootFolder, "extensions");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  t.after(() => fs.rmSync(rootFolder, { recursive: true, force: true }));
  return { rootFolder, pluginsDir, extensionsDir };
}

test("accepts a reusable extension bundled only by a parent plugin", () => {
  assert.equal(
    isReusableExtensionRegistered(
      "daily-focus-board",
      new Set(["ember"]),
      new Set(["daily-focus-board"])
    ),
    true
  );
});

test("accepts a same-named standalone extension plugin", () => {
  assert.equal(
    isReusableExtensionRegistered(
      "daily-focus-board",
      new Set(["daily-focus-board"]),
      new Set()
    ),
    true
  );
});

test("rejects an orphaned reusable extension", () => {
  assert.equal(
    isReusableExtensionRegistered(
      "daily-focus-board",
      new Set(["ember"]),
      new Set()
    ),
    false
  );
});

test("validateName enforces Agent Plugins spec §5.5 naming and folder match", () => {
  assert.deepEqual(validateName("my-plugin.v1", "my-plugin.v1"), []);
  assert.deepEqual(validateName("a", "a"), []);

  assert.ok(validateName("", "demo").some((e) => e.includes("required")));
  assert.ok(validateName("bad--name", "bad--name").some((e) => e.includes("spec §5.5")));
  assert.ok(validateName("bad..name", "bad..name").some((e) => e.includes("spec §5.5")));
  assert.ok(validateName("-leading", "-leading").some((e) => e.includes("spec §5.5")));
  assert.ok(validateName("UpperCase", "UpperCase").some((e) => e.includes("spec §5.5")));
  assert.ok(validateName("other-name", "folder-name").some((e) => e.includes("must match folder name")));
});

test("validateSchema, validateDescription, validateVersion, and validateKeywords enforce field rules", () => {
  assert.equal(
    validateSchema({ $schema: AGENT_PLUGIN_SCHEMA_URL, name: "valid-plugin" }),
    null,
  );
  assert.match(validateSchema({ name: "missing-schema" }), /\$schema must be/);
  assert.match(
    validateSchema({ $schema: AGENT_PLUGIN_SCHEMA_URL, name: "valid-plugin", unknownTopLevel: true }),
    /does not conform to Agent Plugins schema/,
  );

  assert.equal(validateDescription("Helpful toolkit"), null);
  assert.match(validateDescription(""), /required/);
  assert.match(validateDescription("x".repeat(501)), /between 1 and 500/);

  assert.equal(validateVersion("1.0.0"), null);
  assert.match(validateVersion(""), /required/);

  assert.equal(validateKeywords(undefined), null);
  assert.equal(validateKeywords(["testing", "ci-cd"]), null);
  assert.match(validateKeywords("not-array"), /must be an array/);
  assert.match(validateKeywords(Array.from({ length: 11 }, (_, i) => `kw-${i}`)), /maximum 10/);
  assert.match(validateKeywords(["Bad_Keyword"]), /lowercase letters, numbers, and hyphens/);
});

test("validateCompositionNamespace rejects misplaced or non-object composition fields", () => {
  assert.deepEqual(
    validateCompositionNamespace({
      extensions: { [AWESOME_NS]: { agents: ["./agents/a.md"] } },
    }),
    [],
  );

  assert.ok(
    validateCompositionNamespace({ extensions: [] }).some((e) =>
      e.includes("extensions must be an object"),
    ),
  );
  assert.ok(
    validateCompositionNamespace({ extensions: { [AWESOME_NS]: "bad" } }).some((e) =>
      e.includes(`extensions["${AWESOME_NS}"] must be an object`),
    ),
  );
  assert.ok(
    validateCompositionNamespace({ extensions: { agents: [] } }).some((e) =>
      e.includes(`extensions.agents must be moved to extensions["${AWESOME_NS}"].agents`),
    ),
  );
});

test("validateSpecPaths and validateExtensionReferences check sort order, duplicates, and existing sources", (t) => {
  const { rootFolder, extensionsDir } = makeTempRepo(t);
  fs.mkdirSync(path.join(rootFolder, "agents"), { recursive: true });
  fs.mkdirSync(path.join(rootFolder, "skills", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(rootFolder, "hooks", "logger"), { recursive: true });
  fs.mkdirSync(path.join(extensionsDir, "board"), { recursive: true });

  fs.writeFileSync(path.join(rootFolder, "agents", "reviewer.agent.md"), "# Reviewer\n", "utf8");
  fs.writeFileSync(path.join(rootFolder, "skills", "alpha", "SKILL.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(path.join(rootFolder, "hooks", "logger", "README.md"), "# Logger\n", "utf8");
  fs.writeFileSync(path.join(rootFolder, "hooks", "logger", "hooks.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(extensionsDir, "board", "extension.mjs"), "export default {};\n", "utf8");

  const validPlugin = {
    extensions: {
      [AWESOME_NS]: {
        agents: ["./agents/reviewer.md"],
        hooks: ["./hooks/logger/"],
        skills: ["./skills/alpha/"],
        extensions: ["./extensions/board"],
      },
    },
  };
  assert.deepEqual(validateSpecPaths(validPlugin, { rootFolder }), []);
  assert.deepEqual(validateExtensionReferences(validPlugin, "", { extensionsDir }), []);

  const invalidPlugin = {
    extensions: {
      [AWESOME_NS]: {
        agents: ["./agents/z.md", "./agents/a.md", "./agents/a.md"],
        hooks: ["./hooks/missing-hooks-json/"],
        extensions: ["./extensions/missing-ext"],
      },
    },
  };
  fs.mkdirSync(path.join(rootFolder, "hooks", "missing-hooks-json"), { recursive: true });
  fs.writeFileSync(path.join(rootFolder, "hooks", "missing-hooks-json", "README.md"), "# Hook\n", "utf8");

  const specErrors = validateSpecPaths(invalidPlugin, { rootFolder });
  assert.ok(specErrors.some((e) => e.includes("must be sorted alphabetically")));
  assert.ok(specErrors.some((e) => e.includes("must not contain duplicate")));
  assert.ok(specErrors.some((e) => e.includes("hooks/missing-hooks-json/hooks.json")));

  const extErrors = validateExtensionReferences(invalidPlugin, "", { extensionsDir });
  assert.ok(extErrors.some((e) => e.includes("source not found: extensions/missing-ext")));
});

test("validatePlugin validates curated and canvas-extension plugins and warns on non-SPDX license", (t) => {
  const { rootFolder, pluginsDir, extensionsDir } = makeTempRepo(t);

  // Curated plugin with proprietary license -> warning, zero errors
  const curatedDir = path.join(pluginsDir, "curated-pack");
  fs.mkdirSync(curatedDir, { recursive: true });
  fs.writeFileSync(path.join(curatedDir, "README.md"), "# Curated Pack\n", "utf8");
  fs.writeFileSync(
    path.join(curatedDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "curated-pack",
      description: "Curated test bundle",
      version: "1.2.0",
      license: "Proprietary-Custom",
      keywords: ["testing"],
      extensions: { [AWESOME_NS]: {} },
    }),
    "utf8",
  );

  const curatedResult = validatePlugin("curated-pack", { pluginsDir, extensionsDir, rootFolder });
  assert.deepEqual(curatedResult.errors, []);
  assert.equal(curatedResult.warnings.length, 1);
  assert.match(curatedResult.warnings[0], /not a recognized SPDX identifier/);

  // Canvas extension plugin missing preview.png -> reports screenshot error
  const canvasPluginDir = path.join(pluginsDir, "canvas-widget");
  const canvasExtDir = path.join(extensionsDir, "canvas-widget");
  fs.mkdirSync(canvasPluginDir, { recursive: true });
  fs.mkdirSync(canvasExtDir, { recursive: true });
  fs.writeFileSync(path.join(canvasExtDir, "extension.mjs"), "export default {};\n", "utf8");
  fs.writeFileSync(path.join(canvasPluginDir, "README.md"), "# Canvas Widget\n", "utf8");
  fs.writeFileSync(
    path.join(canvasPluginDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "canvas-widget",
      description: "Canvas widget plugin",
      version: "1.0.0",
      extensions: { [COPILOT_NS]: { logo: "assets/preview.png" } },
    }),
    "utf8",
  );

  const missingPreview = validatePlugin("canvas-widget", { pluginsDir, extensionsDir, rootFolder });
  assert.ok(missingPreview.errors.some((e) => e.includes("not found: assets/preview.png")));

  fs.mkdirSync(path.join(canvasExtDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(canvasExtDir, "assets", "preview.png"), "png", "utf8");
  const withPreview = validatePlugin("canvas-widget", { pluginsDir, extensionsDir, rootFolder });
  assert.deepEqual(withPreview.errors, []);
});

test("validatePlugin and validatePlugins enforce catalog integrity, orphaned extension checks, and root field rules", (t) => {
  const { rootFolder, pluginsDir, extensionsDir } = makeTempRepo(t);
  const externalPluginsFile = path.join(pluginsDir, "external.json");

  // Empty pluginsDir returns true
  assert.equal(validatePlugins({ pluginsDir, extensionsDir, rootFolder, externalPluginsFile }), true);

  // Missing plugin.json and malformed plugin.json + misplaced top-level agents
  fs.mkdirSync(path.join(pluginsDir, "missing-manifest"), { recursive: true });
  assert.ok(
    validatePlugin("missing-manifest", { pluginsDir, extensionsDir, rootFolder }).errors.includes(
      "missing required file: plugin.json",
    ),
  );

  fs.mkdirSync(path.join(pluginsDir, "bad-json"), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "bad-json", "plugin.json"), "{broken", "utf8");
  const badJsonResult = validatePlugin("bad-json", { pluginsDir, extensionsDir, rootFolder });
  assert.ok(badJsonResult.errors.some((e) => e.includes("missing required file: README.md")));
  assert.ok(badJsonResult.errors.some((e) => e.includes("failed to parse plugin.json")));

  // Clean up invalid dirs and test validatePlugins catalog checks
  fs.rmSync(path.join(pluginsDir, "missing-manifest"), { recursive: true, force: true });
  fs.rmSync(path.join(pluginsDir, "bad-json"), { recursive: true, force: true });

  const alphaDir = path.join(pluginsDir, "alpha-pack");
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.writeFileSync(path.join(alphaDir, "README.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(
    path.join(alphaDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "alpha-pack",
      description: "Alpha plugin",
      version: "1.0.0",
      extensions: { [AWESOME_NS]: {} },
    }),
    "utf8",
  );
  fs.writeFileSync(externalPluginsFile, "[]\n", "utf8");
  assert.equal(validatePlugins({ pluginsDir, extensionsDir, rootFolder, externalPluginsFile }), true);

  // Orphaned reusable extension causes validatePlugins to return false
  fs.mkdirSync(path.join(extensionsDir, "orphan-ext"), { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, "orphan-ext", "extension.mjs"), "export default {};\n", "utf8");
  assert.equal(validatePlugins({ pluginsDir, extensionsDir, rootFolder, externalPluginsFile }), false);

  // Referencing the extension from alpha-pack resolves the orphan error
  fs.writeFileSync(
    path.join(alphaDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_URL,
      name: "alpha-pack",
      description: "Alpha plugin",
      version: "1.0.0",
      extensions: { [AWESOME_NS]: { extensions: ["./extensions/orphan-ext"] } },
    }),
    "utf8",
  );
  assert.equal(validatePlugins({ pluginsDir, extensionsDir, rootFolder, externalPluginsFile }), true);
});
