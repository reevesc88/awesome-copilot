#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const controlRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(controlRoot, "..", "..");
const inventoryPath = path.join(controlRoot, "inventory.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const options = {
    targets: [],
    items: [],
    write: false,
    replace: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      options.targets.push(argv[++i]);
    } else if (arg === "--targets-file") {
      options.targetsFile = argv[++i];
    } else if (arg === "--item") {
      options.items.push(argv[++i]);
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node personal/reevesc88/scripts/sync-copilot-config.mjs --target /absolute/path/to/repo [--item id] [--write] [--replace]
  node personal/reevesc88/scripts/sync-copilot-config.mjs --targets-file personal/reevesc88/targets.example.json

Behavior:
- dry run by default
- requires an explicit target path list
- prints diffs for conflicting files
- skips differing files unless --replace is provided
`);
}

function collectTargets(options) {
  const targets = [...options.targets];
  if (options.targetsFile) {
    const filePath = path.isAbsolute(options.targetsFile)
      ? options.targetsFile
      : path.join(repoRoot, options.targetsFile);
    const data = readJson(filePath);
    if (!Array.isArray(data.targets)) {
      throw new Error('targets file must contain a { "targets": [] } array');
    }
    targets.push(...data.targets);
  }

  const normalized = [...new Set(targets.map((target) => path.resolve(target)))];
  if (normalized.length === 0) {
    throw new Error("At least one --target or --targets-file entry is required");
  }

  for (const target of normalized) {
    if (!path.isAbsolute(target)) {
      throw new Error(`Target must be an absolute path: ${target}`);
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error(`Target directory does not exist: ${target}`);
    }
  }

  return normalized;
}

function simpleDiff(existingText, desiredText, destPath) {
  const existingLines = existingText.split(/\r?\n/);
  const desiredLines = desiredText.split(/\r?\n/);
  const max = Math.max(existingLines.length, desiredLines.length);
  const lines = [`--- existing ${destPath}`, `+++ desired ${destPath}`];

  for (let i = 0; i < max; i += 1) {
    const before = existingLines[i];
    const after = desiredLines[i];
    if (before === after) continue;
    if (before !== undefined) lines.push(`- ${before}`);
    if (after !== undefined) lines.push(`+ ${after}`);
    if (lines.length > 60) {
      lines.push("... diff truncated ...");
      break;
    }
  }

  return lines.join("\n");
}

function ensureParent(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const inventory = readJson(inventoryPath);
  const targets = collectTargets(options);
  const selectedIds = new Set(options.items);
  const items = inventory.items.filter((item) =>
    selectedIds.size === 0 ? item.installByDefault !== false : selectedIds.has(item.id)
  );

  if (selectedIds.size > 0) {
    const matched = new Set(items.map((item) => item.id));
    for (const id of selectedIds) {
      if (!matched.has(id)) {
        throw new Error(`Unknown inventory item: ${id}`);
      }
    }
  }

  console.log(options.write ? "WRITE MODE" : "DRY RUN");
  console.log(
    options.replace
      ? "Conflicting files may be replaced after diff review."
      : "Conflicting files will be preserved and skipped."
  );

  for (const target of targets) {
    console.log(`\n==> Target: ${target}`);
    for (const item of items) {
      const sourcePath = path.join(repoRoot, item.source);
      const destPath = path.join(target, item.destination);
      const desiredText = fs.readFileSync(sourcePath, "utf8");

      if (!fs.existsSync(destPath)) {
        console.log(`CREATE ${item.destination} (${item.id})`);
        if (options.write) {
          ensureParent(destPath);
          fs.writeFileSync(destPath, desiredText, "utf8");
        }
        continue;
      }

      const existingText = fs.readFileSync(destPath, "utf8");
      if (existingText === desiredText) {
        console.log(`OK     ${item.destination} (${item.id})`);
        continue;
      }

      console.log(`DIFF   ${item.destination} (${item.id})`);
      console.log(simpleDiff(existingText, desiredText, item.destination));
      if (!options.replace) {
        console.log("SKIP   preserved existing target override");
        continue;
      }

      if (options.write) {
        ensureParent(destPath);
        fs.writeFileSync(destPath, desiredText, "utf8");
        console.log("WRITE  replaced after explicit --replace");
      } else {
        console.log("WOULD  replace after explicit --write --replace");
      }
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`sync-copilot-config failed: ${error.message}`);
  process.exit(1);
}
