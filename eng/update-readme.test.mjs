import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildCategoryReadme,
  extractDescription,
  extractTitle,
  formatTableCell,
  generateAgentsSection,
  generateFeaturedPluginsSection,
  generateHooksSection,
  generateInstructionsSection,
  generateMcpServerLinks,
  generatePluginsSection,
  generateSkillsSection,
  generateWorkflowsSection,
  makeBadges,
  writeFileIfChanged,
} from "./update-readme.mjs";

function makeTempDir(t, prefix = "awesome-copilot-readme-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("extractTitle resolves frontmatter name, post-frontmatter heading outside code blocks, and filename fallback", (t) => {
  const dir = makeTempDir(t);

  const namedAgent = path.join(dir, "custom-file.agent.md");
  fs.writeFileSync(
    namedAgent,
    "---\nname: code-review-helper\ndescription: 'Helps review PRs'\n---\n# Ignored Heading\n",
    "utf8",
  );
  assert.equal(extractTitle(namedAgent), "Code Review Helper");

  const headingInstruction = path.join(dir, "python-style.instructions.md");
  fs.writeFileSync(
    headingInstruction,
    [
      "---",
      "description: 'Python conventions'",
      "---",
      "",
      "```markdown",
      "# Heading Inside Code Fence",
      "```",
      "",
      "# Real Python Guidelines",
    ].join("\n"),
    "utf8",
  );
  assert.equal(extractTitle(headingInstruction), "Real Python Guidelines");
  assert.equal(extractDescription(headingInstruction), "Python conventions");

  const fallbackPrompt = path.join(dir, "triage-open_issues.prompt.md");
  fs.writeFileSync(fallbackPrompt, "---\ndescription: 'No H1 here'\n---\nPlain body.\n", "utf8");
  assert.equal(extractTitle(fallbackPrompt), "Triage Open Issues");
});

test("formatTableCell escapes pipes, normalizes CRLF, and collapses repeated blank lines", () => {
  assert.equal(formatTableCell(null), "");
  assert.equal(formatTableCell(undefined), "");
  assert.equal(
    formatTableCell("  First | cell \r\n\r\n\r\n  Second | line  "),
    "First &#124; cell<br /><br />Second &#124; line",
  );
});

test("makeBadges and generateMcpServerLinks render source/published URLs and registry matches", () => {
  const sourceBadge = makeBadges("agents/demo.agent.md", "agent", "source");
  assert.match(sourceBadge, /install\/agent\?url=/);
  assert.match(sourceBadge, /main%2Fagents%2Fdemo\.agent\.md/);

  const publishedBadge = makeBadges("agents/demo.agent.md", "agent", "published");
  assert.match(publishedBadge, /marketplace%2Fagents%2Fdemo\.agent\.md/);

  const registry = [
    {
      name: "io.example/apify-mcp-server",
      displayName: "apify",
      fullName: "io.example/apify-mcp-server",
    },
  ];
  const links = generateMcpServerLinks(
    [
      { name: "apify", command: "npx", args: ["@apify/mcp"] },
      { name: "custom-http", type: "http", url: "https://mcp.example.com" },
    ],
    registry,
  );
  assert.match(links, /\[apify\]\(https:\/\/github\.com\/mcp\/io\.example\/apify-mcp-server\)/);
  assert.match(links, /custom-http<br \/>/);
});

