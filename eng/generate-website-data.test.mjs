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
  generateAgentsData,
  generateCanvasManifest,
  generateExtensionsData,
  generateInstructionsData,
  generatePluginsData,
  generateSamplesData,
  generateSearchIndex,
  generateSkillsData,
  getDirectoryLastUpdated,
  getExtensionAssetInfo,
  getImageMimeType,
  hasExtensionEntryPoint,
  joinRepoPath,
  normalizeAuthor,
  normalizeExtensionScreenshotRole,
  normalizeExternalScreenshotRole,
  normalizeRepoRelativePath,
  parseApplyToPatterns,
  pickAssetFile,
  pluginItemCandidateId,
  resolveExtensionScreenshots,
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
  assert.deepEqual(parseApplyToPatterns("**/*.{ts,tsx}, **/vite.config.*"), [
    "**/*.{ts,tsx}",
    "**/vite.config.*",
  ]);
  assert.deepEqual(parseApplyToPatterns([" *.py ", "", "Dockerfile"]), ["*.py", "Dockerfile"]);

  assert.equal(extractExtensionFromPattern("**/*.ts"), ".ts");
  assert.deepEqual(extractExtensionFromPattern("**/*.{js, mjs, cjs}"), [".js", ".mjs", ".cjs"]);
  assert.equal(extractExtensionFromPattern("Dockerfile"), null);
});

