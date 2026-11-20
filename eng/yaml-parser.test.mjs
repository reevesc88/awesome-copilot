import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractAgentMetadata,
  extractMcpServerConfigs,
  extractMcpServers,
  parseFrontmatter,
  parseHookMetadata,
  parseSkillMetadata,
  parseWorkflowMetadata,
  parseYamlFile,
  safeFileOperation,
} from "./yaml-parser.mjs";

function makeTempDir(t, prefix = "awesome-copilot-yaml-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseFrontmatter trims name/title and strips only trailing description whitespace", (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, "sample.agent.md");
  fs.writeFileSync(
    filePath,
    [
      "---",
      'name: "  sample-agent  "',
      'title: "  Sample Title\\n"',
      "description: |",
      "  First line of description.",
      "  Second line preserved.",
      "",
      "---",
      "",
      "# Sample Heading",
    ].join("\n"),
    "utf8",
  );

  const fm = parseFrontmatter(filePath);
  assert.equal(fm.name, "sample-agent");
  assert.equal(fm.title, "Sample Title");
  assert.equal(
    fm.description,
    "First line of description.\nSecond line preserved.",
  );
});

test("parseFrontmatter returns null for missing files or malformed YAML frontmatter", (t) => {
  const dir = makeTempDir(t);
  assert.equal(parseFrontmatter(path.join(dir, "missing.md")), null);

  const malformed = path.join(dir, "malformed.md");
  fs.writeFileSync(
    malformed,
    "---\nname: [unclosed\ndescription: broken\n---\nBody\n",
    "utf8",
  );
  assert.equal(parseFrontmatter(malformed), null);
});

test("safeFileOperation returns fallback value when callback throws", () => {
  const fallback = { ok: false };
  const result = safeFileOperation(
    () => {
      throw new Error("synthetic read failure");
    },
    "virtual.md",
    fallback,
  );
  assert.equal(result, fallback);
});

test("extractAgentMetadata, extractMcpServers, and extractMcpServerConfigs normalize stdio and HTTP servers", (t) => {
  const dir = makeTempDir(t);
  const agentPath = path.join(dir, "mcp-demo.agent.md");
  fs.writeFileSync(
    agentPath,
    [
      "---",
      "name: mcp-demo",
      "description: 'Demonstrates MCP server extraction'",
      "tools:",
      "  - codebase",
      "  - search",
      "mcp-servers:",
      "  local-runner:",
      "    command: npx",
      "    args:",
      "      - '@example/mcp-server'",
      "      - '--stdio'",
      "  remote-docs:",
      "    type: http",
      "    url: https://mcp.example.com/sse",
      "    headers:",
      "      X-Client-Mode: preview",
      "---",
      "",
      "Agent body.",
    ].join("\n"),
    "utf8",
  );

  const meta = extractAgentMetadata(agentPath);
  assert.equal(meta.name, "mcp-demo");
  assert.equal(meta.description, "Demonstrates MCP server extraction");
  assert.deepEqual(meta.tools, ["codebase", "search"]);
  assert.deepEqual(extractMcpServers(agentPath), ["local-runner", "remote-docs"]);

  const configs = extractMcpServerConfigs(agentPath);
  assert.deepEqual(configs, [
    {
      name: "local-runner",
      type: undefined,
      command: "npx",
      args: ["@example/mcp-server", "--stdio"],
      url: undefined,
      headers: undefined,
    },
    {
      name: "remote-docs",
      type: "http",
      command: undefined,
      args: undefined,
      url: "https://mcp.example.com/sse",
      headers: { "X-Client-Mode": "preview" },
    },
  ]);
});

