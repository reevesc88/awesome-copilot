import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildExtensionPluginOwners,
  readExtensionPluginOwners,
  resolveExtensionPluginName,
} from "./extension-plugin-ownership.mjs";

const namespace = "com.github.awesome-copilot";

test("resolves an extension bundled only by its parent plugin", () => {
  const owners = buildExtensionPluginOwners([
    {
      directoryName: "ember",
      manifest: {
        name: "ember",
        extensions: {
          [namespace]: {
            extensions: ["./extensions/daily-focus-board"],
          },
        },
      },
    },
  ]);

  assert.equal(
    resolveExtensionPluginName("daily-focus-board", owners),
    "ember"
  );
});

test("prefers a same-named standalone plugin over another owner", () => {
  const owners = buildExtensionPluginOwners([
    {
      directoryName: "parent-plugin",
      manifest: {
        name: "parent-plugin",
        extensions: {
          [namespace]: {
            extensions: ["./extensions/daily-focus-board/"],
          },
        },
      },
    },
    {
      directoryName: "daily-focus-board",
      manifest: { name: "daily-focus-board" },
    },
  ]);

  assert.equal(
    resolveExtensionPluginName("daily-focus-board", owners),
    "daily-focus-board"
  );
});

test("preserves the extension name when no plugin owns it", () => {
  assert.equal(
    resolveExtensionPluginName("daily-focus-board", new Map()),
    "daily-focus-board"
  );
});

test("readExtensionPluginOwners reads plugin manifests from disk and handles missing directories or non-extension refs", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-ext-owners-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  assert.equal(readExtensionPluginOwners(path.join(tempRoot, "missing")).size, 0);

  const pluginsDir = path.join(tempRoot, "plugins");
  fs.mkdirSync(path.join(pluginsDir, "bundle-a"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "no-manifest"), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "external.json"), "[]\n", "utf8");

  fs.writeFileSync(
    path.join(pluginsDir, "bundle-a", "plugin.json"),
    JSON.stringify({
      name: "  ",
      extensions: {
        [namespace]: {
          extensions: ["./extensions/shared-canvas/", "./skills/not-an-extension", 42],
        },
      },
    }),
    "utf8",
  );

  const owners = readExtensionPluginOwners(pluginsDir);
  assert.equal(resolveExtensionPluginName("shared-canvas", owners), "bundle-a");
  assert.equal(resolveExtensionPluginName("bundle-a", owners), "bundle-a");
});
