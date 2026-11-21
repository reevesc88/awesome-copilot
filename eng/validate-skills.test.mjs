import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  validateSkillDescription,
  validateSkillFolder,
  validateSkillName,
  validateSkills,
} from "./validate-skills.mjs";

function makeTempDir(t, prefix = "awesome-copilot-skills-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(skillsRoot, folderName, { name = folderName, description = "A clear and concise skill description." } = {}) {
  const folderPath = path.join(skillsRoot, folderName);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(
    path.join(folderPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: '${description}'\n---\n\n# ${folderName}\n`,
    "utf8",
  );
  return folderPath;
}

test("validateSkillName enforces lowercase alphanumeric-and-hyphen bounds", () => {
  assert.equal(validateSkillName("valid-skill-1"), null);
  assert.equal(validateSkillName("a"), null);
  assert.equal(validateSkillName("a".repeat(64)), null);

  assert.match(validateSkillName(""), /required/);
  assert.match(validateSkillName(null), /required/);
  assert.match(validateSkillName("UpperCase"), /lowercase/);
  assert.match(validateSkillName("under_score"), /lowercase/);
  assert.match(validateSkillName("a".repeat(65)), /between 1 and 64/);
});

test("validateSkillDescription enforces 10 to 1024 character bounds", () => {
  assert.equal(validateSkillDescription("0123456789"), null);
  assert.equal(validateSkillDescription("x".repeat(1024)), null);

  assert.match(validateSkillDescription(""), /required/);
  assert.match(validateSkillDescription("too short"), /at least 10/);
  assert.match(validateSkillDescription("x".repeat(1025)), /not exceed 1024/);
});

test("validateSkillFolder accepts a valid skill with small bundled assets", (t) => {
  const root = makeTempDir(t);
  const folderPath = writeSkill(root, "lint-helper");
  fs.mkdirSync(path.join(folderPath, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(folderPath, "scripts", "run.mjs"), "export default 1;\n", "utf8");

  assert.deepEqual(validateSkillFolder(folderPath, "lint-helper"), []);
});

test("validateSkillFolder reports missing SKILL.md, folder mismatch, and oversized assets", (t) => {
  const root = makeTempDir(t);

  const emptyFolder = path.join(root, "empty-skill");
  fs.mkdirSync(emptyFolder, { recursive: true });
  assert.deepEqual(validateSkillFolder(emptyFolder, "empty-skill"), ["Missing SKILL.md file"]);

  const mismatchFolder = writeSkill(root, "folder-a", {
    name: "folder-b",
    description: "Valid description with mismatched name",
  });
  const mismatchErrors = validateSkillFolder(mismatchFolder, "folder-a");
  assert.ok(mismatchErrors.some((err) => err.includes('Folder name "folder-a" does not match skill name "folder-b"')));

  const oversizedFolder = writeSkill(root, "oversized-skill");
  fs.mkdirSync(path.join(oversizedFolder, "assets"), { recursive: true });
  const largeAsset = path.join(oversizedFolder, "assets", "large.bin");
  fs.writeFileSync(largeAsset, Buffer.alloc(5 * 1024 * 1024 + 1024));
  const sizeErrors = validateSkillFolder(oversizedFolder, "oversized-skill");
  assert.ok(sizeErrors.some((err) => err.includes('Bundled asset "assets/large.bin" exceeds maximum size of 5MB')));

  fs.mkdirSync(path.join(oversizedFolder, "examples", "nested"), { recursive: true });
  fs.writeFileSync(path.join(oversizedFolder, "examples", "nested", "large.bin"), Buffer.alloc(5 * 1024 * 1024 + 1024));
  const exampleErrors = validateSkillFolder(oversizedFolder, "oversized-skill");
  assert.ok(exampleErrors.some((err) => err.includes('Bundled asset "examples/nested/large.bin" exceeds maximum size of 5MB')));
});

test("validateSkills handles missing, empty, valid, and invalid skill roots", (t) => {
  const root = makeTempDir(t);
  assert.equal(validateSkills(path.join(root, "nonexistent")), true);
  assert.equal(validateSkills(root), true);

  writeSkill(root, "alpha-skill");
  writeSkill(root, "beta-skill");
  assert.equal(validateSkills(root), true);

  writeSkill(root, "broken-skill", {
    name: "broken-skill",
    description: "short",
  });
  assert.equal(validateSkills(root), false);
});