test("extractCanvasMetadataFromSource handles commas in strings, multiline values, single-line objects, and ignores nested keys", () => {
  const source = `
    const BOARD_ID = "sprint-board";
    const BOARD_DESC = \`Interactive {kanban} board\`;
    export function activate(ctx) {
      ctx.createCanvas({
        // Leading comment
        id: BOARD_ID,
        displayName: 'Sprint " Alpha } Board',
        description:
          "Track branch, commits, and PRs without losing context.",
        actions: [
          { name: "refresh", description: "Nested action description" }
        ],
        render() { return { id: "nested-id", ok: true }; }
      });
      ctx.createCanvas({ id: "metrics-pane", "displayName": "Metrics, Live" });
      ctx.createCanvas({
        id: "no-top-desc",
        actions: [{ name: "ping", description: "Should not leak to canvas" }],
        displayName: BOARD_DESC
      });
    }
  `;

  assert.deepEqual(extractCanvasMetadataFromSource(source), [
    {
      id: "sprint-board",
      displayName: 'Sprint " Alpha } Board',
      description: "Track branch, commits, and PRs without losing context.",
    },
    {
      id: "metrics-pane",
      displayName: "Metrics, Live",
      description: null,
    },
    {
      id: "no-top-desc",
      displayName: "Interactive {kanban} board",
      description: null,
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
  assert.deepEqual(
    normalizeExtensionScreenshotRole(
      { path: "./assets/icon.webp", url: "https://cdn.example.com/icon.webp" },
      "extensions/board",
      "abc123",
    ),
    {
      path: "extensions/board/assets/icon.webp",
      type: "image/webp",
      imageUrl: "https://cdn.example.com/icon.webp",
    },
  );
  assert.deepEqual(
    normalizeExternalScreenshotRole({ path: "assets/shot.jpg" }, "main"),
    {
      path: "assets/shot.jpg",
      type: "image/jpeg",
      imageUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/assets/shot.jpg",
    },
  );
  assert.equal(normalizeExternalScreenshotRole({}, "main"), null);
  assert.equal(buildExternalRepoImageUrl("", "v1.0.0", "a.png"), null);
  assert.equal(buildExternalRepoTreeUrl("octo/pack", "", ""), "https://github.com/octo/pack");
  assert.equal(buildExternalRepoTreeUrl("", "v1.0.0", ""), null);
});

test("generateAgentsData, generateInstructionsData, and generateSkillsData extract metadata and filter facets from fixtures", (t) => {
  const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-web-resources-"));
  t.after(() => fs.rmSync(rootFolder, { recursive: true, force: true }));

  const agentsDir = path.join(rootFolder, "agents");
  const instructionsDir = path.join(rootFolder, "instructions");
  const skillsDir = path.join(rootFolder, "skills");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(instructionsDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "audit-helper", "scripts"), { recursive: true });

  fs.writeFileSync(
    path.join(agentsDir, "architect.agent.md"),
    [
      "---",
      "name: 'system-architect'",
      "description: 'Designs systems'",
      "model: 'gpt-5'",
      "tools:",
      "  - codebase",
      "  - search",
      "handoffs:",
      "  - label: 'Implement'",
      "    agent: 'coder'",
      "mcp-servers:",
      "  github:",
      "    type: http",
      "    url: https://example.com/mcp",
      "---",
      "# Architect",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(instructionsDir, "web.instructions.md"),
    [
      "---",
      "description: 'Frontend standards'",
      "applyTo: '**/*.{ts,tsx}, **/*.ts'",
      "---",
      "# Web",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(skillsDir, "audit-helper", "SKILL.md"),
    [
      "---",
      "name: audit-helper",
      "description: 'Runs offline audits on manifests'",
      "---",
      "# Audit Helper",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(skillsDir, "audit-helper", "scripts", "check.mjs"), "export {};\n", "utf8");

  const gitDates = new Map([
    ["agents/architect.agent.md", "2026-04-01T00:00:00Z"],
    ["instructions/web.instructions.md", "2026-04-02T00:00:00Z"],
    ["skills/audit-helper/SKILL.md", "2026-04-03T00:00:00Z"],
  ]);

  const agentsData = generateAgentsData(gitDates, { agentsDir, rootFolder });
  assert.equal(agentsData.items.length, 1);
  assert.equal(agentsData.items[0].title, "System Architect");
  assert.equal(agentsData.items[0].hasHandoffs, true);
  assert.deepEqual(agentsData.items[0].mcpServers, ["github"]);
  assert.deepEqual(agentsData.filters.models, ["(none)", "gpt-5"]);
  assert.deepEqual(agentsData.filters.tools, ["codebase", "search"]);

  const instructionsData = generateInstructionsData(gitDates, { instructionsDir, rootFolder });
  assert.equal(instructionsData.items.length, 1);
  assert.deepEqual(instructionsData.items[0].extensions, [".ts", ".tsx"]);
  assert.deepEqual(instructionsData.filters.extensions, ["(none)", ".ts", ".tsx"]);

  const skillsData = generateSkillsData(gitDates, { skillsDir, rootFolder });
  assert.equal(skillsData.items.length, 1);
  assert.equal(skillsData.items[0].hasAssets, true);
  assert.equal(skillsData.items[0].assetCount, 1);
  assert.equal(skillsData.items[0].files.length, 2);
  assert.equal(skillsData.items[0].lastUpdated, "2026-04-03T00:00:00Z");

  // Missing directories return empty shapes cleanly
  assert.deepEqual(generateSkillsData(gitDates, { skillsDir: path.join(rootFolder, "none"), rootFolder }).items, []);
});

test("generatePluginsData, generateCanvasManifest, and generateSamplesData assemble local and external resources", (t) => {
  const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-web-catalog-"));
  t.after(() => fs.rmSync(rootFolder, { recursive: true, force: true }));

  const pluginsDir = path.join(rootFolder, "plugins");
  const extensionsDir = path.join(rootFolder, "extensions");
  const cookbookDir = path.join(rootFolder, "cookbook");

  // Local canvas extension + owning plugin + MCP config + agent subfolder
  const extDir = path.join(extensionsDir, "focus-pane");
  fs.mkdirSync(path.join(extDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "assets", "preview.png"), "png", "utf8");
  fs.writeFileSync(path.join(extDir, "README.md"), "# Focus Pane\n", "utf8");
  fs.writeFileSync(
    path.join(extDir, "extension.mjs"),
    `export const c = createCanvas({ id: "focus-pane", displayName: "Focus Pane", description: "Track tasks, notes, and timers" });\n`,
    "utf8",
  );

  const pluginDir = path.join(pluginsDir, "focus-pane");
  fs.mkdirSync(path.join(pluginDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "README.md"), "# Focus Plugin\n", "utf8");
  fs.writeFileSync(path.join(pluginDir, "agents", "coach.md"), "# Coach\n", "utf8");
  fs.writeFileSync(
    path.join(pluginDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { tracker: { command: "node" } } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      name: "focus-pane",
      description: "Focus workflow bundle",
      version: "1.4.0",
      author: { name: "Builder", url: "https://github.com/builder" },
      keywords: ["productivity", "canvas"],
      extensions: {
        "com.github.copilot": { logo: "assets/preview.png" },
        "com.github.awesome-copilot": {
          agents: ["./agents"],
          skills: ["./skills/triage/"],
          mcpServers: "./.mcp.json",
        },
      },
    }),
    "utf8",
  );

  // External extensions & external plugins (including duplicate local collision and external canvas plugin)
  fs.writeFileSync(
    path.join(extensionsDir, "external.json"),
    JSON.stringify([
      { name: "Missing Install Url" },
      {
        id: "remote-board",
        name: "Remote Board",
        installUrl: "https://github.com/example/remote-board",
        tags: ["remote"],
        iconPath: "assets/icon.png",
      },
    ]),
    "utf8",
  );

  const externalPluginsFile = path.join(pluginsDir, "external.json");
  fs.writeFileSync(
    externalPluginsFile,
    JSON.stringify([
      {
        name: "focus-pane",
        description: "Collides with local plugin in generatePluginsData",
        version: "1.0.0",
        author: { name: "Dup" },
        repository: "https://github.com/example/dup",
        keywords: ["productivity"],
        source: { source: "github", repo: "example/dup", ref: "v1.0.0" },
      },
      {
        name: "ext-canvas-pack",
        description: "External canvas plugin",
        version: "2.0.0",
        author: { name: "Ext Author" },
        repository: "https://github.com/example/ext-canvas-pack",
        keywords: ["canvas", "visual"],
        source: {
          source: "github",
          repo: "example/ext-canvas-pack",
          path: "packages/pack",
          sha: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    ]),
    "utf8",
  );

  // Asset helper check
  const assetInfo = getExtensionAssetInfo(extDir, "extensions/focus-pane", "deadbeef");
  assert.equal(assetInfo.assetPath, "extensions/focus-pane/assets/preview.png");
  const resolvedShots = resolveExtensionScreenshots({}, extDir, "extensions/focus-pane", "deadbeef");
  assert.equal(resolvedShots.screenshots.icon.type, "image/png");

  const gitDates = new Map([["extensions/focus-pane/extension.mjs", "2026-05-01T00:00:00Z"]]);
  const canvasManifest = generateCanvasManifest(gitDates, "deadbeef", {
    extensionsDir,
    pluginsDir,
    externalPluginsFile,
  });
  assert.deepEqual(
    canvasManifest.items.map((item) => item.id),
    ["ext-canvas-pack", "focus-pane", "remote-board"],
  );
  const extCanvas = canvasManifest.items.find((item) => item.id === "ext-canvas-pack");
  assert.equal(
    extCanvas.imageUrl,
    "https://raw.githubusercontent.com/example/ext-canvas-pack/0123456789abcdef0123456789abcdef01234567/packages/pack/assets/preview.png",
  );

  const resourceIndex = buildResourceIndex({
    agents: [{ id: "coach", title: "Coach Agent" }],
    skills: [{ id: "triage", title: "Triage Skill" }],
    instructions: [],
    extensions: canvasManifest.items,
  });
  const pluginsData = generatePluginsData(gitDates, resourceIndex, { pluginsDir, extensionsDir });
  assert.deepEqual(
    pluginsData.items.map((p) => p.id),
    ["ext-canvas-pack", "focus-pane"],
  );
  const localPlugin = pluginsData.items.find((p) => p.id === "focus-pane");
  assert.equal(localPlugin.itemCount, 4);
  assert.ok(localPlugin.items.some((i) => i.kind === "mcp" && i.title === "tracker"));
  assert.ok(localPlugin.items.some((i) => i.kind === "agent" && i.detailUrl === "/agent/coach/"));

  // Cookbook / samples fixture (local + external recipes)
  const pyDocDir = path.join(rootFolder, "cookbook", "copilot-sdk", "python");
  fs.mkdirSync(path.join(pyDocDir, "recipe"), { recursive: true });
  fs.writeFileSync(path.join(pyDocDir, "streaming.md"), "# Streaming\n", "utf8");
  fs.writeFileSync(path.join(pyDocDir, "recipe", "streaming.py"), "print('ok')\n", "utf8");
  fs.writeFileSync(
    path.join(cookbookDir, "cookbook.yml"),
    [
      "cookbooks:",
      "  - id: copilot-sdk",
      "    name: Copilot SDK",
      "    description: SDK recipes",
      "    path: cookbook/copilot-sdk",
      "    featured: true",
      "    languages:",
      "      - id: python",
      "        name: Python",
      "        extension: .py",
      "      - id: nodejs",
      "        name: Node.js",
      "        extension: .ts",
      "    recipes:",
      "      - id: streaming",
      "        name: Streaming Responses",
      "        description: Stream tokens",
      "        tags: [streaming, python]",
      "      - id: external-demo",
      "        name: External Demo",
      "        description: Hosted sample",
      "        external: true",
      "        url: https://github.com/example/sample",
      "        tags: [nodejs, external]",
    ].join("\n"),
    "utf8",
  );

  const samplesData = generateSamplesData({ cookbookDir, rootFolder });
  assert.equal(samplesData.totalCookbooks, 1);
  assert.equal(samplesData.totalRecipes, 2);
  assert.deepEqual(samplesData.cookbooks[0].recipes[0].languages, ["python"]);
  assert.equal(
    samplesData.cookbooks[0].recipes[0].variants.python.example,
    "cookbook/copilot-sdk/python/recipe/streaming.py",
  );
  assert.deepEqual(samplesData.cookbooks[0].recipes[1].languages, ["nodejs"]);
  assert.equal(samplesData.cookbooks[0].recipes[1].external, true);
});