test("section generators render sorted markdown tables for instructions, agents, hooks, workflows, and skills", (t) => {
  const root = makeTempDir(t);

  // Instructions: custom description + fallback description
  const instructionsDir = path.join(root, "instructions");
  fs.mkdirSync(instructionsDir);
  fs.writeFileSync(
    path.join(instructionsDir, "zeta-containers.instructions.md"),
    "---\n---\n# Zeta Containers\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(instructionsDir, "alpha-rust.instructions.md"),
    "---\ndescription: 'Idiomatic Rust | ownership rules'\n---\n# Alpha Rust\n",
    "utf8",
  );
  const instructionsOut = generateInstructionsSection(instructionsDir);
  assert.ok(instructionsOut.indexOf("[Alpha Rust]") < instructionsOut.indexOf("[Zeta Containers]"));
  assert.match(instructionsOut, /Idiomatic Rust &#124; ownership rules/);
  assert.match(instructionsOut, /Container specific coding standards and best practices/);

  // Agents
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir);
  fs.writeFileSync(
    path.join(agentsDir, "planner.agent.md"),
    "---\nname: planner\ndescription: 'Plans tasks'\nmcp-servers:\n  docs:\n    command: node\n---\n",
    "utf8",
  );
  const agentsOut = generateAgentsSection(agentsDir, []);
  assert.match(agentsOut, /\| \[Planner\]\(\.\.\/agents\/planner\.agent\.md\)/);
  assert.match(agentsOut, /docs<br \/>/);

  // Hooks
  const hooksDir = path.join(root, "hooks");
  fs.mkdirSync(path.join(hooksDir, "session-audit"), { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "session-audit", "README.md"),
    "---\nname: Session Audit\ndescription: 'Tracks session start'\n---\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(hooksDir, "session-audit", "hooks.json"),
    JSON.stringify({ hooks: { sessionStart: [] } }),
    "utf8",
  );
  const hooksOut = generateHooksSection(hooksDir);
  assert.match(hooksOut, /\| \[Session Audit\]\(\.\.\/hooks\/session-audit\/README\.md\) \| Tracks session start \| sessionStart \| `hooks\.json` \|/);

  // Workflows
  const workflowsDir = path.join(root, "workflows");
  fs.mkdirSync(workflowsDir);
  fs.writeFileSync(
    path.join(workflowsDir, "weekly-triage.md"),
    "---\nname: Weekly Triage\ndescription: 'Triages open issues'\non:\n  schedule: weekly\n---\n",
    "utf8",
  );
  const workflowsOut = generateWorkflowsSection(workflowsDir);
  assert.match(workflowsOut, /\| \[Weekly Triage\]\(\.\.\/workflows\/weekly-triage\.md\) \| Triages open issues \| schedule \|/);

  // Skills
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(path.join(skillsDir, "test-runner"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "test-runner", "SKILL.md"),
    "---\nname: test-runner\ndescription: 'Executes focused unit tests'\n---\n",
    "utf8",
  );
  const skillsOut = generateSkillsSection(skillsDir);
  assert.match(skillsOut, /`gh skills install github\/awesome-copilot test-runner`/);
  assert.match(skillsOut, /\| Executes focused unit tests \| None \|/);
});

test("plugin section generators sort featured first and count agents, skills, and implicit/explicit extensions without double counting", (t) => {
  const root = makeTempDir(t);
  const pluginsDir = path.join(root, "plugins");
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(path.join(pluginsDir, "regular-pack"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "featured-board"), { recursive: true });
  fs.mkdirSync(path.join(extensionsDir, "featured-board"), { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, "featured-board", "extension.mjs"), "export default {};\n", "utf8");

  fs.writeFileSync(
    path.join(pluginsDir, "regular-pack", "plugin.json"),
    JSON.stringify({
      name: "regular-pack",
      description: "Regular plugin",
      keywords: ["ops"],
      extensions: {
        "com.github.awesome-copilot": {
          agents: ["./agents/a.md"],
          skills: ["./skills/s1/", "./skills/s2/"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginsDir, "featured-board", "plugin.json"),
    JSON.stringify({
      name: "featured-board",
      description: "Featured canvas plugin",
      featured: true,
      keywords: ["canvas"],
      extensions: {
        "com.github.awesome-copilot": {
          extensions: ["./extensions/featured-board"],
        },
      },
    }),
    "utf8",
  );

  const pluginsOut = generatePluginsSection(pluginsDir, [], { extensionsDir });
  assert.ok(pluginsOut.indexOf("⭐ featured-board") < pluginsOut.indexOf("[regular-pack]"));
  assert.match(pluginsOut, /\[⭐ featured-board\]\(\.\.\/plugins\/featured-board\/README\.md\) \| Featured canvas plugin \| 1 items \| canvas \|/);
  assert.match(pluginsOut, /\[regular-pack\]\(\.\.\/plugins\/regular-pack\/README\.md\) \| Regular plugin \| 3 items \| ops \|/);

  const featuredOut = generateFeaturedPluginsSection(pluginsDir, { extensionsDir });
  assert.match(featuredOut, /\[featured-board\]\(plugins\/featured-board\/README\.md\)/);
  assert.doesNotMatch(featuredOut, /regular-pack/);
});

test("buildCategoryReadme promotes H2 to H1 with empty fallback and writeFileIfChanged skips identical writes", (t) => {
  const dir = makeTempDir(t);
  const upgraded = buildCategoryReadme(
    () => "## Category Title\n\nBody row",
    dir,
    "# Category Title",
    "Usage note",
  );
  assert.equal(upgraded, "# Category Title\n\nBody row");

  const fallback = buildCategoryReadme(
    () => "",
    dir,
    "# Empty Category",
    "Usage note",
  );
  assert.match(fallback, /_No entries found yet\._/);

  const targetFile = path.join(dir, "README.category.md");
  writeFileIfChanged(targetFile, upgraded);
  const backdated = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(targetFile, backdated, backdated);

  writeFileIfChanged(targetFile, upgraded);
  assert.equal(fs.statSync(targetFile).mtime.getTime(), backdated.getTime());

  writeFileIfChanged(targetFile, `${upgraded}\nUpdated`);
  assert.notEqual(fs.statSync(targetFile).mtime.getTime(), backdated.getTime());
});
