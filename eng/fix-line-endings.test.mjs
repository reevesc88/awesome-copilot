import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fix-line-endings.sh",
);

test("fix-line-endings.sh converts CRLF markdown files to LF and skips node_modules", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-crlf-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const docPath = path.join(tempDir, "guide.md");
  const ignoredPath = path.join(tempDir, "node_modules", "pkg", "README.md");
  const nonMdPath = path.join(tempDir, "notes.txt");

  fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
  fs.writeFileSync(docPath, "# Heading\r\n\r\nLine two\r\n", "utf8");
  fs.writeFileSync(ignoredPath, "Keep CRLF\r\n", "utf8");
  fs.writeFileSync(nonMdPath, "Keep CRLF\r\n", "utf8");

  execFileSync("bash", [SCRIPT_PATH, tempDir], { stdio: "pipe" });

  assert.equal(fs.readFileSync(docPath, "utf8"), "# Heading\n\nLine two\n");
  assert.equal(fs.readFileSync(ignoredPath, "utf8"), "Keep CRLF\r\n");
  assert.equal(fs.readFileSync(nonMdPath, "utf8"), "Keep CRLF\r\n");
});
