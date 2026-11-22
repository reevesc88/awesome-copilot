import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildExternalRepoImageUrl,
  buildExternalRepoTreeUrl,
  buildResourceIndex,
  extractCanvasMetadataFromSource,
  extractExtensionFromPattern,
  extractTitle,
  formatDisplayName,
  generateExtensionsData,
  generateSearchIndex,
  getDirectoryLastUpdated,
  getImageMimeType,
  hasExtensionEntryPoint,
  joinRepoPath,
  normalizeAuthor,
  normalizeExtensionScreenshotRole,
  normalizeRepoRelativePath,
  parseApplyToPatterns,
  pickAssetFile,
  pluginItemCandidateId,
  resolvePluginItem,
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

test("parseApplyToPatterns and extractExtensionFromPattern parse glob strings, arrays, and brace groups", () => {
  assert.deepEqual(parseApplyToPatterns(null), []);
  assert.deepEqual(parseApplyToPatterns(" **/*.ts, src/**/*.tsx , "), ["**/*.ts", "src/**/*.tsx"]);
  assert.deepEqual(parseApplyToPatterns([" *.py ", "", "Dockerfile"]), ["*.py", "Dockerfile"]);

  assert.equal(extractExtensionFromPattern("**/*.ts"), ".ts");
  assert.deepEqual(extractExtensionFromPattern("**/*.{js, mjs, cjs}"), [".js", ".mjs", ".cjs"]);
  assert.equal(extractExtensionFromPattern("Dockerfile"), null);
});

test("extractCanvasMetadataFromSource resolves constants and ignores braces inside strings and templates", () => {
  const source = `
    const BOARD_ID = "sprint-board";
    const BOARD_DESC = \`Interactive {kanban} board\`;
    export function activate(ctx) {
      ctx.createCanvas({
        id: BOARD_ID,
        displayName: 'Sprint " Alpha } Board',
        description: BOARD_DESC,
        render() { return { ok: true }; }
      });
      ctx.createCanvas({
        id: "metrics-pane",
        displayName: "Metrics Pane",
        description: "Live metrics"
      });
    }
  `;

  assert.deepEqual(extractCanvasMetadataFromSource(source), [
    {
      id: "sprint-board",
      displayName: 'Sprint " Alpha } Board',
      description: "Interactive {kanban} board",
    },
    {
      id: "metrics-pane",
      displayName: "Metrics Pane",
      description: "Live metrics",
    },
  ]);
});

test("buildResourceIndex, pluginItemCandidateId, resolvePluginItem, and URL/date helpers link plugin items", () => {
  assert.equal(pluginItemCandidateId("./agents/code-reviewer.agent.md"), "code-reviewer");
  assert.equal(pluginItemCandidateId("./skills/triage-helper/"), "triage-helper");

  const index = buildResourceIndex({
    agents: [{ id: "code-reviewer", title: "Code Reviewer" }],
    skills: [{ id: "triage-helper", title: "Triage Helper" }],
    instructions: [{ id: "ts-strict", title: "TS Strict" }],
    extensions: [{ id: "focus-canvas", extensionId: "daily-focus", name: "Focus Canvas" }],
  });

  assert.deepEqual(
    resolvePluginItem({ kind: "agent", path: "./agents/code-reviewer.md" }, index),
    {
      kind: "agent",
      path: "./agents/code-reviewer.md",
      title: "Code Reviewer",
      detailUrl: "/agent/code-reviewer/",
    },
  );
  assert.deepEqual(
    resolvePluginItem({ kind: "extension", path: "extensions/daily-focus" }, index),
    {
      kind: "extension",
      path: "extensions/daily-focus",
      title: "Focus Canvas",
      detailUrl: "/extension/focus-canvas/",
    },
  );
  assert.deepEqual(
    resolvePluginItem({ kind: "skill", path: "./skills/unknown-skill/" }, index),
    {
      kind: "skill",
      path: "./skills/unknown-skill/",
      title: "unknown-skill",
      detailUrl: null,
    },
  );

  const gitDates = new Map([
    ["plugins/demo/README.md", "2026-01-05T00:00:00Z"],
    ["plugins/demo/plugin.json", "2026-02-20T00:00:00Z"],
    ["plugins/other/plugin.json", "2026-03-10T00:00:00Z"],
  ]);
  assert.equal(getDirectoryLastUpdated(gitDates, "plugins/demo"), "2026-02-20T00:00:00Z");
  assert.equal(getDirectoryLastUpdated(gitDates, "plugins/missing"), null);

  assert.equal(
    buildExternalRepoImageUrl("octo/pack", "v1.0.0", "assets/preview.png"),
    "https://raw.githubusercontent.com/octo/pack/v1.0.0/assets/preview.png",
  );
  assert.equal(
    buildExternalRepoTreeUrl("octo/pack", "v1.0.0", "plugins/sub"),
    "https://github.com/octo/pack/tree/v1.0.0/plugins/sub",
  );
  assert.deepEqual(
    normalizeExtensionScreenshotRole("assets/preview.png", "extensions/board", "main"),
    {
      path: "extensions/board/assets/preview.png",
      type: "image/png",
      imageUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/extensions/board/assets/preview.png",
    },
  );
});
