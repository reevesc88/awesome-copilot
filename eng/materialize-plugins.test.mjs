import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { restoreManifestFromMaterializedFiles } from "./clean-materialized-plugins.mjs";
import { generateMarketplace } from "./generate-marketplace.mjs";
import { materializePlugins, resolveSource } from "./materialize-plugins.mjs";

function makeTempDir(t, prefix = "awesome-copilot-materialize-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("build scripts expose callable APIs without running on import", () => {
  assert.equal(typeof materializePlugins, "function");
  assert.equal(typeof generateMarketplace, "function");
});

test("resolveSource maps plugin-relative resource paths to repository root sources", () => {
  const root = "/tmp/repo-root";
  assert.equal(resolveSource("./agents/reviewer.md", root), path.join(root, "agents", "reviewer.agent.md"));
  assert.equal(resolveSource("./skills/linting/", root), path.join(root, "skills", "linting"));
  assert.equal(resolveSource("./hooks/audit/", root), path.join(root, "hooks", "audit/"));
  assert.equal(resolveSource("./extensions/board", root), path.join(root, "extensions", "board"));
  assert.equal(resolveSource("./instructions/nope.md", root), null);
});

test("materializePlugins copies resources, strips internal namespace, and restoreManifestFromMaterializedFiles round-trips", (t) => {
  const rootFolder = makeTempDir(t);
  fs.mkdirSync(path.join(rootFolder, "agents"), { recursive: true });
  fs.mkdirSync(path.join(rootFolder, "skills", "triage"), { recursive: true });
  fs.mkdirSync(path.join(rootFolder, "extensions", "focus-board"), { recursive: true });
  fs.mkdirSync(path.join(rootFolder, "plugins", "demo-pack"), { recursive: true });

  fs.writeFileSync(path.join(rootFolder, "agents", "helper.agent.md"), "# Helper\n", "utf8");
  fs.writeFileSync(path.join(rootFolder, "skills", "triage", "SKILL.md"), "# Triage\n", "utf8");
  fs.writeFileSync(
    path.join(rootFolder, "extensions", "focus-board", "extension.mjs"),
    "export default {};\n",
    "utf8",
  );

  const pluginPath = path.join(rootFolder, "plugins", "demo-pack");
  const pluginJsonPath = path.join(pluginPath, "plugin.json");
  fs.writeFileSync(
    pluginJsonPath,
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "demo-pack",
      version: "1.0.0",
      description: "Demo plugin",
      featured: true,
      extensions: {
        "com.github.copilot": { logo: "assets/preview.png" },
        "com.github.awesome-copilot": {
          agents: ["./agents/helper.md"],
          skills: ["./skills/triage/"],
          extensions: ["./extensions/focus-board"],
        },
      },
    }),
    "utf8",
  );

  materializePlugins({ rootFolder });

  assert.equal(
    fs.existsSync(path.join(pluginPath, "com.github.copilot", "agents", "helper.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(pluginPath, "skills", "triage", "SKILL.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(pluginPath, "com.github.copilot", "extensions", "focus-board", "extension.mjs")),
    true,
  );

  const servedManifest = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  assert.equal(servedManifest.featured, undefined);
  assert.equal(servedManifest.extensions["com.github.awesome-copilot"], undefined);
  assert.deepEqual(servedManifest.extensions["com.github.copilot"], { logo: "assets/preview.png" });

  // Round-trip restore declarative composition from materialized directories
  const changed = restoreManifestFromMaterializedFiles(pluginPath);
  assert.equal(changed, true);
  const restored = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  assert.deepEqual(restored.extensions["com.github.awesome-copilot"], {
    agents: ["./agents/helper.md"],
    skills: ["./skills/triage/"],
    extensions: ["./extensions/focus-board"],
  });
});

test("generateMarketplace merges and sorts local and external plugins", (t) => {
  const root = makeTempDir(t);
  const pluginsDir = path.join(root, "plugins");
  const marketplaceFile = path.join(root, ".github", "plugin", "marketplace.json");
  const externalPluginsFile = path.join(pluginsDir, "external.json");

  fs.mkdirSync(path.join(pluginsDir, "zeta-local"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginsDir, "zeta-local", "plugin.json"),
    JSON.stringify({
      name: "zeta-local",
      description: "Local plugin",
      version: "2.1.0",
    }),
    "utf8",
  );
  fs.writeFileSync(
    externalPluginsFile,
    JSON.stringify([
      {
        name: "alpha-external",
        description: "External plugin",
        version: "1.0.0",
        author: { name: "Example Maintainer" },
        repository: "https://github.com/example/alpha-external",
        keywords: ["workflow"],
        license: "MIT",
        source: {
          source: "github",
          repo: "example/alpha-external",
          ref: "v1.0.0",
        },
      },
    ]),
    "utf8",
  );

  generateMarketplace({ pluginsDir, marketplaceFile, externalPluginsFile });

  const generated = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  assert.equal(generated.name, "awesome-copilot");
  assert.deepEqual(
    generated.plugins.map((p) => p.name),
    ["alpha-external", "zeta-local"],
  );
  assert.equal(generated.plugins[1].source, "plugins/zeta-local");
  assert.equal(generated.plugins[1].version, "2.1.0");
});
