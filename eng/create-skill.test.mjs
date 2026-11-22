import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSkillTemplate,
  formatYamlSingleQuoted,
  parseArgs,
} from "./create-skill.mjs";
import { validateSkillFolder } from "./validate-skills.mjs";
import { parseSkillMetadata } from "./yaml-parser.mjs";

function makeTempSkillsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-create-skill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseArgs extracts skill name and preserves '=' inside --description=", () => {
  assert.deepEqual(
    parseArgs(["--name=env-parser", "--description=Parse KEY=VALUE pairs safely"]),
    {
      name: "env-parser",
      description: "Parse KEY=VALUE pairs safely",
    },
  );
  assert.deepEqual(
    parseArgs(["-n", "log-triage", "-d", "Inspect structured application logs"]),
    {
      name: "log-triage",
      description: "Inspect structured application logs",
    },
  );
  assert.deepEqual(parseArgs(["positional-skill"]), {
    name: "positional-skill",
    description: undefined,
  });
});

test("formatYamlSingleQuoted wraps text in single quotes and escapes apostrophes", () => {
  assert.equal(
    formatYamlSingleQuoted("Debug Node.js apps: inspect user's heap #1 [fast]"),
    "'Debug Node.js apps: inspect user''s heap #1 [fast]'",
  );
});

test("createSkillTemplate scaffolds SKILL.md whose YAML special characters pass validateSkillFolder", async (t) => {
  const skillsDir = makeTempSkillsDir(t);
  const trickyDescription =
    "Diagnose Node.js errors: parse user's key=value configs, #tags, and [frames]";

  const answers = ["Custom Node Diagnostics", "n"];
  const createdFolder = await createSkillTemplate({
    argv: [`--name=node-diagnostics`, `--description=${trickyDescription}`],
    promptFn: async () => answers.shift() ?? "",
    skillsDir,
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`);
    },
  });

  assert.equal(createdFolder, path.join(skillsDir, "node-diagnostics"));
  const errors = validateSkillFolder(createdFolder, "node-diagnostics");
  assert.deepEqual(errors, []);

  const metadata = parseSkillMetadata(createdFolder);
  assert.equal(metadata.name, "node-diagnostics");
  assert.equal(metadata.description, trickyDescription);
});

test("createSkillTemplate rejects invalid names, out-of-range descriptions, and existing folders", async (t) => {
  const skillsDir = makeTempSkillsDir(t);
  const exitCodes = [];
  const recordExit = (code) => {
    exitCodes.push(code);
    return code;
  };

  // Overlong skill name (>64 chars)
  await createSkillTemplate({
    argv: ["--name", "a".repeat(65), "--description", "Valid description length"],
    promptFn: async () => "",
    skillsDir,
    exit: recordExit,
  });

  // Short description (<10 chars)
  await createSkillTemplate({
    argv: ["--name", "short-desc", "--description", "too short"],
    promptFn: async () => "",
    skillsDir,
    exit: recordExit,
  });

  // Overlong description (>1024 chars)
  await createSkillTemplate({
    argv: ["--name", "long-desc", "--description", "x".repeat(1025)],
    promptFn: async () => "",
    skillsDir,
    exit: recordExit,
  });

  // Duplicate skill folder
  fs.mkdirSync(path.join(skillsDir, "existing-skill"), { recursive: true });
  await createSkillTemplate({
    argv: ["--name", "existing-skill", "--description", "Valid description length"],
    promptFn: async () => "",
    skillsDir,
    exit: recordExit,
  });

  assert.deepEqual(exitCodes, [1, 1, 1, 1]);
});
