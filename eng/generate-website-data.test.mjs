import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractTitle,
  formatDisplayName,
  generateExtensionsData,
  generateSearchIndex,
  getImageMimeType,
  hasExtensionEntryPoint,
  joinRepoPath,
  normalizeAuthor,
  normalizeRepoRelativePath,
  pickAssetFile,
} from "./generate-website-data.mjs";

test("formatDisplayName preserves known acronyms and title-cases words", () => {
  assert.equal(formatDisplayName("mcp-cli-ui_helper"), "MCP CLI UI Helper");
  assert.equal(formatDisplayName("vscode-json-api"), "VS Code JSON API");
});

test("extractTitle uses frontmatter name or strips resource suffixes from filename", () => {
  assert.equal(
    extractTitle("/repo/agents/ignored.agent.md", { name: "custom-reviewer" }),
    "Custom Reviewer",
  );
  assert.equal(
    extractTitle("/repo/instructions/typescript-strict.instructions.md", null),
    "Typescript Strict",
  );
});

test("normalizeAuthor, normalizeRepoRelativePath, and joinRepoPath normalize metadata inputs", () => {
  assert.equal(normalizeAuthor(null), null);
  assert.equal(normalizeAuthor("   "), null);
  assert.deepEqual(normalizeAuthor("  Ada Lovelace "), { name: "Ada Lovelace" });
  assert.deepEqual(
    normalizeAuthor({ name: "Ada", url: " https://example.com/ada " }),
    { name: "Ada", url: "https://example.com/ada" },
  );
  assert.equal(normalizeAuthor({ url: "https://example.com" }), null);

  assert.equal(normalizeRepoRelativePath("/"), "");
  assert.equal(normalizeRepoRelativePath(" /plugins\\demo/ "), "plugins/demo");
  assert.equal(joinRepoPath("plugins/demo/", "/assets/preview.png"), "plugins/demo/assets/preview.png");
});

test("getImageMimeType, pickAssetFile, and hasExtensionEntryPoint inspect extension assets", (t) => {
  assert.equal(getImageMimeType("preview.PNG"), "image/png");
  assert.equal(getImageMimeType("photo.webp"), "image/webp");
  assert.equal(getImageMimeType("archive.bin"), "application/octet-stream");

  assert.equal(
    pickAssetFile(["z-shot.png", "Preview.png", "a-other.png"], ["icon.png", "preview.png"]),
    "Preview.png",
  );
  assert.equal(pickAssetFile(["first.png", "second.png"], ["icon.png"]), "first.png");
  assert.equal(pickAssetFile([], ["icon.png"]), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-web-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const nestedExt = path.join(root, "focus-board");
  assert.equal(hasExtensionEntryPoint(nestedExt, "focus-board"), false);

  fs.mkdirSync(path.join(nestedExt, "extensions", "focus-board"), { recursive: true });
  fs.writeFileSync(
    path.join(nestedExt, "extensions", "focus-board", "extension.mjs"),
    "export default {};\n",
    "utf8",
  );
  assert.equal(hasExtensionEntryPoint(nestedExt, "focus-board"), true);
});

test("generateExtensionsData and generateSearchIndex build deduplicated filters and unified search entries", () => {
  const extensionsData = generateExtensionsData({
    items: [
      { id: "one", keywords: ["dashboard", "canvas"] },
      { id: "two", keywords: ["canvas", "metrics"], screenshots: { icon: "i.png", gallery: null } },
    ],
  });
  assert.deepEqual(extensionsData.filters.keywords, ["canvas", "dashboard", "metrics"]);
  assert.deepEqual(extensionsData.items[0].screenshots, { icon: null, gallery: null });

  const searchIndex = generateSearchIndex(
    [
      {
        id: "planner",
        title: "Planner",
        description: "Creates plans",
        path: "agents/planner.agent.md",
        tools: ["codebase"],
        lastUpdated: "2026-01-01T00:00:00Z",
      },
    ],
    [
      {
        id: "rust",
        title: "Rust Rules",
        description: "Ownership checks",
        path: "instructions/rust.instructions.md",
        applyTo: "**/*.rs",
        lastUpdated: "2026-01-02T00:00:00Z",
      },
    ],
    [
      {
        id: "triage",
        title: "Triage",
        description: "Bug triage workflow",
        skillFile: "skills/triage/SKILL.md",
        searchText: "triage bug triage workflow",
        lastUpdated: "2026-01-03T00:00:00Z",
      },
    ],
    [
      {
        id: "dev-pack",
        name: "Dev Pack",
        description: "Bundled helpers",
        path: "plugins/dev-pack",
        tags: ["productivity"],
        searchText: "dev pack bundled helpers productivity",
        lastUpdated: "2026-01-04T00:00:00Z",
      },
    ],
  );

  assert.equal(searchIndex.length, 4);
  assert.deepEqual(
    searchIndex.map((entry) => entry.type),
    ["agent", "instruction", "skill", "plugin"],
  );
  assert.equal(searchIndex[0].searchText, "planner creates plans codebase");
  assert.equal(searchIndex[1].searchText, "rust rules ownership checks **/*.rs");
});
