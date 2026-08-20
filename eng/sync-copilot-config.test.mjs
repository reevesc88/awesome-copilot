import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoSymlinkSegments,
  collectTargets,
  main,
  parseArgs,
  resolveWithin,
  selectItems,
} from "../personal/reevesc88/scripts/sync-copilot-config.mjs";

const inventory = JSON.parse(
  fs.readFileSync(
    new URL("../personal/reevesc88/inventory.json", import.meta.url),
    "utf8",
  ),
);
const syncScriptPath = fileURLToPath(
  new URL("../personal/reevesc88/scripts/sync-copilot-config.mjs", import.meta.url),
);


function createRepositoryFixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-sync-"));
  fs.mkdirSync(path.join(target, ".git"));
  return target;
}

function runSync(args) {
  return spawnSync(process.execPath, [syncScriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function runMain(args) {
  const originalArgv = process.argv;
  const originalLog = console.log;
  const output = [];

  process.argv = [process.execPath, syncScriptPath, ...args];
  console.log = (...values) => output.push(values.join(" "));

  try {
    main();
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
  }

  return output.join("\n");
}


test("default selection excludes customize-before-enable items", () => {
  const items = selectItems(inventory, []);

  assert.ok(items.some((item) => item.id === "code-review"));
  assert.ok(!items.some((item) => item.id === "main-instructions"));
  assert.ok(!items.some((item) => item.kind === "workflow-template"));
});

test("default selection rejects a customize-before-enable item marked as default", () => {
  const malformedInventory = {
    items: [
      {
        id: "unsafe-default",
        maturity: "customize-before-enable",
        installByDefault: true,
      },
    ],
  };

  assert.throws(
    () => selectItems(malformedInventory, []),
    /Customize-before-enable item cannot be installed by default: unsafe-default/,
  );
});

test("explicit selection can include a customize-before-enable item", () => {
  const items = selectItems(inventory, ["main-instructions"]);

  assert.deepEqual(items.map((item) => item.id), ["main-instructions"]);
});

test("unknown inventory ids are rejected", () => {
  assert.throws(
    () => selectItems(inventory, ["does-not-exist"]),
    /Unknown inventory item: does-not-exist/,
  );
});

test("target collection requires a repository root", (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-not-repo-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  assert.throws(
    () => collectTargets({ targets: [target], items: [] }),
    /Target must be a Git repository root/,
  );
});

test("target collection accepts a repository root", (t) => {
  const target = createRepositoryFixture();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  assert.deepEqual(
    collectTargets({ targets: [target], items: [] }),
    [path.resolve(target)],
  );
});

test("target collection reads and deduplicates a targets file", (t) => {
  const target = createRepositoryFixture();
  const targetsFile = path.join(target, "targets.json");
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  fs.writeFileSync(
    targetsFile,
    JSON.stringify({ targets: [target] }),
    "utf8",
  );

  assert.deepEqual(
    collectTargets({ targets: [target], items: [], targetsFile }),
    [path.resolve(target)],
  );
});

test("path resolution rejects traversal outside the approved root", () => {
  const root = path.resolve(os.tmpdir(), "approved-root");

  assert.throws(
    () => resolveWithin(root, path.join("..", "escape.txt"), "destination"),
    /destination must stay within/,
  );
});

test("path guards validate empty, absolute, missing, and outside paths", (t) => {
  const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-paths-"));
  t.after(() => fs.rmSync(approvedRoot, { recursive: true, force: true }));

  assert.doesNotThrow(() =>
    assertNoSymlinkSegments(
      approvedRoot,
      path.join(approvedRoot, "missing", "file.md"),
      "destination",
    ),
  );
  assert.throws(
    () =>
      assertNoSymlinkSegments(approvedRoot, path.join(approvedRoot, ".."), "destination"),
    /destination must stay within/,
  );
  assert.throws(
    () => resolveWithin(approvedRoot, "", "destination"),
    /destination must be a non-empty relative path/,
  );
  assert.throws(
    () => resolveWithin(approvedRoot, path.resolve(approvedRoot, "file.md"), "destination"),
    /destination must be relative/,
  );
});

test("path guard rejects junction or symlink segments", (t) => {
  const approvedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-approved-"),
  );
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-outside-"),
  );
  t.after(() => fs.rmSync(approvedRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  const linkedDirectory = path.join(approvedRoot, ".github");
  fs.symlinkSync(
    outsideRoot,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.throws(
    () =>
      assertNoSymlinkSegments(
        approvedRoot,
        path.join(linkedDirectory, "copilot-instructions.md"),
        "destination",
      ),
    /destination cannot include a symbolic link or junction/,
  );
});

test("argument parsing rejects a missing option value", () => {
  assert.throws(() => parseArgs(["--target"]), /--target requires a value/);
});

test("argument parsing handles supported options and rejects unknown options", () => {
  const target = path.resolve("repo");
  const options = parseArgs([
    "--target",
    target,
    "--targets-file",
    "targets.json",
    "--item",
    "code-review",
    "--write",
    "--replace",
    "--help",
  ]);

  assert.deepEqual(options, {
    targets: [target],
    items: ["code-review"],
    write: true,
    replace: true,
    targetsFile: "targets.json",
    help: true,
  });
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/);
});

test("main handles help, dry run, create, idempotence, and replace preview", (t) => {
  const target = createRepositoryFixture();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const destination = path.join(target, ".github", "copilot-instructions.md");

  const helpOutput = runMain(["--help"]);
  assert.match(helpOutput, /Usage:/);

  const dryRunOutput = runMain([
    "--target",
    target,
    "--item",
    "main-instructions",
  ]);
  assert.match(dryRunOutput, /DRY RUN[\s\S]*CREATE/);
  assert.equal(fs.existsSync(destination), false);

  const createdOutput = runMain([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--write",
  ]);
  assert.match(createdOutput, /WRITE MODE[\s\S]*CREATE/);
  assert.equal(fs.existsSync(destination), true);

  const unchangedOutput = runMain([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--write",
  ]);
  assert.match(unchangedOutput, /OK     \.github/);

  fs.writeFileSync(destination, "target override\n", "utf8");
  const previewOutput = runMain([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--replace",
  ]);
  assert.match(previewOutput, /WOULD  replace after explicit --write --replace/);
  assert.equal(fs.readFileSync(destination, "utf8"), "target override\n");
});

test("CLI preserves a conflicting target file unless replace is explicit", (t) => {
  const target = createRepositoryFixture();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  const destination = path.join(target, ".github", "copilot-instructions.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "target override\n", "utf8");

  const preserved = runSync([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--write",
  ]);
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.match(preserved.stdout, /SKIP   preserved existing target override/);
  assert.equal(fs.readFileSync(destination, "utf8"), "target override\n");

  const replaced = runSync([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--write",
    "--replace",
  ]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, /WRITE  replaced after explicit --replace/);
  assert.match(fs.readFileSync(destination, "utf8"), /Template status/);
});
