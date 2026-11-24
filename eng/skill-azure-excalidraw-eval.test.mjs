import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-az-excal-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PYTHON_EXECUTABLE = (() => {
  const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : "python3";
})();

function runPy(args, { cwd, env = {}, input } = {}) {
  return spawnSync(PYTHON_EXECUTABLE, ["-B", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    input,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

test("azure-architecture-autopilot icons, generator aliases, and CLI normalization/fallback work offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "az-arch-autopilot-");
  const scriptsDir = path.join(SKILLS_ROOT, "azure-architecture-autopilot", "scripts");
  const cliPy = path.join(scriptsDir, "cli.py");

  // 1. Unit-test icons.py, generator.py, and cli.py helpers directly in Python
  const pyDriver = `
import base64, io, json, pathlib, sys
from contextlib import redirect_stderr
sys.path.insert(0, ${JSON.stringify(scriptsDir)})

import icons
import generator
import cli

# icons.py: normalization, base64 SVG decode, unknown fallback, and search
uri = icons.get_icon_data_uri("AI-Studio")
assert uri.startswith("data:image/svg+xml;base64,")
raw_svg = base64.b64decode(uri.split(",", 1)[1]).decode("utf-8")
assert "<svg" in raw_svg
assert icons.get_icon_data_uri("nonexistent_service_xyz") == ""
matches = icons.search_icons("microsoft-fabric")
assert any(k == "microsoft_fabric" and name == "Microsoft-Fabric" for k, name, _cat in matches)

# generator.py: ARM resource alias resolution + fallback + HTML rendering
pe_info = generator.get_service_info("Private-Endpoints")
assert pe_info["category"] == "Network"
search_info = generator.get_service_info("cognitive_search")
assert search_info["category"] == "AI"
assert search_info["icon_data_uri"].startswith("data:image/svg+xml;base64,")
fallback_info = generator.get_service_info("custom_unmapped_resource")
assert fallback_info["category"] == "Azure"

# cli.py: _normalize_services + _normalize_connections + _load_json combined file extraction
stderr_buf = io.StringIO()
with redirect_stderr(stderr_buf):
    norm_svcs = cli._normalize_services([
        {"id": "web", "name": "Web App", "type": "web-apps", "details": "HTTPS 443", "private": "yes"},
        {"id": "pe1", "name": "Web PE", "type": "private_endpoint", "private": "0"},
        {"id": "kv", "name": "Vault", "type": "key_vaults", "private": "invalid_bool"},
    ])
assert norm_svcs[0]["details"] == ["HTTPS 443"]
assert norm_svcs[0]["private"] is True
assert norm_svcs[1]["private"] is False
assert norm_svcs[2]["private"] is False
assert "Invalid boolean value 'invalid_bool'" in stderr_buf.getvalue()

norm_conns = cli._normalize_connections([
    {"from": "web", "to": "kv"},
    {"from": "web", "to": "pe1", "type": "private", "label": "443"},
])
assert norm_conns[0]["type"] == "default"
assert norm_conns[1]["type"] == "private"

html = generator.generate_diagram(
    services=norm_svcs,
    connections=norm_conns,
    title="Hub & Spoke Prod",
    vnet_info="vnet-prod 10.10.0.0/16 | snet-app 10.10.1.0/24",
    hierarchy=[{"subscription": "sub-prod", "resourceGroups": ["rg-core"]}],
)
assert "<title>Hub & Spoke Prod</title>" in html
assert "<b>2</b> Services" in html
assert "<b>1</b> Private Endpoints" in html
assert "<b>2</b> Connections" in html
assert "10.10.0.0/16" in html
assert "sub-prod" in html
print("OK")
`;
  const unitResult = runPy(["-c", pyDriver], { cwd: dir });
  assert.equal(unitResult.status, 0, unitResult.stdout + unitResult.stderr);
  assert.equal(unitResult.stdout.trim(), "OK");

  // 2. CLI argument validation + combined JSON file + PNG fallback without puppeteer
  assert.notEqual(runPy([cliPy], { cwd: dir }).status, 0);
  const badJsonRun = runPy([cliPy, "-s", "{broken", "-c", "[]"], { cwd: dir });
  assert.equal(badJsonRun.status, 1);
  assert.match(badJsonRun.stderr, /Invalid JSON for --services/);

  const combinedPath = path.join(dir, "arch.json");
  fs.writeFileSync(
    combinedPath,
    JSON.stringify({
      services: [
        { id: "aks", name: "AKS Cluster", type: "managed_clusters", private: "true", details: "System pool" },
        { id: "acr", name: "Registry", type: "container_registries", private: "false" },
      ],
      connections: [{ from: "aks", to: "acr", label: "Pull image", type: "security" }],
      hierarchy: [{ subscription: "sub-1", resourceGroups: ["rg-aks"] }],
    }),
    "utf8",
  );

  const outHtml = path.join(dir, "diagram.html");
  const htmlCliRun = runPy(
    [
      cliPy,
      "-s",
      combinedPath,
      "-c",
      combinedPath,
      "--hierarchy",
      combinedPath,
      "-t",
      "Container Platform",
      "-o",
      outHtml,
    ],
    { cwd: dir },
  );
  assert.equal(htmlCliRun.status, 0, htmlCliRun.stderr);
  const savedHtml = fs.readFileSync(outHtml, "utf8");
  assert.match(savedHtml, /Container Platform/);
  assert.match(savedHtml, /"dash": "5,5"/);

  // --format png without puppeteer (PATH emptied so shutil.which("node") is None) falls back cleanly to HTML and cleans up .tmp.html
  const fallbackBase = path.join(dir, "fallback-out.png");
  const fallbackHtml = path.join(dir, "fallback-out.html");
  const pngFallbackRun = runPy(
    [cliPy, "-s", combinedPath, "-c", combinedPath, "-f", "png", "-o", fallbackBase],
    { cwd: dir, env: { PATH: dir } },
  );
  assert.equal(pngFallbackRun.status, 0);
  assert.match(pngFallbackRun.stderr, /WARNING: PNG export failed/);
  assert.equal(fs.existsSync(fallbackHtml), true);
  assert.equal(fs.existsSync(`${fallbackBase}.tmp.html`), false);
});

test("excalidraw add-icon-to-diagram transforms coordinates/bindings without mutating cached icon definitions and guards .edit files", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "excalidraw-add-icon-");
  const scriptsDir = path.join(SKILLS_ROOT, "excalidraw-diagram-generator", "scripts");
  const addIconPy = path.join(scriptsDir, "add-icon-to-diagram.py");

  // 1. Direct Python unit checks for bounding boxes and non-mutating repeated transformations
  const pyCheck = runPy([
    "-c",
    `
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("add_icon", ${JSON.stringify(addIconPy)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.calculate_bounding_box([]) == (0, 0, 0, 0)
assert mod.calculate_bounding_box([{"id": "no-coords"}]) == (0, 0, 0, 0)
assert mod.calculate_bounding_box([
    {"x": 20, "y": 40, "width": 50, "height": 30},
    {"x": 10, "y": 50, "width": 20, "height": 40},
]) == (10, 40, 70, 90)

template_elements = [
    {
        "id": "box-orig",
        "type": "rectangle",
        "x": 50,
        "y": 60,
        "width": 80,
        "height": 40,
        "groupIds": ["grp-orig"],
        "boundElements": [{"id": "arrow-orig", "type": "arrow"}, {"id": "txt-orig", "type": "text"}],
    },
    {
        "id": "txt-orig",
        "type": "text",
        "x": 60,
        "y": 70,
        "width": 60,
        "height": 20,
        "groupIds": ["grp-orig"],
        "containerId": "box-orig",
    },
    {
        "id": "arrow-orig",
        "type": "arrow",
        "x": 90,
        "y": 100,
        "width": 10,
        "height": 20,
        "groupIds": ["grp-orig"],
        "startBinding": {"elementId": "box-orig", "focus": 0, "gap": 1},
        "endBinding": {"elementId": "txt-orig", "focus": 0, "gap": 1},
    },
]

first = mod.transform_icon_elements(template_elements, 200, 300)
second = mod.transform_icon_elements(template_elements, 500, 600)

# Original template must stay untouched so second placement also rewrites nested bindings
assert template_elements[0]["boundElements"][0]["id"] == "arrow-orig"
assert template_elements[2]["startBinding"]["elementId"] == "box-orig"

assert (first[0]["x"], first[0]["y"]) == (200, 300)
assert (second[0]["x"], second[0]["y"]) == (500, 600)
assert first[0]["id"] != "box-orig" and second[0]["id"] != first[0]["id"]
assert first[0]["groupIds"][0] == first[1]["groupIds"][0]
assert second[0]["groupIds"][0] != first[0]["groupIds"][0]

# Second placement's bindings point to second placement's new IDs (not first placement's IDs!)
assert second[1]["containerId"] == second[0]["id"]
assert second[2]["startBinding"]["elementId"] == second[0]["id"]
assert second[2]["endBinding"]["elementId"] == second[1]["id"]
assert [b["id"] for b in second[0]["boundElements"]] == [second[2]["id"], second[1]["id"]]
print("OK")
`,
  ]);
  assert.equal(pyCheck.status, 0, pyCheck.stdout + pyCheck.stderr);
  assert.equal(pyCheck.stdout.trim(), "OK");

  // 2. CLI end-to-end: library loading, label centering, .edit suffix lock refusal, and --no-use-edit-suffix
  const libDir = path.join(dir, "custom-lib");
  fs.mkdirSync(path.join(libDir, "icons"), { recursive: true });
  fs.writeFileSync(
    path.join(libDir, "icons", "ComputeNode.json"),
    JSON.stringify({
      elements: [
        { id: "icon-1", type: "rectangle", x: 10, y: 20, width: 100, height: 60, groupIds: ["g1"] },
      ],
    }),
    "utf8",
  );

  const diagramPath = path.join(dir, "system.excalidraw");
  fs.writeFileSync(diagramPath, JSON.stringify({ type: "excalidraw", elements: [] }), "utf8");

  // CLI argument & missing-file validation errors exit 1
  for (const badArgs of [
    [addIconPy],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--unknown-flag"],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--label"],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--library-path"],
    [addIconPy, path.join(dir, "missing.excalidraw"), "ComputeNode", "100", "200", "--library-path", libDir],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--library-path", path.join(dir, "no-lib")],
    [addIconPy, diagramPath, "MissingIcon", "100", "200", "--library-path", libDir],
  ]) {
    assert.equal(runPy(badArgs).status, 1);
  }
  // Failed icon lookup must restore diagram.excalidraw instead of stranding it at .excalidraw.edit
  assert.equal(fs.existsSync(diagramPath), true);
  assert.equal(fs.existsSync(`${diagramPath}.edit`), false);

  const okAdd = runPy([
    addIconPy,
    diagramPath,
    "ComputeNode",
    "300",
    "400",
    "--library-path",
    libDir,
    "--label",
    "API Worker",
  ]);
  assert.equal(okAdd.status, 0, okAdd.stdout + okAdd.stderr);
  assert.equal(fs.existsSync(`${diagramPath}.edit`), false);

  const savedDiagram = JSON.parse(fs.readFileSync(diagramPath, "utf8"));
  assert.equal(savedDiagram.elements.length, 2);
  assert.equal(savedDiagram.elements[0].x, 300);
  assert.equal(savedDiagram.elements[0].y, 400);
  assert.equal(savedDiagram.elements[1].type, "text");
  assert.equal(savedDiagram.elements[1].text, "API Worker");
  assert.equal(savedDiagram.elements[1].y, 470); // max_y (460) + 10

  // Stale .edit file blocks default --use-edit-suffix, while --no-use-edit-suffix edits directly
  fs.writeFileSync(`${diagramPath}.edit`, "{}", "utf8");
  assert.equal(
    runPy([addIconPy, diagramPath, "ComputeNode", "50", "50", "--library-path", libDir]).status,
    1,
  );
  assert.equal(
    runPy([
      addIconPy,
      diagramPath,
      "ComputeNode",
      "50",
      "50",
      "--library-path",
      libDir,
      "--no-use-edit-suffix",
    ]).status,
    0,
  );
  assert.equal(JSON.parse(fs.readFileSync(diagramPath, "utf8")).elements.length, 3);
});

