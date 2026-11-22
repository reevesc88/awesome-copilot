import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cleanMaterializedExtensionPlugin,
  cleanMaterializedPlugins,
  cleanPlugin,
  isExtensionPluginDirectory,
  restoreManifestFromMaterializedFiles,
} from "./clean-materialized-plugins.mjs";

const AWESOME_NS = "com.github.awesome-copilot";

function makeTempDir(t, prefix = "awesome-copilot-clean-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("restoreManifestFromMaterializedFiles handles missing, unchanged, malformed, and nested materialized directories", (t) => {
  const root = makeTempDir(t);

  // Missing plugin.json -> false
  const emptyPluginDir = path.join(root, "empty-plugin");
  fs.mkdirSync(emptyPluginDir, { recursive: true });
  assert.equal(restoreManifestFromMaterializedFiles(emptyPluginDir), false);

  // Malformed plugin.json -> descriptive error
  const brokenPluginDir = path.join(root, "broken-plugin");
  fs.mkdirSync(brokenPluginDir, { recursive: true });
  fs.writeFileSync(path.join(brokenPluginDir, "plugin.json"), "{ invalid json", "utf8");
  assert.throws(
    () => restoreManifestFromMaterializedFiles(brokenPluginDir),
    /Failed to parse/,
  );

  // Restores agents, hooks, nested skills, and extensions in sorted order
  const pluginDir = path.join(root, "full-pack");
  fs.mkdirSync(path.join(pluginDir, "com.github.copilot", "agents"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "com.github.copilot", "hooks", "audit-log"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills", "nested", "lint-helper"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "com.github.copilot", "extensions", "focus-board"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(pluginDir, "com.github.copilot", "agents", "z-agent.md"),
    "# Z\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "com.github.copilot", "agents", "a-agent.md"),
    "# A\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "com.github.copilot", "hooks", "audit-log", "hooks.json"),
    "{}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "skills", "nested", "lint-helper", "SKILL.md"),
    "# Skill\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "com.github.copilot", "extensions", "focus-board", "extension.mjs"),
    "export default {};\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "full-pack", version: "1.0.0" }),
    "utf8",
  );

  assert.equal(restoreManifestFromMaterializedFiles(pluginDir), true);
  const restored = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
  assert.deepEqual(restored.extensions[AWESOME_NS], {
    agents: ["./agents/a-agent.md", "./agents/z-agent.md"],
    hooks: ["./hooks/audit-log/"],
    skills: ["./skills/nested/lint-helper/"],
    extensions: ["./extensions/focus-board"],
  });

  // Second call without file changes -> unchanged (false)
  assert.equal(restoreManifestFromMaterializedFiles(pluginDir), false);
});

test("cleanPlugin removes materialized trees and prunes empty com.github.copilot directory", (t) => {
  const root = makeTempDir(t);
  const pluginDir = path.join(root, "sample-pack");
  fs.mkdirSync(path.join(pluginDir, "com.github.copilot", "agents"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills", "triage"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "com.github.copilot", "agents", "helper.md"),
    "# Helper\n",
    "utf8",
  );
  fs.writeFileSync(path.join(pluginDir, "skills", "triage", "SKILL.md"), "# Triage\n", "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "sample-pack", version: "1.0.0" }),
    "utf8",
  );

  const result = cleanPlugin(pluginDir);
  assert.equal(result.removed, 2);
  assert.equal(result.manifestUpdated, true);
  assert.equal(fs.existsSync(path.join(pluginDir, "com.github.copilot")), false);
  assert.equal(fs.existsSync(path.join(pluginDir, "skills")), false);
});

test("isExtensionPluginDirectory and cleanMaterializedExtensionPlugin restore bundled extension layout", (t) => {
  const root = makeTempDir(t);

  // Non-extension directory
  const plainDir = path.join(root, "not-an-extension");
  fs.mkdirSync(plainDir, { recursive: true });
  assert.equal(isExtensionPluginDirectory(plainDir), false);
  fs.writeFileSync(path.join(plainDir, "plugin.json"), "{ invalid", "utf8");
  assert.equal(isExtensionPluginDirectory(plainDir), false);

  // Materialized extension directory with nested bundle + rewritten manifest fields
  const extDir = path.join(root, "board-canvas");
  const bundleDir = path.join(extDir, "extensions", "board-canvas");
  fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "extension.mjs"), "export default {};\n", "utf8");
  fs.writeFileSync(path.join(bundleDir, "assets", "preview.png"), "png-bytes", "utf8");
  fs.writeFileSync(
    path.join(extDir, "plugin.json"),
    JSON.stringify({
      name: "board-canvas",
      extensions: "extensions",
      logo: "extensions/board-canvas/assets/preview.png",
    }),
    "utf8",
  );

  assert.equal(isExtensionPluginDirectory(extDir), true);

  const cleaned = cleanMaterializedExtensionPlugin(extDir);
  assert.equal(cleaned.removed, 2);
  assert.equal(cleaned.manifestUpdated, true);
  assert.equal(fs.existsSync(path.join(extDir, "extension.mjs")), true);
  assert.equal(fs.existsSync(path.join(extDir, "assets", "preview.png")), true);
  assert.equal(fs.existsSync(path.join(extDir, "extensions")), false);

  const updatedManifest = JSON.parse(fs.readFileSync(path.join(extDir, "plugin.json"), "utf8"));
  assert.equal(updatedManifest.extensions, ".");
  assert.equal(updatedManifest.logo, "assets/preview.png");
});

test("cleanMaterializedPlugins cleans plugins and extensions end-to-end and throws if pluginsDir is missing", (t) => {
  const root = makeTempDir(t);
  const pluginsDir = path.join(root, "plugins");
  const extensionsDir = path.join(root, "extensions");

  assert.throws(
    () => cleanMaterializedPlugins({ pluginsDir: path.join(root, "missing-plugins"), extensionsDir }),
    /plugins directory not found/,
  );

  fs.mkdirSync(path.join(pluginsDir, "alpha", "skills", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginsDir, "alpha", "skills", "demo", "SKILL.md"),
    "# Demo\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginsDir, "alpha", "plugin.json"),
    JSON.stringify({ name: "alpha", version: "1.0.0" }),
    "utf8",
  );

  fs.mkdirSync(path.join(extensionsDir, "widget", "extensions", "widget"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionsDir, "widget", "extensions", "widget", "extension.mjs"),
    "export default {};\n",
    "utf8",
  );

  const firstPass = cleanMaterializedPlugins({ pluginsDir, extensionsDir });
  assert.equal(firstPass.removed, 2);
  assert.equal(firstPass.manifestsUpdated, 1);

  const secondPass = cleanMaterializedPlugins({ pluginsDir, extensionsDir });
  assert.deepEqual(secondPass, { removed: 0, manifestsUpdated: 0 });
});
