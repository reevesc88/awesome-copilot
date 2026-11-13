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
import { parseFrontmatter } from "./yaml-parser.mjs";

const inventory = JSON.parse(
  fs.readFileSync(
    new URL("../personal/reevesc88/inventory.json", import.meta.url),
    "utf8",
  ),
);
const syncScriptPath = fileURLToPath(
  new URL("../personal/reevesc88/scripts/sync-copilot-config.mjs", import.meta.url),
);

const dependencySecurityWorkflowPath = fileURLToPath(
  new URL(
    "../personal/reevesc88/templates/repository/.github/workflows/dependency-security-review.md",
    import.meta.url,
  ),
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
  assert.ok(!items.some((item) => item.id === "sync-copilot-config"));
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

test("CLI write rejects a junctioned .github and leaves outside unchanged", (t) => {
  const target = createRepositoryFixture();
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awesome-copilot-cli-outside-"),
  );
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  fs.symlinkSync(
    outsideRoot,
    path.join(target, ".github"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = runSync([
    "--target",
    target,
    "--item",
    "main-instructions",
    "--write",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot include a symbolic link or junction/i);
  assert.equal(
    fs.existsSync(path.join(outsideRoot, "copilot-instructions.md")),
    false,
  );
});

test("dependency security workflow exposes its promised alert sources", () => {
  const frontmatter = parseFrontmatter(dependencySecurityWorkflowPath);

  assert.equal(frontmatter.permissions["security-events"], "read");
  assert.equal(frontmatter.permissions["vulnerability-alerts"], "read");
  assert.deepEqual(
    ["dependabot", "code_security"].filter(
      (toolset) => !frontmatter.tools.github.toolsets.includes(toolset),
    ),
    [],
  );
  // Its output is a normal issue, so secret-scanning data must never feed it.
  assert.equal(frontmatter.tools.github.toolsets.includes("secret_protection"), false);
  const body = fs.readFileSync(dependencySecurityWorkflowPath, "utf8");
  assert.match(body, /counts, alert types, severities, and links only/);
  assert.match(body, /Never copy alert payloads/);
});

test("CI failure summary skips duplicate issues while CI stays red", () => {
  const workflowPath = path.join(
    path.dirname(dependencySecurityWorkflowPath),
    "ci-failure-summary.md",
  );
  const frontmatter = parseFrontmatter(workflowPath);
  assert.equal(frontmatter["safe-outputs"]["create-issue"].max, 1);
  assert.ok(frontmatter.tools.github.toolsets.includes("issues"));
  const body = fs.readFileSync(workflowPath, "utf8");
  assert.match(body, /list the open issues whose title starts with `\[CI Summary\] ` and read their raw markdown bodies/);
  // Cross-run dedup: exact match on a canonical body marker (no hashing; no shell tool).
  assert.equal(frontmatter.tools.bash, undefined);
  assert.match(body, /`<!-- ci-summary-set: <canonical set> -->`/);
  // Lossless canonical set: JSON-encoded pairs, angle brackets escaped, sorted, JSON-array join.
  assert.match(body, /Encode each failing pair as a JSON array of two strings/);
  assert.match(body, /replace every `<` with `\\u003c` and every `>` with `\\u003e`/);
  assert.match(body, /Drop duplicate encoded pairs, sort them by plain character order, and join them with `,` inside one outer `\[` `\]` with no spaces/);
  // Dedup compares the whole wrapped marker line in the raw (unrendered) body.
  assert.match(body, /read their raw markdown bodies \(the API `body` field, not rendered text/);
  assert.match(body, /Build the expected marker line `<!-- ci-summary-set: ` \+ canonical set \+ ` -->`/);
  assert.match(body, /has a line exactly equal to that whole marker line, on any date/);
  assert.doesNotMatch(body, /join them with `; `/);
  assert.doesNotMatch(body, /line is exactly equal to the current canonical set/);
  assert.match(body, /Never compare titles, prefixes, partial lists or the payload without its wrapper/);
  assert.doesNotMatch(body, /SHA-256|set:<digest>|\(\+N more\)/);
  assert.doesNotMatch(body, /same UTC day or for the same set of failing workflows and jobs, stop/);
});

test("sync-copilot-config skill points at the control-repository script and inventory", () => {
  const skillPath = new URL(
    "../personal/reevesc88/templates/repository/.github/skills/sync-copilot-config/SKILL.md",
    import.meta.url,
  );
  const item = inventory.items.find((entry) => entry.id === "sync-copilot-config");
  assert.ok(item);
  assert.equal(item.scope, "control-repo");
  assert.equal(item.installByDefault, false);
  const body = fs.readFileSync(skillPath, "utf8");
  assert.match(body, /control-repo-only/i);
  assert.match(body, /personal\/reevesc88\/scripts\/sync-copilot-config\.mjs/);
  assert.match(body, /personal\/reevesc88\/inventory\.json/);
  assert.match(body, /not installed into target repositories/);
  assert.match(body, /never selected by the default sync profile/);
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

test("dry-run diff does not echo target or template file contents", (t) => {
  const target = createRepositoryFixture();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const destination = path.join(target, ".github", "copilot-instructions.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "token=do-not-log-this\n", "utf8");

  const output = runMain([
    "--target",
    target,
    "--item",
    "main-instructions",
  ]);

  assert.match(output, /DIFF[\s\S]*line 1 differs/);
  assert.doesNotMatch(output, /do-not-log-this/);
  assert.doesNotMatch(output, /Template status/);
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

test("INVENTORY.md default-profile summary matches inventory.json", () => {
  const defaults = inventory.items.filter((entry) => entry.installByDefault);
  const count = (kind) => defaults.filter((entry) => entry.kind === kind).length;
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const md = fs.readFileSync(new URL("../personal/reevesc88/INVENTORY.md", import.meta.url), "utf8");
  const expected = `The default profile contains ${defaults.length} ready, portable items: ${words[count("agent-template")]} agents, ${words[count("instruction-template")]} topic instructions, ${words[count("prompt-template")]} prompts, and ${words[count("skill-template")]} skills.`;
  assert.ok(md.includes(expected), `INVENTORY.md should say: ${expected}`);
});
