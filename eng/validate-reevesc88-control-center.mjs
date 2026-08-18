#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseFrontmatter, parseWorkflowMetadata } from "./yaml-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const controlRoot = path.join(repoRoot, "personal", "reevesc88");
const inventoryPath = path.join(controlRoot, "inventory.json");
const templateRoot = path.join(controlRoot, "templates", "repository", ".github");

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walk(dir, predicate = () => true, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function validateInstructions(dir) {
  const files = walk(dir, (file) => file.endsWith('.instructions.md'));
  for (const file of files) {
    const fm = parseFrontmatter(file);
    if (!fm) {
      fail(`Invalid frontmatter: ${relative(file)}`);
      continue;
    }
    if (!fm.description) fail(`Missing description: ${relative(file)}`);
    if (!fm.applyTo) fail(`Missing applyTo: ${relative(file)}`);
  }
}

function validateAgents(dir) {
  const files = walk(dir, (file) => file.endsWith('.md'));
  const names = new Map();
  for (const file of files) {
    const fm = parseFrontmatter(file);
    if (!fm) {
      fail(`Invalid frontmatter: ${relative(file)}`);
      continue;
    }
    if (!fm.name) fail(`Missing agent name: ${relative(file)}`);
    if (!fm.description) fail(`Missing agent description: ${relative(file)}`);
    if (fm.name) {
      if (names.has(fm.name)) fail(`Duplicate agent name: ${fm.name}`);
      names.set(fm.name, file);
    }
  }
}

function validatePrompts(dir) {
  const files = walk(dir, (file) => file.endsWith('.prompt.md'));
  const names = new Map();
  for (const file of files) {
    const fm = parseFrontmatter(file);
    if (!fm) {
      fail(`Invalid frontmatter: ${relative(file)}`);
      continue;
    }
    if (!fm.description) fail(`Missing prompt description: ${relative(file)}`);
    if (!fm.agent || !['agent', 'ask', 'Plan'].includes(fm.agent)) {
      fail(`Prompt agent must be one of agent, ask, Plan: ${relative(file)}`);
    }
    if (!fm.name) fail(`Missing prompt name: ${relative(file)}`);
    if (fm.name) {
      if (names.has(fm.name)) fail(`Duplicate prompt name: ${fm.name}`);
      names.set(fm.name, file);
    }
  }
}

function validateSkills(dir) {
  const skillDirs = fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).isDirectory());
  const names = new Set();
  for (const skillDir of skillDirs) {
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      fail(`Missing SKILL.md: ${relative(skillDir)}`);
      continue;
    }
    const fm = parseFrontmatter(skillFile);
    if (!fm) {
      fail(`Invalid frontmatter: ${relative(skillFile)}`);
      continue;
    }
    if (!fm.name) fail(`Missing skill name: ${relative(skillFile)}`);
    if (!fm.description) fail(`Missing skill description: ${relative(skillFile)}`);
    const folderName = path.basename(skillDir);
    if (fm.name && fm.name !== folderName) {
      fail(`Skill name/folder mismatch: ${relative(skillFile)} -> ${fm.name} vs ${folderName}`);
    }
    if (fm.name) {
      if (names.has(fm.name)) fail(`Duplicate skill name: ${fm.name}`);
      names.add(fm.name);
    }
  }
}

function validateWorkflows(dir) {
  const files = walk(dir, (file) => file.endsWith('.md'));
  const names = new Set();
  for (const file of files) {
    const meta = parseWorkflowMetadata(file);
    const fm = parseFrontmatter(file);
    if (!meta || !fm) {
      fail(`Invalid workflow frontmatter: ${relative(file)}`);
      continue;
    }
    if (names.has(meta.name)) fail(`Duplicate workflow name: ${meta.name}`);
    names.add(meta.name);
    const hasWorkflowDispatch =
      fm.on &&
      typeof fm.on === "object" &&
      Object.prototype.hasOwnProperty.call(fm.on, "workflow_dispatch");
    if (!hasWorkflowDispatch) fail(`Workflow missing workflow_dispatch: ${relative(file)}`);
    if (!fm.permissions || typeof fm.permissions !== 'object') fail(`Workflow missing permissions: ${relative(file)}`);
    if (!fm['safe-outputs']) fail(`Workflow missing safe-outputs: ${relative(file)}`);
    if (!fm['timeout-minutes']) fail(`Workflow missing timeout-minutes: ${relative(file)}`);

    const permissions = fm.permissions || {};
    for (const [scope, value] of Object.entries(permissions)) {
      if (value === 'write' && !['issues'].includes(scope)) {
        fail(`Workflow permission too broad (${scope}: write): ${relative(file)}`);
      }
    }
  }
}

function validateInventory() {
  const inventory = readJson(inventoryPath);
  const ids = new Set();
  const destinations = new Set();
  for (const item of inventory.items) {
    if (ids.has(item.id)) fail(`Duplicate inventory id: ${item.id}`);
    ids.add(item.id);
    if (destinations.has(item.destination)) fail(`Duplicate inventory destination: ${item.destination}`);
    destinations.add(item.destination);
    const sourcePath = path.join(repoRoot, item.source);
    if (!fs.existsSync(sourcePath)) fail(`Inventory source missing: ${item.source}`);
  }
}

function validateLinks() {
  const markdownFiles = walk(controlRoot, (file) => file.endsWith('.md'));
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const file of markdownFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = markdownLinkPattern.exec(content)) !== null) {
      const target = match[1];
      if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#') || target.startsWith('mailto:')) {
        continue;
      }
      const cleanTarget = target.split('#')[0];
      const resolved = path.resolve(path.dirname(file), cleanTarget);
      if (!fs.existsSync(resolved)) {
        fail(`Broken relative link in ${relative(file)} -> ${target}`);
      }
    }
  }
}

function main() {
  if (!fs.existsSync(controlRoot)) {
    throw new Error(`Missing control root: ${controlRoot}`);
  }

  validateInventory();
  validateInstructions(path.join(templateRoot, 'instructions'));
  validateAgents(path.join(templateRoot, 'agents'));
  validatePrompts(path.join(templateRoot, 'prompts'));
  validateSkills(path.join(templateRoot, 'skills'));
  validateWorkflows(path.join(templateRoot, 'workflows'));
  validateLinks();

  if (errors.length > 0) {
    console.error('Control-center validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('Control-center validation passed');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
