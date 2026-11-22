import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateMarketplace } from "./generate-marketplace.mjs";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-marketplace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("generateMarketplace skips missing or malformed plugin.json, defaults version, and handles missing external.json", (t) => {
  const root = makeTempDir(t);
  const pluginsDir = path.join(root, "plugins");
  const marketplaceFile = path.join(root, "out", "nested", "marketplace.json");
  const missingExternalFile = path.join(pluginsDir, "does-not-exist.json");

  fs.mkdirSync(path.join(pluginsDir, "broken-json"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "empty-folder"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "default-version"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "alpha-upper"), { recursive: true });
  // Non-directory entry in plugins/ should be ignored
  fs.writeFileSync(path.join(pluginsDir, "README.md"), "# Plugins\n", "utf8");

  fs.writeFileSync(path.join(pluginsDir, "broken-json", "plugin.json"), "{invalid", "utf8");
  fs.writeFileSync(
    path.join(pluginsDir, "default-version", "plugin.json"),
    JSON.stringify({ name: "beta-pack", description: "No explicit version" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginsDir, "alpha-upper", "plugin.json"),
    JSON.stringify({ name: "Alpha-Pack", description: "Case-insensitive sort check", version: "3.0.0" }),
    "utf8",
  );

  const warnings = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    generateMarketplace({
      pluginsDir,
      marketplaceFile,
      externalPluginsFile: missingExternalFile,
    });
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }

  assert.ok(warnings.some((w) => w.includes("No plugin.json found for empty-folder")));
  assert.ok(errors.some((e) => e.includes("Error reading plugin.json for broken-json")));

  const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name),
    ["Alpha-Pack", "beta-pack"],
  );
  assert.equal(marketplace.plugins[1].version, "1.0.0");
});

test("generateMarketplace logs external warnings and exits non-zero on missing pluginsDir or invalid external.json", (t) => {
  const root = makeTempDir(t);
  const pluginsDir = path.join(root, "plugins");
  const marketplaceFile = path.join(root, "marketplace.json");
  const externalPluginsFile = path.join(pluginsDir, "external.json");
  fs.mkdirSync(pluginsDir, { recursive: true });

  // External plugin without immutable ref/sha emits a warning under marketplace policy
  fs.writeFileSync(
    externalPluginsFile,
    JSON.stringify([
      {
        name: "warn-external",
        description: "Valid entry with warning",
        version: "1.0.0",
        author: { name: "Maintainer" },
        repository: "https://github.com/example/warn-external",
        keywords: ["demo"],
        license: "Proprietary-1.0",
        source: { source: "github", repo: "example/warn-external" },
      },
    ]),
    "utf8",
  );

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    generateMarketplace({ pluginsDir, marketplaceFile, externalPluginsFile });
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes("immutable tag ref or commit SHA is recommended")));

  // Invalid external.json triggers process.exit(1)
  fs.writeFileSync(externalPluginsFile, JSON.stringify([{ name: "INVALID_UPPER" }]), "utf8");
  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`EXIT:${code}`);
  };
  try {
    assert.throws(
      () => generateMarketplace({ pluginsDir, marketplaceFile, externalPluginsFile }),
      /EXIT:1/,
    );
    assert.throws(
      () => generateMarketplace({ pluginsDir: path.join(root, "missing-plugins"), marketplaceFile }),
      /EXIT:1/,
    );
  } finally {
    process.exit = origExit;
  }
});
