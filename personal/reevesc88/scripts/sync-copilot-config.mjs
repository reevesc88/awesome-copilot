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

function requireOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function isWithinOrEqual(root, candidate) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  );
}

function isWithin(root, candidate) {
  return (
    path.relative(path.resolve(root), path.resolve(candidate)) !== "" &&
    isWithinOrEqual(root, candidate)
  );
}

export function assertNoSymlinkSegments(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isWithinOrEqual(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} must stay within ${resolvedRoot}: ${resolvedCandidate}`);
  }

  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);
  let currentPath = resolvedRoot;

  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        `${label} cannot include a symbolic link or junction: ${currentPath}`,
      );
    }

    const canonicalCurrentPath = fs.realpathSync(currentPath);
    if (!isWithinOrEqual(canonicalRoot, canonicalCurrentPath)) {
      throw new Error(
        `${label} resolves outside ${canonicalRoot}: ${currentPath}`,
      );
    }
  }
}

export function resolveWithin(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative: ${relativePath}`);
  }

  const resolved = path.resolve(root, relativePath);
  if (!isWithin(root, resolved)) {
    throw new Error(`${label} must stay within ${path.resolve(root)}: ${relativePath}`);
  }
  return resolved;
}

export function parseArgs(argv) {
  const options = {
    targets: [],
    items: [],
    write: false,
    replace: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      options.targets.push(requireOptionValue(argv, i, arg));
      i += 1;
    } else if (arg === "--targets-file") {
      options.targetsFile = requireOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--item") {
      options.items.push(requireOptionValue(argv, i, arg));
      i += 1;
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
  node personal/reevesc88/scripts/sync-copilot-config.mjs --target <absolute-repository-root> [--item id] [--write] [--replace]
  node personal/reevesc88/scripts/sync-copilot-config.mjs --targets-file personal/reevesc88/targets.example.json

Behavior:
- dry run by default
- requires an explicit absolute Git repository root
- installs only inventory items marked installByDefault when --item is omitted
- customize-before-enable items and workflows require explicit --item selection
- prints bounded line-number summaries for conflicting files without echoing contents
- skips differing files unless --replace is provided
`);
}

export function collectTargets(options) {
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

  for (const target of targets) {
    if (typeof target !== "string" || target.trim() === "") {
      throw new Error("Target must be a non-empty absolute path");
    }
  }

  for (const target of targets) {
    if (!path.isAbsolute(target)) {
      throw new Error(`Target must be an absolute path: ${target}`);
    }
  }

  const normalized = [...new Set(targets.map((target) => path.resolve(target)))];
  if (normalized.length === 0) {
    throw new Error("At least one --target or --targets-file entry is required");
  }

  for (const target of normalized) {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error(`Target directory does not exist: ${target}`);
    }
    if (!fs.existsSync(path.join(target, ".git"))) {
      throw new Error(`Target must be a Git repository root: ${target}`);
    }
  }

  return normalized;
}

export function selectItems(inventory, requestedIds) {
  if (!inventory || !Array.isArray(inventory.items)) {
    throw new Error("Inventory must contain an items array");
  }

  const selectedIds = new Set(requestedIds);
  if (selectedIds.size === 0) {
    const unsafeDefault = inventory.items.find(
      (item) =>
        item.installByDefault === true &&
        item.maturity === "customize-before-enable",
    );
    if (unsafeDefault) {
      throw new Error(
        `Customize-before-enable item cannot be installed by default: ${unsafeDefault.id}`,
      );
    }
  }

  const items = inventory.items.filter((item) =>
    selectedIds.size === 0 ? item.installByDefault === true : selectedIds.has(item.id)
  );

  const matched = new Set(items.map((item) => item.id));
  for (const id of selectedIds) {
    if (!matched.has(id)) {
      throw new Error(`Unknown inventory item: ${id}`);
    }
  }

  return items;
}


function simpleDiff(existingText, desiredText, destPath) {
  const existingLines = existingText.split(/\r?\n/);
  const desiredLines = desiredText.split(/\r?\n/);
  const max = Math.max(existingLines.length, desiredLines.length);
  const lines = [
    `--- existing ${destPath}`,
    `+++ desired ${destPath}`,
    "Content omitted from preview to avoid exposing sensitive target data.",
  ];

  for (let i = 0; i < max; i += 1) {
    const before = existingLines[i];
    const after = desiredLines[i];
    if (before === after) continue;
    lines.push(`@@ line ${i + 1} differs @@`);
    if (lines.length > 60) {
      lines.push("... diff summary truncated ...");
      break;
    }
  }

  return lines.join("\n");
}

function ensureParent(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
}

export function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const inventory = readJson(inventoryPath);
  const sourceRoot = resolveWithin(repoRoot, inventory.sourceRoot, "inventory sourceRoot");
  assertNoSymlinkSegments(repoRoot, sourceRoot, "inventory sourceRoot");
  const targets = collectTargets(options);
  const items = selectItems(inventory, options.items);
  if (items.length === 0) {
    throw new Error("No inventory items selected");
  }

  console.log(options.write ? "WRITE MODE" : "DRY RUN");
  console.log(`Selected ${items.length} inventory item(s).`);
  console.log(
    options.replace
      ? "Conflicting files may be replaced after diff review."
      : "Conflicting files will be preserved and skipped."
  );

  for (const target of targets) {
    console.log(`\n==> Target: ${target}`);
    for (const item of items) {
      const sourcePath = resolveWithin(repoRoot, item.source, `Source for ${item.id}`);
      if (!isWithin(sourceRoot, sourcePath)) {
        throw new Error(`Source for ${item.id} must stay within ${sourceRoot}: ${item.source}`);
      }
      assertNoSymlinkSegments(sourceRoot, sourcePath, `Source for ${item.id}`);
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`Source for ${item.id} must be a file: ${item.source}`);
      }

      const destPath = resolveWithin(target, item.destination, `Destination for ${item.id}`);
      const targetGitHubRoot = path.join(target, ".github");
      if (!isWithin(targetGitHubRoot, destPath)) {
        throw new Error(`Destination for ${item.id} must stay within ${targetGitHubRoot}: ${item.destination}`);
      }
      assertNoSymlinkSegments(target, destPath, `Destination for ${item.id}`);
      const desiredText = fs.readFileSync(sourcePath, "utf8");

      if (!fs.existsSync(destPath)) {
        console.log(`CREATE ${item.destination} (${item.id})`);
        if (options.write) {
          ensureParent(destPath);
          assertNoSymlinkSegments(target, destPath, `Destination for ${item.id}`);
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
        assertNoSymlinkSegments(target, destPath, `Destination for ${item.id}`);
        fs.writeFileSync(destPath, desiredText, "utf8");
        console.log("WRITE  replaced after explicit --replace");
      } else {
        console.log("WOULD  replace after explicit --write --replace");
      }
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase();

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(`sync-copilot-config failed: ${error.message}`);
    process.exit(1);
  }
}
