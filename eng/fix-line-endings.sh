#!/bin/bash
# Script to fix line endings in all markdown files

set -euo pipefail

TARGET_DIR="${1:-.}"

echo "Normalizing line endings in markdown files..."

# Find all markdown files (excluding .git and node_modules) and convert CRLF to LF portably across macOS/Linux
node - "$TARGET_DIR" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(process.argv[2] || ".");
const skipDirs = new Set([".git", "node_modules"]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes("\r")) {
        fs.writeFileSync(fullPath, content.replace(/\r\n?/g, "\n"), "utf8");
      }
    }
  }
}

walk(rootDir);
EOF

echo "Done! All markdown files now have LF line endings."