test("parseSkillMetadata collects sorted assets from recognized subdirectories and rejects incomplete frontmatter", (t) => {
  const dir = makeTempDir(t);
  const validSkill = path.join(dir, "valid-skill");
  fs.mkdirSync(path.join(validSkill, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(validSkill, "references", "nested"), { recursive: true });
  fs.mkdirSync(path.join(validSkill, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(validSkill, "SKILL.md"),
    "---\nname: valid-skill\ndescription: 'Valid skill description for testing'\n---\n# Skill\n",
    "utf8",
  );
  fs.writeFileSync(path.join(validSkill, "scripts", "check.mjs"), "// noop\n", "utf8");
  fs.writeFileSync(path.join(validSkill, "assets", "template.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(validSkill, "references", "guide.md"), "# Guide\n", "utf8");
  fs.writeFileSync(path.join(validSkill, "references", "nested", "deep.md"), "# Deep\n", "utf8");

  const skillMeta = parseSkillMetadata(validSkill);
  assert.deepEqual(skillMeta, {
    name: "valid-skill",
    description: "Valid skill description for testing",
    assets: ["assets/template.json", "references/guide.md", "references/nested/deep.md", "scripts/check.mjs"],
    path: validSkill,
  });

  const incompleteSkill = path.join(dir, "incomplete-skill");
  fs.mkdirSync(incompleteSkill, { recursive: true });
  fs.writeFileSync(path.join(incompleteSkill, "SKILL.md"), "---\nname: only-name\n---\n", "utf8");
  assert.equal(parseSkillMetadata(incompleteSkill), null);
  assert.equal(parseSkillMetadata(path.join(dir, "missing-skill")), null);
});

test("parseHookMetadata extracts events from hooks.json and tolerates malformed hooks.json", (t) => {
  const dir = makeTempDir(t);
  const hookDir = path.join(dir, "audit-hook");
  fs.mkdirSync(path.join(hookDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "README.md"),
    "---\nname: Audit Hook\ndescription: 'Logs session lifecycle events'\ntags:\n  - logging\n---\n# Audit Hook\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(hookDir, "hooks.json"),
    JSON.stringify({
      hooks: {
        sessionStart: [{ type: "command", command: "./scripts/run.sh" }],
        postToolUse: [{ type: "command", command: "./scripts/run.sh" }],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(hookDir, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", "utf8");

  const meta = parseHookMetadata(hookDir);
  assert.deepEqual(meta, {
    name: "Audit Hook",
    description: "Logs session lifecycle events",
    hooks: ["sessionStart", "postToolUse"],
    tags: ["logging"],
    assets: ["hooks.json", "scripts/run.sh"],
    path: hookDir,
  });

  const brokenJsonHook = path.join(dir, "broken-hook");
  fs.mkdirSync(brokenJsonHook, { recursive: true });
  fs.writeFileSync(
    path.join(brokenJsonHook, "README.md"),
    "---\nname: Broken Hook\ndescription: 'Still parses README metadata'\n---\n",
    "utf8",
  );
  fs.writeFileSync(path.join(brokenJsonHook, "hooks.json"), "{ invalid json", "utf8");

  const fallbackMeta = parseHookMetadata(brokenJsonHook);
  assert.equal(fallbackMeta.name, "Broken Hook");
  assert.deepEqual(fallbackMeta.hooks, []);
  assert.deepEqual(fallbackMeta.tags, []);
});

test("parseWorkflowMetadata supports both object and string 'on' triggers", (t) => {
  const dir = makeTempDir(t);
  const objectTriggerFile = path.join(dir, "daily-report.md");
  fs.writeFileSync(
    objectTriggerFile,
    [
      "---",
      "name: Daily Report",
      "description: 'Summarizes repository status'",
      "on:",
      "  schedule: daily",
      "  workflow_dispatch: {}",
      "---",
      "Body",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(parseWorkflowMetadata(objectTriggerFile), {
    name: "Daily Report",
    description: "Summarizes repository status",
    triggers: ["schedule", "workflow_dispatch"],
    path: objectTriggerFile,
  });

  const stringTriggerFile = path.join(dir, "push-check.md");
  fs.writeFileSync(
    stringTriggerFile,
    "---\nname: Push Check\ndescription: 'Runs on push'\non: push\n---\n",
    "utf8",
  );
  assert.deepEqual(parseWorkflowMetadata(stringTriggerFile).triggers, ["push"]);
});

test("parseYamlFile parses JSON-compatible YAML and returns null on invalid YAML", (t) => {
  const dir = makeTempDir(t);
  const validYaml = path.join(dir, "config.yml");
  fs.writeFileSync(
    validYaml,
    "cookbooks:\n  - id: nodejs\n    featured: true\n",
    "utf8",
  );
  assert.deepEqual(parseYamlFile(validYaml), {
    cookbooks: [{ id: "nodejs", featured: true }],
  });

  const invalidYaml = path.join(dir, "invalid.yml");
  fs.writeFileSync(invalidYaml, "cookbooks: [unclosed\n", "utf8");
  assert.equal(parseYamlFile(invalidYaml), null);
});