test("eval-driven-dev verify_step6_completion validates complete pixie result trees and reports every artifact/JSONL failure offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "eval-step6-");
  const verifyPy = path.join(SKILLS_ROOT, "eval-driven-dev", "resources", "verify_step6_completion.py");

  // 1. Missing directory fails with exit 1
  const missingRun = runPy([verifyPy, path.join(dir, "does-not-exist")]);
  assert.equal(missingRun.status, 1);
  assert.match(missingRun.stdout, /results directory not found/);

  // 2. Complete, valid Step 6 results directory passes with exit 0
  const okRoot = path.join(dir, "run-pass");
  const okEntry = path.join(okRoot, "dataset-golden", "entry-001");
  fs.mkdirSync(okEntry, { recursive: true });
  for (const rootFile of ["action-plan.md", "action-plan-summary.md", "meta.json"]) {
    fs.writeFileSync(path.join(okRoot, rootFile), "{}\n", "utf8");
  }
  for (const dsFile of ["analysis.md", "analysis-summary.md"]) {
    fs.writeFileSync(path.join(okRoot, "dataset-golden", dsFile), "# Summary\n", "utf8");
  }
  fs.writeFileSync(
    path.join(okEntry, "evaluations.jsonl"),
    [
      "",
      JSON.stringify({ evaluator: "factuality", status: "completed", score: 1.0, reasoning: "Grounded." }),
      JSON.stringify({ evaluator: "conciseness", score: 0.9, reasoning: "Direct answer." }),
    ].join("\n") + "\n",
    "utf8",
  );

  const okRun = runPy([verifyPy, okRoot]);
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.match(okRun.stdout, /Step 6 completion check passed\./);

  // 3. Incomplete / malformed directory reports root, dataset, entry, pending, non-dict, and missing score/reasoning errors
  const badRoot = path.join(dir, "run-fail");
  const dsEmpty = path.join(badRoot, "dataset-01-empty");
  const dsBroken = path.join(badRoot, "dataset-02-broken");
  const entryPending = path.join(dsBroken, "entry-01");
  const entryCorrupt = path.join(dsBroken, "entry-02");
  const entryMissingEval = path.join(dsBroken, "entry-03");
  fs.mkdirSync(dsEmpty, { recursive: true });
  fs.mkdirSync(entryPending, { recursive: true });
  fs.mkdirSync(entryCorrupt, { recursive: true });
  fs.mkdirSync(entryMissingEval, { recursive: true });

  // Omit meta.json at root and analysis-summary.md on dsEmpty
  fs.writeFileSync(path.join(badRoot, "action-plan.md"), "# Plan\n", "utf8");
  fs.writeFileSync(path.join(badRoot, "action-plan-summary.md"), "# Summary\n", "utf8");
  fs.writeFileSync(path.join(dsEmpty, "analysis.md"), "# Analysis\n", "utf8");
  fs.writeFileSync(path.join(dsBroken, "analysis.md"), "# Analysis\n", "utf8");
  fs.writeFileSync(path.join(dsBroken, "analysis-summary.md"), "# Summary\n", "utf8");

  fs.writeFileSync(
    path.join(entryPending, "evaluations.jsonl"),
    [
      "[1, 2, 3]",
      JSON.stringify({ evaluator: "tone-eval", status: "pending" }),
      JSON.stringify({ evaluator: "accuracy-eval", status: "scored" }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(entryCorrupt, "evaluations.jsonl"), "{not-valid-jsonl\n", "utf8");

  const failedRun = runPy([verifyPy, badRoot]);
  assert.equal(failedRun.status, 1);
  for (const expectedSnippet of [
    "Missing root artifact:",
    "Missing dataset artifact:",
    "no entry-* directories found",
    "Missing entry artifact:",
    "line 1 is not a JSON object",
    "Pending evaluation remains:",
    "tone-eval",
    "Missing score in scored evaluation:",
    "Missing reasoning in scored evaluation:",
    "invalid JSONL",
  ]) {
    assert.ok(
      failedRun.stdout.includes(expectedSnippet),
      `expected ${expectedSnippet} in:\n${failedRun.stdout}`,
    );
  }
});
