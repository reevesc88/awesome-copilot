import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlugin, isValidPluginId, parseArgs } from "./create-plugin.mjs";
import { validatePlugin } from "./validate-plugins.mjs";

function makeTempPluginsDir(t) {
  const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-create-plugin-"));
  const pluginsDir = path.join(rootFolder, "plugins");
  const extensionsDir = path.join(rootFolder, "extensions");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  t.after(() => fs.rmSync(rootFolder, { recursive: true, force: true }));
  return { rootFolder, pluginsDir, extensionsDir };
}

test("parseArgs supports flags, equals syntax without truncating '=', and positional fallbacks", () => {
  assert.deepEqual(parseArgs(["--name", "python-pack", "--keywords", "python,testing"]), {
    name: "python-pack",
    keywords: "python,testing",
  });
  assert.deepEqual(parseArgs(["-n", "go-pack", "-t", "golang,cli"]), {
    name: "go-pack",
    keywords: "golang,cli",
  });
  assert.deepEqual(parseArgs(["--name=rust-pack", "--tags=rust,key=val"]), {
    name: "rust-pack",
    keywords: "rust,key=val",
  });
  assert.deepEqual(parseArgs(["positional-pack", "one,two"]), {
    name: "positional-pack",
    keywords: "one,two",
  });
});

test("isValidPluginId enforces 1-64 lowercase alphanumeric characters and single internal hyphens", () => {
  assert.equal(isValidPluginId("my-plugin-1"), true);
  assert.equal(isValidPluginId("a"), true);

  assert.equal(isValidPluginId(""), false);
  assert.equal(isValidPluginId("-leading"), false);
  assert.equal(isValidPluginId("trailing-"), false);
  assert.equal(isValidPluginId("double--hyphen"), false);
  assert.equal(isValidPluginId("UpperCase"), false);
  assert.equal(isValidPluginId("a".repeat(65)), false);
});

test("createPlugin scaffolds valid plugin.json and README.md that pass validatePlugin", async (t) => {
  const { rootFolder, pluginsDir, extensionsDir } = makeTempPluginsDir(t);

  // Use defaults for displayName, description, and keywords (first 3 segments of ID)
  const createdDir = await createPlugin({
    argv: ["--name", "cloud-deploy-toolkit-extra"],
    promptFn: async () => "",
    pluginsDir,
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`);
    },
  });

  assert.equal(createdDir, path.join(pluginsDir, "cloud-deploy-toolkit-extra"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(createdDir, "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "cloud-deploy-toolkit-extra");
  assert.equal(manifest.description, "A plugin for cloud deploy toolkit extra.");
  assert.deepEqual(manifest.keywords, ["cloud", "deploy", "toolkit"]);

  const readme = fs.readFileSync(path.join(createdDir, "README.md"), "utf8");
  assert.match(readme, /# Cloud Deploy Toolkit Extra Plugin/);
  assert.match(readme, /copilot plugin install cloud-deploy-toolkit-extra@awesome-copilot/);

  const validation = validatePlugin("cloud-deploy-toolkit-extra", {
    pluginsDir,
    extensionsDir,
    rootFolder,
  });
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
});

test("createPlugin rejects invalid IDs and duplicate plugin directories", async (t) => {
  const { pluginsDir } = makeTempPluginsDir(t);
  const exitCodes = [];
  const recordExit = (code) => {
    exitCodes.push(code);
    return code;
  };

  // Invalid double-hyphen ID
  await createPlugin({
    argv: ["--name", "bad--id"],
    promptFn: async () => "",
    pluginsDir,
    exit: recordExit,
  });

  // Missing ID
  await createPlugin({
    argv: [],
    promptFn: async () => "",
    pluginsDir,
    exit: recordExit,
  });

  // Duplicate existing plugin directory
  fs.mkdirSync(path.join(pluginsDir, "existing-pack"), { recursive: true });
  await createPlugin({
    argv: ["--name", "existing-pack"],
    promptFn: async () => "",
    pluginsDir,
    exit: recordExit,
  });

  assert.deepEqual(exitCodes, [1, 1, 1]);
});
