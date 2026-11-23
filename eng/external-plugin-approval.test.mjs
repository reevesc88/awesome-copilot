import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DECISION_COMMANDS,
  parseDecisionCommand,
  readCliArgs,
  slugifyPluginName,
  upsertExternalPlugin,
} from "./external-plugin-approval.mjs";

function makePlugin(overrides = {}) {
  return {
    name: "beta-helper",
    description: "External helper plugin",
    version: "1.0.0",
    author: { name: "Example Author" },
    repository: "https://github.com/example/beta-helper",
    keywords: ["workflow"],
    license: "MIT",
    source: {
      source: "github",
      repo: "example/beta-helper",
      path: "plugins/beta-helper",
      ref: "v1.0.0",
    },
    ...overrides,
  };
}

test("parseDecisionCommand parses /approve and /reject commands and ignores non-commands", () => {
  assert.equal(DECISION_COMMANDS.approve, "/approve");
  assert.equal(DECISION_COMMANDS.reject, "/reject");

  assert.deepEqual(parseDecisionCommand("  /approve  "), {
    command: "approve",
    reason: undefined,
  });
  assert.deepEqual(parseDecisionCommand("LGTM!\n/APPROVE ship it"), {
    command: "approve",
    reason: undefined,
  });
  assert.deepEqual(parseDecisionCommand("/reject Missing immutable tag\nExtra details"), {
    command: "reject",
    reason: "Missing immutable tag\nExtra details",
  });
  assert.deepEqual(parseDecisionCommand("/reject   "), {
    command: "reject",
    reason: undefined,
  });

  assert.equal(parseDecisionCommand("/approved"), undefined);
  assert.equal(parseDecisionCommand("/rejecting"), undefined);
  assert.equal(parseDecisionCommand("Please /approve this submission"), undefined);
  assert.equal(parseDecisionCommand(""), undefined);
});

test("slugifyPluginName and readCliArgs normalize inputs", () => {
  assert.equal(slugifyPluginName("  My Cool_Plugin! v2 "), "my-cool-plugin-v2");
  assert.equal(slugifyPluginName("___"), "external-plugin");
  assert.deepEqual(readCliArgs(["positional", "--file", "custom.json"]), {
    file: "custom.json",
  });
});

test("upsertExternalPlugin inserts sorted entries, updates matching plugins, and detects no-op writes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "external.json");

  const zeta = makePlugin({
    name: "zeta-pack",
    repository: "https://github.com/example/zeta-pack",
    source: { source: "github", repo: "example/zeta-pack", ref: "v1.0.0" },
  });
  fs.writeFileSync(filePath, `${JSON.stringify([zeta], null, 2)}\n`, "utf8");

  // Insert beta-helper before zeta-pack alphabetically
  const beta = makePlugin();
  const inserted = upsertExternalPlugin(beta, { filePath, localPluginNames: [] });
  assert.equal(inserted.action, "inserted");
  assert.equal(inserted.changed, true);

  const afterInsert = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(
    afterInsert.map((p) => p.name),
    ["beta-helper", "zeta-pack"],
  );

  // Idempotent upsert of identical plugin -> updated, changed: false
  const unchanged = upsertExternalPlugin(beta, { filePath, localPluginNames: [] });
  assert.equal(unchanged.action, "updated");
  assert.equal(unchanged.changed, false);

  // Update matched by same source.repo + source.path even when plugin was renamed
  const renamedSameSource = makePlugin({
    name: "alpha-renamed",
    version: "1.1.0",
  });
  const updated = upsertExternalPlugin(renamedSameSource, { filePath, localPluginNames: [] });
  assert.equal(updated.action, "updated");
  assert.equal(updated.changed, true);

  const afterRename = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(
    afterRename.map((p) => p.name),
    ["alpha-renamed", "zeta-pack"],
  );
  assert.equal(afterRename[0].version, "1.1.0");

  // Rejects collision with a local plugin name
  assert.throws(
    () =>
      upsertExternalPlugin(
        makePlugin({
          name: "local-conflict",
          repository: "https://github.com/example/local-conflict",
          source: { source: "github", repo: "example/local-conflict", ref: "v1.0.0" },
        }),
        { filePath, localPluginNames: ["local-conflict"] },
      ),
    /local-conflict/,
  );

  // Rejects corrupt existing external.json and CLI missing-args usage exits 1
  const badJsonPath = path.join(dir, "corrupt-external.json");
  fs.writeFileSync(badJsonPath, "{not-json", "utf8");
  assert.throws(() => upsertExternalPlugin(beta, { filePath: badJsonPath, localPluginNames: [] }));

  const scriptPath = fileURLToPath(new URL("./external-plugin-approval.mjs", import.meta.url));
  const cliBadArgs = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(cliBadArgs.status, 1);
  assert.match(cliBadArgs.stderr, /Usage: node \.\/eng\/external-plugin-approval\.mjs approve/);
});
