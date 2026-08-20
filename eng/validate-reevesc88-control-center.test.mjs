import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, resolveInventoryPath } from "./validate-reevesc88-control-center.mjs";

function createInventoryFixture(t) {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-validator-"),
  );
  const controlRoot = path.join(repoRoot, "personal", "reevesc88");
  const sourceRoot = path.join(controlRoot, "templates", "repository");
  fs.mkdirSync(sourceRoot, { recursive: true });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  return { repoRoot, controlRoot, sourceRoot };
}

test("inventory path accepts a relative path inside its approved root", (t) => {
  const { repoRoot, controlRoot, sourceRoot } = createInventoryFixture(t);

  assert.equal(
    resolveInventoryPath(
      repoRoot,
      controlRoot,
      path.relative(repoRoot, sourceRoot),
      "Inventory sourceRoot",
    ),
    sourceRoot,
  );
});

test("inventory sourceRoot rejects an absolute path inside the control root", (t) => {
  const { repoRoot, controlRoot, sourceRoot } = createInventoryFixture(t);

  assert.throws(
    () =>
      resolveInventoryPath(
        repoRoot,
        controlRoot,
        sourceRoot,
        "Inventory sourceRoot",
      ),
    /Inventory sourceRoot must be relative/,
  );
});

test("inventory sourceRoot rejects a junction or symlink segment", (t) => {
  const { repoRoot, controlRoot } = createInventoryFixture(t);
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-validator-outside-"),
  );
  const linkedRoot = path.join(controlRoot, "linked-templates");
  fs.mkdirSync(path.join(outsideRoot, "repository"), { recursive: true });
  fs.symlinkSync(
    outsideRoot,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  assert.throws(
    () =>
      resolveInventoryPath(
        repoRoot,
        controlRoot,
        path.relative(repoRoot, path.join(linkedRoot, "repository")),
        "Inventory sourceRoot",
      ),
    /Inventory sourceRoot cannot include a symbolic link or junction/,
  );
});

test("inventory item source rejects a junction or symlink segment", (t) => {
  const { repoRoot, sourceRoot } = createInventoryFixture(t);
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-validator-item-outside-"),
  );
  const linkedDirectory = path.join(sourceRoot, "agents");
  fs.writeFileSync(path.join(outsideRoot, "reviewer.md"), "outside\n", "utf8");
  fs.symlinkSync(
    outsideRoot,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  assert.throws(
    () =>
      resolveInventoryPath(
        repoRoot,
        sourceRoot,
        path.relative(repoRoot, path.join(linkedDirectory, "reviewer.md")),
        "Inventory source for reviewer",
      ),
    /Inventory source for reviewer cannot include a symbolic link or junction/,
  );
});
test("validator main accepts the curated control center", () => {
  const originalLog = console.log;
  const output = [];
  console.log = (...values) => output.push(values.join(" "));

  try {
    main();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, ["Control-center validation passed"]);
});
