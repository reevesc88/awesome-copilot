import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findMissingInventoryIds,
  main,
  resolveInventoryPath,
  validateControlCenter,
  validateDecisionSections,
} from "./validate-reevesc88-control-center.mjs";

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

test("human inventory coverage reports only undocumented item ids", () => {
  const inventory = {
    items: [{ id: "planner-architect" }, { id: "security-review" }],
  };

  assert.deepEqual(
    findMissingInventoryIds(inventory, "Available: `planner-architect`."),
    ["security-review"],
  );
});

test("overlap audit requires Keep, Adapt, and Reject decisions", () => {
  assert.deepEqual(
    validateDecisionSections("# Audit\n\n## Keep\n\n## Reject\n"),
    ["Adapt"],
  );
  assert.deepEqual(
    validateDecisionSections("# Audit\n\n## Keep\n\n## Adapt\n\n## Reject\n"),
    [],
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

test("validateControlCenter detects inventory, governance, template frontmatter, workflow permission, and link errors", (t) => {
  const { repoRoot, controlRoot, sourceRoot } = createInventoryFixture(t);

  assert.throws(
    () => validateControlCenter({ repoRoot: path.join(repoRoot, "does-not-exist") }),
    /Missing control root/,
  );

  const ghRoot = path.join(sourceRoot, ".github");
  fs.mkdirSync(path.join(ghRoot, "instructions"), { recursive: true });
  fs.mkdirSync(path.join(ghRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(ghRoot, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(ghRoot, "skills", "folder-a"), { recursive: true });
  fs.mkdirSync(path.join(ghRoot, "skills", "no-skill-md"), { recursive: true });
  fs.mkdirSync(path.join(ghRoot, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(controlRoot, "docs"), { recursive: true });

  // Instruction missing applyTo
  const instrRel = "personal/reevesc88/templates/repository/.github/instructions/ts.instructions.md";
  fs.writeFileSync(path.join(repoRoot, instrRel), "---\ndescription: 'TS rules'\n---\n# TS\n", "utf8");

  // Duplicate agent names
  const agent1Rel = "personal/reevesc88/templates/repository/.github/agents/one.md";
  const agent2Rel = "personal/reevesc88/templates/repository/.github/agents/two.md";
  fs.writeFileSync(path.join(repoRoot, agent1Rel), "---\nname: 'Reviewer'\ndescription: 'Desc'\n---\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, agent2Rel), "---\nname: 'Reviewer'\ndescription: 'Desc'\n---\n", "utf8");

  // Prompt with invalid agent mode
  const promptRel = "personal/reevesc88/templates/repository/.github/prompts/fix.prompt.md";
  fs.writeFileSync(
    path.join(repoRoot, promptRel),
    "---\nname: 'fix'\ndescription: 'Fix bug'\nagent: 'invalid-mode'\n---\n",
    "utf8",
  );

  // Skill with folder/name mismatch
  const skillRel = "personal/reevesc88/templates/repository/.github/skills/folder-a/SKILL.md";
  fs.writeFileSync(
    path.join(repoRoot, skillRel),
    "---\nname: 'wrong-skill-name'\ndescription: 'Skill desc'\n---\n",
    "utf8",
  );

  // Workflow missing workflow_dispatch, safe-outputs, timeout-minutes and using write permission
  const wfRel = "personal/reevesc88/templates/repository/.github/workflows/audit.md";
  fs.writeFileSync(
    path.join(repoRoot, wfRel),
    [
      "---",
      "name: 'Audit'",
      "description: 'Audit workflow'",
      "on:",
      "  push: {}",
      "permissions:",
      "  contents: write",
      "---",
      "# Audit",
    ].join("\n"),
    "utf8",
  );

  // Governance docs with missing item ID, missing Adapt section, and broken relative link
  fs.writeFileSync(
    path.join(controlRoot, "INVENTORY.md"),
    "# Inventory\n\nSee [missing](./missing-doc.md#top) and [ok](./AGENTS.md#intro).\n",
    "utf8",
  );
  fs.writeFileSync(path.join(controlRoot, "docs", "ecc-overlap-audit.md"), "# Audit\n\n## Keep\n\n## Reject\n", "utf8");
  // Deliberately omit AGENTS.md to trigger missing governance document + broken link

  fs.writeFileSync(
    path.join(controlRoot, "inventory.json"),
    JSON.stringify({
      sourceRoot: "personal/reevesc88/templates/repository",
      items: [
        {
          id: "bad-customize",
          kind: "instruction-template",
          maturity: "customize-before-enable",
          scope: "control-repo",
          safety: "advisory",
          installByDefault: true,
          source: instrRel,
          destination: "../escape/ts.instructions.md",
        },
        {
          id: "bad-customize",
          kind: "unknown-kind",
          maturity: "unknown-maturity",
          scope: "unknown-scope",
          safety: "unknown-safety",
          installByDefault: "yes",
          source: "personal/reevesc88/templates/repository/.github/missing.md",
          destination: ".github/agents/one.md",
        },
      ],
    }),
    "utf8",
  );

  const result = validateControlCenter({ repoRoot });
  assert.equal(result.valid, false);
  const joined = result.errors.join("\n");
  assert.match(joined, /Customize-before-enable item must be opt-in/);
  assert.match(joined, /Control-repo item must be opt-in/);
  assert.match(joined, /Inventory destination must stay within \.github/);
  assert.match(joined, /Duplicate inventory id: bad-customize/);
  assert.match(joined, /Invalid inventory kind/);
  assert.match(joined, /Inventory source missing or not a file/);
  assert.match(joined, /Template file missing from inventory/);
  assert.match(joined, /Missing governance document: personal\/reevesc88\/AGENTS\.md/);
  assert.match(joined, /Human inventory missing item id: bad-customize/);
  assert.match(joined, /ECC overlap audit missing decision section: Adapt/);
  assert.match(joined, /Missing applyTo/);
  assert.match(joined, /Duplicate agent name: Reviewer/);
  assert.match(joined, /Prompt agent must be one of agent, ask, Plan/);
  assert.match(joined, /Missing SKILL\.md/);
  assert.match(joined, /Skill name\/folder mismatch/);
  assert.match(joined, /Workflow missing workflow_dispatch/);
  assert.match(joined, /Workflow missing safe-outputs/);
  assert.match(joined, /Workflow missing timeout-minutes/);
  assert.match(joined, /Workflow permission must use safe-outputs instead of direct write \(contents: write\)/);
  assert.match(joined, /Broken relative link/);
});
